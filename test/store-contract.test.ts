import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  MemoryStore,
  VISITOR_HOURS,
  newVisitorHouseholdId,
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

    it("keeps a visitor household's own clock, apart from the deployment-wide clock", async () => {
      const store = make();
      const id = newVisitorHouseholdId();
      const other = uniq();
      const deployment = await store.getClockOffsetSeconds();
      await store.putHousehold({ ...household(id), clockOffsetSeconds: 3600, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      await store.putHousehold(household(other));
      expect(await store.getClockOffsetSeconds(id)).toBe(3600);
      await store.setClockOffsetSeconds(7200, id);
      expect(await store.getClockOffsetSeconds(id)).toBe(7200);
      expect(await store.getClockOffsetSeconds()).toBe(deployment);
      // Any other household follows the deployment-wide clock.
      expect(await store.getClockOffsetSeconds(other)).toBe(deployment);
      await store.deleteHousehold(id);
      await store.deleteHousehold(other);
    });

    it('treats a visitor household past its expiry as gone', async () => {
      const store = make();
      const id = newVisitorHouseholdId();
      await store.putHousehold({ ...household(id), expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(await store.getHousehold(id)).toBeUndefined();
      expect(await store.listHouseholdIds()).not.toContain(id);
      await store.deleteHousehold(id);
    });
  });
}

if (process.env.DDB_TEST_TABLE) {
  describe('store contract: dynamodb TTL for visitor households', { timeout: 30_000 }, () => {
    it('puts a TTL on every item of a visitor household, and none on another household', async () => {
      const table = process.env.DDB_TEST_TABLE!;
      const store = new DynamoStore(table);
      const raw = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      const id = newVisitorHouseholdId();
      const other = uniq();
      const expiresAt = new Date(Date.now() + VISITOR_HOURS * 3_600_000).toISOString();
      for (const h of [id, other]) {
        await store.putHousehold({ ...household(h), ...(h === id ? { expiresAt, clockOffsetSeconds: 60 } : {}) });
        await store.putLadder(h, { l1ContactIds: ['c1'], l2ContactIds: [], l2AfterMissedDays: 2, dailyAlertCap: 3, quietHours: null, planExpiryDays: 14 });
        await store.createOccurrence(occurrence(h, '2026-10-19'));
        await store.updateOccurrence({ ...occurrence(h, '2026-10-19'), state: 'PROMPTED', version: 2 }, 1);
        await store.appendEvent({ householdId: h, at: '2026-10-19T12:00:00.000Z', type: 'prompted', detail: 'x' });
        await store.tryConsumeAlert(h, '2026-10-19', 3);
      }
      const items = async (h: string) =>
        (await raw.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `H#${h}` } }))).Items ?? [];
      const latest = Math.floor(Date.now() / 1000) + VISITOR_HOURS * 3600 + 5;
      const visitorItems = await items(id);
      expect(visitorItems.length).toBeGreaterThanOrEqual(5);
      for (const item of visitorItems) expect(typeof item.ttl === 'number' && item.ttl <= latest, `${item.SK} ttl ${item.ttl}`).toBe(true);
      expect(visitorItems.find((i) => i.SK === 'META')?.ttl).toBe(Math.floor(Date.parse(expiresAt) / 1000));
      const otherItems = await items(other);
      expect(otherItems.filter((i) => ['META', 'LADDER'].includes(String(i.SK)) || String(i.SK).startsWith('OCC#')).every((i) => i.ttl === undefined)).toBe(true);
      await store.deleteHousehold(id);
      await store.deleteHousehold(other);
    });
  });
}
