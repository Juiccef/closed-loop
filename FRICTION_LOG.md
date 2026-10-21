# Friction log

Each entry: task, steps, expected vs actual, severity, workaround, suggestion. Severity: High (blocks or changes design), Medium (costs time or adds risk), Low (annoyance).

---

## 1. Alexa+ docs disagree on the MCP protocol version

- **Task:** Decide which `protocolVersion` the server must accept in `initialize`.
- **Steps:** Read "Create an MCP Add-on" (`/docs/alexaplus/add-ons/category-sdk-create-mcp-addon`) and "Alexa+ MCP Client and App Lifecycle" (`/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle`).
- **Expected:** One documented version.
- **Actual:** The create page links the 2025-11-25 transport spec. The lifecycle page's example `initialize` from "Alexa+ MCP Client" sends and receives `"protocolVersion": "2025-03-26"`. Neither page lists the supported versions.
- **Severity:** Medium.
- **Workaround:** Accept both and echo the client's version (MCP SDK 1.32.1 supports 2024-10-07 through 2025-11-25). Verified with curl for both versions.
- **Suggestion:** Publish a "supported protocol versions" table and update the lifecycle example to match.

## 2. 401 guidance conflicts with the MCP spec's discovery default

- **Task:** Implement the unauthenticated 401 response.
- **Steps:** Read "MCP authentication" (`/docs/alexaplus/add-ons/category-sdk-mcp-authentication`).
- **Expected:** The MCP 2025-11-25 authorization spec's pattern: 401 with `WWW-Authenticate: Bearer resource_metadata="..."`.
- **Actual:** The page's "What isn't supported" list includes "`WWW-Authenticate` headers in 401 responses". It also lists Dynamic Client Registration as unsupported. It does not mention the Protected Resource Metadata path; it refers to the Account Linking page for user identity.
- **Severity:** Medium (a spec-default server could fail discovery).
- **Workaround:** 401 with no `WWW-Authenticate` by default (a config flag turns it on), and Protected Resource Metadata always served at `/.well-known/oauth-protected-resource` (RFC 9728), which the MCP spec allows as the alternative discovery path.
- **Suggestion:** State explicitly that discovery uses the well-known PRM URI only, and show a full 401 example.

## 3. Alexa+ client request headers are undocumented

- **Task:** Make sure the server accepts whatever headers Alexa+ sends.
- **Steps:** Searched the lifecycle and create pages for `Accept`, `MCP-Protocol-Version`, and identity headers. Read SDK transport source.
- **Expected:** A list of headers the Alexa+ client sends.
- **Actual:** Not documented. The MCP TypeScript SDK 1.32.1 `WebStandardStreamableHTTPServerTransport` answers **406** unless `Accept` includes both `application/json` and `text/event-stream`.
- **Severity:** Medium (unknown risk of a hard 406 in production).
- **Workaround:** The server completes a missing or partial `Accept` header before the SDK sees it. It only ever answers with JSON. Tested: `initialize` with no `Accept` returns 200.
- **Suggestion:** Document the exact request headers, including whether `MCP-Protocol-Version` is sent after `initialize`.

## 4. No documented way for an MCP add-on to speak first

- **Task:** Phase 0 spike 6: find reminders, notifications, or routine invocation for MCP add-ons.
- **Steps:** Read the create, lifecycle, authentication, and policy pages; searched developer.amazon.com for "proactive", "notification", "reminder", "routine" with "add-on".
- **Expected:** An API to start a check-in at a scheduled time, or to create a native reminder from a tool.
- **Actual:** None found. "Proactive" appears only as "proactive or conversational discovery" (Alexa+ choosing to use an add-on during a conversation the person started) and, in certification, "experiences must respond to Alexa+ proactively". The only push notification mentioned is for starting OAuth on screenless devices. Routines invoking an add-on: not documented.
- **Severity:** High for this use case: a daily check-in for a person living alone cannot be started by the service.
- **Workaround:** Turns are started by the person, a household routine, or (in the demo) the simulator. The scheduler only closes windows and emails family. Stated on every surface.
- **Suggestion (Critical feature request):** A consent-gated proactive primitive for MCP add-ons, for example a tool result that schedules a native reminder, or an add-on-initiated prompt with per-household opt-in and rate limits.

## 5. Add-on docs index URLs fail

