import type { ClockStore } from './clock';
import {
  DEFAULT_LADDER,
  type AuditEvent,
  type CheckinDefinition,
  type ConsentRecord,
  type Household,
  type HouseholdId,
  type LadderConfig,
  type Occurrence,
  type Utterance,
} from './model';

/** A conditional write lost the race: someone else changed the item first. */
export class ConflictError extends Error {
  constructor(what: string) {
    super(`conflict: ${what} changed concurrently`);
  }
}

export interface Store extends ClockStore {
  getHousehold(id: HouseholdId): Promise<Household | undefined>;
  /** Creates or replaces the household and registers it for the tick. */
  putHousehold(household: Household): Promise<void>;
  /** Sets only the given fields (undefined removes a field), so concurrent writers do not clobber each other. */
  updateHousehold(id: HouseholdId, patch: Partial<Omit<Household, 'id'>>): Promise<void>;
  listHouseholdIds(): Promise<HouseholdId[]>;

  /** Newest first. */
  listConsents(id: HouseholdId): Promise<ConsentRecord[]>;
  putConsent(id: HouseholdId, consent: ConsentRecord): Promise<void>;

  listCheckins(id: HouseholdId): Promise<CheckinDefinition[]>;
  putCheckin(id: HouseholdId, def: CheckinDefinition): Promise<void>;
  deleteCheckin(id: HouseholdId, checkinId: string): Promise<void>;

  /** Returns the default ladder when none is stored. */
  getLadder(id: HouseholdId): Promise<LadderConfig>;
  putLadder(id: HouseholdId, ladder: LadderConfig): Promise<void>;

  getOccurrence(id: HouseholdId, occurrenceId: string): Promise<Occurrence | undefined>;
  /** Occurrences whose local date is in [fromDate, toDate], oldest first. */
  listOccurrences(id: HouseholdId, fromDate: string, toDate?: string): Promise<Occurrence[]>;
  /** Writes only if absent. Returns false when it already existed. */
  createOccurrence(occ: Occurrence): Promise<boolean>;
  /** Writes `next` only if the stored version still equals `expectedVersion`; otherwise throws ConflictError. */
  updateOccurrence(next: Occurrence, expectedVersion: number): Promise<void>;

  putUtterance(u: Utterance): Promise<void>;
  listUtterances(id: HouseholdId, occurrenceId?: string): Promise<Utterance[]>;
  markUtteranceReviewed(id: HouseholdId, occurrenceId: string, at: string): Promise<void>;

  appendEvent(e: AuditEvent): Promise<void>;
  /** Newest first. */
  listEvents(id: HouseholdId, limit: number): Promise<AuditEvent[]>;

  /** Atomically counts one alert for the household's local date. False when the cap is already reached. */
  tryConsumeAlert(id: HouseholdId, date: string, cap: number): Promise<boolean>;
  getAlertCount(id: HouseholdId, date: string): Promise<number>;

  /** Removes every item for the household, including the registry entry. Returns the number of items removed. */
  deleteHousehold(id: HouseholdId): Promise<number>;
}

export const UTTERANCE_TTL_DAYS = 30;
export const EVENT_TTL_DAYS = 90;
export const MAX_TEXT = 200;

export function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

