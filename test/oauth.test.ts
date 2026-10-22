import { afterEach, describe, expect, it } from 'vitest';
import { generateLinkCode, hashSecret, setRealTimeSource } from '../packages/core/src';
import { coreBackend, createMcpHttpHandler, createOAuth, pkceChallenge, signJwt } from '../packages/mcp-server/src';
import { H, demo, setLocal } from './helpers';

const ORIGIN = 'http://localhost';
const RESOURCE = `${ORIGIN}/mcp`;
const ALEXA_REDIRECT = 'https://alexa.example/api/skill/link/TEST';
const SECRET = 'alexa-client-secret';
const SIGNING = 'test-signing-secret-0123456789abcdef';

async function setup() {
  const d = await demo();
  const oauth = createOAuth(
    {
      signingSecret: SIGNING,
      clients: [
        { id: 'alexa-plus', secret: SECRET, redirectUris: [ALEXA_REDIRECT], allowClientCredentials: true },
        { id: 'simulator', redirectUris: [], sameOriginRedirectPath: '/simulator/linked.html' },
      ],
    },
    d.store,
  );
  const handle = createMcpHttpHandler(
    { bearerTokens: { 'static-demo': H }, allowedOrigins: [], allowSameOrigin: true, resourceUrl: '', includeWwwAuthenticate: false, oauth },
    coreBackend(d.store),
  );
  const linkCode = async (role: 'person' | 'family' = 'person') => {
    const code = generateLinkCode();
    await d.store.putLinkCode(hashSecret(code), H, new Date(Date.now() + 600_000).toISOString(), role);
    return code;
  };
  const authorizeUrl = (over: Record<string, string> = {}) => {
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: 'alexa-plus',
      redirect_uri: ALEXA_REDIRECT,
      state: 'st4te',
      code_challenge: pkceChallenge('verifier-0123456789-0123456789-0123456789-abc'),
      code_challenge_method: 'S256',
      scope: 'mcp:tools',
      resource: RESOURCE,
      ...over,
    });
    return `${ORIGIN}/oauth/authorize?${p}`;
  };
  const approve = async (code: string, over: Record<string, string> = {}, decision = 'allow') => {
    const params = new URL(authorizeUrl(over)).searchParams;
    params.set('link_code', code);
    params.set('decision', decision);
    return handle(new Request(`${ORIGIN}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() }));
  };
  const basic = `Basic ${Buffer.from(`alexa-plus:${SECRET}`).toString('base64')}`;
  const token = (form: Record<string, string>, auth: string | null = basic) =>
    handle(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(auth ? { authorization: auth } : {}) },
        body: new URLSearchParams(form).toString(),
      }),
    );
  const mcp = (bearer: string, method: string, params?: unknown) =>
    handle(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
  const codeFrom = (res: Response) => new URL(res.headers.get('location')!).searchParams;
  return { ...d, handle, oauth, linkCode, authorizeUrl, approve, token, mcp, codeFrom };
}

const VERIFIER = 'verifier-0123456789-0123456789-0123456789-abc';
afterEach(() => setRealTimeSource(() => Date.now()));

describe('OAuth 2.1 account linking (authorization code + PKCE)', () => {
  it('links a household and the access token works on /mcp', async () => {
    const t = await setup();
    const page = await t.handle(new Request(t.authorizeUrl()));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Link code from the caregiver console');

    const res = await t.approve(await t.linkCode());
    expect(res.status).toBe(302);
    const q = t.codeFrom(res);
    expect(q.get('state')).toBe('st4te');
    expect(q.get('iss')).toBe(ORIGIN);

    const tok = await t.token({ grant_type: 'authorization_code', code: q.get('code')!, code_verifier: VERIFIER, client_id: 'alexa-plus', resource: RESOURCE });
    expect(tok.status).toBe(200);
    expect(tok.headers.get('cache-control')).toBe('no-store');
    const body = await tok.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:tools' });
    expect(body.refresh_token).toMatch(/^clrt\.demo\./);

    setLocal('2026-10-19 08:05');
    const call = await t.mcp(body.access_token, 'tools/call', { name: 'get_due_checkins', arguments: {} });
    expect(call.status).toBe(200);
    expect((await call.json()).result.structuredContent.checkins[0].label).toBe('your morning routine');
  });

  it("a family member's link can read the day but never answer for the person", async () => {
    const t = await setup();
    const linkAs = async (role: 'person' | 'family') => {
      const code = t.codeFrom(await t.approve(await t.linkCode(role))).get('code')!;
      return (await (await t.token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'alexa-plus', resource: RESOURCE })).json()) as {
        access_token: string;
        refresh_token: string;
      };
    };
    setLocal('2026-10-19 08:05');
    const person = await linkAs('person');
    const due = (await (await t.mcp(person.access_token, 'tools/call', { name: 'get_due_checkins', arguments: {} })).json()).result.structuredContent;
    const occurrenceId = due.checkins[0].occurrenceId;

    const family = await linkAs('family');
    for (const [name, args] of [
      ['get_due_checkins', {}],
      ['record_response', { occurrenceId, response: 'done' }],
      ['defer_checkin', { occurrenceId, until: 'in_1_hour' }],
      ['pause_checkins', { scope: 'today' }],
      ['set_my_checkin', { phrase: 'good night', by: '22:00' }],
      ['cancel_my_checkin', {}],
    ] as const) {
      const r = (await (await t.mcp(family.access_token, 'tools/call', { name, arguments: args })).json()).result;
      expect(r.isError, name).toBe(true);
      expect(r.content[0].text).toContain('Only the person can answer');
    }
    const summary = (await (await t.mcp(family.access_token, 'tools/call', { name: 'get_family_summary', arguments: {} })).json()).result;
    expect(summary.isError).toBeFalsy();
    expect(summary.structuredContent.items[0].recorded).toBe('asked, no answer yet');

    // The role survives a refresh-token rotation.
    const refreshed = await (await t.token({ grant_type: 'refresh_token', refresh_token: family.refresh_token, client_id: 'alexa-plus' })).json();
    const again = (await (await t.mcp(refreshed.access_token, 'tools/call', { name: 'record_response', arguments: { occurrenceId, response: 'done' } })).json()).result;
    expect(again.isError).toBe(true);

    // The person's own link still answers.
    const ok = (await (await t.mcp(person.access_token, 'tools/call', { name: 'record_response', arguments: { occurrenceId, response: 'done' } })).json()).result;
    expect(ok.structuredContent.recordedWording).toBe('reported by the person');
  });

  it('a code works once, and only with the right PKCE verifier', async () => {
    const t = await setup();
    const code = t.codeFrom(await t.approve(await t.linkCode())).get('code')!;
    const bad = await t.token({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_grant');
    const reused = await t.token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER });
    expect((await reused.json()).error).toBe('invalid_grant'); // consumed by the failed attempt
  });

  it('link codes are single-use; a wrong code re-shows the page with an error', async () => {
    const t = await setup();
    const code = await t.linkCode();
    expect((await t.approve(code)).status).toBe(302);
    const again = await t.approve(code);
    expect(again.status).toBe(400);
    expect(again.headers.get('location')).toBeNull();
    expect(await again.text()).toContain('That code did not work');
    expect((await t.approve('ZZZZ-ZZZZ')).status).toBe(400);
  });

  it('accepts link codes typed loosely (lower case, no dash, O for 0)', async () => {
    const t = await setup();
    const code = await t.linkCode();
    const loose = code.toLowerCase().replace('-', ' ').replace(/0/g, 'o');
    expect((await t.approve(loose)).status).toBe(302);
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const t = await setup();
    const res = await t.handle(new Request(t.authorizeUrl({ redirect_uri: 'https://evil.example/cb' })));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('requires S256 PKCE, the right resource, and user scopes', async () => {
    const t = await setup();
    const noPkce = await t.handle(new Request(t.authorizeUrl({ code_challenge_method: 'plain' })));
    expect(t.codeFrom(noPkce).get('error')).toBe('invalid_request');
    const wrongResource = await t.handle(new Request(t.authorizeUrl({ resource: 'https://other.example/mcp' })));
    expect(t.codeFrom(wrongResource).get('error')).toBe('invalid_target');
    const serviceScope = await t.handle(new Request(t.authorizeUrl({ scope: 'mcp:service' })));
    expect(t.codeFrom(serviceScope).get('error')).toBe('invalid_scope');
  });

  it('cancelling returns access_denied with the state', async () => {
    const t = await setup();
    const q = t.codeFrom(await t.approve(await t.linkCode(), {}, 'deny'));
    expect(q.get('error')).toBe('access_denied');
    expect(q.get('state')).toBe('st4te');
  });

  it('refresh tokens rotate: the new one works, the old one does not', async () => {
    const t = await setup();
    const code = t.codeFrom(await t.approve(await t.linkCode())).get('code')!;
    const first = await (await t.token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER })).json();
    const second = await t.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    const next = await second.json();
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect((await (await t.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).json()).error).toBe('invalid_grant');
    expect((await t.token({ grant_type: 'refresh_token', refresh_token: next.refresh_token })).status).toBe(200);
  });

  it('revoking a refresh token (RFC 7009) stops it working', async () => {
    const t = await setup();
    const code = t.codeFrom(await t.approve(await t.linkCode())).get('code')!;
    const tokens = await (await t.token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER })).json();
    const r = await t.handle(
      new Request(`${ORIGIN}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`alexa-plus:${SECRET}`).toString('base64')}` },
        body: new URLSearchParams({ token: tokens.refresh_token }).toString(),
      }),
    );
    expect(r.status).toBe(200);
    expect((await (await t.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).json()).error).toBe('invalid_grant');
  });

  it('the public simulator client links with PKCE alone, back to its same-origin page', async () => {
    const t = await setup();
    const res = await t.approve(await t.linkCode(), { client_id: 'simulator', redirect_uri: `${ORIGIN}/simulator/linked.html` });
    expect(res.status).toBe(302);
    const code = t.codeFrom(res).get('code')!;
    const tok = await t.token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'simulator' }, null);
    expect(tok.status).toBe(200);
    const withSecret = await t.token({ grant_type: 'refresh_token', refresh_token: (await tok.json()).refresh_token, client_id: 'simulator', client_secret: 'x' }, null);
    expect((await withSecret.json()).error).toBe('invalid_client');
  });
});

describe('OAuth 2.1 client credentials (service level)', () => {
  it('issues an mcp:service token without a refresh token; it can list tools but not call them', async () => {
    const t = await setup();
    const res = await t.token({ grant_type: 'client_credentials', scope: 'mcp:service', resource: RESOURCE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:service' });
    expect(body.refresh_token).toBeUndefined();
    expect((await t.mcp(body.access_token, 'tools/list')).status).toBe(200);
    const call = await t.mcp(body.access_token, 'tools/call', { name: 'get_my_status', arguments: {} });
    expect(call.status).toBe(401);
    expect(await call.json()).toEqual({ error: 'unauthorized', message: 'Access token required to use this tool.' });
    expect(call.headers.get('www-authenticate')).toBeNull();
  });

  it('a confidential client may send its credentials in the POST body instead of HTTP Basic', async () => {
    const t = await setup();
    const ok = await t.token({ grant_type: 'client_credentials', scope: 'mcp:service', client_id: 'alexa-plus', client_secret: SECRET }, null);
    expect(ok.status).toBe(200);
    const bad = await t.token({ grant_type: 'client_credentials', scope: 'mcp:service', client_id: 'alexa-plus', client_secret: 'nope' }, null);
    expect((await bad.json()).error).toBe('invalid_client');
  });

  it('rejects user scopes, bad secrets, and public clients', async () => {
    const t = await setup();
    expect((await (await t.token({ grant_type: 'client_credentials', scope: 'mcp:tools' })).json()).error).toBe('invalid_scope');
    const badSecret = await t.token({ grant_type: 'client_credentials' }, `Basic ${Buffer.from('alexa-plus:nope').toString('base64')}`);
    expect(badSecret.status).toBe(401);
    expect((await badSecret.json()).error).toBe('invalid_client');
    expect((await (await t.token({ grant_type: 'client_credentials', client_id: 'simulator' }, null)).json()).error).toBe('unauthorized_client');
  });
});

describe('access token checks on /mcp', () => {
  it('rejects tampered, expired, and wrong-audience tokens with 401', async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: ORIGIN, sub: H, aud: RESOURCE, scope: 'mcp:tools', iat: now, exp: now + 600 };
    expect((await t.mcp(signJwt(good, SIGNING), 'ping')).status).toBe(200);
    expect((await t.mcp(signJwt(good, 'another-secret'), 'ping')).status).toBe(401);
    expect((await t.mcp(signJwt({ ...good, exp: now - 1 }, SIGNING), 'ping')).status).toBe(401);
    expect((await t.mcp(signJwt({ ...good, aud: 'https://other.example/mcp' }, SIGNING), 'ping')).status).toBe(401);
    expect((await t.mcp(signJwt({ ...good, scope: 'mcp:resources' }, SIGNING), 'ping')).status).toBe(401);
  });

  it('publishes metadata with what Alexa+ requires', async () => {
    const t = await setup();
    const as = await (await t.handle(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token', 'client_credentials']));
    expect(as.scopes_supported).toEqual(expect.arrayContaining(['mcp:tools', 'mcp:resources', 'mcp:service']));
    expect(as.response_types_supported).toEqual(['code']);
    const prm = await (await t.handle(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))).json();
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([ORIGIN]);
    expect(as.issuer).toBe(ORIGIN);
    expect(as.registration_endpoint).toBeUndefined(); // static client registration: Alexa+ does not use DCR
  });
});