- **Task:** Find the doc set's table of contents.
- **Steps:** Fetched `https://developer.amazon.com/docs/alexaplus/add-ons/` and `https://developer.amazon.com/docs/llms.txt`.
- **Expected:** An index page and a plain-text llms.txt.
- **Actual:** The folder URL returns 404. `llms.txt` returns the HTML portal shell (login header script), not a text index.
- **Severity:** Low.
- **Workaround:** Page links in the "Create an MCP Add-on" sidebar.
- **Suggestion:** Redirect the folder URL to `/home`; serve llms.txt as `text/plain`.

## 6. Partner-only tooling vs hackathon framing

- **Task:** Test against a real Alexa+ client.
- **Expected:** Access to the Alexa AI CLI, MCP Toolkit, or web simulator.
- **Actual:** The hackathon FAQ says this tooling is partner-only and entrants cannot apply.
- **Severity:** High (no end-to-end test against the real client is possible).
- **Workaround:** A self-built simulated client that speaks real MCP over Streamable HTTP, plus MCP Inspector, as the FAQ allows.
- **Suggestion:** A public, rate-limited web simulator or a recorded-traffic conformance test for hackathon entrants.

## 7. New account: Bedrock unusable (verification, then zero daily token quotas)

- **Task:** Phase 0 spike 4: confirm Bedrock access with a Converse call.
- **Steps:** Signed in with `aws login` (new in AWS CLI 2.3x; uses console credentials, no access keys). Listed models: Nova Micro/Lite/2 Lite, Claude Haiku 5.5, GPT-5.6, gpt-oss are ACTIVE in us-east-1. Called `bedrock-runtime converse` with `maxTokens` 5–64.
- **Expected:** A one-word reply, or a model-access error that says which form to fill in.
- **Actual:**
  1. First attempt (about 22:10 ET): `AccessDeniedException: Your account is currently being verified. Verification normally takes less than 2 hours.`
  2. About 30 minutes later: Nova Micro, Nova Lite, Nova 2 Lite, gpt-oss-20b and gpt-oss-120b return `ThrottlingException: Too many tokens per day` on the first call. Service Quotas shows "Model invocation max tokens per day" = **0** for each Nova model, marked **not adjustable**. Claude Haiku 5.5 and GPT-5.6 return `AccessDeniedException: ... is not available for this account ... contact AWS Sales`.
  3. The only non-zero inference quotas are AI21 Jamba 1.5 (1 request/min) and GPT-5.6 on the `bedrock-mantle` endpoint (but Converse says those models are not available to the account).
  - DynamoDB, Lambda, SES, Scheduler and CloudFormation all work on the same account at the same moment.
- **Severity:** High for a 3-day hackathon (blocks the Bedrock half of the build and puts the AWS Builder mini challenge at risk).
- **Workaround:** Rule-based planner and classifier first (required as fallbacks anyway), Bedrock behind an interface; request a quota increase through AWS Support.
- **Suggestion:** A "Throttling: tokens per day" error on the very first call should say the quota is 0 and how to raise it. Non-adjustable quotas of 0 should be explained in the console, with expected timing if they lift automatically.

## 8. New account: Lambda concurrency quota of 10 rules out provisioned concurrency

- **Task:** Phase 0 spike 3: MCP round trip under 500 ms including cold starts.
- **Steps:** Deployed the real MCP handler (SDK 1.32.1, 756 KB bundle, AWS SDK from the runtime) on a Function URL with one DynamoDB `GetItem`. Forced cold starts by changing an environment variable. Read `REPORT` lines in CloudWatch Logs.
- **Expected:** Cold start well under 500 ms; provisioned concurrency available if not.
- **Actual:** Warm: p50 9 ms, p95 33 ms server-side. Cold at 1024 MB, CJS: init 384–484 ms + first invoke 360–552 ms. Cold at 2048 MB, ESM, DynamoDB connection opened at init (top-level await): init 471–550 ms + first invoke 90 ms = 561–640 ms. `get-account-settings` reports `ConcurrentExecutions: 10`; provisioned concurrency needs 10 unreserved, so none can be configured.
- **Severity:** Medium.
- **Workaround:** Keep-warm schedule (EventBridge Scheduler, every 5 minutes) on the MCP function. One household's calls are sequential, so one warm instance covers it.
- **Suggestion:** Note the new-account concurrency quota on the provisioned-concurrency page; consider SnapStart for Node.js.

## 9. Two Function URLs that reference each other form a CloudFormation cycle

