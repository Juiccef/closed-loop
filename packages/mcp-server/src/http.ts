import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SCOPE_RESOURCES, SCOPE_SERVICE, SCOPE_TOOLS, type AccessContext, type OAuthServer } from './oauth';
import { registerTools, type CheckinBackend } from './tools';

export const SERVER_NAME = 'closed-loop-checkins';
export const SERVER_VERSION = '0.1.0';
const MAX_BODY_BYTES = 16 * 1024;

export interface McpHttpConfig {
  /** Static bearer tokens mapped to the household they act for (the demo token, for MCP Inspector and scripts). */
  bearerTokens: Record<string, string>;
  /** Per-visitor demo tokens (minted with /admin/demo-start): the one visitor household a token acts for, or undefined. */
  householdBearer?: (bearer: string) => string | undefined;
  /** Browser origins allowed to call the endpoint. Requests with no Origin header are allowed (server-to-server). */
  allowedOrigins: string[];
  /** Also allow pages served from this endpoint's own origin (console and simulator on the same URL). */
  allowSameOrigin?: boolean;
  /** Canonical URI of the MCP endpoint, advertised in Protected Resource Metadata. Derived from the request when empty. */
  resourceUrl: string;
  /**
   * Alexa+ docs list "WWW-Authenticate headers in 401 responses" as not supported, while the MCP spec
   * allows either that header or the well-known PRM document for discovery. Default off; PRM is always served.
   */
  includeWwwAuthenticate: boolean;
  /** Path prefix the endpoint is mounted under, e.g. '' locally or '' on a Function URL. */
  basePath?: string;
  /** OAuth 2.1 authorization server (account linking). Without it, the OAuth endpoints answer 501. */
  oauth?: OAuthServer;
}

const CORS_ALLOW_HEADERS = 'content-type, authorization, accept, mcp-protocol-version, mcp-session-id, last-event-id';

function originAllowed(reqOrigin: string, url: URL, config: McpHttpConfig): boolean {
  return config.allowedOrigins.includes(reqOrigin) || (!!config.allowSameOrigin && reqOrigin === `${url.protocol}//${url.host}`);
}

function corsHeaders(origin: string | null, url: URL, config: McpHttpConfig): Record<string, string> {
  if (!origin || !originAllowed(origin, url, config)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const merged = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(authHeader: string | null): string | undefined {
  return authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

function staticHousehold(bearer: string, config: McpHttpConfig): string | undefined {
  for (const [token, householdId] of Object.entries(config.bearerTokens)) {
    if (tokenMatches(bearer, token)) return householdId;
  }
  return undefined;
}

function origin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function canonicalResource(config: McpHttpConfig, url: URL): string {
  return config.resourceUrl || `${origin(url)}${config.basePath ?? ''}/mcp`;
}

const SCOPES = [SCOPE_TOOLS, SCOPE_RESOURCES, SCOPE_SERVICE];

function protectedResourceMetadata(config: McpHttpConfig, url: URL) {
  return {
    resource: canonicalResource(config, url),
    authorization_servers: [origin(url)],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Closed Loop daily check-ins',
  };
}

function authorizationServerMetadata(url: URL) {
  const base = origin(url);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * Accept-header normalization. The SDK answers 406 unless Accept lists both application/json and
 * text/event-stream. The spec requires clients to send both, but Alexa+'s client headers are undocumented,
 * and this server only ever answers with JSON, so a missing or partial Accept is completed here.
 */
function normalizedHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  const accept = headers.get('accept') ?? '';
  if (!(accept.includes('application/json') && accept.includes('text/event-stream'))) headers.set('accept', 'application/json, text/event-stream');
  return headers;
}

const SERVICE_DENIED = { error: 'unauthorized', message: 'Access token required to use this tool.' };

export function createMcpHttpHandler(config: McpHttpConfig, backend: CheckinBackend) {
  const base = config.basePath ?? '';

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;
    const reqOrigin = req.headers.get('origin');
    const cors = corsHeaders(reqOrigin, url, config);

    if (reqOrigin && !originAllowed(reqOrigin, url, config)) {
      return json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden: origin not allowed' }, id: null });
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return json(200, protectedResourceMetadata(config, url), cors);
    }
    if (path === '/.well-known/oauth-authorization-server') {
      return json(200, authorizationServerMetadata(url), cors);
    }
    if (path === '/oauth/authorize' || path === '/oauth/token' || path === '/oauth/revoke') {
      if (!config.oauth) {
        return json(501, { error: 'temporarily_unavailable', error_description: 'OAuth is not configured on this deployment.' }, cors);
      }
      const o = origin(url);
      const canonical = canonicalResource(config, url);
      const res =
        path === '/oauth/authorize' ? await config.oauth.authorize(req, o, canonical) : path === '/oauth/token' ? await config.oauth.token(req, o, canonical) : await config.oauth.revoke(req);
      return withHeaders(res, cors);
    }

    if (path !== '/mcp') return json(404, { error: 'not_found' }, cors);

    const bearer = bearerOf(req.headers.get('authorization'));
    const staticId = bearer ? (staticHousehold(bearer, config) ?? config.householdBearer?.(bearer)) : undefined;
    const access: AccessContext | undefined = staticId
      ? { kind: 'static', householdId: staticId, scopes: [SCOPE_TOOLS] }
      : bearer && config.oauth
        ? config.oauth.verifyAccess(bearer, origin(url), canonicalResource(config, url))
        : undefined;
    if (!access) {
      const headers: Record<string, string> = { ...cors };
      if (config.includeWwwAuthenticate) {
        headers['www-authenticate'] =
          `Bearer resource_metadata="${origin(url)}${base}/.well-known/oauth-protected-resource"`;
      }
      return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, headers);
    }

    if (req.method !== 'POST') {
      // Stateless JSON-only server: no standalone SSE stream, no session to DELETE.
      return json(
        405,
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
        { ...cors, allow: 'POST, OPTIONS' },
      );
    }

    const declaredLength = Number(req.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_BODY_BYTES) {
      return json(413, { jsonrpc: '2.0', error: { code: -32000, message: 'Request too large' }, id: null }, cors);
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return json(413, { jsonrpc: '2.0', error: { code: -32000, message: 'Request too large' }, id: null }, cors);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, cors);
    }

    // Service-level tokens (client_credentials, mcp:service) may discover tools but not call them:
    // every tool here acts for a household, so a linked account is required (Alexa+: 401 or 403).
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (access.kind === 'service' && messages.some((m) => (m as { method?: string })?.method === 'tools/call')) {
      return json(401, SERVICE_DENIED, cors);
    }

    // A fresh server and transport per request: stateless mode, no Mcp-Session-Id, no request-id collisions.
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
    registerTools(server, backend, { householdId: access.householdId ?? '', role: access.kind === 'user' ? (access.role ?? 'person') : 'any' });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      const forward = new Request(req.url, { method: 'POST', headers: normalizedHeaders(req) });
      const res = await transport.handleRequest(forward, { parsedBody: parsed });
      // Read the body before closing so the response is complete.
      const body = await res.arrayBuffer();
      return withHeaders(new Response(body.byteLength ? body : null, { status: res.status, headers: res.headers }), cors);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
