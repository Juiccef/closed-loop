import { afterEach, describe, expect, it } from 'vitest';
import { setMyCheckin, setRealTimeSource } from '../packages/core/src';
import { createApiHandler } from '../packages/api/src/router';
import { H, demo, setLocal } from './helpers';

afterEach(() => setRealTimeSource(() => Date.now()));

async function setup() {
  const d = await demo();
  const handle = createApiHandler({
    store: d.store,
    adminToken: 'admin',
    ackSecret: 'test-secret',
    runTick: async () => d.tick(),
    seed: async () => {},
    publicConfig: () => ({}),
    demoConfig: () => ({}),
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await handle(
      new Request(`http://localhost${path}`, { method, headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    );
    return { status: res.status, body: await res.json() };
  };
  return { ...d, api };
}

describe('console: check-ins the person set up by voice', () => {
  it('shows them as "Set by Margaret", lets the family pause everything, and refuses edits and deletes', async () => {
    const { store, api } = await setup();
    setLocal('2026-10-19 20:00');
    const preview = await setMyCheckin(store, H, { phrase: 'good night', by: '22:00', tell: 'Dana' });
    const set = await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance: 'Yes' });
    const id = set.checkin!.checkinId;

    const view = (await api('GET', `/api/households/${H}`)).body;
    expect(view.ownCheckins).toEqual([
      expect.objectContaining({ id, phrase: 'good night', byLocal: '22:00', bySpoken: '10 pm', tell: 'Dana', repeat: 'tonight', setBy: 'Margaret' }),
    ]);
    const ledger = (await api('GET', `/api/households/${H}/ledger?days=1`)).body;
    const item = ledger.items.find((i: { checkinId: string }) => i.checkinId === id);
    expect(item).toMatchObject({ author: 'person', setBy: 'Margaret', tell: 'Dana', ledger: 'not said yet', window: '16:00–22:00' });
    expect(ledger.events.some((e: { type: string }) => e.type === 'self_checkin_set')).toBe(true);

    const put = await api('PUT', `/api/households/${H}/checkins/${id}`, { label: 'x', prompt: 'y', calmingLine: 'z', windows: [{ start: '09:00', end: '10:00' }] });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('Margaret set this check-in by voice. Only Margaret can change or cancel it. You can still pause all check-ins.');
    expect((await api('DELETE', `/api/households/${H}/checkins/${id}`)).status).toBe(403);
    expect((await store.listCheckins(H)).find((d) => d.id === id)?.active).toBe(true);

    expect((await api('POST', `/api/households/${H}/pause`, { hours: 24 })).status).toBe(200);
    // Family check-ins stay editable.
    const family = await api('PUT', `/api/households/${H}/checkins/lunch`, { label: 'your lunchtime check', prompt: 'Have you had some lunch today?', calmingLine: "You're safe at home.", windows: [{ start: '12:00', end: '15:00' }] });
    expect(family.status).toBe(200);
  });
});