- **Task:** Deploy the MCP endpoint and the console/simulator API as separate Lambda functions, each with a Function URL.
- **Steps:** The MCP function needs the simulator page's origin (to allow it in the Origin check); the API function needs the MCP URL (to tell the simulator where to connect). Both as environment variables via `!GetAtt <Fn>Url.FunctionUrl`.
- **Expected:** Two functions, two URLs.
- **Actual:** Each function depends on the other's URL resource, which depends on the other function: a circular dependency.
- **Severity:** Medium.
- **Workaround:** One web function, path-routed: `/mcp` for MCP, everything else for the console API and pages (same origin, no CORS). Tick and classifier stay separate.
- **Suggestion:** Document the pattern, or allow a Function URL to be created before its function's configuration is final (as API Gateway stages allow).

## 10. A new DynamoDB Streams mapping silently skips records for its first minutes

- **Task:** Trigger the classifier for every new utterance (stream event source, `StartingPosition: LATEST`, event filter on `SK` prefix `UTT#`).
- **Steps:** Deployed, then immediately wrote utterances via the MCP server. Checked `LastProcessingResult` and logs; read the stream directly with `get-records`.
- **Expected:** The function invoked for each new utterance once the mapping is `Enabled`.
- **Actual:** The mapping reported `Enabled` and "No records processed" while the records were visibly in the stream. Records written in the first minutes after creation were never delivered; later ones were (the classifier then logged `review ... ThrottlingException`, as expected).
- **Severity:** Low (cost about 20 minutes).
- **Workaround:** Wait a few minutes after creating a mapping before testing, or use `TRIM_HORIZON` for tests.
- **Suggestion:** Expose a "polling started at" timestamp on the mapping.

## 11. SAM rejects empty parameter overrides

- **Task:** Make the Bedrock model ID optional (`BedrockModelId`, default empty).
- **Steps:** `sam deploy --parameter-overrides ... BedrockModelId=`.
- **Expected:** The default (empty) value is used.
- **Actual:** `Invalid value for '--parameter-overrides': BedrockModelId= is not a valid format`.
- **Severity:** Low.
- **Workaround:** Only pass the parameter when it is set (bash array in `scripts/deploy.sh`).
- **Suggestion:** Accept `Key=` as an empty string.

## 12. SES verification email: no resend in the v2 API, no status hint

- **Task:** Verify the demo sender/recipient address in the SES sandbox.
- **Steps:** `aws sesv2 create-email-identity`; polled `get-email-identity` (`VerificationStatus: PENDING`) for over an hour.
- **Expected:** A way to resend the verification email from the v2 API.
- **Actual:** `create-email-identity` fails if the identity exists; resending needs the v1 call `aws ses verify-email-identity`. Meanwhile every tick's send failed with "Email address is not verified", which revealed that needs-human notes had no retry cap (fixed: 3 attempts, logged).
- **Severity:** Low.
- **Workaround:** v1 `verify-email-identity` to resend.
- **Suggestion:** Add `ResendVerification` to SESv2.

---

## Unknowns (BRIEF section 20): status

| Unknown | Answer | Source / status |
|---|---|---|
| Latency limit | < 500 ms round trip | Verified: "Create an MCP Add-on", Performance section |
| Other timeouts, retries | Not documented | Searched create + lifecycle pages |
| Tool-count / schema limits | Not documented (only store listing limits) | Create page |
| Tool signature lock | "Alexa+ refreshes tool information only on deployment" | Create page; "locked" wording not found |
| User identity header/claim | Not documented on auth page; refers to Account Linking page | Unverified, to read |
| Routines invoke an add-on | Not documented | Entry 4 |
| Tool creates native reminder | Not documented | Entry 4 |
| `_meta.ui` / MCP Apps | Documented: tool result `_meta.ui` with `resourceUri` (e.g. `ui://...`), `invoking`, `invoked`; data-only fallback | Lifecycle page. ext-apps with SDK 1.x: not yet tested |
| Elicitation | Alexa+ uses MCP elicitation when it cannot fill missing details itself | Lifecycle page. We still do not use server-initiated elicitation |
| Bedrock model IDs | Listed ACTIVE in us-east-1: `us.amazon.nova-micro-v1:0`, `us.amazon.nova-lite-v1:0`, `us.anthropic.claude-haiku-5-5` (inference profiles) | `list-inference-profiles`. Invocation blocked: daily token quota 0 / not available for account (entry 7). Prices: to check |
| Crisis wording policy | "Redirect apparent references to personal crises or suicidal intent to emergency services or crisis hotlines." | Policy Requirements, Sec. 13. Added 988 line for self-harm wording |
