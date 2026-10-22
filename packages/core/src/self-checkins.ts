// Check-ins the person sets up for themselves, by voice: "If I haven't said good night by ten, let Dana know."
// They reuse the occurrence state machine and the ladder, but they are never asked: the loop closes when the
// person speaks first and says their own phrase before the deadline, so no proactive prompt is needed.
// Creating one takes two calls: a spoken preview with a short-lived signed token, then the token and the person's yes.
// Hot path rules hold: storage only, fail closed. Family accounts cannot reach these (enforced at the tool layer).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { addDays, addMinutes, inLocalRange, localDate, localTime, parseHHMM, spokenClock, spokenTime, zonedInstant } from './clock';
import { CheckinInputError, mutateOccurrence, type NextStep } from './checkins';
import { lintField } from './lint';
import { occurrenceId, type CheckinDefinition, type Contact, type HouseholdId, type Occurrence, type OccurrenceState, type SelfRepeat } from './model';
import { isOwnCheckin, loadPlan, materialize, newOccurrence, runsOn, windowInstants, type Plan, type PlanContext } from './plan';
import { CRISIS_REPLY, SELF_HARM_REPLY, applySafety, normalizeUtterance } from './safety';
import type { Store } from './store';
import { joinNames, ledgerLine, spoken } from './wording';

/** At most this many live check-ins of the person's own. */
export const MAX_OWN_CHECKINS = 3;
/** A preview's confirm token works for this long (simulated clock). */
export const CONFIRM_TOKEN_MINUTES = 5;
/** Each window opens this long before its deadline (the console shows it; saying the phrase earlier that day still counts). */
export const OWN_WINDOW_HOURS = 6;
export const SET_STATUSES = ['confirm_needed', 'set', 'not_set'] as const;
export const CANCEL_STATUSES = ['cancelled', 'not_cancelled'] as const;

/** One of the person's own check-ins, as tools report it. */
export interface OwnCheckinSummary {
  /** Empty in a preview. */
  checkinId: string;
  phrase: string;
  /** Local deadline, HH:MM. */
  byLocal: string;
  /** First name of the contact who is told. */
  tell: string;
  repeat: SelfRepeat;
  /** The occurrence that saying the phrase now would close (pass it to record_response). Empty when none is in play. */
  occurrenceId: string;
  /** Ledger wording for that occurrence. Empty in a preview. */
  recorded: string;
}

export interface SetMyCheckinResult {
  status: (typeof SET_STATUSES)[number];
  checkin?: OwnCheckinSummary;
  confirmToken?: string;
  expiresInSeconds?: number;
  nextStep: NextStep;
  calmingLine?: string;
  say: string;
}

export interface CancelMyCheckinResult {
  status: (typeof CANCEL_STATUSES)[number];
  checkin?: OwnCheckinSummary;
  remaining: number;
  say: string;
}

export interface SetMyCheckinInput {
  phrase?: string;
  by?: string;
  tell?: string;
  repeat?: SelfRepeat;
  confirmToken?: string;
  utterance?: string;
}

const OPEN: ReadonlySet<OccurrenceState> = new Set(['SCHEDULED', 'PROMPTED', 'DEFERRED', 'UNSURE', 'DECLINED']);
const PENDING_ALERT = new Set(['pending', 'waiting_quiet_hours', 'failed']);

const said = {
  howTo: "Tell me what you'll say and by when. For example: if I haven't said good night by 10, let Dana know.",
  wording: 'I can only set that up with everyday words, like good night or good morning.',
  noContacts: "No one is set up to get emails yet, so I can't set that up.",
  limit: `You already have ${MAX_OWN_CHECKINS} check-ins of your own. Cancel one first, for example by saying: cancel my good night check.`,
  notSet: "Okay, I haven't set it.",
  expired: "That took a little too long, so I haven't set it. You can ask me again.",
  none: "You haven't set up any check-ins of your own.",
};

