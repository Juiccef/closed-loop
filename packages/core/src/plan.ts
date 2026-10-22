import { addDays, clockAt, localDate, zonedInstant } from './clock';
import {
  occurrenceId,
  type CheckinDefinition,
  type ConsentRecord,
  type Household,
  type HouseholdId,
  type LadderConfig,
  type Occurrence,
} from './model';
import type { Store } from './store';
import { ownClockOffset } from './visitor';

export type PlanStatus = 'active' | 'no_household' | 'no_consent' | 'revoked' | 'expired' | 'paused';

export interface Plan {
  household: Household;
  consent?: ConsentRecord;
  checkins: CheckinDefinition[];
  ladder: LadderConfig;
}

export interface PlanContext {
  now: Date;
  today: string;
  plan?: Plan;
  status: PlanStatus;
}

/** Latest consent record decides: revoked or expired turns everything off immediately. */
export function planStatus(plan: Plan | undefined, now: Date): PlanStatus {
  if (!plan) return 'no_household';
  const c = plan.consent;
  if (!c) return 'no_consent';
  if (c.revokedAt) return 'revoked';
  if (new Date(c.planExpiresAt) <= now) return 'expired';
  if (isPaused(plan.household, now)) return 'paused';
  return 'active';
}

export function isPaused(h: Household, now: Date): boolean {
  return !!h.pausedUntil && new Date(h.pausedUntil) > now;
}

/**
 * Reads the clock and the whole plan in one parallel round trip. A visitor household's own clock offset
 * comes with the household record, so it costs no extra read.
 */
export async function loadPlan(store: Store, householdId: HouseholdId): Promise<PlanContext> {
  const [deploymentOffset, household, consents, checkins, ladder] = await Promise.all([
    store.getClockOffsetSeconds(),
    store.getHousehold(householdId),
    store.listConsents(householdId),
    store.listCheckins(householdId),
    store.getLadder(householdId),
  ]);
  const now = clockAt(ownClockOffset(household) ?? deploymentOffset);
  const plan: Plan | undefined = household
    ? { household, consent: consents[0], checkins: checkins.filter((c) => c.active), ladder }
    : undefined;
  const today = household ? localDate(now, household.timezone) : now.toISOString().slice(0, 10);
  return { now, today, plan, status: planStatus(plan, now) };
}

/** True for check-ins the person set up by voice. They are never asked; they close when the person says the phrase. */
export function isOwnCheckin(def: CheckinDefinition): boolean {
  return def.author === 'person' && !!def.self;
}

/** A `tonight` check-in covers one date only; everything else runs every day. */
export function runsOn(def: CheckinDefinition, date: string): boolean {
  return !def.self?.date || def.self.date === date;
}

export function windowInstants(date: string, start: string, end: string, tz: string): { start: Date; end: Date } {
  const s = zonedInstant(date, start, tz);
  // A window that ends at or before it starts runs past midnight.
  const e = end > start ? zonedInstant(date, end, tz) : zonedInstant(addDays(date, 1), end, tz);
  return { start: s, end: e };
}

export function newOccurrence(householdId: HouseholdId, def: CheckinDefinition, date: string, idx: number, tz: string, now: Date): Occurrence {
  const w = def.windows[idx]!;
  const { start, end } = windowInstants(date, w.start, w.end, tz);
  return {
    householdId,
    id: occurrenceId(date, def.id, idx),
    date,
    checkinId: def.id,
    windowIdx: idx,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    state: 'SCHEDULED',
    reasks: 0,
    escalationLevel: 0,
    alertStatus: 'none',
    version: 1,
    updatedAt: now.toISOString(),
  };
}

/**
 * Makes sure an occurrence exists for every active check-in window on `date`.
 * Check-ins created after a window ended are not back-filled for that window.
 * Returns the full list for the date, existing and new, oldest first.
 */
export async function materialize(store: Store, plan: Plan, date: string, now: Date, existing?: Occurrence[]): Promise<Occurrence[]> {
  const tz = plan.household.timezone;
  const have = existing ?? (await store.listOccurrences(plan.household.id, date));
  const byId = new Map(have.map((o) => [o.id, o]));
  const created: Occurrence[] = [];
  for (const def of plan.checkins) {
    if (!runsOn(def, date)) continue;
    def.windows.forEach((_, idx) => {
      const id = occurrenceId(date, def.id, idx);
      if (byId.has(id)) return;
      const occ = newOccurrence(plan.household.id, def, date, idx, tz, now);
      if (new Date(occ.windowEnd) <= new Date(def.createdAt)) return;
      created.push(occ);
    });
  }
  const results = await Promise.all(created.map((o) => store.createOccurrence(o)));
  if (results.some((r) => !r)) return store.listOccurrences(plan.household.id, date);
  return [...have, ...created].sort((a, b) => a.id.localeCompare(b.id));
}
