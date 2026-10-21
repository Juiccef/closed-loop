import { addMinutes, localDate, zonedInstant } from './clock';
import type { CheckinDefinition, Household, LadderConfig } from './model';
import type { Store } from './store';

export const DEMO_HOUSEHOLD_ID = 'demo';

export interface SeedOptions {
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

/** Creates (or resets) the demo household: plan, ladder, and Dana's consent record for Margaret. */
export async function seedDemoHousehold(store: Store, opts: SeedOptions): Promise<void> {
  await store.deleteHousehold(DEMO_HOUSEHOLD_ID);
  const timezone = opts.timezone ?? 'America/New_York';
  // Created at local midnight so all of today's windows count, whatever time the demo starts.
  const createdAt = zonedInstant(localDate(opts.now, timezone), '00:00', timezone).toISOString();
  const household: Household = {
    id: DEMO_HOUSEHOLD_ID,
    recipientName: 'Margaret',
    timezone,
    contacts: [
      { id: 'dana', name: 'Dana', relation: 'daughter', email: opts.l1Email },
      { id: 'sam', name: 'Sam', relation: 'son', email: opts.l2Email },
    ],
    createdAt,
    demoMode: opts.demoMode ?? true,
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
  await store.putLadder(DEMO_HOUSEHOLD_ID, ladder);
  for (const def of demoCheckins(createdAt)) await store.putCheckin(DEMO_HOUSEHOLD_ID, def);
  await store.putConsent(DEMO_HOUSEHOLD_ID, {
    id: 'consent-1',
    recipientName: 'Margaret',
    recordedBy: 'Dana (daughter)',
    recordedAt: createdAt,
    planExpiresAt: addMinutes(opts.now, ladder.planExpiryDays * 24 * 60).toISOString(),
  });
  await store.appendEvent({
    householdId: DEMO_HOUSEHOLD_ID,
    at: createdAt,
    type: 'consent_recorded',
    detail: "Dana recorded Margaret's consent to daily check-ins for 14 days.",
  });
}
