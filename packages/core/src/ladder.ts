// The tick: closes windows, decides who to tell, and sends email. It never speaks to the person.
// Every alert is claimed with a conditional write before sending, so overlapping ticks cannot double-send.

import { addDays, datesBetween, inLocalRange, localDate, localTime, minutesBetween, realNow } from './clock';
import { mutateOccurrence } from './checkins';
import type { CheckinDefinition, Contact, HouseholdId, Occurrence, OccurrenceState, OpenReason } from './model';
import { loadPlan, materialize, type Plan } from './plan';
import type { Store } from './store';
import { ledgerLine, missedEmail, needsHumanEmail, type EmailContent } from './wording';
import { VISITOR_EMAIL_BUDGET_ID, VISITOR_EMAILS_PER_DAY, isVisitorHousehold } from './visitor';

export interface OutgoingEmail extends EmailContent {
  to: string;
  /** Contact's name, for logs and the demo panel (never the address). */
  toName: string;
  householdId: HouseholdId;
  occurrenceId: string;
  kind: 'missed_l1' | 'missed_l2' | 'needs_human';
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ messageId: string }>;
  /** Shown in the demo's email panel, e.g. "Amazon SES". */
  readonly label?: string;
}

async function logSent(store: Store, mailer: Mailer, email: OutgoingEmail, messageId: string, relation: string): Promise<void> {
  const preview = email.text.split('\n\n').slice(0, 2).join(' ').slice(0, 400);
  await store.appendMailLog({
    householdId: email.householdId,
    at: new Date().toISOString(),
    toName: relation ? `${email.toName} (${relation})` : email.toName,
    subject: email.subject.slice(0, 160),
    preview,
    via: mailer.label ?? 'email',
    messageId: messageId.slice(0, 120),
    kind: email.kind,
  });
}

export interface TickOptions {
  mailer: Mailer;
  /** Builds the signed acknowledge URL for one contact. */
  ackUrl: (householdId: HouseholdId, occurrenceId: string, contactId: string) => string;
  maxAlertAttempts?: number;
  /** Check-in emails from all visitor demo households together, per real (UTC) day. */
  visitorEmailsPerDay?: number;
}

export interface TickReport {
  households: number;
  closed: number;
  alertsSent: number;
  alertsSuppressed: number;
  notesSent: number;
  errors: string[];
}

const OPEN_AT_CLOSE: ReadonlySet<OccurrenceState> = new Set(['SCHEDULED', 'PROMPTED', 'DEFERRED', 'UNSURE', 'DECLINED']);
const LOOP_OPEN: ReadonlySet<OccurrenceState> = new Set(['MISSED', 'ESCALATED_L1', 'ESCALATED_L2']);
const STALE_CLAIM_MINUTES = 5;

const REASON_BY_STATE: Partial<Record<OccurrenceState, OpenReason>> = {
  SCHEDULED: 'not_reached',
  PROMPTED: 'no_answer',
  DEFERRED: 'said_later',
  UNSURE: 'not_sure',
  DECLINED: 'declined',
};

const TICK_CONCURRENCY = 8;

/**
 * Ticks every registered household, or only `householdIds`. Each household is evaluated at its own time
 * (a visitor household has its own clock), a few at a time so many visitor households still fit in a minute.
 */