// ---- Confirm tokens: HMAC-signed, short-lived, bound to the household and the exact draft ----

interface Draft {
  v: 1;
  h: HouseholdId;
  p: string;
  b: string;
  c: string;
  r: SelfRepeat;
  /** The first deadline, epoch ms. */
  t: number;
  /** Id of a live check-in with the same phrase that this one replaces. */
  rp?: string;
  /** Expiry, epoch ms (simulated clock). */
  x: number;
}

let fallbackSecret: string | undefined;
/** Deployments pass a configured secret; a random per-process one keeps single-process tests and local runs working. */
function secretOr(secret?: string): string {
  return secret || (fallbackSecret ??= randomBytes(32).toString('base64url'));
}

function sign(secret: string, draft: Draft): string {
  const body = Buffer.from(JSON.stringify(draft)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(`confirm.${body}`).digest('base64url')}`;
}

function verify(secret: string, token: string): Draft | undefined {
  const [body, sig] = token.split('.');
  if (!body || !sig) return undefined;
  const want = Buffer.from(createHmac('sha256', secret).update(`confirm.${body}`).digest('base64url'));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Draft;
    return d.v === 1 ? d : undefined;
  } catch {
    return undefined;
  }
}

/** The same token always yields the same id, so a replayed confirm cannot create a second check-in. */
const idFor = (token: string) => `me-${createHash('sha256').update(token).digest('hex').slice(0, 10)}`;

// ---- Helpers ----

const YES = [/\byes\b/, /\byeah\b/, /\byep\b/, /\byup\b/, /\bsure\b/, /\bok(ay)?\b/, /\bplease\b/, /\bgo ahead\b/, /\bdo it\b/, /\bset it\b/, /\bthat'?s right\b/, /\bcorrect\b/, /\bsounds good\b/];
const NOT_YES = [/\bno\b/, /\bnope\b/, /\bnot\b/, /\bdon'?t\b/, /\bcancel\b/, /\bwait\b/, /\bnever ?mind\b/, /\bstop\b/, /\bmaybe\b/, /\bi guess\b/, /\bi think\b/];

/** The confirm call carries the person's own answer; only a clear, unhedged yes creates the check-in. */
export function isClearYes(utterance: string): boolean {
  const t = normalizeUtterance(utterance);
  return YES.some((p) => p.test(t)) && !NOT_YES.some((p) => p.test(t));
}

function ladderContacts(plan: Plan): Contact[] {
  const ids = new Set([...plan.ladder.l1ContactIds, ...plan.ladder.l2ContactIds]);
  return plan.household.contacts.filter((c) => ids.has(c.id));
}

/** "Dana", "dana", "my daughter", or nothing (the first contact told about check-ins). */
function resolveContact(plan: Plan, tell: string | undefined): Contact | undefined {
  const all = ladderContacts(plan);
  const t = (tell ?? '').toLowerCase().replace(/^(my|our)\s+/, '').trim();
  if (!t) return all.find((c) => plan.ladder.l1ContactIds.includes(c.id)) ?? all[0];
  return all.find((c) => c.name.toLowerCase() === t || c.id === t || c.relation.toLowerCase() === t);
}

/** The next deadline at least 10 minutes away: "by 1 am" said at 10 pm means tonight, after midnight. */
function nextDeadline(by: string, now: Date, today: string, tz: string): Date {
  const first = zonedInstant(today, by, tz);
  return first > addMinutes(now, 10) ? first : zonedInstant(addDays(today, 1), by, tz);
}

function whenWord(deadline: Date, now: Date, tz: string): string {
  const today = localDate(now, tz);
  const date = localDate(deadline, tz);
  const { hour } = parseHHMM(localTime(deadline, tz));
  if (date === today) return hour >= 17 ? 'tonight' : 'today';
  if (date === addDays(today, 1) && hour < 5) return 'tonight';
  return 'tomorrow';
}

const quoted = (phrase: string) => `“${phrase}”`;
const compact = (s: string) => normalizeUtterance(s).replace(/[^a-z0-9]/g, '');

/** "Good night!" -> "good night"; keeps "I" capitalized ("I'm home"). */
function cleanPhrase(raw: string): string {
  return raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d"]/g, '')
    .replace(/[\s.!?,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\bi\b/g, 'I');
}
const labelFor = (phrase: string, by: string) => `your ${quoted(phrase)} by ${spokenClock(by)}`;

/** Late reports ("good night" just after the deadline) still reach the window for this long. */
const LATE_HOURS = 3;

/** A check-in of the person's own that can still close: daily, or a `tonight` whose deadline is less than `graceHours` ago. */
function isLive(def: CheckinDefinition, tz: string, now: Date, graceHours = 0): boolean {
  if (!isOwnCheckin(def) || !def.active) return false;
  if (def.self!.repeat === 'daily' || !def.self!.date) return true;
  const w = def.windows[0]!;
  return windowInstants(def.self!.date, w.start, w.end, tz).end.getTime() > now.getTime() - graceHours * 3_600_000;
}

export function liveOwnCheckins(plan: Plan, now: Date): CheckinDefinition[] {
  return plan.checkins.filter((d) => isLive(d, plan.household.timezone, now));
}

/**
 * The occurrence that saying the phrase now would close: the window open now; else one that closed in the last
 * three hours (a late report); else today's next window. Returned virtual when not yet stored.
 */
function inPlay(plan: Plan, def: CheckinDefinition, stored: Map<string, Occurrence>, now: Date, today: string): Occurrence | undefined {
  const tz = plan.household.timezone;
  const candidates: Occurrence[] = [];
  for (const date of [addDays(today, -1), today]) {
    if (!runsOn(def, date)) continue;
    const v = newOccurrence(plan.household.id, def, date, 0, tz, now);
    if (new Date(v.windowEnd) <= new Date(def.createdAt)) continue;
    candidates.push(stored.get(v.id) ?? v);
  }
  const open = candidates.find((o) => new Date(o.windowStart) <= now && now < new Date(o.windowEnd));
  if (open) return open;
  const late = candidates.filter((o) => new Date(o.windowEnd) <= now && now.getTime() - new Date(o.windowEnd).getTime() <= LATE_HOURS * 3_600_000).at(-1);
  if (late) return late;
  return candidates.find((o) => o.date === today && new Date(o.windowStart) > now);
}

function summary(plan: Plan, def: CheckinDefinition, occ: Occurrence | undefined): OwnCheckinSummary {
  const s = def.self!;
  const contact = plan.household.contacts.find((c) => c.id === s.contactId);
  return {
    checkinId: def.id,
    phrase: s.phrase,
    byLocal: s.by,
    tell: contact?.name ?? '',
    repeat: s.repeat,
    occurrenceId: occ?.id ?? '',
    recorded: occ ? ledgerLine(occ, undefined, { own: true }) : '',
  };
}

/** The person's own check-ins (including a `tonight` one just past its deadline) with the occurrence each would close now. Read-only. */
export async function ownCheckinSummaries(store: Store, ctx: PlanContext): Promise<OwnCheckinSummary[]> {
  if (!ctx.plan) return [];
  const { plan, now, today } = ctx;
  const live = plan.checkins.filter((d) => isLive(d, plan.household.timezone, now, LATE_HOURS));
  if (!live.length) return [];
  const stored = new Map((await store.listOccurrences(plan.household.id, addDays(today, -1), today)).map((o) => [o.id, o]));
  return live.slice(0, MAX_OWN_CHECKINS * 2).map((d) => summary(plan, d, inPlay(plan, d, stored, now, today)));
}

/** "You asked me to email Dana if you haven't said good night by 10 pm." */
export function ownStatusSentence(items: OwnCheckinSummary[]): string {
  return items
    .map((i) => {
      const heard = /^reported by the person/.test(i.recorded);
      return `You asked me to email ${i.tell} if you haven't said ${i.phrase} by ${spokenClock(i.byLocal)}${i.repeat === 'daily' ? ' each day' : ''}${heard ? '; I heard it' : ''}.`;
    })
    .join(' ');
}

