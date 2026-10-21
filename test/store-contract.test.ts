import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  MemoryStore,
  occurrenceId,
  type Household,
  type Occurrence,
  type Store,
} from '../packages/core/src';
import { DynamoStore } from '../packages/store-dynamo/src';

// One contract, two implementations. DynamoDB runs only when DDB_TEST_TABLE names a real table.
const backends: Array<[string, () => Store]> = [['memory', () => new MemoryStore()]];
if (process.env.DDB_TEST_TABLE) backends.push(['dynamodb', () => new DynamoStore(process.env.DDB_TEST_TABLE!)]);

const uniq = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function household(id: string): Household {
  return {
    id,
    recipientName: 'Margaret',
    timezone: 'America/New_York',
    contacts: [{ id: 'c1', name: 'Dana', relation: 'daughter', email: 'dana@example.com' }],
    createdAt: '2026-10-19T12:00:00.000Z',
    demoMode: true,
  };
}

function occurrence(householdId: string, date: string, checkinId = 'morning'): Occurrence {
  return {
    householdId,
    id: occurrenceId(date, checkinId, 0),
    date,
    checkinId,
    windowIdx: 0,
    windowStart: `${date}T12:00:00.000Z`,
    windowEnd: `${date}T18:00:00.000Z`,
    state: 'SCHEDULED',
    reasks: 0,
    escalationLevel: 0,
    alertStatus: 'none',
    version: 1,
    updatedAt: `${date}T11:00:00.000Z`,
  };
}

for (const [name, make] of backends) {
  describe(`store contract: ${name}`, { timeout: 30_000 }, () => {
    it('stores and registers households', async () => {
      const store = make();
      const id = uniq();
      await store.putHousehold(household(id));
      expect((await store.getHousehold(id))?.recipientName).toBe('Margaret');
      expect(await store.listHouseholdIds()).toContain(id);
      await store.deleteHousehold(id);
    });

    it('creates an occurrence once and rejects a second create', async () => {
      const store = make();
      const id = uniq();
      const occ = occurrence(id, '2026-10-19');
      expect(await store.createOccurrence(occ)).toBe(true);
      expect(await store.createOccurrence({ ...occ, state: 'PROMPTED' })).toBe(false);
      expect((await store.getOccurrence(id, occ.id))?.state).toBe('SCHEDULED');
      await store.deleteHousehold(id);
    });

    it('conditional update: the stale writer loses (no double processing)', async () => {
      const store = make();
      const id = uniq();
      const occ = occurrence(id, '2026-10-19');
      await store.createOccurrence(occ);
      const a = { ...occ, state: 'MISSED' as const, version: 2 };
      const b = { ...occ, state: 'PROMPTED' as const, version: 2 };
      await store.updateOccurrence(a, 1);
      await expect(store.updateOccurrence(b, 1)).rejects.toBeInstanceOf(ConflictError);
      expect((await store.getOccurrence(id, occ.id))?.state).toBe('MISSED');
      await store.deleteHousehold(id);
    });

    it('lists occurrences by local date range', async () => {
      const store = make();
      const id = uniq();
      for (const d of ['2026-10-18', '2026-10-19', '2026-10-20']) await store.createOccurrence(occurrence(id, d));
      expect((await store.listOccurrences(id, '2026-10-19')).map((o) => o.date)).toEqual(['2026-10-19']);
      expect((await store.listOccurrences(id, '2026-10-18', '2026-10-19')).map((o) => o.date)).toEqual([
        '2026-10-18',
        '2026-10-19',
      ]);
      await store.deleteHousehold(id);
    });

    it('enforces the daily alert cap atomically', async () => {
      const store = make();
      const id = uniq();
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.tryConsumeAlert(id, '2026-10-19', 3)));
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(await store.getAlertCount(id, '2026-10-19')).toBe(3);
      expect(await store.tryConsumeAlert(id, '2026-10-20', 3)).toBe(true);
      await store.deleteHousehold(id);
    });

    it('clips utterances and event detail to 200 characters', async () => {
      const store = make();
      const id = uniq();
      const long = 'x'.repeat(500);
      await store.putUtterance({ householdId: id, occurrenceId: 'OCC#2026-10-19#m#0', at: '2026-10-19T12:00:00.000Z', text: long, claimed: 'done', stored: 'unsure' });
      await store.appendEvent({ householdId: id, at: '2026-10-19T12:00:00.000Z', type: 'prompted', detail: long });
      expect((await store.listUtterances(id))[0]?.text).toHaveLength(200);
      expect((await store.listEvents(id, 5))[0]?.detail).toHaveLength(200);
      await store.deleteHousehold(id);
    });

    it('returns events newest first', async () => {
      const store = make();
      const id = uniq();
      await store.appendEvent({ householdId: id, at: '2026-10-19T12:00:00.000Z', type: 'prompted', detail: 'first' });
      await store.appendEvent({ householdId: id, at: '2026-10-19T13:00:00.000Z', type: 'deferred', detail: 'second' });
      expect((await store.listEvents(id, 10)).map((e) => e.detail)).toEqual(['second', 'first']);
      await store.deleteHousehold(id);
    });

    it('returns consents newest first and the default ladder when none is stored', async () => {
      const store = make();
      const id = uniq();
      await store.putConsent(id, { id: 'a', recipientName: 'Margaret', recordedBy: 'Dana', recordedAt: '2026-10-01T00:00:00.000Z', planExpiresAt: '2026-10-15T00:00:00.000Z' });
      await store.putConsent(id, { id: 'b', recipientName: 'Margaret', recordedBy: 'Dana', recordedAt: '2026-10-19T00:00:00.000Z', planExpiresAt: '2026-11-02T00:00:00.000Z' });
      expect((await store.listConsents(id)).map((c) => c.id)).toEqual(['b', 'a']);
      expect((await store.getLadder(id)).dailyAlertCap).toBe(3);
      await store.deleteHousehold(id);
    });

    it('deletes every item for a household', async () => {
      const store = make();
      const id = uniq();
      await store.putHousehold(household(id));
      await store.createOccurrence(occurrence(id, '2026-10-19'));
      await store.appendEvent({ householdId: id, at: '2026-10-19T12:00:00.000Z', type: 'prompted', detail: 'x' });
      expect(await store.deleteHousehold(id)).toBeGreaterThanOrEqual(4);
      expect(await store.getHousehold(id)).toBeUndefined();
      expect(await store.listOccurrences(id, '2026-10-19')).toEqual([]);
      expect(await store.listHouseholdIds()).not.toContain(id);
    });
  });
}
