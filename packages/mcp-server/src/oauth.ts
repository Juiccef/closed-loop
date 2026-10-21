// OAuth 2.1 authorization server for Alexa+ account linking, as described in the Alexa+ MCP add-on docs:
//  - authorization_code + PKCE (S256 required) for user-level access (scopes mcp:tools, mcp:resources)
//  - client_credentials for service-level access (scope mcp:service, no refresh token)
//  - static client registration (no DCR), HTTP Basic or POST-body client auth, `resource` must be this MCP URI
//  - access tokens are short-lived JWTs (HS256, <= 3600 s, aud = resource); a refresh token comes with every
//    user access token and rotates on use. Errors follow RFC 6749 section 5.2.
// Linking a household: the person linking enters a one-time link code created in the caregiver console.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { hashSecret, normalizeLinkCode, randomToken, type OAuthGrant, type Store } from '@closed-loop/core';

export const SCOPE_SERVICE = 'mcp:service';
export const SCOPE_TOOLS = 'mcp:tools';
export const SCOPE_RESOURCES = 'mcp:resources';
const USER_SCOPES = new Set([SCOPE_TOOLS, SCOPE_RESOURCES]);

export interface OAuthClient {
  id: string;
  /** Confidential clients (Alexa+) have a secret; public clients (the simulator) rely on PKCE alone. */
  secret?: string;
  /** Exact-match redirect URIs. */
  redirectUris: string[];
  /** Also allow this path on the server's own origin (the simulator's callback page). */
  sameOriginRedirectPath?: string;
  allowClientCredentials?: boolean;
}

export interface OAuthConfig {
  signingSecret: string;
  clients: OAuthClient[];
  accessTokenSeconds?: number;
  refreshTokenDays?: number;
  authCodeSeconds?: number;
}

export interface AccessContext {
  kind: 'static' | 'user' | 'service';
  householdId?: string;
  scopes: string[];
  clientId?: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'at+jwt' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [h, b, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return undefined;
    const expected = createHmac('sha256', secret).update(`${h}.${b}`).digest();
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function pkceChallenge(verifier: string): string {
  return hashSecret(verifier);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' } });
const oauthError = (status: number, error: string, description: string) => json(status, { error, error_description: description });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createOAuth(cfg: OAuthConfig, store: Store) {
  const accessSeconds = Math.min(cfg.accessTokenSeconds ?? 3600, 3600);
  const refreshDays = cfg.refreshTokenDays ?? 30;
  const codeSeconds = cfg.authCodeSeconds ?? 60;
  const clientById = new Map(cfg.clients.map((c) => [c.id, c]));

  function redirectAllowed(client: OAuthClient, redirectUri: string, origin: string): boolean {
    if (client.redirectUris.includes(redirectUri)) return true;
    return !!client.sameOriginRedirectPath && redirectUri === `${origin}${client.sameOriginRedirectPath}`;
  }

  function issueAccessToken(origin: string, resource: string, sub: string, scope: string, clientId: string) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ iss: origin, sub, aud: resource, scope, client_id: clientId, iat: now, exp: now + accessSeconds, jti: randomToken(12) }, cfg.signingSecret);
  }

  async function issueUserTokens(origin: string, grant: OAuthGrant) {
    const refresh = `clrt.${grant.householdId}.${randomToken(32)}`;
    const expiresAt = new Date(Date.now() + refreshDays * 86_400_000).toISOString();
    await store.putRefreshToken(grant.householdId, hashSecret(refresh), { ...grant, codeChallenge: undefined, redirectUri: undefined }, expiresAt);
    return json(200, {
      access_token: issueAccessToken(origin, grant.resource, grant.householdId, grant.scope, grant.clientId),
      token_type: 'Bearer',
      expires_in: accessSeconds,
      refresh_token: refresh,
      scope: grant.scope,
    });
  }