function inactiveSay(ctx: PlanContext): string {
  if (ctx.status === 'paused' && ctx.plan?.household.pausedUntil) return spoken.paused(new Date(ctx.plan.household.pausedUntil), ctx.plan.household.timezone);
  return spoken.inactive;
}

/** Closes open occurrences of a check-in being cancelled or replaced, and cancels emails not yet sent. */
async function retire(store: Store, plan: Plan, def: CheckinDefinition, now: Date, today: string): Promise<void> {
  const id = plan.household.id;
  const nowIso = now.toISOString();
  await store.putCheckin(id, { ...def, active: false, self: { ...def.self!, cancelledAt: nowIso } });
  const occs = (await store.listOccurrences(id, addDays(today, -1), addDays(today, 1))).filter((o) => o.checkinId === def.id);
  await Promise.all(
    occs.map((o) =>
      mutateOccurrence(
        store,
        id,
        o.id,
        (cur) => {
          if (OPEN.has(cur.state) && new Date(cur.windowEnd) > now) return { ...cur, state: 'CANCELLED', updatedAt: nowIso };
          if (PENDING_ALERT.has(cur.alertStatus)) return { ...cur, alertStatus: 'cancelled', updatedAt: nowIso };
          return null;
        },
        o,
      ),
    ),
  );
}

