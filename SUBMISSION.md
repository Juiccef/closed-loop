# Devpost submission text (copy and paste)

Fill in the video link (`<VIDEO_URL>`) before submitting.

---

## Project name

Closed Loop

## Tagline (short)

Daily check-ins that close the loop: an Alexa+ MCP add-on that records what was actually said, follows up, and tells family only when the loop stays open.

## Track and mini challenges

- Track: **Alexa+** (self-hosted MCP server, Streamable HTTP, demonstrated through a self-built simulated client as the FAQ allows)
- Mini challenges: **AWS Builder**, **Open Source**

## Text description

### Inspiration

Families of older adults who live alone improvise daily check-ins: an Alexa reminder plus a follow-up phone call, a lamp switched off as a sign of life. Amazon ended Alexa Together in 2025. Native Alexa+ reminders can repeat until someone says yes, but nothing keeps an honest history across days, and nothing tells family when the loop never closed. And a voice "yes" is not ground truth: "I think so, maybe after lunch" is not done.

### What it does

Closed Loop is a self-hosted MCP server for an Alexa+ add-on, plus a caregiver console and a simulated Alexa+ client.

- **Records honestly.** "I think so, maybe after lunch" is stored as *said later*, with a follow-up at 13:00. A hedged yes becomes *said they would, not sure*. The ledger only ever says *reported by the person*, *said later*, *no response*, or *needs human contact*, never "confirmed".
- **Follows up** at the time the person chose, or after the caregiver's interval, a capped number of times, never twice in one turn.
- **Tells a human** when a window closes without a report: a plain email ("We did not hear back about your morning routine today. This is not an emergency alert.") with a signed acknowledge link. Nobody acknowledges for a second day, the second contact is told.
- **Handles distress carefully:** confusion gets the family's own calming line and no more questions, plus a neutral note to family; emergency wording gets one fixed line, "If this is an emergency, please call 911 now" (and 988 for self-harm wording).
- **Puts the family in charge, with consent:** check-ins in their own words (linted so no drug names or doses are read aloud), who gets emailed, quiet hours, a daily email cap, plan expiry, recorded consent that stops everything when revoked, and delete-all-data.
- **Shows results as an MCP App card** (`ui://` resource, SEP-1865) using Alexa+'s documented `_meta.ui` placement.

It is deliberately not an emergency system, and it says so on every surface. MCP add-ons have no documented way to speak first, so turns start with the person, a household routine, or (in the demo) the simulator.

### How we built it

