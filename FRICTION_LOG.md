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
| Bedrock model IDs/prices | Pending AWS access | |
| Crisis wording policy | "Redirect apparent references to personal crises or suicidal intent to emergency services or crisis hotlines." | Policy Requirements, Sec. 13. Added 988 line for self-harm wording |