// ---- set_my_checkin ----

/**
 * Two steps. Without a confirmToken: validates the draft and returns a spoken preview plus a short-lived token;
 * nothing is stored. With the token and the person's own yes as `utterance`: creates the check-in.
 */
export async function setMyCheckin(store: Store, householdId: HouseholdId, input: SetMyCheckinInput, opts: { secret?: string } = {}): Promise<SetMyCheckinResult> {
  const secret = secretOr(opts.secret);
  // Safety first: crisis or distress wording while setting one up gets the same replies as anywhere else.
  const safety = applySafety('unsure', input.utterance);
  if (safety.branch === 'crisis') return { status: 'not_set', nextStep: 'call_emergency_services', say: safety.selfHarm ? SELF_HARM_REPLY : CRISIS_REPLY };

  const ctx = await loadPlan(store, householdId);
  if (safety.branch === 'distress') {
    const calmingLine = ctx.plan?.checkins.find((d) => !isOwnCheckin(d))?.calmingLine;
    const say = calmingLine ?? spoken.needsHelp;
    return { status: 'not_set', nextStep: 'none', calmingLine, say: safety.helpRequest ? `${say} ${CRISIS_REPLY}` : say };
  }
  if (!ctx.plan || (ctx.status !== 'active' && ctx.status !== 'paused')) return { status: 'not_set', nextStep: 'none', say: inactiveSay(ctx) };
  const { plan, now, today } = ctx;
  const tz = plan.household.timezone;
  const notSet = (say: string): SetMyCheckinResult => ({ status: 'not_set', nextStep: 'none', say });

  // ---- Step 2: confirm ----
  if (input.confirmToken) {
    const draft = verify(secret, input.confirmToken);
    if (!draft || draft.h !== householdId) return notSet(said.expired);
    if (draft.x <= now.getTime()) return notSet(said.expired);
    if (!input.utterance) throw new CheckinInputError("Read the preview to the person first, then send the person's own answer as utterance, with the confirmToken.");
    if (!isClearYes(input.utterance)) return notSet(said.notSet);

    const id = idFor(input.confirmToken);
    const existing = (await store.listCheckins(householdId)).find((d) => d.id === id);
    if (existing && !existing.active) return notSet(said.expired);
    const contact = ladderContacts(plan).find((c) => c.id === draft.c);
    if (!contact) return notSet(said.noContacts);
    const live = liveOwnCheckins(plan, now);
    const replaced = draft.rp ? live.find((d) => d.id === draft.rp) : undefined;
    if (!existing && live.filter((d) => d !== replaced).length >= MAX_OWN_CHECKINS) return notSet(said.limit);

    const deadline = new Date(draft.t);
    const start = addMinutes(deadline, -OWN_WINDOW_HOURS * 60);
    const firstDate = localDate(start, tz);
    const def: CheckinDefinition = existing ?? {
      id,
      author: 'person',
      self: { phrase: draft.p, by: draft.b, contactId: contact.id, repeat: draft.r, ...(draft.r === 'tonight' ? { date: firstDate } : {}) },
      label: labelFor(draft.p, draft.b),
      prompt: '', // never asked
      kind: 'wellbeing',
      windows: [{ start: localTime(start, tz), end: draft.b }],
      reaskMinutes: 60,
      maxReasks: 0,
      // If the person sounds upset while saying it, the family's own calming line is used.
      calmingLine: plan.checkins.find((d) => !isOwnCheckin(d))?.calmingLine ?? spoken.needsHelp,
      active: true,
      createdAt: now.toISOString(),
    };
    if (!existing) {
      if (replaced) {
        await retire(store, plan, replaced, now, today);
        await store.appendEvent({ householdId, at: now.toISOString(), type: 'self_checkin_cancelled', detail: `${plan.household.recipientName} replaced ${quoted(replaced.self!.phrase)} by ${spokenClock(replaced.self!.by)} with a new time, by voice.` });
      }
      await store.putCheckin(householdId, def);
      const when = draft.r === 'daily' ? 'every day' : whenWord(deadline, now, tz);
      await store.appendEvent({
        householdId,
        at: now.toISOString(),
        type: 'self_checkin_set',
        detail: `${plan.household.recipientName} set a check-in by voice: email ${contact.name} if there is no ${quoted(draft.p)} by ${spokenClock(draft.b)} ${when}.`,
      });
    }
    const occs = await materialize(store, { ...plan, checkins: [def] }, firstDate, now);
    const occ = occs.find((o) => o.id === occurrenceId(firstDate, def.id, 0));
    const tonight = draft.r === 'daily' ? '' : ` ${whenWord(deadline, now, tz)}`;
    const say =
      draft.r === 'daily'
        ? `Okay, it's set for every day. Say ${draft.p} before ${spokenClock(draft.b)}. If I don't hear it, I'll email ${contact.name}.`
        : `Okay, it's set. Say ${draft.p} any time before ${spokenClock(draft.b)}${tonight}. If I don't hear it, I'll email ${contact.name}.`;
    return { status: 'set', checkin: summary(plan, def, occ), nextStep: 'none', say };
  }

  // ---- Step 1: preview ----
  const phrase = cleanPhrase(input.phrase ?? '');
  const by = input.by ?? '';
  if (!phrase || !/^([01]\d|2[0-3]):[0-5]\d$/.test(by)) return notSet(said.howTo);
  if (lintField('label', phrase).length || lintField('label', labelFor(phrase, by)).length) return notSet(said.wording);
  const contacts = ladderContacts(plan);
  if (!contacts.length) return notSet(said.noContacts);
  const contact = resolveContact(plan, input.tell);
  if (!contact) return notSet(`I can only tell someone who already gets check-in emails: ${joinNames(contacts.map((c) => c.name)).replace(/ and /, ' or ')}.`);
  const repeat: SelfRepeat = input.repeat ?? 'tonight';
  const live = liveOwnCheckins(plan, now);
  const replaces = live.find((d) => compact(d.self!.phrase) === compact(phrase));
  if (!replaces && live.length >= MAX_OWN_CHECKINS) return notSet(said.limit);

  const deadline = nextDeadline(by, now, today, tz);
  const exp = addMinutes(now, CONFIRM_TOKEN_MINUTES);
  const token = sign(secret, { v: 1, h: householdId, p: phrase, b: by, c: contact.id, r: repeat, t: deadline.getTime(), ...(replaces ? { rp: replaces.id } : {}), x: exp.getTime() });

  const time = spokenClock(by);
  const parts = [
    replaces ? `This replaces your ${replaces.self!.phrase} by ${spokenClock(replaces.self!.by)}.` : '',
    repeat === 'daily'
      ? `Every day, if you haven't said ${phrase} by ${time}, I'll email ${contact.name}.`
      : `If you haven't said ${phrase} by ${time} ${whenWord(deadline, now, tz)}, I'll email ${contact.name}.`,
  ];
  const q = plan.ladder.quietHours;
  if (!plan.household.demoMode && q && inLocalRange(by, q.start, q.end)) parts.push(`Emails wait until quiet hours end at ${spokenClock(q.end)}.`);
  if (ctx.status === 'paused' && plan.household.pausedUntil) parts.push(`Check-ins are paused until ${spokenTime(new Date(plan.household.pausedUntil), tz)}, so nothing is sent before then.`);
  parts.push('Should I set that up?');
  return {
    status: 'confirm_needed',
    checkin: { checkinId: '', phrase, byLocal: by, tell: contact.name, repeat, occurrenceId: '', recorded: '' },
    confirmToken: token,
    expiresInSeconds: CONFIRM_TOKEN_MINUTES * 60,
    nextStep: 'none',
    say: parts.filter(Boolean).join(' '),
  };
}