- **MCP server:** TypeScript on `@modelcontextprotocol/sdk` 1.32.1, stateless Streamable HTTP via the Web-standard transport. Accepts both `2025-03-26` and `2025-11-25` handshakes, validates Origin, returns 401 without `WWW-Authenticate` (per Alexa+'s auth docs) and serves RFC 9728 metadata. Five tools with enums and bounded strings, `structuredContent` plus text, a tools/list snapshot test.
- **State machine and ladder** in a pure, tested core: conditional writes on a version attribute so overlapping ticks never double-send, an atomic daily alert cap, and honest "open reasons" (not reached vs asked with no answer).
- **AWS:** Lambda (arm64) behind a Function URL, DynamoDB single table with TTL and Streams, EventBridge Scheduler (minute tick plus keep-warm), SES, Bedrock (Converse with tool use) for the planner and an asynchronous second opinion, all in one SAM template.
- **Simulated Alexa+ client:** a browser page that is a real MCP client and shows every JSON-RPC message, a planner hop, the MCP App card, and a simulated clock that moves the whole system.
- **Accessible caregiver console:** large type (Atkinson Hyperlegible), keyboard-first, status by shape and words, zero axe-core violations in light and dark.
- **Tests:** 82 unit and protocol tests, a 20-utterance fail-closed eval, an end-to-end replay of the demo that passes locally and on AWS, and three independent MCP clients (browser, MCP Inspector, the official SDK client).

### Challenges we ran into

- Alexa+ docs disagree on the protocol version and differ from the MCP spec on 401 headers; client headers are undocumented, and the SDK 406s JSON-only clients. We accept both versions and normalize `Accept`.
- No proactive primitive for add-ons, so the design separates "asking" (person-initiated) from "closing the loop" (scheduled).
- A brand-new AWS account: Bedrock daily token quota of 0 (not adjustable), Lambda concurrency of 10 (no provisioned concurrency), SES sandbox. Bedrock paths are deployed and pass request validation but fall back to rules today, and the UI says so.
- Cold starts above Alexa+'s 500 ms budget; mitigated with lazy SDK loading and a keep-warm schedule.

### Accomplishments that we're proud of

- The ledger never claims more than the person said, and every unsafe path fails closed.
- Exactly-once email under concurrency, proven against real DynamoDB.
- A real MCP App card that works with both the MCP Apps spec and Alexa+'s documented placement.
- An accessible console that passes axe-core with zero violations.

### What we learned

Most of the work in a "reminder" product is what happens after the question: honest recording, follow-up timing, and knowing when to involve a human without crying wolf.

### What's next

A consent-gated proactive primitive in Alexa+ would let the add-on start the morning check-in itself. Then: OAuth 2.1 with PKCE for account linking, a weekly Bedrock digest for families, and multi-household support.

## Built with

TypeScript, Node.js, Model Context Protocol (TypeScript SDK 1.x, MCP Apps), AWS Lambda, Lambda Function URLs, Amazon DynamoDB (Streams, TTL), Amazon EventBridge Scheduler, Amazon SES, Amazon Bedrock (Converse API), AWS SAM, esbuild, Vitest, axe-core.

## Links

- Repository: https://github.com/Juiccef/closed-loop (MIT license)
- Demo video: `<VIDEO_URL>`

## Product feedback (required: every tool used)

Full per-tool answers (what it was used for, what worked, what needs work, onboarding, would you build again) are in `PRODUCT_FEEDBACK.md` in the repo. Covered: Alexa+ add-on docs, MCP TypeScript SDK, MCP Inspector, AWS Lambda, Amazon DynamoDB, Amazon EventBridge Scheduler, Amazon SES, Amazon Bedrock, AWS SAM, AWS CLI. The AWS usage write-up is in the same file under "How this project uses AWS".

## Feature requests

| Request | Rating |
|---|---|
| A consent-gated proactive primitive for MCP add-ons (scheduled prompt, or creating a native reminder or routine step from a tool) | **Critical** |
| A public, rate-limited Alexa+ simulator or conformance test for non-partners | Important |
| Documented request headers and supported protocol versions for the Alexa+ MCP client | Important |
| Bedrock: say "your quota is 0" on the first throttling error; show account verification status | Important |
| SnapStart or easier provisioned concurrency for Node.js on new accounts | Nice-to-have |

## Friction log (optional bonus)

12 entries in `FRICTION_LOG.md`, each with task, steps, expected vs actual, severity, workaround, and suggestion: protocol version conflict, 401 header guidance, undocumented client headers, no proactive primitive, broken doc index URLs, partner-only tooling, Bedrock zero quota on a new account, Lambda concurrency and cold starts, a CloudFormation cycle between Function URLs, a DynamoDB Streams mapping start-up gap, SAM empty parameters, and SES verification resend.

## Open Source mini challenge

- **Contribution URL:** https://github.com/Juiccef/mcp-handshake-check
- **Repository URL:** https://github.com/Juiccef/mcp-handshake-check
- **GitHub username:** Juiccef
- **What I did:** Created `mcp-handshake-check`, a new MIT-licensed, zero-dependency CLI and library, during the hackathon window.
- **How it works:** Point it at any MCP endpoint. It initializes with both `2025-03-26` and `2025-11-25`, checks statelessness, JSON-only `Accept` tolerance, notification status, ping, tools/list stability across calls and versions, tool schema hygiene (object inputs, bounded strings, output schemas), an optional `tools/call` for `structuredContent` plus text, Origin rejection, 401 behavior, RFC 9728 and authorization-server metadata (S256, client_credentials), GET handling, and round-trip latency against a 500 ms budget. It prints PASS/WARN/FAIL with plain explanations, or JSON for CI, and exits non-zero on failure. Tests run against two in-process mock servers; CI runs on Node 20, 22, and 24.
- **Why it matters:** Each check is a real problem I hit while building an Alexa+ MCP add-on: conflicting version examples, an SDK that rejects JSON-only clients, and auth guidance that differs between the spec and a client. Anyone deploying an MCP server behind a strict client can catch these in one command instead of discovering them in production.
