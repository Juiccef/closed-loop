import { afterEach, describe, expect, it } from 'vitest';
import { setRealTimeSource } from '../packages/core/src';
import { coreBackend, createMcpHttpHandler } from '../packages/mcp-server/src';
import { H, demo, setLocal } from './helpers';

const TOKEN = 'test-token';
const ORIGIN = 'http://localhost:5173';

async function setup() {
  const d = await demo();
  const handle = createMcpHttpHandler(
    { bearerTokens: { [TOKEN]: H }, allowedOrigins: [ORIGIN], resourceUrl: '', includeWwwAuthenticate: false },
    coreBackend(d.store),
  );
  let id = 0;
  const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': '2025-11-25',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      }),
    );
    return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc('tools/call', { name, arguments: args })).body.result;
  return { ...d, handle, rpc, call };
}

afterEach(() => setRealTimeSource(() => Date.now()));

describe('MCP protocol (in-process, real backend)', () => {
  for (const version of ['2025-03-26', '2025-11-25']) {
    it(`initialize ${version}: negotiates it, stateless, tools capability`, async () => {
      const { rpc } = await setup();
      const r = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }, { 'mcp-protocol-version': version });
      expect(r.status).toBe(200);
      expect(r.body.result.protocolVersion).toBe(version);
      expect(r.body.result.capabilities.tools).toBeDefined();
      expect(r.headers.get('mcp-session-id')).toBeNull();
    });
  }

  it('tools/list is stable (snapshot)', async () => {
    const { rpc } = await setup();
    const r = await rpc('tools/list');
    expect(r.body.result.tools).toMatchSnapshot();
  });

  it('tool names, titles, and descriptions stay free of medical, emergency, and tracking language', async () => {
    const { rpc } = await setup();
    const tools: Array<{ name: string; title?: string; description?: string }> = (await rpc('tools/list')).body.result.tools;
    const text = tools.map((t) => `${t.name} ${t.title ?? ''} ${t.description ?? ''}`).join(' ').toLowerCase();
    for (const banned of ['medication', 'medicine', 'pill', 'dose', 'emergency', 'confirmed', 'taken', 'track', 'monitor', 'spy']) {
      expect(text).not.toContain(banned);
    }
  });

  it('demo beat over JSON-RPC: ask, hedge, defer, follow up, report', async () => {
    const { call } = await setup();
    setLocal('2026-10-19 08:00');
    const due = await call('get_due_checkins');
    const occ = due.structuredContent.checkins[0].occurrenceId;
    expect(due.content[0].text).toBe(due.structuredContent.say);

    const hedged = await call('record_response', { occurrenceId: occ, response: 'done', utterance: 'I think so, maybe after lunch' });
    expect(hedged.structuredContent.recordedWording).toBe('said they would, not sure');

    const deferred = await call('defer_checkin', { occurrenceId: occ, until: 'after_lunch' });
    expect(deferred.structuredContent.deferredUntilLocal).toBe('13:00');

    setLocal('2026-10-19 13:00');
    const follow = await call('get_due_checkins');
    expect(follow.structuredContent.checkins.find((c: { occurrenceId: string }) => c.occurrenceId === occ)?.isFollowUp).toBe(true);

    const done = await call('record_response', { occurrenceId: occ, response: 'done', utterance: 'Yes, done.' });
    expect(done.structuredContent.recordedWording).toBe('reported by the person');
  });

  it('unknown occurrence is a tool error (isError), not a protocol error', async () => {
    const { call } = await setup();
    setLocal('2026-10-19 08:00');
    const r = await call('record_response', { occurrenceId: 'OCC#2026-10-19#nope#0', response: 'done' });
    expect(r.isError).toBe(true);
  });

  it('rejects enum violations and oversize input', async () => {
    const { call } = await setup();
    setLocal('2026-10-19 08:00');
    expect((await call('record_response', { occurrenceId: 'OCC#2026-10-19#morning#0', response: 'confirmed' })).isError).toBe(true);
    expect((await call('defer_checkin', { occurrenceId: 'OCC#2026-10-19#morning#0', until: 'next_week' })).isError).toBe(true);
    expect((await call('record_response', { occurrenceId: 'OCC#2026-10-19#morning#0', response: 'done', utterance: 'x'.repeat(201) })).isError).toBe(true);
  });

  it('auth and origin: 401 without WWW-Authenticate, 403 for foreign origins', async () => {
    const { handle } = await setup();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const noAuth = await handle(new Request('http://localhost/mcp', { method: 'POST', headers: base, body }));
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBeNull();
    const evil = await handle(new Request('http://localhost/mcp', { method: 'POST', headers: { ...base, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }, body }));
    expect(evil.status).toBe(403);
    const ok = await handle(new Request('http://localhost/mcp', { method: 'POST', headers: { ...base, authorization: `Bearer ${TOKEN}`, origin: ORIGIN }, body }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
