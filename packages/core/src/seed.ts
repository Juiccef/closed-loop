import { addMinutes, localDate, zonedInstant } from './clock';
import type { CheckinDefinition, Household, HouseholdId, LadderConfig } from './model';
import type { Store } from './store';

export const DEMO_HOUSEHOLD_ID = 'demo';
export const DEMO_TIMEZONE = 'America/New_York';

/** What makes a per-visitor copy of the demo household (see visitor.ts). */
export interface VisitorSeed {
  householdId: HouseholdId;
  /** The visitor's simulated time at the start; `clockOffsetSeconds` is that minus real time. */
  now: Date;
  clockOffsetSeconds: number;
  /** Real time. */
  expiresAt: string;
}

export interface SeedOptions extends Partial<Omit<VisitorSeed, 'now'>> {
  now: Date;
  /** Daughter, first contact (L1). In the SES sandbox this must be a verified address. */
  l1Email: string;
  /** Son, second contact (L2). */
  l2Email: string;
  timezone?: string;
  demoMode?: boolean;
}

export function demoCheckins(createdAt: string): CheckinDefinition[] {
  const calmingLine = "You're safe at home, Margaret. Dana will give you a call this evening.";
  return [
    {
      id: 'morning',
      label: 'your morning routine',
      prompt: 'Good morning, Margaret. Have you done your morning routine yet?',
      kind: 'routine',
      windows: [{ start: '08:00', end: '14:00' }],
      reaskMinutes: 60,
      maxReasks: 2,
      calmingLine,
      active: true,
      createdAt,
    },
    {
      id: 'lunch',
      label: 'your lunchtime check',
      prompt: 'Have you had some lunch today?',
      kind: 'meal',
      windows: [{ start: '12:00', end: '15:00' }],
      reaskMinutes: 45,
      maxReasks: 2,
      calmingLine,
      active: true,
      createdAt,
    },
    {
      id: 'evening',
      label: 'your evening check-in',
      prompt: 'How are you doing this evening? All okay?',
      kind: 'wellbeing',
      windows: [{ start: '18:00', end: '21:00' }],
      reaskMinutes: 60,
      maxReasks: 1,
      calmingLine,
      active: true,
      createdAt,
    },
  ];
}

/**
 * Creates (or resets) the demo household: plan, ladder, and Dana's consent record for Margaret.
 * The shared 'demo' household by default; with `householdId`, a visitor's own copy on its own clock.
 */
export async function seedDemoHousehold(store: Store, opts: SeedOptions): Promise<void> {
  const id = opts.householdId ?? DEMO_HOUSEHOLD_ID;
  await store.deleteHousehold(id);
  const timezone = opts.timezone ?? DEMO_TIMEZONE;
  // Created at local midnight so all of today's windows count, whatever time the demo starts.
  const createdAt = zonedInstant(localDate(opts.now, timezone), '00:00', timezone).toISOString();
  const household: Household = {
    id,
    recipientName: 'Margaret',
    timezone,
    contacts: [
      { id: 'dana', name: 'Dana', relation: 'daughter', email: opts.l1Email },
      { id: 'sam', name: 'Sam', relation: 'son', email: opts.l2Email },
    ],
    createdAt,
    demoMode: opts.demoMode ?? true,
    ...(opts.clockOffsetSeconds !== undefined ? { clockOffsetSeconds: opts.clockOffsetSeconds } : {}),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  };
  const ladder: LadderConfig = {
    l1ContactIds: ['dana'],
    l2ContactIds: ['sam'],
    l2AfterMissedDays: 2,
    dailyAlertCap: 3,
    quietHours: { start: '21:00', end: '07:00' },
    planExpiryDays: 14,
  };
  await store.putHousehold(household);
  await store.putLadder(id, ladder);
  for (const def of demoCheckins(createdAt)) await store.putCheckin(id, def);
  await store.putConsent(id, {
    id: 'consent-1',
    recipientName: 'Margaret',
    recordedBy: 'Dana (daughter)',
    recordedAt: createdAt,
    planExpiresAt: addMinutes(opts.now, ladder.planExpiryDays * 24 * 60).toISOString(),
  });
  await store.appendEvent({
    householdId: id,
    at: createdAt,
    type: 'consent_recorded',
    detail: "Dana recorded Margaret's consent to daily check-ins for 14 days.",
  });
}
