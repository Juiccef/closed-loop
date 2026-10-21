import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools, type CheckinBackend } from './tools';

export const SERVER_NAME = 'closed-loop-checkins';
export const SERVER_VERSION = '0.1.0';
const MAX_BODY_BYTES = 16 * 1024;

export interface McpHttpConfig {
  /** Static bearer tokens mapped to the household they act for. Stand-in for OAuth 2.1 (out of scope). */
  bearerTokens: Record<string, string>;
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

function householdForToken(authHeader: string | null, config: McpHttpConfig): string | undefined {
  const match = authHeader?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) return undefined;
  for (const [token, householdId] of Object.entries(config.bearerTokens)) {
    if (tokenMatches(match[1], token)) return householdId;
  }
  return undefined;
}

function origin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function protectedResourceMetadata(config: McpHttpConfig, url: URL) {
  return {
    resource: config.resourceUrl || `${origin(url)}${config.basePath ?? ''}/mcp`,
    authorization_servers: [origin(url)],
    scopes_supported: ['checkins'],
    bearer_methods_supported: ['header'],
    resource_name: 'Closed Loop daily check-ins (hackathon build)',
  };
}

// Metadata stub so discovery can be exercised. The endpoints answer 501: this build uses a static bearer token.
function authorizationServerMetadata(url: URL) {
  const base = origin(url);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    scopes_supported: ['checkins'],
  };
}

/**
 * Accept-header normalization. The SDK answers 406 unless Accept lists both application/json and
 * text/event-stream. The spec requires clients to send both, but Alexa+'s client headers are undocumented,
 * and this server only ever answers with JSON, so a missing or partial Accept is completed here.
 */
function normalizeAccept(req: Request): Request {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return req;
  const headers = new Headers(req.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request(req.url, { method: req.method, headers, body: req.body, duplex: 'half' } as RequestInit);
}

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
    if (path === '/oauth/authorize' || path === '/oauth/token') {
      return json(
        501,
        { error: 'temporarily_unavailable', error_description: 'OAuth is not implemented in this build; use the static bearer token.' },
        cors,
      );
    }

    if (path !== '/mcp') return json(404, { error: 'not_found' }, cors);

    const householdId = householdForToken(req.headers.get('authorization'), config);
    if (!householdId) {
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

    // A fresh server and transport per request: stateless mode, no Mcp-Session-Id, no request-id collisions.
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
    registerTools(server, backend, { householdId });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(normalizeAccept(req));
      // Read the body before closing so the response is complete.
      const body = await res.arrayBuffer();
      return withHeaders(new Response(body.byteLength ? body : null, { status: res.status, headers: res.headers }), cors);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