export async function runTick(store: Store, opts: TickOptions, householdIds?: HouseholdId[]): Promise<TickReport> {
  const report: TickReport = { households: 0, closed: 0, alertsSent: 0, alertsSuppressed: 0, notesSent: 0, errors: [] };
  const queue = [...(householdIds ?? (await store.listHouseholdIds()))];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        await tickHousehold(store, id, opts, report);
        report.households++;
      } catch (err) {
        report.errors.push(`${id}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TICK_CONCURRENCY, queue.length) }, worker));
  return report;
}

export async function tickHousehold(store: Store, id: HouseholdId, opts: TickOptions, report: TickReport): Promise<void> {
  const ctx = await loadPlan(store, id);
  if (!ctx.plan) return;
  const { plan, now, today } = ctx;
  const h = plan.household;

  // Consent missing, revoked, or expired: nothing is closed, nothing is sent.
  if (ctx.status === 'no_consent' || ctx.status === 'revoked' || ctx.status === 'expired') {
    if (ctx.status === 'expired' && h.expiryNoticeFor !== plan.consent?.planExpiresAt) {
      await store.appendEvent({ householdId: id, at: now.toISOString(), type: 'plan_expired', detail: 'The check-in plan expired. Renew it to resume check-ins and emails.' });
      await store.updateHousehold(id, { expiryNoticeFor: plan.consent?.planExpiresAt });
    }
    return;
  }

  const created = localDate(new Date(h.createdAt), h.timezone);
  const last = h.lastProcessedDate ?? addDays(today, -1);
  let from = [last, addDays(today, -1)].sort()[0]!; // always revisit yesterday for late windows and retries
  if (from < addDays(today, -7)) from = addDays(today, -7);
  if (from < created) from = created;

  for (const date of datesBetween(from, today)) await materialize(store, plan, date, now);

  const defs = new Map(plan.checkins.map((d) => [d.id, d]));
  const lookback = addDays(from, -Math.max(1, plan.ladder.l2AfterMissedDays));
  const history = await store.listOccurrences(id, lookback, today);
  const occs = history.filter((o) => o.date >= from);

  for (const occ of occs) {
    if (new Date(occ.windowEnd) > now || !OPEN_AT_CLOSE.has(occ.state)) continue;
    const def = defs.get(occ.checkinId);
    const closed = await closeOccurrence(store, plan, occ, def, history, now);
    if (closed) {
      report.closed++;
      Object.assign(occ, closed);
    }
  }

  for (const occ of await store.listOccurrences(id, from, today)) {
    const def = defs.get(occ.checkinId);
    if (shouldDeliver(occ.alertStatus, occ.alertClaimedAt, occ.alertAttempts, now, opts) && def) {
      await deliverAlert(store, plan, occ, def, now, opts, report);
    }
    if (occ.needsHumanNoteStatus && shouldDeliver(occ.needsHumanNoteStatus, occ.needsHumanClaimedAt, occ.needsHumanAttempts, now, opts)) {
      await deliverNote(store, plan, occ, now, opts, report);
    }
  }

  if (h.lastProcessedDate !== today) await store.updateHousehold(id, { lastProcessedDate: today });
}

function shouldDeliver(status: string | undefined, claimedAt: string | undefined, attempts: number | undefined, now: Date, opts: TickOptions): boolean {
  if (status === 'pending' || status === 'waiting_quiet_hours') return true;
  if (status === 'failed') return (attempts ?? 0) < (opts.maxAlertAttempts ?? 3);
  if (status === 'sending') return !claimedAt || minutesBetween(new Date(claimedAt), now) >= STALE_CLAIM_MINUTES;
  return false;
}

function pausedDuring(plan: Plan, occ: Occurrence): boolean {
  const h = plan.household;
  if (!h.pausedAt || !h.pausedUntil) return false;
  return new Date(h.pausedAt) < new Date(occ.windowEnd) && new Date(h.pausedUntil) > new Date(occ.windowStart);
}

/** Consecutive days, ending with `occ.date`, on which this check-in's loop stayed open and nobody acknowledged. */
export function consecutiveOpenDays(occ: Occurrence, history: Occurrence[]): number {
  let days = 1;
  for (let d = addDays(occ.date, -1); ; d = addDays(d, -1)) {
    const that = history.filter((o) => o.checkinId === occ.checkinId && o.date === d);
    if (!that.length || !that.some((o) => LOOP_OPEN.has(o.state))) return days;
    days++;
  }
}

async function closeOccurrence(
  store: Store,
  plan: Plan,
  occ: Occurrence,
  def: CheckinDefinition | undefined,
  history: Occurrence[],
  now: Date,
): Promise<Occurrence | null> {
  const nowIso = now.toISOString();
  const ladder = plan.ladder;
  const paused = pausedDuring(plan, occ);
  const days = consecutiveOpenDays(occ, history);
  const level: 1 | 2 = days >= ladder.l2AfterMissedDays && ladder.l2ContactIds.length > 0 ? 2 : 1;
  const hasRecipients = ladder.l1ContactIds.length > 0 || (level === 2 && ladder.l2ContactIds.length > 0);

  const written = await mutateOccurrence(
    store,
    plan.household.id,
    occ.id,
    (cur) => {
      if (!OPEN_AT_CLOSE.has(cur.state) || new Date(cur.windowEnd) > now) return null;
      if (paused) return { ...cur, state: 'PAUSED', updatedAt: nowIso };
      return {
        ...cur,
        state: 'MISSED',
        openReason: REASON_BY_STATE[cur.state] ?? 'not_reached',
        escalationLevel: level,
        alertStatus: hasRecipients && def ? 'pending' : 'none',
        updatedAt: nowIso,
      };
    },
    occ,
  );
  if (!written) return null;
  await store.appendEvent({
    householdId: plan.household.id,
    at: nowIso,
    type: 'missed',
    occurrenceId: occ.id,
    detail: written.state === 'PAUSED' ? `${def?.label ?? 'Check-in'}: window closed while paused; no email.` : `${def?.label ?? 'Check-in'}: window closed, ${ledgerLine(written)}.`,
  });
  return written;
}

function quietNow(plan: Plan, now: Date): boolean {
  const q = plan.ladder.quietHours;
  if (plan.household.demoMode || !q) return false;
  return inLocalRange(localTime(now, plan.household.timezone), q.start, q.end);
}

function contactsFor(plan: Plan, ids: string[]): Contact[] {
  const byId = new Map(plan.household.contacts.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is Contact => !!c);
}

async function deliverAlert(
  store: Store,
  plan: Plan,
  occ: Occurrence,
  def: CheckinDefinition,
  now: Date,
  opts: TickOptions,
  report: TickReport,
): Promise<void> {
  const id = plan.household.id;
  const nowIso = now.toISOString();
  if (quietNow(plan, now)) {
    if (occ.alertStatus !== 'waiting_quiet_hours') {
      await mutateOccurrence(store, id, occ.id, (cur) => (cur.alertStatus === occ.alertStatus ? { ...cur, alertStatus: 'waiting_quiet_hours', updatedAt: nowIso } : null), occ);
    }
    return;
  }
  // Claim it. Whoever wins this conditional write is the only sender.
  const claimed = await mutateOccurrence(
    store,
    id,
    occ.id,
    (cur) => (shouldDeliver(cur.alertStatus, cur.alertClaimedAt, cur.alertAttempts, now, opts) ? { ...cur, alertStatus: 'sending', alertClaimedAt: nowIso, updatedAt: nowIso } : null),
    occ,
  );
  if (!claimed) return;

  // Visitor households share one deployment-wide daily budget (checked first, so the household's own count
  // stays exact), then each household's own cap applies on its own date.
  const overBudget =
    isVisitorHousehold(id) &&
    !(await store.tryConsumeAlert(VISITOR_EMAIL_BUDGET_ID, new Date(realNow()).toISOString().slice(0, 10), opts.visitorEmailsPerDay ?? VISITOR_EMAILS_PER_DAY));
  if (overBudget || !(await store.tryConsumeAlert(id, localDate(now, plan.household.timezone), plan.ladder.dailyAlertCap))) {
    await mutateOccurrence(store, id, occ.id, (cur) => (cur.alertStatus === 'sending' ? { ...cur, alertStatus: 'suppressed_cap', updatedAt: nowIso } : null), claimed);
    const why = overBudget ? 'demo email limit for today reached' : 'daily email limit reached';
    await store.appendEvent({ householdId: id, at: nowIso, type: 'alert_suppressed', occurrenceId: occ.id, detail: `${def.label}: ${why}; shown in the console only.` });
    report.alertsSuppressed++;
    return;
  }

  const level = claimed.escalationLevel === 2 ? 2 : 1;
  const l1 = contactsFor(plan, plan.ladder.l1ContactIds);
  const recipients = level === 2 ? [...l1, ...contactsFor(plan, plan.ladder.l2ContactIds).filter((c) => !l1.some((x) => x.id === c.id))] : l1;
  const history = level === 2 ? await store.listOccurrences(id, addDays(occ.date, -14), occ.date) : [];
  const days = level === 2 ? consecutiveOpenDays(claimed, history) : 1;

  const sentTo: string[] = [];
  for (const c of recipients) {
    const content = missedEmail({ household: plan.household, def, occ: claimed, level, consecutiveDays: days, ackUrl: opts.ackUrl(id, occ.id, c.id) });
    try {
      const email: OutgoingEmail = { ...content, to: c.email, toName: c.name, householdId: id, occurrenceId: occ.id, kind: level === 2 ? 'missed_l2' : 'missed_l1' };
      const { messageId } = await opts.mailer.send(email);
      sentTo.push(c.name);
      await logSent(store, opts.mailer, email, messageId, c.relation).catch(() => {});
    } catch (err) {
      report.errors.push(`${occ.id} -> ${c.id}: ${(err as Error).message}`);
    }
  }

  const ok = sentTo.length > 0;
  await mutateOccurrence(
    store,
    id,
    occ.id,
    (cur) => {
      const base = { ...cur, updatedAt: nowIso };
      if (!ok) return { ...base, alertStatus: 'failed', alertAttempts: (cur.alertAttempts ?? 0) + 1 };
      // The person may have answered or the family acknowledged while we were sending; keep that state.
      const state = LOOP_OPEN.has(cur.state) ? (level === 2 ? 'ESCALATED_L2' : 'ESCALATED_L1') : cur.state;
      return { ...base, state, alertStatus: 'sent', alertedAt: nowIso };
    },
    claimed,
  );
  await store.appendEvent({
    householdId: id,
    at: nowIso,
    type: ok ? 'alert_sent' : 'alert_failed',
    occurrenceId: occ.id,
    detail: ok ? `${def.label}: emailed ${sentTo.join(', ')}${level === 2 ? ' (second contact)' : ''}.` : `${def.label}: email failed; will retry.`,
  });
  if (ok) report.alertsSent++;
}

async function deliverNote(store: Store, plan: Plan, occ: Occurrence, now: Date, opts: TickOptions, report: TickReport): Promise<void> {
  const id = plan.household.id;
  const nowIso = now.toISOString();
  const claimed = await mutateOccurrence(
    store,
    id,
    occ.id,
    (cur) =>
      cur.needsHumanNoteStatus && shouldDeliver(cur.needsHumanNoteStatus, cur.needsHumanClaimedAt, cur.needsHumanAttempts, now, opts)
        ? { ...cur, needsHumanNoteStatus: 'sending', needsHumanClaimedAt: nowIso, updatedAt: nowIso }
        : null,
    occ,
  );
  if (!claimed) return;
  // Needs-human notes count toward the daily total but are never blocked by the cap or quiet hours.
  await store.tryConsumeAlert(id, localDate(now, plan.household.timezone), Number.MAX_SAFE_INTEGER);
  const recipients = contactsFor(plan, plan.ladder.l1ContactIds);
  const sentTo: string[] = [];
  for (const c of recipients) {
    const content = needsHumanEmail({ household: plan.household, occ: claimed, crisis: !!claimed.needsHumanCrisis, ackUrl: opts.ackUrl(id, occ.id, c.id) });
    try {
      const email: OutgoingEmail = { ...content, to: c.email, toName: c.name, householdId: id, occurrenceId: occ.id, kind: 'needs_human' };
      const { messageId } = await opts.mailer.send(email);
      sentTo.push(c.name);
      await logSent(store, opts.mailer, email, messageId, c.relation).catch(() => {});
    } catch (err) {
      report.errors.push(`${occ.id} -> ${c.id}: ${(err as Error).message}`);
    }
  }
  const ok = sentTo.length > 0 || recipients.length === 0;
  await mutateOccurrence(
    store,
    id,
    occ.id,
    (cur) => ({ ...cur, needsHumanNoteStatus: ok ? 'sent' : 'failed', needsHumanAttempts: ok ? cur.needsHumanAttempts : (cur.needsHumanAttempts ?? 0) + 1, updatedAt: nowIso }),
    claimed,
  );
  if (!ok) await store.appendEvent({ householdId: id, at: nowIso, type: 'alert_failed', occurrenceId: occ.id, detail: 'Family note could not be sent; will retry.' });
  if (sentTo.length) {
    await store.appendEvent({ householdId: id, at: nowIso, type: 'needs_human_note_sent', occurrenceId: occ.id, detail: `Note sent to ${sentTo.join(', ')}: a call may help.` });
    report.notesSent++;
  }
}

// ---- Acknowledge (from the signed email link or the console) ----

const ACKABLE: ReadonlySet<OccurrenceState> = new Set(['MISSED', 'ESCALATED_L1', 'ESCALATED_L2', 'NEEDS_HUMAN']);

export async function acknowledge(
  store: Store,
  householdId: HouseholdId,
  occurrenceId: string,
  contactId: string,
  now: Date,
): Promise<{ ok: boolean; state?: OccurrenceState; already?: boolean }> {
  const nowIso = now.toISOString();
  const before = await store.getOccurrence(householdId, occurrenceId);
  if (!before) return { ok: false };
  if (before.state === 'ACKNOWLEDGED') return { ok: true, state: 'ACKNOWLEDGED', already: true };
  const written = await mutateOccurrence(
    store,
    householdId,
    occurrenceId,
    (cur) => {
      if (!ACKABLE.has(cur.state)) return null;
      const cancel = (s: Occurrence['alertStatus'] | undefined) => (s && ['pending', 'waiting_quiet_hours', 'failed'].includes(s) ? 'cancelled' : s);
      return {
        ...cur,
        state: 'ACKNOWLEDGED',
        ackedAt: nowIso,
        ackedBy: contactId,
        alertStatus: cancel(cur.alertStatus) ?? 'none',
        needsHumanNoteStatus: cancel(cur.needsHumanNoteStatus),
        updatedAt: nowIso,
      };
    },
    before,
  );
  if (!written) return { ok: false, state: before.state };
  await store.appendEvent({ householdId, at: nowIso, type: 'acknowledged', occurrenceId, detail: 'Acknowledged by family; no further emails about this check-in.' });
  return { ok: true, state: 'ACKNOWLEDGED' };
}