// ---- In-memory implementation (local run mode and tests) ----

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private households = new Map<HouseholdId, Household>();
  private consents = new Map<HouseholdId, ConsentRecord[]>();
  private checkins = new Map<HouseholdId, Map<string, CheckinDefinition>>();
  private ladders = new Map<HouseholdId, LadderConfig>();
  private occurrences = new Map<HouseholdId, Map<string, Occurrence>>();
  private utterances = new Map<HouseholdId, Utterance[]>();
  private events = new Map<HouseholdId, AuditEvent[]>();
  private caps = new Map<string, number>();
  private offsetSeconds = 0;

  async getClockOffsetSeconds() {
    return this.offsetSeconds;
  }
  async setClockOffsetSeconds(seconds: number) {
    this.offsetSeconds = seconds;
  }

  async getHousehold(id: HouseholdId) {
    const h = this.households.get(id);
    return h && clone(h);
  }
  async putHousehold(household: Household) {
    this.households.set(household.id, clone(household));
  }
  async updateHousehold(id: HouseholdId, patch: Partial<Omit<Household, 'id'>>) {
    const h = this.households.get(id);
    if (!h) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (h as unknown as Record<string, unknown>)[k];
      else (h as unknown as Record<string, unknown>)[k] = clone(v);
    }
  }
  async listHouseholdIds() {
    return [...this.households.keys()].sort();
  }

  async listConsents(id: HouseholdId) {
    return clone(this.consents.get(id) ?? []).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }
  async putConsent(id: HouseholdId, consent: ConsentRecord) {
    const list = (this.consents.get(id) ?? []).filter((c) => c.recordedAt !== consent.recordedAt);
    list.push(clone(consent));
    this.consents.set(id, list);
  }

  async listCheckins(id: HouseholdId) {
    return clone([...(this.checkins.get(id)?.values() ?? [])]).sort((a, b) => a.id.localeCompare(b.id));
  }
  async putCheckin(id: HouseholdId, def: CheckinDefinition) {
    const m = this.checkins.get(id) ?? new Map();
    m.set(def.id, clone(def));
    this.checkins.set(id, m);
  }
  async deleteCheckin(id: HouseholdId, checkinId: string) {
    this.checkins.get(id)?.delete(checkinId);
  }

  async getLadder(id: HouseholdId) {
    return clone(this.ladders.get(id) ?? DEFAULT_LADDER);
  }
  async putLadder(id: HouseholdId, ladder: LadderConfig) {
    this.ladders.set(id, clone(ladder));
  }

  async getOccurrence(id: HouseholdId, occurrenceId: string) {
    const o = this.occurrences.get(id)?.get(occurrenceId);
    return o && clone(o);
  }
  async listOccurrences(id: HouseholdId, fromDate: string, toDate = fromDate) {
    return clone([...(this.occurrences.get(id)?.values() ?? [])])
      .filter((o) => o.date >= fromDate && o.date <= toDate)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async createOccurrence(occ: Occurrence) {
    const m = this.occurrences.get(occ.householdId) ?? new Map();
    this.occurrences.set(occ.householdId, m);
    if (m.has(occ.id)) return false;
    m.set(occ.id, clone(occ));
    return true;
  }
  async updateOccurrence(next: Occurrence, expectedVersion: number) {
    const m = this.occurrences.get(next.householdId);
    const current = m?.get(next.id);
    if (!m || !current || current.version !== expectedVersion) throw new ConflictError(next.id);
    m.set(next.id, clone(next));
  }

  async putUtterance(u: Utterance) {
    const list = this.utterances.get(u.householdId) ?? [];
    list.push(clone({ ...u, text: clip(u.text) }));
    this.utterances.set(u.householdId, list);
  }
  async listUtterances(id: HouseholdId, occurrenceId?: string) {
    return clone((this.utterances.get(id) ?? []).filter((u) => !occurrenceId || u.occurrenceId === occurrenceId));
  }
  async markUtteranceReviewed(id: HouseholdId, occurrenceId: string, at: string) {
    const u = (this.utterances.get(id) ?? []).find((x) => x.occurrenceId === occurrenceId && x.at === at);
    if (u) u.reviewed = true;
  }

  async appendEvent(e: AuditEvent) {
    const list = this.events.get(e.householdId) ?? [];
    list.push(clone({ ...e, detail: clip(e.detail) }));
    this.events.set(e.householdId, list);
  }
  async listEvents(id: HouseholdId, limit: number) {
    return clone(this.events.get(id) ?? [])
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i)
      .slice(0, limit)
      .map((x) => x.e);
  }

  async tryConsumeAlert(id: HouseholdId, date: string, cap: number) {
    const key = `${id}|${date}`;
    const count = this.caps.get(key) ?? 0;
    if (count >= cap) return false;
    this.caps.set(key, count + 1);
    return true;
  }
  async getAlertCount(id: HouseholdId, date: string) {
    return this.caps.get(`${id}|${date}`) ?? 0;
  }

  async deleteHousehold(id: HouseholdId) {
    let n = 0;
    if (this.households.delete(id)) n += 2; // META + registry entry
    n += this.consents.get(id)?.length ?? 0;
    n += this.checkins.get(id)?.size ?? 0;
    if (this.ladders.delete(id)) n += 1;
    n += this.occurrences.get(id)?.size ?? 0;
    n += this.utterances.get(id)?.length ?? 0;
    n += this.events.get(id)?.length ?? 0;
    for (const k of [...this.caps.keys()]) if (k.startsWith(`${id}|`)) (this.caps.delete(k), n++);
    this.consents.delete(id);
    this.checkins.delete(id);
    this.occurrences.delete(id);
    this.utterances.delete(id);
    this.events.delete(id);
    return n;
  }
}
