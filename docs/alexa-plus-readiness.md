# Alexa+ add-on readiness

Each Alexa+ add-on requirement this repository implements, mapped to the test or file that proves it. A row appears here only if something in the repo shows it.

> **Simulated client.** Alexa+ add-on tooling is partner-only, so none of this has run against the real Alexa+ client. "Proven" means proven against our own tests and the published requirements, nothing more.

**Kinds of evidence**

- **npm test**: runs in `npm test` against the real MCP handler and core logic in-process (no network). File and test name given.
- **handshake**: `spikes/handshake.sh`, 18 wire-level curl checks against a running server (`spikes/handshake.sh http://localhost:5173 local-dev-mcp`).
- **measured**: numbers from a manual run against the deployment, recorded in the file named. Not an automated test.
- **file**: code or configuration only. No test checks it.

Requirement sources are the Alexa+ pages as recorded in [FRICTION_LOG.md](../FRICTION_LOG.md), the MCP specification, or [BRIEF.md](../BRIEF.md) where the requirement is our own reading of them.

## Transport and protocol

| Requirement | Source | Evidence | Kind |
|---|---|---|---|
| `initialize` accepts protocol version **2025-03-26** and answers with it | Alexa+ lifecycle page example (FRICTION_LOG #1) | `test/mcp-protocol.test.ts` › "initialize 2025-03-26: negotiates it, stateless, tools capability"; handshake check 1 | npm test, handshake |
| `initialize` accepts protocol version **2025-11-25** and answers with it | Alexa+ create page links this spec version (FRICTION_LOG #1) | `test/mcp-protocol.test.ts` › "initialize 2025-11-25: …"; handshake check 2 | npm test, handshake |
| **Stateless**: no `Mcp-Session-Id` is issued | BRIEF.md §7 | Same two tests assert the header is absent; handshake checks 1–2; `packages/mcp-server/src/http.ts` (`sessionIdGenerator: undefined`, a fresh server per request) | npm test, handshake |
| **Streamable HTTP, JSON responses** (no SSE stream) | BRIEF.md §7 | Every protocol test reads the reply as JSON; "GET /mcp is 405 (no SSE stream); a POST with no Accept header still gets a JSON answer" checks `content-type: application/json`; `http.ts` (`enableJsonResponse: true`) | npm test, handshake |
| `GET /mcp` returns 405 | BRIEF.md §7 | "GET /mcp is 405 …"; handshake check 17 | npm test, handshake |
| A missing or partial `Accept` header still works (the SDK alone answers 406) | Alexa+ client headers are undocumented (FRICTION_LOG #3) | "GET /mcp is 405 …; a POST with no Accept header still gets a JSON answer"; handshake check 3 | npm test, handshake |
| `notifications/initialized` → 202, `ping` → 200 | MCP spec | handshake checks 4–5 | handshake |
| **Origin check**: foreign Origin → 403; a listed origin is allowed; no Origin is allowed (server to server) | MCP spec, Streamable HTTP security | `test/mcp-protocol.test.ts` › "auth and origin: 401 without WWW-Authenticate, 403 for foreign origins"; handshake checks 11–12, 18 (CORS preflight) | npm test, handshake |
| `tools/list` is stable: byte-identical across calls and protocol versions | Alexa+ refreshes tool information only on deployment (FRICTION_LOG, unknowns table) | "tools/list is stable (snapshot)" with `test/__snapshots__/mcp-protocol.test.ts.snap`; handshake checks 6–7 | npm test, handshake |
| Bounded inputs: enums for choices, strings capped at 200 characters | BRIEF.md §7 | "rejects enum violations and oversize input"; handshake checks 9–10 | npm test, handshake |
| Tool errors come back as `isError` results, not protocol errors | MCP spec | "unknown occurrence is a tool error (isError), not a protocol error" | npm test |

## Authorization

| Requirement | Source | Evidence | Kind |
|---|---|---|---|
| **401 without `WWW-Authenticate`** for a missing or wrong token | Alexa+ MCP authentication page lists the header as unsupported (FRICTION_LOG #2) | "auth and origin: 401 without WWW-Authenticate …"; `test/oauth.test.ts` › "issues an mcp:service token …" also checks the header is absent; handshake checks 13–14 | npm test, handshake |
| **Protected Resource Metadata (RFC 9728)** at `/.well-known/oauth-protected-resource`, naming this `/mcp` URI and the authorization server | MCP spec discovery; the Alexa+ page rules out the header path (FRICTION_LOG #2) | `test/oauth.test.ts` › "publishes metadata with what Alexa+ requires" (`resource`, `authorization_servers`); handshake check 15 | npm test, handshake |
| **Authorization server metadata (RFC 8414)** at `/.well-known/oauth-authorization-server`: issuer, S256 only, `authorization_code` + `refresh_token` + `client_credentials`, scopes `mcp:tools` `mcp:resources` `mcp:service`, `response_types: ["code"]`, no registration endpoint | Alexa+ authentication and account linking pages (FRICTION_LOG #13); no Dynamic Client Registration (FRICTION_LOG #2) | "publishes metadata with what Alexa+ requires"; handshake check 16 | npm test, handshake |
| **Client credentials with `mcp:service`**: token issued with no refresh token; it can list tools; a tool call gets 401 `{"error":"unauthorized","message":"Access token required to use this tool."}` | Alexa+ authentication page (FRICTION_LOG #13) | "issues an mcp:service token without a refresh token; it can list tools but not call them"; "rejects user scopes, bad secrets, and public clients" | npm test |
| Client authentication by HTTP Basic or by credentials in the POST body | Alexa+ account linking checklist (FRICTION_LOG #13) | Basic: every token request in `test/oauth.test.ts`; body: "a confidential client may send its credentials in the POST body instead of HTTP Basic" | npm test |
| **Authorization code + PKCE S256**: `plain` refused, `resource` must be this `/mcp` URI, unregistered redirect URIs refused, `state` and `iss` returned, a code works once and only with its verifier | Alexa+ account linking page; MCP authorization spec | "links a household and the access token works on /mcp"; "requires S256 PKCE, the right resource, and user scopes"; "a code works once, and only with the right PKCE verifier"; "never redirects to an unregistered redirect_uri"; "cancelling returns access_denied with the state" | npm test |
| Access tokens: `expires_in` at most 3600, `Cache-Control: no-store`, and `/mcp` rejects a tampered, expired, wrong-audience or wrong-scope token with 401 | Alexa+ authentication page (FRICTION_LOG #13) | "links a household …" (`expires_in: 3600`, `no-store`); "rejects tampered, expired, and wrong-audience tokens with 401" | npm test |
| **Refresh token with every user access token, rotated on use**: the new one works, the old one does not; refresh works without `resource` | Alexa+ account linking page (FRICTION_LOG #13) | "refresh tokens rotate: the new one works, the old one does not" | npm test |
| **Revocation (RFC 7009)**: a revoked refresh token stops working | Alexa+ account linking page | "revoking a refresh token (RFC 7009) stops it working" | npm test |

## Tool results and UI

| Requirement | Source | Evidence | Kind |
|---|---|---|---|
| **`structuredContent` plus a text fallback** from every tool, with the text equal to the spoken `say` | BRIEF.md §7 | `test/mcp-protocol.test.ts` › "every tool answers with structuredContent, the same words as text, and _meta.ui" (all six tools); handshake check 8 | npm test, handshake |
| Output schemas declared for every tool | MCP spec (`outputSchema` with `structuredContent`) | `tools/list` snapshot in `test/__snapshots__/mcp-protocol.test.ts.snap` | npm test |
| **MCP Apps `ui://` resource**: `ui://closed-loop/checkin-card`, `text/html;profile=mcp-app`, listed and readable, no URLs in the card (it runs under the default CSP) | MCP Apps extension (SEP-1865) | "MCP App card: listed and readable as text/html;profile=mcp-app, referenced by tools and results" | npm test |
| **`_meta.ui` on tool results** (`resourceUri`, `invoking`, `invoked`) | Alexa+ lifecycle page (FRICTION_LOG, unknowns table) | Same test (for `get_due_checkins`); "every tool answers with structuredContent …" (`resourceUri` on all six) | npm test |
| **`_meta.ui.resourceUri` on tool definitions** | MCP Apps extension (SEP-1865) | "MCP App card: …" checks every tool in `tools/list` | npm test |
| **Tool annotations**: `readOnlyHint` true only for `get_my_status` and `get_family_summary`; `openWorldHint` false on all six | MCP spec tool annotations. Not found among the Alexa+ requirements recorded in this repo | "tool annotations: only the two read-only tools say so, and no tool reaches outside the server"; the `tools/list` snapshot locks `idempotentHint` as well | npm test |

## Latency and the hot path

| Requirement | Source | Evidence | Kind |
|---|---|---|---|
| **Round trip under 500 ms** | Alexa+ "Create an MCP Add-on", Performance section (FRICTION_LOG, unknowns table) | `spikes/latency.mjs` (sequential `tools/call` round trips, prints p50/p95/p99). Results in FRICTION_LOG #8: warm requests 4.4 ms p50 / 28 ms p95 server-side with the full app. **A cold start does not meet it**: a cold `get_due_checkins` took about 930 ms. A keep-warm schedule (`infra/template.yaml`, `KeepWarm`, every 5 minutes) holds one instance warm; provisioned concurrency is unavailable on this account | measured, file |
| No model or outside call on the MCP hot path | BRIEF.md §7 | `packages/mcp-server/src` imports only the MCP SDK, zod, `node:crypto` and `@closed-loop/core`; tool handlers call the core over the store (DynamoDB in AWS) | file |

## Policy

| Requirement | Source | Evidence | Kind |
|---|---|---|---|
| Redirect apparent crises to emergency services or crisis hotlines | Alexa+ Policy Requirements, Sec. 13 (FRICTION_LOG, unknowns table) | `test/engine.test.ts` › "crisis wording gets the fixed 911 line; self-harm wording adds 988"; the fail-closed eval in `test/safety-eval.test.ts` runs 225 labeled replies through `tools/call`. Its current results, including the crisis and self-harm phrasings it still misses, are in [docs/evals.md](evals.md) | npm test |
| Tool names and descriptions free of medical, emergency and tracking language | Alexa+ policy (BRIEF.md §7) | "tool names, titles, and descriptions stay free of medical, emergency, and tracking language" | npm test |

## Not claimed

- **Real Alexa+.** Not tested against the Alexa+ client, its account linking service, or its rendering of MCP App cards (all partner-only).
- **Cold-start latency.** Over budget, as stated above.
- **Proactive speech, routines, native reminders.** No documented way exists for an add-on to do these (FRICTION_LOG #4); nothing here implements them.
- **Elicitation, sampling, MCP Tasks.** Not used.
