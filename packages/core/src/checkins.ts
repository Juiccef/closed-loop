// The five care-recipient tools, as plain async functions over the Store.
// Hot path rules: storage only (no network, no LLM), fail closed, never re-quiz after distress.

import { addDays, addMinutes, localDateTime, localTime, minutesBetween, zonedInstant } from './clock';
import { parseOccurrenceId, type CheckinDefinition, type HouseholdId, type Occurrence, type OccurrenceState } from './model';
import { loadPlan, materialize, newOccurrence, type PlanContext } from './plan';
import { CRISIS_REPLY, RESPONSES, SELF_HARM_REPLY, applySafety, type CheckinResponse } from './safety';
import { ConflictError, clip, type Store } from './store';
import { LEDGER_WORDING, ledgerStatusFor, spoken, statusSentence, type LedgerStatus } from './wording';

export const DEFER_UNTIL = ['in_30_min', 'in_1_hour', 'after_lunch', 'this_afternoon', 'this_evening'] as const;
export type DeferUntil = (typeof DEFER_UNTIL)[number];
export const PAUSE_SCOPES = ['today', '24_hours'] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];
export const NEXT_STEPS = ['none', 'will_ask_again_later', 'family_will_be_told', 'call_emergency_services'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

/** Minutes after a distress or crisis reply during which no check-in is asked. */
export const DISTRESS_QUIET_MINUTES = 60;

export interface DueCheckin {
  occurrenceId: string;
  label: string;
  prompt: string;
  allowedResponses: CheckinResponse[];
  isFollowUp: boolean;
}
export interface DueResult {
  checkins: DueCheckin[];
  paused: boolean;
  say: string;
}
export interface RecordResult {
  occurrenceId: string;
  recordedAs: LedgerStatus | 'not_recorded';
  recordedWording: string;
  nextStep: NextStep;
  calmingLine?: string;
  say: string;
}
export interface DeferResult {
  occurrenceId: string;
  deferredUntilLocal: string;
  say: string;
}
export interface StatusResult {
  date: string;
  reported: number;
  open: number;
  sharedWith: string[];
  paused: boolean;
  say: string;
}
export interface PauseResult {
  pausedUntilLocal: string;
  say: string;
}

/** Input the person can fix (unknown id); surfaced as a tool error, not a server error. */
export class CheckinInputError extends Error {}

const ASKABLE: ReadonlySet<OccurrenceState> = new Set(['SCHEDULED', 'PROMPTED', 'DEFERRED', 'UNSURE']);
const AFTER_CLOSE: ReadonlySet<OccurrenceState> = new Set(['MISSED', 'ESCALATED_L1', 'ESCALATED_L2', 'ACKNOWLEDGED', 'PAUSED']);
const PENDING_ALERT = new Set(['pending', 'waiting_quiet_hours', 'failed', 'sending']);

const inWindow = (o: Occurrence, now: Date) => new Date(o.windowStart) <= now && now < new Date(o.windowEnd);

/** Re-reads and retries a conditional occurrence write until it lands or `fn` declines. */
export async function mutateOccurrence(
  store: Store,
  householdId: HouseholdId,
  occurrenceId: string,
  fn: (current: Occurrence) => Occurrence | null,
  first?: Occurrence,
): Promise<Occurrence | null> {
  let current = first ?? (await store.getOccurrence(householdId, occurrenceId));
  for (let attempt = 0; attempt < 4 && current; attempt++) {
    const next = fn(current);
    if (!next) return null;
    const written = { ...next, version: current.version + 1 };
    try {
      await store.updateOccurrence(written, current.version);
      return written;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      current = await store.getOccurrence(householdId, occurrenceId);
    }
  }
  return null;
}

export function serveKind(o: Occurrence, def: CheckinDefinition, now: Date): 'first' | 'followup' | null {
  if (!inWindow(o, now) || !ASKABLE.has(o.state)) return null;
  if (o.state === 'SCHEDULED') return 'first';
  if (o.reasks >= def.maxReasks) return null;
  if (o.state === 'DEFERRED') return o.deferUntil && new Date(o.deferUntil) <= now ? 'followup' : null;
  const lastTouch = [o.lastPromptedAt, o.lastResponseAt].filter(Boolean).map((t) => new Date(t!).getTime());
  if (!lastTouch.length) return 'followup';
  return minutesBetween(new Date(Math.max(...lastTouch)), now) >= def.reaskMinutes ? 'followup' : null;
}

function recentDistress(occs: Occurrence[], now: Date): boolean {
  return occs.some(
    (o) => o.state === 'NEEDS_HUMAN' && o.lastResponseAt && minutesBetween(new Date(o.lastResponseAt), now) < DISTRESS_QUIET_MINUTES,
  );
}

function inactiveSay(ctx: PlanContext): string {
  if (ctx.status === 'paused' && ctx.plan?.household.pausedUntil) {
    return spoken.paused(new Date(ctx.plan.household.pausedUntil), ctx.plan.household.timezone);
  }
  return spoken.inactive;
}

// ---- get_due_checkins ----

export async function getDueCheckins(store: Store, householdId: HouseholdId): Promise<DueResult> {
  const ctx = await loadPlan(store, householdId);
  if (ctx.status !== 'active' || !ctx.plan) {
    return { checkins: [], paused: ctx.status === 'paused', say: inactiveSay(ctx) };
  }
  const { plan, now, today } = ctx;
  const occs = await materialize(store, plan, today, now);
  if (recentDistress(occs, now)) return { checkins: [], paused: false, say: spoken.noneDue };

  const defs = new Map(plan.checkins.map((d) => [d.id, d]));
  const nowIso = now.toISOString();
  const served = await Promise.all(
    occs.map(async (o): Promise<DueCheckin | null> => {
      const def = defs.get(o.checkinId);
      if (!def) return null;
      const kind = serveKind(o, def, now);
      if (!kind) return null;
      const written = await mutateOccurrence(
        store,
        householdId,
        o.id,
        (cur) =>
          serveKind(cur, def, now) === kind
            ? {
                ...cur,
                state: 'PROMPTED',
                promptedAt: cur.promptedAt ?? nowIso,
                lastPromptedAt: nowIso,
                reasks: kind === 'followup' ? cur.reasks + 1 : cur.reasks,
                deferUntil: undefined,
                updatedAt: nowIso,
              }
            : null,
        o,
      );
      if (!written) return null;
      await store.appendEvent({
        householdId,
        at: nowIso,
        type: kind === 'first' ? 'prompted' : 'reasked',
        occurrenceId: o.id,
        detail: kind === 'first' ? `Asked about ${def.label}.` : `Asked again about ${def.label} (follow-up ${written.reasks} of ${def.maxReasks}).`,
      });
      return { occurrenceId: o.id, label: def.label, prompt: def.prompt, allowedResponses: [...RESPONSES], isFollowUp: kind === 'followup' };
    }),
  );
  const checkins = served.filter((x): x is DueCheckin => !!x);
  const first = checkins[0];
  const say = !first ? spoken.noneDue : first.isFollowUp ? spoken.followUp(first.prompt) : first.prompt;
  return { checkins, paused: false, say };
}

// ---- record_response ----

export async function recordResponse(
  store: Store,
  householdId: HouseholdId,
  input: { occurrenceId: string; response: CheckinResponse; utterance?: string },
): Promise<RecordResult> {
  if (!parseOccurrenceId(input.occurrenceId)) throw new CheckinInputError(spoken.notFound);
  const [ctx, occ] = await Promise.all([loadPlan(store, householdId), store.getOccurrence(householdId, input.occurrenceId)]);
  const safety = applySafety(input.response, input.utterance);
  const crisisSay = safety.selfHarm ? SELF_HARM_REPLY : CRISIS_REPLY;

  // No consent, revoked, or expired: store nothing. The safety reply still goes out.
  if (!ctx.plan || ['no_household', 'no_consent', 'revoked', 'expired'].includes(ctx.status)) {
    return {
      occurrenceId: input.occurrenceId,
      recordedAs: 'not_recorded',
      recordedWording: 'not recorded (check-ins are turned off)',
      nextStep: safety.branch === 'crisis' ? 'call_emergency_services' : 'none',
      say: safety.branch === 'crisis' ? crisisSay : spoken.inactive,
    };
  }
  if (!occ) throw new CheckinInputError(spoken.notFound);

  const { plan, now } = ctx;
  const tz = plan.household.timezone;
  const def = plan.checkins.find((d) => d.id === occ.checkinId) ?? (await store.listCheckins(householdId)).find((d) => d.id === occ.checkinId);
  const label = def?.label ?? 'a check-in';
  const nowIso = now.toISOString();
  const final = safety.response;

  const written = await mutateOccurrence(
    store,
    householdId,
    occ.id,
    (cur) => {
      const open = inWindow(cur, now);
      const next: Occurrence = {
        ...cur,
        lastResponse: final,
        lastResponseAt: nowIso,
        safetyNote: safety.downgraded ? safety.reason : cur.safetyNote,
        updatedAt: nowIso,
      };
      const cancelPendingAlert = () => {
        if (PENDING_ALERT.has(next.alertStatus)) next.alertStatus = 'cancelled';
      };
      if (final === 'needs_help') {
        next.state = 'NEEDS_HUMAN';
        if (cur.state !== 'NEEDS_HUMAN' || cur.needsHumanNoteStatus !== 'sent') next.needsHumanNoteStatus = 'pending';
        next.needsHumanCrisis = cur.needsHumanCrisis || safety.branch === 'crisis';
        cancelPendingAlert();
        return next;
      }
      if (cur.state === 'NEEDS_HUMAN') return next; // sticky until a family member acknowledges
      if (final === 'done') {
        next.state = 'REPORTED_DONE';
        next.reportedLate = !open || AFTER_CLOSE.has(cur.state);
        next.deferUntil = undefined;
        cancelPendingAlert();
        return next;
      }
      if (!open || AFTER_CLOSE.has(cur.state)) return next; // window closed: keep the record, no new state
      if (final === 'later' || final === 'not_yet') {
        next.state = 'DEFERRED';
        next.deferUntil = clampDefer(addMinutes(now, def?.reaskMinutes ?? 60), cur, now).toISOString();
      } else if (final === 'no') {
        next.state = 'DECLINED';
      } else {
        next.state = 'UNSURE';
      }
      return next;
    },
    occ,
  );
  if (!written) throw new Error(`could not record response for ${occ.id}`);

  const status = ledgerStatusFor(final);
  const wording = LEDGER_WORDING[status];
  const tasks: Promise<void>[] = [
    store.appendEvent({ householdId, at: nowIso, type: 'response_recorded', occurrenceId: occ.id, detail: `${label}: ${wording}.` }),
  ];
  if (input.utterance) {
    tasks.push(
      store.putUtterance({ householdId, occurrenceId: occ.id, at: nowIso, text: clip(input.utterance), claimed: input.response, stored: final }),
    );
  }
  if (safety.downgraded) {
    tasks.push(
      store.appendEvent({
        householdId,
        at: nowIso,
        type: 'response_downgraded',
        occurrenceId: occ.id,
        detail: `${label}: recorded as "${wording}" instead of "done" (${safety.reason}).`,
      }),
    );
  }
  if (safety.branch !== 'none') {
    tasks.push(
      store.appendEvent({
        householdId,
        at: nowIso,
        type: safety.branch === 'crisis' ? 'crisis_branch' : 'distress_branch',
        occurrenceId: occ.id,
        detail: safety.branch === 'crisis' ? 'Emergency wording heard; 911 redirect given. Family note queued.' : 'Calming line given; no further questions. Family note queued.',
      }),
    );
  }
  await Promise.all(tasks);

  const hasL1 = plan.ladder.l1ContactIds.length > 0;
  const base = { occurrenceId: occ.id, recordedAs: status, recordedWording: wording };
  if (safety.branch === 'crisis') return { ...base, nextStep: 'call_emergency_services', say: crisisSay };
  if (final === 'needs_help') {
    const calmingLine = def?.calmingLine;
    return { ...base, nextStep: hasL1 ? 'family_will_be_told' : 'none', calmingLine, say: calmingLine ?? spoken.needsHelp };
  }
  if (written.state === 'NEEDS_HUMAN') return { ...base, nextStep: 'none', say: def?.calmingLine ?? spoken.needsHelp };
  if (final === 'done') return { ...base, nextStep: 'none', say: spoken.done };
  const willAsk = written.state === 'DEFERRED' || (written.state === 'UNSURE' && def !== undefined && written.reasks < def.maxReasks && inWindow(written, now));
  if (written.state === 'DEFERRED' && written.deferUntil) {
    return { ...base, nextStep: 'will_ask_again_later', say: spoken.later(new Date(written.deferUntil), tz) };
  }
  if (final === 'no') return { ...base, nextStep: hasL1 ? 'family_will_be_told' : 'none', say: spoken.declined };
  return { ...base, nextStep: willAsk ? 'will_ask_again_later' : 'none', say: final === 'unsure' ? spoken.unsure : spoken.laterNoTime };
}

// ---- defer_checkin ----

/** Keeps a deferral inside the window: at least 10 minutes from now, at most 10 minutes before the end. */
function clampDefer(target: Date, occ: Occurrence, now: Date): Date {
  const min = addMinutes(now, 10);
  const max = addMinutes(new Date(occ.windowEnd), -10);
  if (max <= min) return new Date(occ.windowEnd);
  return new Date(Math.min(Math.max(target.getTime(), min.getTime()), max.getTime()));
}

export function deferTarget(until: DeferUntil, now: Date, today: string, tz: string): Date {
  const at = (hhmm: string) => {
    const t = zonedInstant(today, hhmm, tz);
    return t > addMinutes(now, 10) ? t : addMinutes(now, 60);
  };
  switch (until) {
    case 'in_30_min':
      return addMinutes(now, 30);
    case 'in_1_hour':
      return addMinutes(now, 60);
    case 'after_lunch':
      return at('13:00');
    case 'this_afternoon':
      return at('15:00');
    case 'this_evening':
      return at('18:00');
  }
}

export async function deferCheckin(store: Store, householdId: HouseholdId, input: { occurrenceId: string; until: DeferUntil }): Promise<DeferResult> {
  if (!parseOccurrenceId(input.occurrenceId)) throw new CheckinInputError(spoken.notFound);
  const [ctx, occ] = await Promise.all([loadPlan(store, householdId), store.getOccurrence(householdId, input.occurrenceId)]);
  if (!ctx.plan || ctx.status !== 'active') return { occurrenceId: input.occurrenceId, deferredUntilLocal: '', say: inactiveSay(ctx) };
  if (!occ) throw new CheckinInputError(spoken.notFound);
  const { now, today, plan } = ctx;
  const tz = plan.household.timezone;
  if (occ.state === 'REPORTED_DONE') return { occurrenceId: occ.id, deferredUntilLocal: '', say: spoken.alreadyDone };
  if (!inWindow(occ, now) || !ASKABLE.has(occ.state)) {
    return { occurrenceId: occ.id, deferredUntilLocal: '', say: "Okay, I've noted that." };
  }
  const target = clampDefer(deferTarget(input.until, now, today, tz), occ, now);
  const nowIso = now.toISOString();
  const written = await mutateOccurrence(
    store,
    householdId,
    occ.id,
    (cur) =>
      ASKABLE.has(cur.state)
        ? { ...cur, state: 'DEFERRED', deferUntil: target.toISOString(), lastResponse: 'later', lastResponseAt: nowIso, updatedAt: nowIso }
        : null,
    occ,
  );
  if (!written) return { occurrenceId: occ.id, deferredUntilLocal: '', say: "Okay, I've noted that." };
  const label = plan.checkins.find((d) => d.id === occ.checkinId)?.label ?? 'a check-in';
  const atEnd = target.getTime() === new Date(occ.windowEnd).getTime();
  await store.appendEvent({
    householdId,
    at: nowIso,
    type: 'deferred',
    occurrenceId: occ.id,
    detail: atEnd ? `${label}: said later; the window closes before another ask.` : `${label}: said later; will ask again at ${localTime(target, tz)}.`,
  });
  return {
    occurrenceId: occ.id,
    deferredUntilLocal: atEnd ? '' : localTime(target, tz),
    say: atEnd ? spoken.laterNoTime : spoken.later(target, tz),
  };
}

// ---- get_my_status ----

export async function getMyStatus(store: Store, householdId: HouseholdId): Promise<StatusResult> {
  const ctx = await loadPlan(store, householdId);
  if (!ctx.plan) return { date: ctx.today, reported: 0, open: 0, sharedWith: [], paused: false, say: spoken.inactive };
  const { plan, now, today } = ctx;
  const stored = new Map((await store.listOccurrences(householdId, today)).map((o) => [o.id, o]));
  // Count windows not yet materialized too, without writing (this tool is read-only).
  const all: Occurrence[] = [];
  for (const def of plan.checkins) {
    def.windows.forEach((_, idx) => {
      const virtual = newOccurrence(householdId, def, today, idx, plan.household.timezone, now);
      all.push(stored.get(virtual.id) ?? virtual);
    });
  }
  const reported = all.filter((o) => o.state === 'REPORTED_DONE').length;
  const open = all.filter((o) => ASKABLE.has(o.state) && new Date(o.windowEnd) > now).length;
  const missed = all.filter((o) => ['MISSED', 'ESCALATED_L1', 'ESCALATED_L2'].includes(o.state) || (ASKABLE.has(o.state) && new Date(o.windowEnd) <= now)).length;
  const contacts = new Map(plan.household.contacts.map((c) => [c.id, c]));
  const l1 = plan.ladder.l1ContactIds.map((id) => contacts.get(id)).filter((c) => !!c);
  const paused = ctx.status === 'paused';
  let say = ctx.status === 'active' || paused ? statusSentence(reported, open, missed, l1.map((c) => c.name)) : spoken.inactive;
  if (paused) say += ` ${inactiveSay(ctx)}`;
  return { date: today, reported, open, sharedWith: l1.map((c) => `${c.name} (${c.relation})`), paused, say };
}

// ---- pause_checkins ----

export async function pauseCheckins(store: Store, householdId: HouseholdId, input: { scope: PauseScope }): Promise<PauseResult> {
  const ctx = await loadPlan(store, householdId);
  if (!ctx.plan) return { pausedUntilLocal: '', say: spoken.inactive };
  const { now, today, plan } = ctx;
  const tz = plan.household.timezone;
  const until = input.scope === 'today' ? zonedInstant(addDays(today, 1), '00:00', tz) : addMinutes(now, 24 * 60);
  const nowIso = now.toISOString();
  await store.updateHousehold(householdId, { pausedUntil: until.toISOString(), pausedAt: nowIso, pausedBy: 'person' });
  const untilLocal = localDateTime(until, tz);
  await store.appendEvent({
    householdId,
    at: nowIso,
    type: 'paused',
    detail: `Paused by ${plan.household.recipientName} ${input.scope === 'today' ? 'for the rest of today' : 'for 24 hours'}.`,
  });
  return { pausedUntilLocal: untilLocal, say: input.scope === 'today' ? spoken.pausedToday : spoken.paused24h };
}
