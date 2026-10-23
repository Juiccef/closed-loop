# Product feedback

One section per tool, API, or SDK used: what it was used for, what worked, what needs work, onboarding, and whether I would build with it again. Friction details with steps and workarounds are in [FRICTION_LOG.md](FRICTION_LOG.md).

## Feature requests

| Request | Rating | Why |
|---|---|---|
| A consent-gated proactive primitive for MCP add-ons (scheduled prompt, or a tool result that creates a native reminder or routine step) | **Critical** | A daily check-in for someone who lives alone cannot be started by the service. Today the person or a household routine has to start every turn (FRICTION_LOG #4). Classic custom skills already have the Reminders API for this, which the Echo Show skill uses ([docs/echo-show.md](docs/echo-show.md)). |
| Let an add-on declare a few consent-gated phrases it wants to hear (for example "good night"), and document how utterances are routed to add-ons | Important | The person's own check-ins close when the person says their phrase; whether a bare "good night" ever reaches an add-on is undocumented (FRICTION_LOG #14). |
| A public, rate-limited Alexa+ web simulator or recorded-traffic conformance test for non-partners | Important | Partner-only tooling means hackathon entrants cannot test against the real client (FRICTION_LOG #6). |
| A documented list of request headers and supported protocol versions for the Alexa+ MCP client | Important | Version examples disagree (2025-03-26 vs 2025-11-25) and `Accept` / `MCP-Protocol-Version` behavior is undocumented (FRICTION_LOG #1, #3). |
| Bedrock: say "your quota is 0" in the first throttling error, and show account verification status | Important | A new account's first Converse call returned "Too many tokens per day" (FRICTION_LOG #7). |
| SnapStart (or provisioned concurrency without the 10-unreserved rule) for Node.js on new accounts | Nice-to-have | Cold starts of 0.56–0.64 s exceed Alexa+'s 500 ms budget (FRICTION_LOG #8). |

---

## Alexa+ add-on documentation (MCP Toolkit, Category SDK pages, policy and certification)

- **Used for:** Protocol, authentication, latency, and policy requirements. The tooling itself (Alexa AI CLI, MCP Toolkit, web simulator) is partner-only, so the docs were the only interface.
- **What worked:** A clear latency target (round trip under 500 ms). The policy page gives concrete, testable rules that shaped the design: no emergency-intervention claims, redirect crises to emergency services or hotlines, attribute medical information, collect only what is needed, never recite private information by voice, no "customer tracking". The lifecycle page documents `_meta.ui` for custom UI and a data-only fallback.
- **What needs work:** OAuth requirements are split across three pages and disagree on how clients authenticate at the token endpoint (FRICTION_LOG #13). Protocol version examples disagree; the 401 guidance ("`WWW-Authenticate` headers in 401 responses" listed as not supported) differs from the MCP spec's default; client request headers are undocumented; there is no proactive or notification primitive, and how a short phrase like "good night" is routed to an add-on is not described (FRICTION_LOG #14); the folder URL 404s and `llms.txt` returns an HTML shell. See FRICTION_LOG #1–#6.
- **Onboarding:** About 45 minutes to find and read the relevant pages from search results, since the index URL does not resolve.
- **Would build again:** Yes, and I would build the proactive version of this the day a primitive exists.

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Used for:** The MCP server (tool registration with zod schemas and output schemas, stateless Streamable HTTP via `WebStandardStreamableHTTPServerTransport`) and a second test client (`Client` + `StreamableHTTPClientTransport`).
- **What worked:** The Web-standard transport (`handleRequest(Request) → Response`) runs unchanged on Lambda Function URLs and in a local Node server with a 40-line adapter. Stateless mode plus `enableJsonResponse` gave plain JSON with no session header. Negotiates 2024-10-07 through 2025-11-25 with no extra code. zod 4 shapes work directly, including `outputSchema` for `structuredContent`. Invalid enums and oversize strings are rejected before the handler runs. The client connected to the stateless server first time.
- **What needs work:** A strict `Accept` check returns 406 for clients that send only `application/json`, even in JSON-only mode. Host and Origin validation options are deprecated in favor of "external middleware" with no example. The 1.x vs 2.x split (and the 2026 spec dropping `initialize`) makes it unclear which line to pin for clients that still handshake.
- **Onboarding:** About 30 minutes from install to a passing curl handshake, mostly reading `.d.ts` files.
- **Would build again:** Yes.

## Alexa Skills Kit (classic custom skill, `ask-sdk-core` 2.14.0, Reminders API, APL)

- **Used for:** Running Closed Loop on a real Echo Show as a development-stage custom skill: a catch-all slot, the Reminders API (`SCHEDULED_RELATIVE` and daily `SCHEDULED_ABSOLUTE`), the permission card, and an APL card with an AVG ring.
- **What worked:** `ask-sdk-model` types cover the Reminders request shapes, so the request is type-checked against Amazon's model. Swapping the SDK's `ApiClient` for a fake made the Reminders API easy to test. The SAM `AlexaSkill` event sets the skill ID on the Lambda permission in one line. Leaving `shouldEndSession` unset keeps an APL card on screen without opening the microphone.
- **What needs work:** `withSkillId` skips the check when the ID is unset (FRICTION_LOG #15). There is no non-deprecated way to tell whether the Reminders permission is granted, and the refusal code is undocumented (FRICTION_LOG #16). The Reminders reference gives two different success codes.
- **Onboarding:** About an hour from reading the docs to passing handler tests; console and device steps still to do on the real Echo.
- **Would build again:** Yes, for anything that needs Alexa to speak first.

## MCP Inspector (`@modelcontextprotocol/inspector` 2.11.0, CLI mode)

- **Used for:** An independent client in the Phase 0 spike and against the deployed endpoint (`tools/list`, `tools/call` with a bearer header).
- **What worked:** `--cli --transport http --header` worked first time; JSON output is easy to script.
- **What needs work:** `--tool-arg` values containing `#` need careful shell quoting; a `--json-args` option would help for structured arguments.
- **Onboarding:** Five minutes.
- **Would build again:** Yes.

## AWS Lambda (Function URLs, nodejs22.x, arm64)

- **Used for:** Three functions: web (MCP server, console API, pages, planner), tick (scheduled), classifier (stream-triggered).
- **What worked:** Function URLs plus a small adapter to Web `Request`/`Response` ran the MCP SDK's transport unchanged. Warm round trips 9 ms p50 / 33 ms p95 server-side including a DynamoDB read. ESM bundles with top-level `await` moved credential loading and the first DynamoDB connection into init, cutting first-invoke time from 360–552 ms to about 90 ms. SAM created both Function URL permissions (`InvokeFunctionUrl` and public `InvokeFunction`) automatically.
- **What needs work:** Cold start is still 561–640 ms at 2048 MB. New accounts get 10 concurrent executions, which rules out provisioned concurrency. Two Function URLs that reference each other create a CloudFormation cycle, which pushed MCP and the console onto one path-routed URL.
- **Onboarding:** Fast with SAM; the Function URL event shape is easy to adapt.
- **Would build again:** Yes, with a keep-warm schedule.

## Amazon DynamoDB (single table, TTL, Streams)

- **Used for:** All state: households, consent, check-in definitions, ladder, occurrences, utterances, audit events, daily alert counters, the simulated clock. Streams feed the classifier.
- **What worked:** Conditional writes on a `version` attribute made "never double-send" simple: a five-way race against a cap of 3 produced exactly three alerts against the real service. TTL handles the 30-day utterance limit with no code. On-demand billing is ideal for a bursty demo. Stream event filters (`prefix: "UTT#"`) mean the classifier only runs for new utterances.
- **What needs work:** A new stream event source mapping with `LATEST` takes a few minutes to start reading, and records written in that gap are silently skipped while the mapping already reports `Enabled`; a "ready" signal would save debugging time.
- **Onboarding:** Quick for anyone who knows single-table design; the Document client's `removeUndefinedValues` option is essential and easy to miss.
- **Would build again:** Yes.

## Amazon EventBridge Scheduler

- **Used for:** The minute tick (window close, ladder, email) and a 5-minute keep-warm ping, both declared as SAM `ScheduleV2` events.
- **What worked:** Two lines of SAM each, a dedicated execution role created automatically, a static JSON input for the keep-warm event, and retry policy control (`MaximumRetryAttempts: 0`, since the next tick retries anyway).
- **What needs work:** Nothing blocking. A per-schedule invocation history in the console would help confirm a schedule is firing without opening CloudWatch Logs.
- **Onboarding:** Ten minutes.
- **Would build again:** Yes. It is a better fit than EventBridge rules for this.

## Amazon SES (v2 API)

- **Used for:** Family emails: "we did not hear back" alerts with signed acknowledge links, and needs-human notes.
- **What worked:** `SendEmail` with simple content (text and HTML parts) and email tags for kind and household. Sandbox limits (200 per day, 1 per second) are plenty for a demo. Errors are specific: the unverified-address rejection named the failing identity, which surfaced a missing retry cap in my code.
- **What needs work:** Verification is by emailed link only; when it lands in spam, nothing in the CLI tells you. The v2 API has no "resend verification" call (I used the v1 `verify-email-identity`). Production access takes days, so the sandbox defines the demo.
- **Onboarding:** Quick, apart from verification timing.
- **Would build again:** Yes. (Pinpoint was avoided: end of support October 30, 2026.)

## Amazon Bedrock (Converse API)

- **Used for:** (1) The planner that stands in for Alexa+'s LLM: the live MCP `tools/list` is converted into Converse tool specs and the model picks one tool call. (2) An asynchronous second opinion on what the person said, using a forced `classify` tool.
- **What worked:** The Converse tool-use shape maps cleanly onto MCP tool schemas (after removing `$schema`). Requests are validated before quota is checked, which let me confirm both request shapes were valid without any quota: a missing tool list returned `ValidationException`, a correct request returned `ThrottlingException`. `maxAttempts: 1` plus a timeout makes fallback to rules immediate.
- **What needs work:** On this new account every model was unusable: first "account is being verified", then a daily token quota of **0** (not adjustable in Service Quotas) for Nova, and "not available for this account" for Anthropic and OpenAI models (FRICTION_LOG #7). The error says "Too many tokens per day" on the very first call.
- **Onboarding:** The API itself is quick to learn; account access was the blocker.
- **Would build again:** Yes, on an account with quota.

## AWS SAM (CLI 1.169)

- **Used for:** The whole stack: table, three functions, Function URL, two schedules, a stream event source with a filter, least-privilege IAM, log groups with retention. `sam validate --lint` before every deploy.
- **What worked:** `ScheduleV2` and `FunctionUrlConfig` save a lot of raw CloudFormation. `--resolve-s3` removed bucket setup. Linting caught nothing wrong, which is a good sign for its defaults.
- **What needs work:** `--parameter-overrides` rejects an empty value (`Key=`), so optional parameters need shell gymnastics. Building TypeScript monorepos works best by bundling with esbuild yourself and pointing `CodeUri` at the output.
- **Onboarding:** Smooth.
- **Would build again:** Yes.

## AWS CLI 2 (`aws login`)

- **Used for:** Signing in, verifying SES identities, inspecting quotas, logs, streams, and stacks.
- **What worked:** `aws login` (console credentials, no access keys) was the fastest way to get a new account working.
- **What needs work:** It signs in as the root user when the console session is root, without a warning.
- **Would build again:** Yes.

---

## How this project uses AWS (AWS Builder mini challenge)

Closed Loop is a multi-service, event-driven pipeline rather than a single call:

1. **AWS Lambda + Function URL** host the MCP server (Streamable HTTP, stateless), the caregiver console API, signed acknowledge links, and the simulated client, on arm64 with esbuild-bundled ESM.
2. **Amazon DynamoDB** is the single source of truth: one table with conditional writes for idempotent state transitions, an atomic daily alert counter, TTL for data minimization (utterances expire after 30 days), and **DynamoDB Streams** with an event filter.
3. **Amazon EventBridge Scheduler** runs the tick every minute (closing check-in windows and running the escalation ladder) and a keep-warm schedule that holds MCP latency under Alexa+'s 500 ms budget.
4. **Amazon SES** delivers plain-language family emails with signed, expiring acknowledge links, claimed by conditional write before sending so no email is sent twice.
5. **Amazon Bedrock (Converse with tool use)** plays two roles off the hot path: the planner that picks MCP tools from the live `tools/list`, and a stream-triggered second opinion that can only move a record toward caution. Both are deployed and validated; this account's Bedrock quota is 0, so both fall back to rules today and say so.
6. **AWS SAM / CloudFormation** defines all of it, with least-privilege IAM (SES send, Bedrock invoke, table-scoped DynamoDB) and 7-day log retention, deployed with one command.
