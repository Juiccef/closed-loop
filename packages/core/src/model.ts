// Data model for the single DynamoDB table (BRIEF section 5). Pure types and key builders.

import type { CheckinResponse } from './safety';

export type HouseholdId = string;

export interface Contact {
  id: string;
  name: string;
  relation: string;
  email: string;
}

export interface Household {
  id: HouseholdId;
  /** First name only. Used in caregiver emails, never read aloud beyond the person's own name. */
  recipientName: string;
  timezone: string;
  contacts: Contact[];
  createdAt: string;
  /** Set by pause_checkins or the console. No prompts and no alerts before this instant. */
  pausedUntil?: string;
  pausedBy?: 'person' | 'caregiver';
  /** Demo mode turns quiet hours off. */
  demoMode: boolean;
  /** Last local date the tick fully processed; lets the tick catch up after a clock jump. */
  lastProcessedDate?: string;
}

export interface ConsentRecord {
  id: string;
  recipientName: string;
  recordedBy: string;
  recordedAt: string;
  planExpiresAt: string;
  revokedAt?: string;
}

export const CHECKIN_KINDS = ['routine', 'wellbeing', 'meal'] as const;
export type CheckinKind = (typeof CHECKIN_KINDS)[number];

export interface TimeWindow {
  /** Local time, HH:MM, 24-hour. */
  start: string;
  end: string;
}

export interface CheckinDefinition {
  id: string;
  /** Caregiver-authored, generic ("your morning routine"). Linted: no drug terms, doses, or URLs. */
  label: string;
  /** The question as spoken. Caregiver-authored and linted like the label. */
  prompt: string;
  kind: CheckinKind;
  windows: TimeWindow[];
  reaskMinutes: number;
  maxReasks: number;
  /** Said instead of a re-quiz when the person sounds confused or upset. */
  calmingLine: string;
  active: boolean;
  createdAt: string;
}

export interface LadderConfig {
  l1ContactIds: string[];
  l2ContactIds: string[];
  /** Consecutive days with the loop left open before L2 contacts are told. */
  l2AfterMissedDays: number;
  dailyAlertCap: number;
  /** Local HH:MM range; alerts wait until it ends. Ignored in demo mode. */
  quietHours: TimeWindow | null;
  planExpiryDays: number;
}

export const OCCURRENCE_STATES = [
  'SCHEDULED',
  'PROMPTED',
  'DEFERRED',
  'UNSURE',
  'DECLINED',
  'REPORTED_DONE',
  'NEEDS_HUMAN',
  'MISSED',
  'ESCALATED_L1',
  'ESCALATED_L2',
  'ACKNOWLEDGED',
  'PAUSED',
] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

/** Why the loop stayed open when the window closed. Drives honest email and ledger wording. */
export type OpenReason = 'not_reached' | 'no_answer' | 'said_later' | 'not_sure' | 'declined';

export type AlertStatus = 'none' | 'pending' | 'sent' | 'suppressed_cap' | 'waiting_quiet_hours' | 'failed';

export interface Occurrence {
  householdId: HouseholdId;
  /** OCC#<yyyy-mm-dd>#<checkinId>#<windowIdx> */
  id: string;
  date: string;
  checkinId: string;
  windowIdx: number;
  windowStart: string;
  windowEnd: string;
  state: OccurrenceState;
  /** First time the person was actually asked. Unset means they were never reached. */
  promptedAt?: string;
  lastPromptedAt?: string;
  reasks: number;
  deferUntil?: string;
  lastResponse?: CheckinResponse;
  lastResponseAt?: string;
  /** Set when the safety layer downgraded a claimed answer, with the rule that fired. */
  safetyNote?: string;
  /** Async second opinion (Bedrock or rules). Only ever moves toward caution. */
  reviewFlag?: 'needs_human' | 'agrees';
  openReason?: OpenReason;
  escalationLevel: 0 | 1 | 2;
  alertStatus: AlertStatus;
  alertedAt?: string;
  alertAttempts?: number;
  needsHumanNoteStatus?: AlertStatus;
  ackedAt?: string;
  ackedBy?: string;
  reportedLate?: boolean;
  version: number;
  updatedAt: string;
}

export interface Utterance {
  householdId: HouseholdId;
  occurrenceId: string;
  at: string;
  /** At most 200 characters. Expires after 30 days. */
  text: string;
  claimed: CheckinResponse;
  stored: CheckinResponse;
  reviewed?: boolean;
}

export const EVENT_TYPES = [
  'checkin_defined',
  'checkin_updated',
  'ladder_updated',
  'consent_recorded',
  'consent_revoked',
  'prompted',
  'reasked',
  'response_recorded',
  'response_downgraded',
  'deferred',
  'distress_branch',
  'crisis_branch',
  'missed',
  'alert_sent',
  'alert_suppressed',
  'alert_failed',
  'needs_human_note_sent',
  'acknowledged',
  'paused',
  'resumed',
  'review_flagged',
  'data_deleted',
  'plan_expired',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AuditEvent {
  householdId: HouseholdId;
  at: string;
  type: EventType;
  occurrenceId?: string;
  /** Plain-language detail, at most 200 characters. Never the person's free text. */
  detail: string;
}

// ---- Keys ----

export const keys = {
  household: (id: HouseholdId) => ({ PK: `H#${id}`, SK: 'META' }),
  consent: (id: HouseholdId, recordedAt: string) => ({ PK: `H#${id}`, SK: `CONSENT#${recordedAt}` }),
  checkin: (id: HouseholdId, checkinId: string) => ({ PK: `H#${id}`, SK: `CHK#${checkinId}` }),
  ladder: (id: HouseholdId) => ({ PK: `H#${id}`, SK: 'LADDER' }),
  occurrence: (id: HouseholdId, occurrenceId: string) => ({ PK: `H#${id}`, SK: occurrenceId }),
  utterance: (id: HouseholdId, occurrenceId: string, at: string) => ({ PK: `H#${id}`, SK: `UTT#${occurrenceId}#${at}` }),
  event: (id: HouseholdId, at: string, suffix: string) => ({ PK: `H#${id}`, SK: `EVT#${at}#${suffix}` }),
  alertCap: (id: HouseholdId, date: string) => ({ PK: `H#${id}`, SK: `CAP#${date}` }),
  registry: (id: HouseholdId) => ({ PK: 'REGISTRY', SK: `H#${id}` }),
  clock: () => ({ PK: 'CLOCK', SK: 'GLOBAL' }),
};

export function occurrenceId(date: string, checkinId: string, windowIdx: number): string {
  return `OCC#${date}#${checkinId}#${windowIdx}`;
}

export function parseOccurrenceId(id: string): { date: string; checkinId: string; windowIdx: number } | undefined {
  const m = id.match(/^OCC#(\d{4}-\d{2}-\d{2})#([A-Za-z0-9_-]+)#(\d+)$/);
  if (!m) return undefined;
  return { date: m[1]!, checkinId: m[2]!, windowIdx: Number(m[3]) };
}

export const DEFAULT_LADDER: LadderConfig = {
  l1ContactIds: [],
  l2ContactIds: [],
  l2AfterMissedDays: 2,
  dailyAlertCap: 3,
  quietHours: { start: '21:00', end: '07:00' },
  planExpiryDays: 14,
};