  /** Client authentication: HTTP Basic, or client_id (+ client_secret) in the body. */
  function authenticateClient(req: Request, form: URLSearchParams): OAuthClient | 'invalid' {
    let id = form.get('client_id') ?? '';
    let secret = form.get('client_secret') ?? undefined;
    const basic = req.headers.get('authorization')?.match(/^Basic\s+(\S+)$/i)?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) return 'invalid';
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const client = clientById.get(id);
    if (!client) return 'invalid';
    if (client.secret) return secret !== undefined && safeEqual(secret, client.secret) ? client : 'invalid';
    return secret ? 'invalid' : client; // public client: no secret expected
  }

  // ---- /oauth/authorize ----

  interface AuthorizeParams {
    client: OAuthClient;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope: string;
    resource: string;
  }

  function page(status: number, title: string, body: string): Response {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{--paper:#f5efe3;--card:#fffaf0;--ink:#1f2a2c;--ink2:#4a5557;--rule:#d8ccb4;--terra:#b2441f;--focus:#0b57d0}
@media (prefers-color-scheme:dark){:root{--paper:#12191a;--card:#1e2829;--ink:#efe8da;--ink2:#b9b2a4;--rule:#34403f;--terra:#f08a66;--focus:#8ab4ff}}
body{margin:0;font:18px/1.5 "Atkinson Hyperlegible","Segoe UI",system-ui,sans-serif;background:var(--paper);color:var(--ink)}
main{max-width:34rem;margin:2.5rem auto;padding:0 1rem}
.card{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:1.4rem 1.5rem}
h1{font-family:Georgia,serif;font-size:1.7rem;margin:0 0 .5rem}
ul{padding-left:1.2rem}label{display:block;font-weight:700;margin:1rem 0 .3rem}
input{font:inherit;font-size:1.3rem;letter-spacing:.12em;text-transform:uppercase;width:100%;box-sizing:border-box;padding:.55rem .75rem;border:2px solid var(--rule);border-radius:10px;background:var(--paper);color:var(--ink)}
.row{display:flex;gap:.6rem;margin-top:1.1rem;flex-wrap:wrap}
button{font:inherit;font-weight:700;padding:.6rem 1.2rem;border-radius:999px;border:2px solid var(--ink);background:var(--ink);color:var(--paper);min-height:44px;cursor:pointer}
button.ghost{background:transparent;color:var(--ink)}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.err{color:var(--terra);font-weight:700}.note{font-size:.9rem;color:var(--ink2)}
</style></head><body><main><div class="card">${body}</div><p class="note">Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.</p></main></body></html>`,
      {
        status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
      },
    );
  }

  function redirectWith(redirectUri: string, params: Record<string, string>): Response {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
  }

  /** Validates authorization parameters. Errors before the redirect URI is trusted are shown, never redirected. */
  function validateAuthorize(p: URLSearchParams, origin: string, canonical: string): AuthorizeParams | Response {
    const client = clientById.get(p.get('client_id') ?? '');
    if (!client) return page(400, 'Unknown app', '<h1>Unknown app</h1><p>This sign-in link names an app that is not registered.</p>');
    const redirectUri = p.get('redirect_uri') ?? '';
    if (!redirectAllowed(client, redirectUri, origin)) return page(400, 'Unregistered redirect', '<h1>Cannot continue</h1><p>The return address in this link is not registered for this app.</p>');
    const state = p.get('state') ?? '';
    const fail = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state, iss: origin });
    if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const codeChallenge = p.get('code_challenge') ?? '';
    if (!codeChallenge || p.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    const requested = (p.get('scope') ?? SCOPE_TOOLS).split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some((s) => !USER_SCOPES.has(s))) return fail('invalid_scope', 'allowed scopes: mcp:tools mcp:resources');
    const resource = p.get('resource') ?? canonical;
    if (resource !== canonical) return fail('invalid_target', `resource must be ${canonical}`);
    return { client, redirectUri, state, codeChallenge, scope: requested.join(' '), resource };
  }

  function consentPage(ap: AuthorizeParams, raw: URLSearchParams, error?: string): Response {
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
      .filter((k) => raw.get(k) !== null)
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(raw.get(k)!)}">`)
      .join('');
    const who = ap.client.secret ? 'your voice assistant' : 'the simulated voice assistant';
    return page(
      error ? 400 : 200,
      'Link Closed Loop',
      `<h1>Link Closed Loop</h1>
<p>This lets ${who} ask the daily check-ins your family set up and record the answers.</p>
<ul><li>Answers are recorded as said, never as “confirmed”.</li><li>Family is emailed only when a check-in stays open.</li><li>You can pause check-ins any time, and the family can unlink this from the console.</li></ul>
<form method="post" action="/oauth/authorize">${hidden}
<label for="link-code">Link code from the caregiver console</label>
<input id="link-code" name="link_code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" required aria-describedby="link-help${error ? ' link-err' : ''}"${error ? ' aria-invalid="true" autofocus' : ''}>
<p class="note" id="link-help">Eight characters, like K7P2-9QXM. Codes expire after 10 minutes.</p>
${error ? `<p class="err" id="link-err" role="alert">${escapeHtml(error)}</p>` : ''}
<div class="row"><button type="submit" name="decision" value="allow">Link</button><button type="submit" name="decision" value="deny" class="ghost" formnovalidate>Cancel</button></div>
</form>`,
    );
  }

  async function authorize(req: Request, origin: string, canonical: string): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      const ap = validateAuthorize(url.searchParams, origin, canonical);
      return ap instanceof Response ? ap : consentPage(ap, url.searchParams);
    }
    if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'use GET or POST');
    const form = new URLSearchParams((await req.text()).slice(0, 8192));
    const ap = validateAuthorize(form, origin, canonical);
    if (ap instanceof Response) return ap;
    if (form.get('decision') !== 'allow') return redirectWith(ap.redirectUri, { error: 'access_denied', error_description: 'The person cancelled linking.', state: ap.state, iss: origin });
    const householdId = await store.consumeLinkCode(hashSecret(normalizeLinkCode(form.get('link_code') ?? '')), new Date());
    if (!householdId) return consentPage(ap, form, 'That code did not work. It may have expired or been used already. Create a new one in the caregiver console.');
    const code = randomToken(32);
    const grant: OAuthGrant = {
      clientId: ap.client.id,
      householdId,
      scope: ap.scope,
      resource: ap.resource,
      redirectUri: ap.redirectUri,
      codeChallenge: ap.codeChallenge,
      createdAt: new Date().toISOString(),
    };
    await store.putAuthCode(hashSecret(code), grant, new Date(Date.now() + codeSeconds * 1000).toISOString());
    return redirectWith(ap.redirectUri, { code, state: ap.state, iss: origin });
  }

  // ---- /oauth/token ----

  async function token(req: Request, origin: string, canonical: string): Promise<Response> {
    if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'use POST');
    if (!(req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
      return oauthError(400, 'invalid_request', 'body must be application/x-www-form-urlencoded');
    }
    const form = new URLSearchParams((await req.text()).slice(0, 8192));
    const client = authenticateClient(req, form);
    if (client === 'invalid') return oauthError(401, 'invalid_client', 'client authentication failed');
    const grantType = form.get('grant_type');
    const now = new Date();

    if (grantType === 'authorization_code') {
      const code = form.get('code');
      const verifier = form.get('code_verifier');
      if (!code || !verifier) return oauthError(400, 'invalid_request', 'code and code_verifier are required');
      const grant = await store.consumeAuthCode(hashSecret(code), now);
      if (!grant || grant.clientId !== client.id) return oauthError(400, 'invalid_grant', 'code is invalid, expired, or already used');
      if (!grant.codeChallenge || !safeEqual(pkceChallenge(verifier), grant.codeChallenge)) return oauthError(400, 'invalid_grant', 'code_verifier does not match');
      const redirectUri = form.get('redirect_uri');
      if (redirectUri && redirectUri !== grant.redirectUri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match');
      const resource = form.get('resource');
      if (resource && resource !== grant.resource) return oauthError(400, 'invalid_target', 'resource does not match');
      await store.appendEvent({
        householdId: grant.householdId,
        at: new Date().toISOString(),
        type: 'account_linked',
        detail: `A voice assistant was linked with a link code (${client.secret ? 'Alexa+ add-on' : 'simulated client'}).`,
      });
      return issueUserTokens(origin, grant);
    }

    if (grantType === 'refresh_token') {
      const rt = form.get('refresh_token') ?? '';
      const m = rt.match(/^clrt\.([a-z0-9_-]{1,32})\.[A-Za-z0-9_-]{20,}$/);
      if (!m) return oauthError(400, 'invalid_grant', 'refresh token is invalid');
      const grant = await store.consumeRefreshToken(m[1]!, hashSecret(rt), now);
      if (!grant || grant.clientId !== client.id) return oauthError(400, 'invalid_grant', 'refresh token is invalid, expired, or already used');
      const requested = form.get('scope');
      if (requested && requested.split(/\s+/).some((s) => !grant.scope.split(' ').includes(s))) return oauthError(400, 'invalid_scope', 'cannot widen scope on refresh');
      return issueUserTokens(origin, { ...grant, scope: requested ?? grant.scope, createdAt: grant.createdAt });
    }

    if (grantType === 'client_credentials') {
      if (!client.secret || !client.allowClientCredentials) return oauthError(400, 'unauthorized_client', 'client_credentials is not allowed for this client');
      const scope = form.get('scope') ?? SCOPE_SERVICE;
      if (scope !== SCOPE_SERVICE) return oauthError(400, 'invalid_scope', 'client_credentials allows only mcp:service');
      const resource = form.get('resource') ?? canonical;
      if (resource !== canonical) return oauthError(400, 'invalid_target', `resource must be ${canonical}`);
      return json(200, { access_token: issueAccessToken(origin, resource, `client:${client.id}`, SCOPE_SERVICE, client.id), token_type: 'Bearer', expires_in: accessSeconds, scope: SCOPE_SERVICE });
    }

    return oauthError(400, 'unsupported_grant_type', 'supported: authorization_code, refresh_token, client_credentials');
  }

  // ---- /oauth/revoke (RFC 7009) ----

  async function revoke(req: Request): Promise<Response> {
    if (req.method !== 'POST') return oauthError(405, 'invalid_request', 'use POST');
    const form = new URLSearchParams((await req.text()).slice(0, 8192));
    if (authenticateClient(req, form) === 'invalid') return oauthError(401, 'invalid_client', 'client authentication failed');
    const rt = form.get('token') ?? '';
    const m = rt.match(/^clrt\.([a-z0-9_-]{1,32})\./);
    if (m) await store.consumeRefreshToken(m[1]!, hashSecret(rt), new Date());
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  /** Validates a bearer JWT for this MCP endpoint. */
  function verifyAccess(bearer: string, origin: string, canonical: string): AccessContext | undefined {
    const claims = verifyJwt(bearer, cfg.signingSecret);
    if (!claims) return undefined;
    if (claims.iss !== origin || claims.aud !== canonical) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return undefined;
    const scopes = String(claims.scope ?? '').split(' ').filter(Boolean);
    const sub = String(claims.sub ?? '');
    if (sub.startsWith('client:')) return { kind: 'service', scopes, clientId: String(claims.client_id ?? '') };
    if (!scopes.includes(SCOPE_TOOLS)) return undefined;
    return { kind: 'user', householdId: sub, scopes, clientId: String(claims.client_id ?? '') };
  }

  return { authorize, token, revoke, verifyAccess };
}

export type OAuthServer = ReturnType<typeof createOAuth>;
