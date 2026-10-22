# Devpost submission text (copy and paste)

Fill in the video link (`<VIDEO_URL>`) before submitting.

---

## Project name

Closed Loop

## Tagline (short)

Daily check-ins for people living alone: an Alexa+ MCP add-on that records what was actually said, follows up, and tells family only when the loop stays open.

## Track and mini challenges

- Track: **Alexa+** (self-hosted MCP server, Streamable HTTP, demonstrated through a self-built simulated client as the FAQ allows)
- Mini challenges: **AWS Builder**, **Open Source**

## Text description

### Inspiration

My grandmother had severe dementia. Toward the end she would forget our names and where she was. She fell once and was badly hurt, and we had to move her into an elder care facility because she needed more watching over than we could give her. Having something like this would have helped us when she was still with us.

Closed Loop wouldn't have stopped that fall, and it can't replace care. It's for the stretch before that, when someone still lives at home and mostly manages on their own, and the family needs to know each day whether things are okay, and to hear about it when they're not.

An estimated **7.4 million** Americans 65 and older are living with Alzheimer's, and **1 in 4** older Americans with dementia or mild cognitive impairment lives alone. **Nearly 13 million** family members and friends give them unpaid care, often from another town. Amazon's own remote-caregiving service, Alexa Together, is **no longer available**. (Sources in `docs/impact.md`: Alzheimer's Association 2026 Facts and Figures; UCSF, JAMA Network Open 2023; Amazon, May 2025.)

Families improvise: an Alexa reminder, then a phone call to check. A reminder can ask the question, but it never learns whether the loop closed. And for someone with memory changes, a voice "yes" is not ground truth: "I think so, maybe after lunch" is not done.

### What it does

Closed Loop is a self-hosted MCP server for an Alexa+ add-on, plus a caregiver console and a simulated Alexa+ client. It is live on AWS.

- **Records honestly.** "I think so, maybe after lunch" is stored as *said later*, with a follow-up at 13:00. A hedged yes becomes *said they would, not sure*. The ledger only ever says *reported by the person*, *said later*, *no response*, or *needs human contact*, never "confirmed".
- **Follows up** at the time the person chose, or after the caregiver's interval, a capped number of times, never twice in one turn.
- **Tells a human, without crying wolf.** When a window closes with no answer, Amazon SES sends a plain email ("We did not hear back about your morning routine today. This is not an emergency alert.") with a signed acknowledge link. Nobody acknowledges for a second day, the second contact is told. A daily cap and quiet hours keep it calm.
- **Lets family ask from their own Alexa.** "How is Mom doing today?" reads back the day exactly as recorded ("needs human contact; a call may help"). A family member's linked account can read the day but can never answer, defer, or pause a check-in for the person: the server refuses it.
- **Handles distress carefully:** confusion gets the family's own calming line and no more questions, plus a neutral note to family; emergency wording gets one fixed line, "If this is an emergency, please call 911 now" (and 988 for self-harm wording).
- **Puts the family in charge, with consent:** check-ins in their own words (linted so no drug names or doses are read aloud), who gets emailed, quiet hours, plan expiry, recorded consent that stops everything when revoked, and delete-all-data.
- **Shows results as MCP App cards** (`ui://` resource, SEP-1865) using Alexa+'s documented `_meta.ui` placement.
- **Links accounts with OAuth 2.1** the way Alexa+ add-ons do, with separate link codes for the person's own Alexa and a family member's.
- **Ships an Agent Skill** (`skills/closed-loop-checkins/SKILL.md`): the check-in protocol and honesty rules for any agent connected to the server.

It is deliberately not an emergency system, and it says so on every surface. MCP add-ons have no documented way to speak first, so turns start with the person, a household routine, or (in the demo) the simulator.

### What the rules call creative, and where it is

| The Alexa+ judging guidance lists | Closed Loop | Video |
|---|---|---|
| An agentic workflow that orchestrates across services autonomously | Every minute EventBridge Scheduler runs a tick that closes windows in DynamoDB, emails family through SES, escalates to a second contact on day two, and stops when someone acknowledges. No human in the loop until a human is needed. | 1:33 |
| A context-aware add-on that keeps state across sessions | The ledger, follow-ups at the time the person chose, the distress quiet period, and the family's view of the day all persist across sessions. | 0:56, 1:20, 2:13 |
| Media support (cards) and MCP Apps | One MCP App card renders all six tool results, including the family summary, in a sandboxed iframe with the spec's handshake. | 0:56 |
| Agent Skills | `skills/closed-loop-checkins/SKILL.md` | 2:38 |
| Not a single-turn Q&A bot | Answers, deferrals and follow-ups span hours and days; family hear the result later from their own device. | throughout |

### How we built it

- **MCP server:** TypeScript on `@modelcontextprotocol/sdk` 1.32.1, stateless Streamable HTTP via the Web-standard transport. Accepts both `2025-03-26` and `2025-11-25` handshakes, validates Origin, returns 401 without `WWW-Authenticate` (per Alexa+'s auth docs), serves RFC 9728 metadata, and runs its own OAuth 2.1 authorization server built to Alexa+'s account-linking requirements, with a person/family role carried in the authorization code, refresh token and access token. Six tools with enums and bounded strings, `structuredContent` plus text, a tools/list snapshot test.
- **State machine and ladder** in a pure, tested core: conditional writes on a version attribute so overlapping ticks never double-send, an atomic daily alert cap, and honest "open reasons" (not reached vs asked with no answer).
- **AWS:** Lambda (arm64) behind a Function URL, DynamoDB single table with TTL and Streams, EventBridge Scheduler (minute tick plus keep-warm), SES, Bedrock (Converse with tool use) for the planner and an asynchronous second opinion, all in one SAM template.
- **Simulated Alexa+ client:** a browser page that is a real MCP client and shows every JSON-RPC message, a planner hop, the MCP App card, a "who is speaking" switch for the person or a family member, and a simulated clock that moves the whole system.
- **Caregiver console:** Amazon-style app layout with Apple's system type, keyboard-first, status by shape and words, zero axe-core violations on every page in light and dark.
- **Tests:** 109 unit, protocol, OAuth and planner tests, a 20-utterance fail-closed eval, an end-to-end replay of the demo that passes locally and on AWS, and three independent MCP clients (browser, MCP Inspector, the official SDK client).

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

A consent-gated proactive primitive in Alexa+ would let the add-on start the morning check-in itself. Then: a weekly Bedrock digest for families, multi-household support, and a calibrated decision model (such as TypeSafe's Jev) as a second-opinion classifier.

## Built with

TypeScript, Node.js, Model Context Protocol (TypeScript SDK 1.x, MCP Apps), Agent Skills, AWS Lambda, Lambda Function URLs, Amazon DynamoDB (Streams, TTL), Amazon EventBridge Scheduler, Amazon SES, Amazon Bedrock (Converse API), AWS SAM, esbuild, Vitest, axe-core.

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

13 entries in `FRICTION_LOG.md`, each with task, steps, expected vs actual, severity, workaround, and suggestion: protocol version conflict, 401 header guidance, undocumented client headers, no proactive primitive, broken doc index URLs, partner-only tooling, Bedrock zero quota on a new account, Lambda concurrency and cold starts, a CloudFormation cycle between Function URLs, a DynamoDB Streams mapping start-up gap, SAM empty parameters, SES verification resend, and OAuth requirements split across pages.

## Open Source mini challenge

- **Contribution URL:** https://github.com/Juiccef/mcp-handshake-check
- **Repository URL:** https://github.com/Juiccef/mcp-handshake-check
- **GitHub username:** Juiccef
- **What I did:** Created `mcp-handshake-check`, a new MIT-licensed, zero-dependency CLI and library, during the hackathon window.
- **How it works:** Point it at any MCP endpoint. It initializes with both `2025-03-26` and `2025-11-25`, checks statelessness, JSON-only `Accept` tolerance, notification status, ping, tools/list stability across calls and versions, tool schema hygiene (object inputs, bounded strings, output schemas), an optional `tools/call` for `structuredContent` plus text, Origin rejection, 401 behavior, RFC 9728 and authorization-server metadata (S256, client_credentials), GET handling, and round-trip latency against a 500 ms budget. It prints PASS/WARN/FAIL with plain explanations, or JSON for CI, and exits non-zero on failure. Tests run against two in-process mock servers; CI runs on Node 20, 22, and 24.
- **Why it matters:** Each check is a real problem I hit while building an Alexa+ MCP add-on: conflicting version examples, an SDK that rejects JSON-only clients, and auth guidance that differs between the spec and a client. Anyone deploying an MCP server behind a strict client can catch these in one command instead of discovering them in production.