// ---- cancel_my_checkin ----

/** Cancels one of the person's own check-ins: by id, by a phrase hint ("good night"), or the only one there is. */
export async function cancelMyCheckin(store: Store, householdId: HouseholdId, input: { checkinId?: string; phrase?: string }): Promise<CancelMyCheckinResult> {
  const ctx = await loadPlan(store, householdId);
  if (!ctx.plan || ['no_household', 'no_consent', 'revoked', 'expired'].includes(ctx.status)) return { status: 'not_cancelled', remaining: 0, say: spoken.inactive };
  const { plan, now, today } = ctx;
  const live = liveOwnCheckins(plan, now);
  if (!live.length) return { status: 'not_cancelled', remaining: 0, say: said.none };
  const hint = compact(input.phrase ?? '');
  const matches = input.checkinId
    ? live.filter((d) => d.id === input.checkinId)
    : hint
      ? live.filter((d) => {
          const p = compact(d.self!.phrase);
          return hint.includes(p) || p.includes(hint);
        })
      : live;
  const names = joinNames(live.map((d) => `${d.self!.phrase} by ${spokenClock(d.self!.by)}`));
  if (matches.length !== 1) {
    const say = matches.length ? `Which one? You have ${names}.` : `You don't have one like that. You have ${names}.`;
    return { status: 'not_cancelled', remaining: live.length, say };
  }
  const def = matches[0]!;
  const s = def.self!;
  const contact = plan.household.contacts.find((c) => c.id === s.contactId)?.name ?? 'your family';
  await retire(store, plan, def, now, today);
  await store.appendEvent({
    householdId,
    at: now.toISOString(),
    type: 'self_checkin_cancelled',
    detail: `${plan.household.recipientName} cancelled ${quoted(s.phrase)} by ${spokenClock(s.by)} by voice. ${contact} will not be emailed about it.`,
  });
  const after = { ...plan, checkins: plan.checkins.map((d) => (d.id === def.id ? { ...d, active: false } : d)) };
  return {
    status: 'cancelled',
    checkin: { ...summary(plan, def, undefined), recorded: 'cancelled by the person' },
    remaining: liveOwnCheckins(after, now).length,
    say: `Okay, I've cancelled your ${s.phrase} by ${spokenClock(s.by)}. ${contact} won't be emailed about it.`,
  };
}
