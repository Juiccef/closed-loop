# Product feedback

One section per tool, API, or SDK used. Filled in as the build proceeds; entries marked _pending_ have not been used yet.

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Used for:** The MCP server: tool registration with zod schemas, stateless Streamable HTTP via `WebStandardStreamableHTTPServerTransport`.
- **What worked:** The Web-standard transport (`handleRequest(Request) → Response`) runs unchanged locally and on Lambda. Stateless mode (`sessionIdGenerator: undefined`) plus `enableJsonResponse: true` gave plain JSON with no `Mcp-Session-Id`. It negotiates both 2025-03-26 and 2025-11-25 with no extra code. zod 4 shapes work directly in `registerTool`, including `outputSchema` for `structuredContent`. Invalid enums and oversize strings are rejected before the handler runs.
- **What needs work:** A strict `Accept` check returns 406 for clients that send only `application/json`, even in JSON-only mode. Host/origin options are deprecated in favor of "external middleware" with no example. The 1.x vs 2.x split and the 2026 spec dropping `initialize` make it unclear which line to pin for clients that still handshake.
- **Onboarding:** About 30 minutes from install to a passing curl handshake, reading the `.d.ts` files.
- **Would build again:** Yes.

## MCP Inspector (`@modelcontextprotocol/inspector` 2.11.0, CLI mode)

- **Used for:** Independent client check: `tools/list` and `tools/call` over HTTP with a bearer header.
- **What worked:** `--cli --transport http --header` worked first time; output is JSON that scripts can parse.
- **What needs work:** _to add_
- **Would build again:** Yes.

## Alexa+ add-on documentation

- **Used for:** Protocol, auth, latency, and policy requirements (we cannot access the partner-only tooling).
- **What worked:** Clear latency target (< 500 ms). Policy page gives concrete, testable rules (no emergency-intervention claims, redirect crises, no reciting private info by voice, collect only what is necessary).
- **What needs work:** See FRICTION_LOG entries 1–6: version conflict, 401 header guidance, undocumented client headers, no proactive primitive, broken index URLs.
- **Onboarding:** _to add_
- **Would build again:** _to add_

## AWS Lambda: _pending_
## Amazon DynamoDB: _pending_
## Amazon EventBridge Scheduler: _pending_
## Amazon SES: _pending_
## Amazon Bedrock: _pending_
## AWS SAM: _pending_

## How this project uses AWS (AWS Builder mini challenge)

_To be written after deployment._
