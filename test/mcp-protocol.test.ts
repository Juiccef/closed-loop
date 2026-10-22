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

  it('set_my_checkin is two calls: a preview with a token, then the token and the person’s yes', async () => {
    const { call, store } = await setup();
    setLocal('2026-10-19 20:00');
    const preview = await call('set_my_checkin', { phrase: 'good night', by: '22:00', tell: 'Dana', utterance: "If I haven't said good night by ten, let Dana know." });
    expect(preview.structuredContent).toMatchObject({ status: 'confirm_needed', expiresInSeconds: 300, nextStep: 'none' });
    expect(preview.content[0].text).toBe(preview.structuredContent.say);
    expect((await store.listCheckins(H)).some((d) => d.author === 'person')).toBe(false);

    // A model cannot create one in a single call, even by inventing a token.
    const forged = await call('set_my_checkin', { phrase: 'good night', by: '22:00', confirmToken: 'abc.def', utterance: 'Yes' });
    expect(forged.structuredContent.status).toBe('not_set');
    const noAnswer = await call('set_my_checkin', { confirmToken: preview.structuredContent.confirmToken });
    expect(noAnswer.isError).toBe(true);

    const set = await call('set_my_checkin', { confirmToken: preview.structuredContent.confirmToken, utterance: 'Yes, please.' });
    expect(set.structuredContent).toMatchObject({ status: 'set', checkin: { phrase: 'good night', byLocal: '22:00', tell: 'Dana', repeat: 'tonight' } });
    expect(set._meta.ui).toEqual({ resourceUri: 'ui://closed-loop/checkin-card', invoking: 'Setting up your check-in', invoked: 'Your check-in' });

    setLocal('2026-10-19 21:30');
    const status = await call('get_my_status');
    const [mine] = status.structuredContent.mine;
    expect(mine).toMatchObject({ phrase: 'good night', recorded: 'not said yet', occurrenceId: set.structuredContent.checkin.occurrenceId });
    const closed = await call('record_response', { occurrenceId: mine.occurrenceId, response: 'done', utterance: 'Good night' });
    expect(closed.structuredContent.recordedWording).toBe('reported by the person');

    const cancelled = await call('cancel_my_checkin', { phrase: 'good night' });
    expect(cancelled.structuredContent).toMatchObject({ status: 'cancelled', remaining: 0 });
    expect((await call('set_my_checkin', { phrase: 'good night', by: '25:00' })).isError).toBe(true);
    expect((await call('set_my_checkin', { phrase: 'take 10mg', by: '09:00' })).isError).toBe(true);
  });

  it('MCP App card: listed and readable as text/html;profile=mcp-app, referenced by tools and results', async () => {
    const { rpc, call } = await setup();
    const init = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.capabilities.resources).toBeDefined();
    const list = (await rpc('resources/list')).body.result.resources;
    expect(list).toEqual([expect.objectContaining({ uri: 'ui://closed-loop/checkin-card', mimeType: 'text/html;profile=mcp-app' })]);
    const read = (await rpc('resources/read', { uri: 'ui://closed-loop/checkin-card' })).body.result.contents[0];
    expect(read.mimeType).toBe('text/html;profile=mcp-app');
    expect(read.text).toContain('ui/initialize');
    expect(read.text).not.toMatch(/https?:\/\//); // no network under the default CSP
    const tools = (await rpc('tools/list')).body.result.tools;
    for (const t of tools) expect(t._meta?.ui?.resourceUri).toBe('ui://closed-loop/checkin-card');
    setLocal('2026-10-19 08:00');
    const due = await call('get_due_checkins');
    expect(due._meta.ui).toEqual({ resourceUri: 'ui://closed-loop/checkin-card', invoking: 'Checking today\u2019s check-ins', invoked: 'Check-ins ready' });
  });

  it('every tool answers with structuredContent, the same words as text, and _meta.ui', async () => {
    const { call } = await setup();
    setLocal('2026-10-19 08:00');
    const due = await call('get_due_checkins');
    const occurrenceId = due.structuredContent.checkins[0].occurrenceId;
    const results = {
      get_due_checkins: due,
      defer_checkin: await call('defer_checkin', { occurrenceId, until: 'in_1_hour' }),
      record_response: await call('record_response', { occurrenceId, response: 'done', utterance: 'Yes, done.' }),
      get_my_status: await call('get_my_status'),
      get_family_summary: await call('get_family_summary'),
      set_my_checkin: await call('set_my_checkin', { phrase: 'good night', by: '22:00', tell: 'Dana', utterance: "If I haven't said good night by ten, let Dana know." }),
      cancel_my_checkin: await call('cancel_my_checkin', { phrase: 'good night' }),
      pause_checkins: await call('pause_checkins', { scope: 'today' }),
    };
    expect(Object.keys(results)).toHaveLength(8);
    for (const [name, r] of Object.entries(results)) {
      expect(r.isError, name).toBeFalsy();
      expect(r.content, name).toEqual([{ type: 'text', text: r.structuredContent.say }]);
      expect(r._meta.ui.resourceUri, name).toBe('ui://closed-loop/checkin-card');
    }
  });

  it('tool annotations: only the two read-only tools say so, and no tool reaches outside the server', async () => {
    const { rpc } = await setup();
    const tools: Array<{ name: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }> = (await rpc('tools/list')).body.result.tools;
    expect(tools).toHaveLength(8);
    for (const t of tools) expect(t.annotations.openWorldHint, t.name).toBe(false);
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['get_my_status', 'get_family_summary']);
  });

  it('GET /mcp is 405 (no SSE stream); a POST with no Accept header still gets a JSON answer', async () => {
    const { handle } = await setup();
    const get = await handle(new Request('http://localhost/mcp', { method: 'GET', headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } }));
    expect(get.status).toBe(405);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'no-accept', version: '1' } } };
    const res = await handle(
      new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(init) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).result.protocolVersion).toBe('2025-03-26');
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
