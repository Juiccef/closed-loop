import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryStore,
  VISITOR_HOURS,
  ackUrlBuilder,
  isVisitorHousehold,
  localDateTime,
  now,
  realNow,
  runTick,
  seedDemoHousehold,
  setRealTimeSource,
  verifyVisitorToken,
  visitorToken,
  type VisitorSeed,
} from '../packages/core/src';
import { createWebHandler } from '../packages/api/src';
import { FakeMailer, TZ, setLocal } from './helpers';

// Per-visitor demo households: two people using the hosted demo at once must never affect each other's
// clock, ledger, or email, and the shared 'demo' household must keep working exactly as before.

const ORIGIN = 'http://localhost:5173';
const ADMIN = 'admin-code';
const MCP = 'static-demo-token';
const ACK = 'ack-secret';

async function setup(opts: { visitorEmailsPerDay?: number } = {}) {
  setLocal('2026-10-19 10:00'); // real time
  const store = new MemoryStore();
  const mailer = new FakeMailer();
  const seed = async (visitor?: VisitorSeed) =>
    seedDemoHousehold(store, { now: visitor?.now ?? (await now(store)), l1Email: 'dana@example.com', l2Email: 'sam@example.com', demoMode: true, ...visitor });
  await seed(); // the shared 'demo' household
  const tickOpts = { mailer, ackUrl: ackUrlBuilder(ORIGIN, ACK), visitorEmailsPerDay: opts.visitorEmailsPerDay };
  const handle = createWebHandler(
    store,
    {
      bearerTokens: { [MCP]: 'demo' },
      householdBearer: (b) => verifyVisitorToken(MCP, b),
      allowedOrigins: [ORIGIN],
      allowSameOrigin: true,
      resourceUrl: '',
      includeWwwAuthenticate: false,
    },
    {
      store,
      adminToken: ADMIN,
      ackSecret: ACK,
      runTick: (_origin, ids) => runTick(store, tickOpts, ids),
      seed,
      householdToken: (id) => visitorToken(MCP, id),
      publicConfig: () => ({}),
      demoConfig: (origin) => ({ mcpUrl: `${origin}/mcp`, mcpToken: MCP, householdId: 'demo' }),
    },
  );
  const admin = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await handle(
      new Request(ORIGIN + path, {
        method,
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  let rpc = 0;
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await handle(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    return { status: res.status, result: ((await res.json()) as any).result };
  };
  const start = async (body: unknown = {}) => (await admin('/admin/demo-start', body)).body as { householdId: string; mcpToken: string; localNow: string; expiresAt: string };
  const clock = async (id?: string) => (await admin(`/admin/clock${id ? `?household=${id}` : ''}`)).body;
  const advance = async (id: string | undefined, seconds: number) => (await admin(`/admin/clock${id ? `?household=${id}` : ''}`, { advanceSeconds: seconds })).body;
  const ledger = async (id: string, days = 3) => (await admin(`/api/households/${id}/ledger?days=${days}`)).body as { today: string; items: any[]; events: any[] };
  return { store, mailer, handle, admin, tool, start, clock, advance, ledger };
}

afterEach(() => setRealTimeSource(() => Date.now()));

describe('per-visitor demo households', () => {
  it('two visitors who start at the same moment get separate households, tokens, and clocks', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.start(), t.start()]);
    expect(isVisitorHousehold(a.householdId) && isVisitorHousehold(b.householdId)).toBe(true);
    expect(a.householdId).not.toBe(b.householdId);
    expect(a.mcpToken).not.toBe(b.mcpToken);
    expect(verifyVisitorToken(MCP, a.mcpToken)).toBe(a.householdId);
    expect(a.localNow).toBe('2026-10-20 07:55');
    expect(b.localNow).toBe('2026-10-20 07:55');
    expect(new Date(a.expiresAt).getTime() - realNow()).toBe(VISITOR_HOURS * 3_600_000);

    await t.advance(a.householdId, 5 * 3600);
    expect((await t.clock(a.householdId)).localNow).toBe('2026-10-20 12:55');
    expect((await t.clock(b.householdId)).localNow).toBe('2026-10-20 07:55');
    // The shared 'demo' household stays on the deployment-wide clock, at real time.
    expect((await t.clock()).offsetSeconds).toBe(0);
    expect(localDateTime(await now(t.store, 'demo'), TZ)).toBe('2026-10-19 10:00');
    expect(localDateTime(await now(t.store, b.householdId), TZ)).toBe('2026-10-20 07:55');
  });

  it("MCP calls with a visitor's token act only on that visitor's ledger", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.start(), t.start()]);
    await t.advance(a.householdId, 10 * 60); // A: 08:05
    await t.advance(b.householdId, 10 * 60); // B: 08:05 too, so both mornings are open

    const due = (await t.tool(a.mcpToken, 'get_due_checkins')).result.structuredContent;
    expect(due.checkins.map((c: any) => c.label)).toEqual(['your morning routine']);
    const rec = (await t.tool(a.mcpToken, 'record_response', { occurrenceId: due.checkins[0].occurrenceId, response: 'done', utterance: 'Yes, done.' })).result.structuredContent;
    expect(rec.recordedWording).toBe('reported by the person');

    const morningA = (await t.ledger(a.householdId)).items.find((i) => i.checkinId === 'morning');
    const morningB = (await t.ledger(b.householdId)).items.find((i) => i.checkinId === 'morning');
    expect(morningA.ledger).toBe('reported by the person');
    expect(morningB.state).toBe('SCHEDULED');
    expect(morningB.askedAt).toBeNull();
    expect(await t.store.listUtterances(b.householdId)).toEqual([]);
    expect((await t.store.listOccurrences('demo', '2026-10-19', '2026-10-20')).every((o) => !o.promptedAt)).toBe(true);

    // B still gets its own first ask: A's answer did not close B's loop.
    const dueB = (await t.tool(b.mcpToken, 'get_due_checkins')).result.structuredContent;
    expect(dueB.checkins.map((c: any) => c.label)).toEqual(['your morning routine']);
  });

  it('a token is bound to one visitor household and cannot be forged for another', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.start(), t.start()]);
    const forged = `cldemo.${b.householdId}.${a.mcpToken.split('.')[2]}`;
    expect(verifyVisitorToken(MCP, forged)).toBeUndefined();
    expect((await t.tool(forged, 'get_my_status')).status).toBe(401);
    expect(verifyVisitorToken('another-deployment', a.mcpToken)).toBeUndefined();
    expect(() => visitorToken(MCP, 'demo')).toThrow();
  });

  it("each household's tick runs at its own time, and emails only that household's family", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.start(), t.start()]);
    const moved = await t.advance(a.householdId, 86_400); // A: the next morning; yesterday's three windows close
    expect(moved.tick.households).toBe(1);
    expect(moved.tick.closed).toBe(3);
    expect(moved.tick.alertsSent).toBe(3);
    expect(t.mailer.sent.map((m) => m.householdId)).toEqual([a.householdId, a.householdId, a.householdId]);

    // The minute schedule ticks everyone; B is still at 07:55 on day one, so nothing of B's closes.
    const bg = await runTick(t.store, { mailer: t.mailer, ackUrl: ackUrlBuilder(ORIGIN, ACK) });
    expect(bg.households).toBe(3); // demo, A, B
    expect(bg.closed).toBe(0);
    expect((await t.store.listOccurrences(b.householdId, '2026-10-20')).every((o) => o.state === 'SCHEDULED')).toBe(true);

    const mailA = (await t.admin(`/admin/emails?household=${a.householdId}`)).body;
    const mailB = (await t.admin(`/admin/emails?household=${b.householdId}`)).body;
    expect(mailA).toHaveLength(3);
    expect(mailA.every((m: any) => m.householdId === a.householdId)).toBe(true);
    expect(mailB).toEqual([]);
    expect((await t.admin('/admin/emails')).body).toEqual([]); // the shared household's panel too
  });

  it("the daily email cap holds for each household, on that household's own date", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.start(), t.start()]);
    // A minute passes (the schedule ticks both), then two days of A's windows close on A's 2026-10-22.
    await Promise.all([t.advance(a.householdId, 60), t.advance(b.householdId, 60)]);
    const movedA = await t.advance(a.householdId, 2 * 86_400);
    expect(movedA.tick.closed).toBe(6);
    expect(movedA.tick.alertsSent).toBe(3);
    expect(movedA.tick.alertsSuppressed).toBe(3);
    expect(await t.store.getAlertCount(a.householdId, '2026-10-22')).toBe(3);
    expect((await t.ledger(a.householdId)).events.filter((e) => /daily email limit reached/.test(e.detail))).toHaveLength(3);

    // B's cap is its own: A having used all of A's emails does not hold back B's.
    const movedB = await t.advance(b.householdId, 2 * 86_400);
    expect(movedB.tick.alertsSent).toBe(3);
    expect(await t.store.getAlertCount(b.householdId, '2026-10-22')).toBe(3);
    expect(await t.store.getAlertCount(a.householdId, '2026-10-22')).toBe(3);
  });

  it('visitor households share one deployment-wide daily email budget; the shared household does not use it', async () => {
    const t = await setup({ visitorEmailsPerDay: 4 });
    const [a, b] = await Promise.all([t.start(), t.start()]);
    expect((await t.advance(a.householdId, 86_400)).tick.alertsSent).toBe(3);
    const movedB = await t.advance(b.householdId, 86_400);
    expect(movedB.tick.alertsSent).toBe(1);
    expect(movedB.tick.alertsSuppressed).toBe(2);
    expect((await t.ledger(b.householdId)).events.filter((e) => /demo email limit for today reached/.test(e.detail))).toHaveLength(2);
    // B's own count only reflects what was sent.
    expect(await t.store.getAlertCount(b.householdId, '2026-10-21')).toBe(1);

    // Moving the deployment-wide clock moves the shared household only, and its emails are not budgeted.
    const shared = await t.advance(undefined, 86_400);
    expect(shared.tick.households).toBe(1);
    expect(shared.tick.alertsSent).toBe(3);
    expect((await t.clock(a.householdId)).localNow).toBe('2026-10-21 07:55');
  });

  it('a visitor household expires: gone for the console, the tick, and MCP, and nothing more is emailed', async () => {
    const t = await setup();
    const a = await t.start();
    const real = realNow();
    setRealTimeSource(() => real + (VISITOR_HOURS + 1) * 3_600_000);
    expect(await t.store.getHousehold(a.householdId)).toBeUndefined();
    expect((await t.admin(`/api/households/${a.householdId}`)).status).toBe(404);
    expect((await t.admin(`/admin/clock?household=${a.householdId}`)).status).toBe(404);
    const report = await runTick(t.store, { mailer: t.mailer, ackUrl: ackUrlBuilder(ORIGIN, ACK) });
    expect(report.households).toBe(1); // only the shared household is left
    expect(t.mailer.sent.filter((m) => m.householdId === a.householdId)).toEqual([]);
    expect(await t.store.listHouseholdIds()).toEqual(['demo']);
    expect((await t.tool(a.mcpToken, 'get_due_checkins')).result.structuredContent.checkins).toEqual([]);
  });

  it("a fresh demo day deletes the visitor's previous household, and never the shared one or anyone else's", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.start(), t.start()]);
    const c = await t.start({ previous: a.householdId });
    expect((await t.admin(`/api/households/${a.householdId}`)).status).toBe(404);
    expect((await t.admin(`/api/households/${b.householdId}`)).status).toBe(200);
    expect((await t.admin(`/api/households/${c.householdId}`)).status).toBe(200);
    await t.start({ previous: 'demo' });
    expect((await t.admin('/api/households/demo')).status).toBe(200);
  });

  it("the shared 'demo' household, its static token, and the deployment clock work as before", async () => {
    const t = await setup();
    const a = await t.start();
    await t.advance(undefined, 3600);
    expect((await t.clock()).offsetSeconds).toBe(3600);
    expect((await t.clock('demo')).localNow).toBe('2026-10-19 11:00');
    expect((await t.clock(a.householdId)).localNow).toBe('2026-10-20 07:55');
    const status = (await t.tool(MCP, 'get_my_status')).result.structuredContent;
    expect(status.date).toBe('2026-10-19');
    // demo-config without a household is the shared one; with one, that visitor's token.
    expect((await t.admin('/admin/demo-config')).body).toMatchObject({ householdId: 'demo', mcpToken: MCP });
    expect((await t.admin(`/admin/demo-config?household=${a.householdId}`)).body).toMatchObject({ householdId: a.householdId, mcpToken: a.mcpToken });
  });

  it("an acknowledge link uses its own household's clock", async () => {
    const t = await setup();
    const a = await t.start();
    await t.advance(a.householdId, 86_400);
    const lunch = (await t.ledger(a.householdId)).items.find((i) => i.checkinId === 'lunch' && i.canAcknowledge);
    const link = new URL(ackUrlBuilder(ORIGIN, ACK)(a.householdId, lunch.occurrenceId, 'dana'));
    const res = await t.handle(new Request(`${ORIGIN}/ack`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${link.searchParams.get('t')}` }));
    expect(await res.text()).toMatch(/Acknowledged/);
    const occ = await t.store.getOccurrence(a.householdId, lunch.occurrenceId);
    expect(occ?.state).toBe('ACKNOWLEDGED');
    expect(localDateTime(new Date(occ!.ackedAt!), TZ)).toBe('2026-10-21 07:55');
  });
});
