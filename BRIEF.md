# BRIEF: Closed Loop (working title) — Alexa+ track, Amazon Developer Hackathon

Read this whole file before writing any code. It is the single source of truth for the build.

**Deadline:** Friday Oct 23, 2026, 3:00 pm ET (12:00 pm PT). Target submission: noon ET Friday. Build window starts Tue Oct 20 evening. About 37 productive hours are realistic; the plan below commits 34.

**Kickoff prompt to paste into Claude Code:**

> Read BRIEF.md completely. Do Phase 0 (spike tests) first and report results before building anything else. Then follow the phases and gates in order. Keep FRICTION_LOG.md and PRODUCT_FEEDBACK.md updated as you go. Never invent an API shape: check the docs or test it, and mark anything unverified. Commit often. Stop at each gate and tell me whether it passed.

---

## 1. What we are building (plain version)

A daily check-in service for an older adult who lives alone, set up by a family caregiver. The person answers by voice. The project's job is everything that happens **after** the question:

1. **Record** what the person said, honestly. "I think so, maybe after lunch" is logged as "said they would do it later", never as "confirmed".
2. **Follow up** later in the day.
3. **Tell a human** (by email) when the loop stays open: "we did not hear back about your mother's morning routine today."

It is a **self-hosted MCP server** (Streamable HTTP) that an Alexa+ add-on would call, plus a **caregiver web console**, plus a **simulated Alexa+ web client** used for the demo.

Why this shape: Amazon shut down Alexa Together in 2025. Native Alexa+ reminders can repeat hourly or daily until the user confirms, but nothing keeps a durable history across days or tells family when the loop never closed. Families already improvise this (Alexa reminder plus a follow-up, a lamp switched off with a button to confirm).

**The honest limit:** no documented way exists for an Alexa+ MCP add-on to start a spoken conversation. Voice turns are started by the person, a household routine, or (in the demo) the simulator. We say so on screen and in the README.

## 2. Hackathon rules that constrain the build (verified from the pasted rules and FAQ)

- Alexa+ track: a working Agent Skill **or** a self-hosted MCP server, MCP spec **2025-11-25 or later**, over **Streamable HTTP**. Alternatively a simulated Alexa+ web app; then the repo must include the simulation source and the demo must clearly show it working.
- The FAQ (verified) says Alexa+ developer tooling (CLI, MCP Toolkit, web simulator) is partner-only and entrants cannot apply. A web page acting as a real MCP client (sends `initialize`, `tools/list`, `tools/call` over Streamable HTTP) satisfies the requirement. The server does not need to stay running after submission.
- Repo: public with an open-source LICENSE file visible in the GitHub About section (recommended; also supports the Open Source mini challenge). Must contain all source, assets, and clear setup/run instructions.
- Demo video: under 3 minutes, public on YouTube or Vimeo, English, no third-party trademarks or copyrighted music. Lead with the best material.
- Product feedback is required for **every tool, API, SDK used** (what used for, what worked, what needs work, onboarding, would you build again). AWS usage is described in this same answer.
- Optional friction log (up to 10% judging bonus): per entry: task attempted, steps taken, expected vs actual, severity, workaround, actionable suggestion.
- Judging (equal weight): Tech Implementation, Design, Potential Impact, Quality of the Idea. Judges call a single-turn bot or a thin API wrapper "obvious", and call state across sessions, multi-service orchestration, and MCP Apps/cards "creative".
- Mini challenges: AWS Builder (documented AWS service integrations, e.g. Bedrock) and Open Source (see section 18). The rules' own examples: AWS Builder "obvious" = a single Bedrock call or S3 storage; "creative" = multi-service pipeline or agent orchestration. Alexa+ "obvious" = single-turn Q&A or a basic MCP wrapper; "creative" = agentic workflow across services, state across sessions, cards/carousels, MCP Apps, Agent Skills.
- Multiple submissions are allowed only if each is "unique and substantially different". Do not submit this one project to two tracks as separate entries.

## 3. Honest-labelling text (use verbatim on every surface: UI, README, video)

1. **Simulated client:** "Simulated Alexa+ client. Not Amazon software. Alexa+ add-on tooling is partner-only, so this project implements the MCP server side and demonstrates it through a self-built MCP client, as the hackathon FAQ allows."
2. **Scope:** "Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency."
3. **Voice turns:** "Check-in conversations are started by the person, a household routine, or the simulator. MCP add-ons have no documented way to speak first."
4. **Ledger wording:** statuses are "reported by the person", "said later", "no response", "needs human contact". Never "confirmed" or "taken".

## 4. Architecture

```
Caregiver console (static web) ──► API Lambda ──► DynamoDB ◄── Tick Lambda ◄── EventBridge Scheduler (rate 1 min)
                                        │                         │
Simulated Alexa+ page ──► MCP Lambda ───┘                         └──► SES email (L1/L2 alerts)
   │  (real MCP over HTTP)
   └──► Planner Lambda ──► Bedrock (stand-in for Alexa+'s own LLM; also async classifier, digest)
```

- **MCP Lambda** (Function URL): stateless Streamable HTTP, tools touch **DynamoDB only** (no Bedrock, no network calls on the hot path). Round trip must stay **under 500 ms** (Alexa+'s documented limit).
- **Tick Lambda:** runs every minute, reads `now()` (real time plus simulated offset), advances occurrences (window close → missed → escalate), sends email. It cannot speak to the user.
- **API Lambda:** caregiver console endpoints, signed acknowledge links, admin clock endpoints (demo only, token protected).
- **Planner Lambda:** takes the conversation and the MCP `tools/list`, calls Bedrock (Converse API with tool definitions), returns the next tool call. The browser executes the call against the MCP server so the traffic is real and visible.
- Region: `us-east-1` unless Bedrock model access dictates otherwise.
- Language: TypeScript, Node 20+. Shared pure logic in one package so it can run locally and on Lambda.

## 5. Data model (DynamoDB single table, on-demand billing)

Keys `PK`, `SK`. Use TTL attribute `ttl` where noted.

| Item | PK | SK | Key fields |
|---|---|---|---|
| Household | `H#<id>` | `META` | name, timezone, caregiver contacts (verified emails), createdAt |
| Consent | `H#<id>` | `CONSENT#<ts>` | recipientName, recordedBy, recordedAt, revokedAt?, planExpiresAt |
| Check-in definition | `H#<id>` | `CHK#<id>` | label (caregiver-authored, generic), kind (`routine`/`wellbeing`/`meal`), windows `[{start,end}]` local time, reaskMinutes, maxReasks, calmingLine, active |
| Ladder config | `H#<id>` | `LADDER` | L1 contacts, L2 contacts, L2 after N missed days, dailyAlertCap, quietHours, expiry days |
| Occurrence | `H#<id>` | `OCC#<yyyy-mm-dd>#<chkId>#<windowIdx>` | state, promptedAt, reasks, deferUntil, lastResponse, classification, escalationLevel, ackedAt, version |
| Utterance (minimal) | `H#<id>` | `UTT#<occ>#<ts>` | text (max 200 chars), `ttl` 30 days |
| Audit event | `H#<id>` | `EVT#<ts>#<n>` | type, detail (no free text beyond 200 chars) |
| Alert counter | `H#<id>` | `CAP#<yyyy-mm-dd>` | count, `ttl` |
| Clock | `CLOCK` | `GLOBAL` | offsetSeconds |

Every state transition uses a **conditional write on `version`** so two ticks or retries never double-send.

## 6. State machine and escalation ladder

States: `SCHEDULED → PROMPTED → (REPORTED_DONE | DEFERRED | DECLINED | UNSURE | NEEDS_HUMAN)`; `DEFERRED → PROMPTED` when `deferUntil` passes and the person next interacts; window end without `REPORTED_DONE` → `MISSED` → `ESCALATED_L1` → `ACKNOWLEDGED` (stops the ladder). A second missed day (configurable) → `ESCALATED_L2`.

Rules:
- Re-ask: if `PROMPTED` or `DEFERRED` and `reaskMinutes` elapsed and `reasks < maxReasks`, the next `get_due_checkins` returns it again. Cap re-asks (default 2). Never argue or repeat a question inside one turn.
- "Yes" is not ground truth. Hedged yes (see safety layer) becomes `UNSURE`, shown as "said they would, not sure".
- `MISSED` is written by the tick when the window closes with no `REPORTED_DONE`. Email wording: "We did not hear back about <label> today. This is not an emergency alert."
- `NEEDS_HUMAN` (distress or crisis wording) sends a neutral note at L1: "<Name> seemed confused or upset during a check-in. A call may help."
- Acknowledge link (signed, expiring) sets `ACKNOWLEDGED` and stops further alerts for that occurrence.
- **Daily alert cap** (default 3 emails per household per day), **quiet hours** (configurable, off in demo mode), **plan expiry** (default 14 days, must be renewed) so a forgotten plan cannot keep alerting.
- Consent revoked or plan paused: no prompts returned, no emails sent, immediately.
- Because the tick cannot prompt, "no response" means "not reached or did not answer". The ledger must not claim the person was asked unless `promptedAt` is set.

## 7. MCP server specification

**Pin the SDK:** `@modelcontextprotocol/sdk` **1.x** (TypeScript). Do **not** use the 2026-07-28 spec or any v2 SDK line: it drops the `initialize` handshake that Alexa's documented client still sends. Alexa's docs conflict (overview says 2025-11-25, lifecycle example negotiates 2025-03-26), so **accept both** in `initialize`, answer with the version negotiated, and work with no `Mcp-Session-Id` (stateless). Fallback if the SDK fights Lambda: hand-roll `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call` as JSON-RPC over POST (about 150 lines).

**Protocol behaviors (test each):**
- POST JSON-RPC, JSON responses (no SSE needed). `GET` may return 405.
- Validate `Origin`: allow the simulator origin and requests with no Origin; **403** on others.
- Auth: static bearer token for the simulator and Inspector. Add stubs for `/.well-known/oauth-protected-resource` and authorization-server metadata, and a 401 path. Alexa's documented model is OAuth 2.1 + PKCE with static client registration; its docs reportedly describe the 401 behavior specifically. **Re-read** `developer.amazon.com/docs/alexaplus/add-ons/` auth pages before finalizing the 401 response. Full OAuth is out of scope (cut first).
- Return `structuredContent` plus a short text fallback in `content` for every tool.
- Do **not** use MCP Tasks, sampling, or server-initiated elicitation. Do not rely on `_meta.ui` (MCP Apps) except as a stretch goal (verify `ext-apps` works with the 1.x SDK).
- Tool definitions must be deterministic and stable (Alexa locks signatures after publication). No free-text "ask anything" tool. Bound every string (max 200 chars) and use enums.

**Five tools (care-recipient facing):**

1. `get_due_checkins()` → open check-ins for now: `[{occurrenceId, label, prompt, allowedResponses}]`. Marks `PROMPTED`, increments re-ask count when re-served. Prompt text is the caregiver-authored wording.
2. `record_response({occurrenceId, response, utterance?})` → `response` enum: `done | later | not_yet | no | unsure | needs_help`; `utterance` optional, max 200 chars. Runs the rule-based safety layer (section 8) and may **downgrade** `done` to `unsure` or route to the distress/crisis branch. Returns what was recorded in honest wording plus the next step, and the calming line when relevant.
3. `defer_checkin({occurrenceId, until})` → `until` enum: `in_30_min | in_1_hour | after_lunch | this_afternoon | this_evening`. Maps to a concrete time inside the window.
4. `get_my_status()` → today's summary for the person in plain words ("Today: 1 reported, 1 still open") and who is notified, so the person knows what is shared.
5. `pause_checkins({scope})` → `scope` enum: `today | 24_hours`. Always works, no questions asked, tells the caregiver at next digest only.

Tool descriptions must not give medical advice or mention drug names or doses. Alexa+ policy rejects emergency-intervention claims, unattributed medical info, over-collection, reciting private information by voice, and "spying/tracking" language.

## 8. Safety layer (rule-based, on the hot path, no LLM)

- **Hedge detection:** phrases like "I think so", "maybe", "just about to", "not sure", "I guess" turn `done` into `unsure`.
- **Distress branch:** phrases like "where is everyone", "I want to go home", "who are you", "I'm scared" → respond with the caregiver's calming line, **do not re-quiz**, mark `NEEDS_HUMAN`, send the neutral L1 note.
- **Crisis branch:** emergency or self-harm wording ("I fell", "can't breathe", "chest pain", "help me", self-harm phrases) → fixed text only: "If this is an emergency, please call 911 now." Plus `NEEDS_HUMAN`. No promise that anyone is notified immediately.
- **Fail closed:** anything unclassifiable becomes `unsure` or `needs_human`, **never** `done`.
- **Async Bedrock check:** after the response is stored, an async Lambda classifies the utterance. If it disagrees with the stored result in the unsafe direction, flag `needs_human`. This never delays the tool response.
- **Caregiver wording lint:** reject check-in labels/prompts containing drug-like terms (a small denylist), dose patterns (`\d+\s?(mg|mcg|ml|units)`), URLs, or over 80 characters. Use generic wording: "your morning routine", "your lunchtime check".
- **Data minimization:** store utterances ≤200 chars with 30-day TTL, a delete-my-data endpoint, recorded consent with name and date, revocation that takes effect immediately.
- **Not medical advice, not emergency detection.** Scope banner on every surface.

## 9. Caregiver console (static page + API)

Forms and views: create/edit check-ins (label, windows, re-ask minutes, max re-asks, calming line), ladder (L1/L2 contacts, days before L2, cap, quiet hours), **consent record** (recipient name, who recorded it, date, revoke button), timeline/ledger view with honest wording, acknowledge button, pause/delete data.

**Accessibility is a requirement, not a stretch:** semantic HTML, every control labelled, full keyboard use, visible focus, status never conveyed by color alone, large default text, and run axe-core with zero serious/critical violations. (Blind and low-vision users complain about apps that read out only "button, button"; this console should be a counter-example. Do not claim blind users requested this product.)

## 10. Simulated Alexa+ client (demo centerpiece)

A single web page with:
- **Echo panel:** captions of what "Alexa" says (optionally browser `speechSynthesis`), text input for the person's reply (optionally Web Speech API for mic). Banner with label 1.
- **MCP traffic pane:** shows every real JSON-RPC call (`initialize`, `tools/list`, `tools/call`) and response over Streamable HTTP. The browser makes these calls itself (add CORS for the simulator origin on the MCP endpoint).
- **Clock panel:** buttons `+1 hour`, `+5 hours`, `+1 day`, `Reset`, calling the admin clock endpoint. Shows the simulated time prominently.
- **Routine button:** "Simulate morning routine start" (labelled as simulated); triggers `get_due_checkins` and speaks the prompt.
- **Planner:** user reply → Planner Lambda → Bedrock decides which tool to call → browser executes it against the MCP server. Model ID from env `BEDROCK_MODEL_ID`; do not hardcode. If Bedrock is unreachable, fall back to a rule-based planner and show "planner: rules" in the UI.
- No Amazon/Alexa logos or device skins. Use the word "simulated".

## 11. AWS and infra

- **IaC:** AWS SAM (`infra/template.yaml`). Resources: DynamoDB table, MCP/API/Tick/Planner Lambdas (arm64, esbuild bundled, 512–1024 MB), Lambda Function URLs, one EventBridge Scheduler `rate(1 minute)` schedule, SES permissions, scoped Bedrock invoke permission, TTL enabled.
- **SES:** verify the sender identity and **your own recipient addresses** (sandbox only sends to verified addresses; production access takes days, so do not rely on it). Pinpoint is **end of support Oct 30, 2026: do not use it.**
- **Bedrock:** request model access in `us-east-1` tonight. Use the Converse API. Check current model IDs and prices in the console; pick a small, cheap model.
- **Do not** host the MCP endpoint on AgentCore Runtime (its auth model is unverified against Alexa's OAuth expectations). Strands is optional and out of the committed plan.
- **Cost:** stay in free tier; set an AWS Budget alert at $5. Scheduler free tier is ample for a 1-minute rate.
- **Latency:** if p95 exceeds 500 ms including cold starts, enable provisioned concurrency (1) on the MCP Lambda or move it to a tiny always-on container.

## 12. Local run mode (so judges can run it without AWS)

`npm install && npm run dev` must start: the MCP server on `localhost`, the console, and the simulator, with an **in-memory store**, a **fake email sender** that writes HTML files to `./out/emails/` and logs them, the same **simulated clock**, and a **rule-based planner**. Document this first in the README. AWS deployment is a second section.

## 13. Repo layout and conventions

```
README.md  LICENSE (MIT)  BRIEF.md  FRICTION_LOG.md  PRODUCT_FEEDBACK.md
packages/core/        state machine, ledger, safety rules, wording lint, clock (pure TS, unit tested)
packages/mcp-server/  MCP handler (SDK 1.x), tools, auth stubs, Origin check
packages/api/         console API, ack links, admin clock, planner proxy
packages/tick/        scheduler Lambda
apps/console/         static caregiver console
apps/simulator/       static simulated Alexa+ client
infra/template.yaml   SAM
docs/                 architecture.md, demo-script.md
test/                 unit + protocol tests
```

Conventions: strict TypeScript, no `any` in `core`, one `now()` function used everywhere, no secrets in the repo (`.env.example` only), conventional commit messages.

## 14. Phases, hours, gates, cut order

| # | Task | Hours |
|---|---|---|
| 0 | Spike and access gates (section 15) | 2.5 |
| 1 | Data model and simulated clock | 2.0 |
| 2 | MCP server: five tools, stateless Streamable HTTP, Origin and 401 behavior, metadata stubs, static bearer | 4.0 |
| 3 | State machine, idempotent writes, ladder, SES alerts, caps and quiet hours | 5.5 |
| 4 | EventBridge Scheduler, tick Lambda, advance-clock path | 2.5 |
| 5 | Bedrock async classification, safety layer, 20-utterance fail-closed eval | 2.5 |
| 6 | Simulated Alexa+ client: real MCP, planner loop, captions, clock panel | 4.0 |
| 7 | Caregiver console (accessible) | 2.0 |
| 8 | Consent, pause, delete, wording lint, distress branch, crisis redirect | 2.0 |
| 9 | Tests: state machine, Inspector, one second MCP client | 1.0 |
| 10 | SAM deploy and local-run mode | 1.5 |
| 11 | Demo rehearsal, recording, edit | 2.5 |
| 12 | README, per-tool feedback, AWS write-up, friction log, Devpost form | 2.0 |
| | **Committed** | **34.0** |

**Gates (Eastern):** Gate A about 1:00 am Wed: all spike tests pass or you have decided. Gate B about midnight Wed: server, ledger, tick and email work end to end through the Inspector. Gate C about 10:00 pm Thu: feature freeze, then record. Submit by noon Fri.

**Stretch, in priority order (unscheduled):** MCP App check-in card (3 h), Bedrock caregiver weekly digest (1.5 h), full OAuth 2.1 (3.5 h), Strands coordinator (3.5 h).

**Cut order if time runs short:** eval 20→10 utterances; console to a seeded page with one live form; Bedrock distress branch to rules only; second-client test; per-occurrence schedules → single 1-minute schedule (already the default); simulator captions to plain text with the clock panel. **Never cut:** wire-level MCP compliance, state machine and ladder with SES, honest labelling, the video, the public repo with LICENSE and per-tool feedback.

After Gate A, a failed check means **cut scope, not switch ideas**. The fallback idea (Ring "acknowledge until resolved" escalation) needs 25–35 hours and cannot be absorbed late.

## 15. Phase 0 spike tests (do first, report results)

1. **Eligibility (30 min):** the user is asking organizers whether a self-hosted MCP server demoed through a self-built simulated Alexa+ client is judged for Alexa+ track prizes. Do not block on the reply; the FAQ already supports it.
2. **Handshake (75 min):** stateless Streamable HTTP on SDK 1.x. With curl, send a raw legacy `initialize` (protocolVersion `2025-03-26`, no session header) and a `2025-11-25` one. Check deterministic `tools/list`, `structuredContent` with text fallback, 403 on a bad Origin, correct 401 behavior. Pass: MCP Inspector and curl both succeed. If the SDK fights Lambda for over 2 h, hand-roll the three methods.
3. **Latency (30 min):** deploy hello-world to a Lambda Function URL with one DynamoDB read; 50 calls. Pass: p95 under 500 ms including cold starts.
4. **AWS gates (45 min, start immediately):** Bedrock model access, SES sender and recipient verified. If Bedrock is blocked past 2 h: rule-based classifier, mocked Bedrock, and the AWS Builder mini challenge is at risk (SES, DynamoDB, Lambda, EventBridge still count as AWS use; document honestly).
5. **Fail-closed classifier (45 min):** 20 utterances (ambiguous, deferral, refusal, confusion, crisis) through the rules plus a small Bedrock model. Pass: zero ambiguous/confused/crisis replies mapped to `done`. If it fails, restrict to closed-set replies (`yes/later/no`) and use the model only to normalize times.
6. **Proactive/native reminder probe (45 min, not a gate):** search Alexa+ add-on docs for reminders, notifications, and routine invocation for MCP add-ons. Record the answer in FRICTION_LOG.md either way.

## 16. Test plan

- Unit tests for `core`: every transition, double-tick idempotency, window boundaries, ladder levels, daily cap, plan expiry, hedge→`unsure`, distress and crisis branches, consent revoked blocks everything, wording lint.
- Protocol tests: legacy and current `initialize`, `tools/list` stability (snapshot), Origin 403, auth 401, oversize input rejected, enum violations rejected.
- One second MCP client (different from the simulator and Inspector) can list and call tools.
- Console: axe-core run, keyboard-only walkthrough.
- End-to-end script that replays the demo with the simulated clock and asserts the ledger.

## 17. Demo script (aim 2:50, never over 3:00)

| Time | On screen | Beat |
|---|---|---|
| 0:00–0:15 | Title, problem | Alexa+ for builders is partner-gated, so this is a real MCP server with a simulated Alexa+ client. Reminders rarely learn whether the loop closed. |
| 0:15–0:35 | Caregiver console | A daughter writes three check-ins in her own words, sets the ladder, and the parent's consent is recorded. |
| 0:35–1:10 | Simulator, Monday 08:00 | Traffic pane shows EventBridge → Lambda; labelled routine start; reply "I think so, maybe after lunch"; visible `tools/call`; card shows deferred to the 13:00 window. |
| 1:10–1:35 | Clock +5 h | Follow-up, "yes, done", ledger row shows "reported by the person". |
| 1:35–2:10 | Clock +1 day | Prompts unanswered, window closes, plain-wording email ("we did not hear back"), caregiver acknowledges, ladder stops. |
| 2:10–2:35 | Distress case | "I want to go home, where is everyone?" gets the calming line, no re-quiz, neutral "needs human contact" note; crisis wording gets the fixed redirect. |
| 2:35–2:50 | Proof | Inspector listing and calling the same endpoint; AWS services listed; the product-feedback ask for a proactive primitive. |

No copyrighted music. Every simulated element labelled on screen.

## 18. Submission checklist and documents to maintain as you build

- **FRICTION_LOG.md:** add an entry whenever something bites (task, steps, expected vs actual, severity, workaround, suggestion). Known candidates: Alexa docs list 2025-11-25 in the overview but 2025-03-26 in the handshake example; partner gating vs hackathon framing; no documented proactive/notification primitive for MCP add-ons; SDK v2 vs 1.x churn; Pinpoint end of support.
- **PRODUCT_FEEDBACK.md:** one section per tool/API/SDK used (MCP SDK, Alexa+ docs, Lambda, DynamoDB, EventBridge Scheduler, SES, Bedrock, SAM): what used for, what worked, what needs work, onboarding, would build again. Include the AWS Builder description here.
- **Devpost form:** text description, repo URL, video URL, track (Alexa+), mini challenges (AWS Builder; Open Source if confirmed), product feedback, optional feature requests (rate Critical/Important/Nice-to-have: a proactive/notification primitive for MCP add-ons is **Critical**), friction log.
- **Open Source mini challenge:** needs contribution URL, repo URL, GitHub username, and a description of what you did, how it works, and why it matters. The rules say "a **new, additional** open-source project (with an open-source license) **or** a contribution (a branch, a fork, or a pull request) to a public repository during the hackathon window, alongside your primary-track submission." So the main repo alone probably does **not** qualify (it is the primary submission); the organizers are being asked. Plan for the safe route: extract one small reusable piece as a **separate MIT-licensed repo** created during the window, for example a stateless MCP test harness that sends both the legacy (`2025-03-26`) and current (`2025-11-25`) `initialize` forms and checks Origin/401/tool-schema stability. Timebox 2 h; the rules' own "creative" examples are a feature with tests or a new integration pattern, and "README update / typo fix" counts as obvious. This is optional and is cut before anything in section 14's "never cut" list. Only one track prize and one mini-challenge prize can be won per project.
- Public repo: LICENSE detectable at the top of the GitHub page; README with setup and run instructions; `.env.example`; no secrets.
- Video: under 3:00, public, English, YouTube or Vimeo.

## 19. Do not

- Do not use Pinpoint, AgentCore Runtime as the public endpoint, MCP Tasks, server-initiated elicitation, the 2026-07-28 spec, or an MCP SDK v2 line.
- Do not put Bedrock or any network call on the MCP hot path.
- Do not say "confirmed" or "taken". Do not put drug names or doses in prompts or tool text.
- Do not claim Alexa can start the conversation, or that this runs on real Alexa+.
- Do not claim blind or low-vision users asked for this. Accessibility is a design choice here.
- Do not build full OAuth before everything else works.

## 20. Unknowns to resolve (log answers; do not guess)

Alexa+ timeouts and tool-count limits; which header or claim carries user identity; whether routines can invoke an add-on; whether an MCP tool can create native reminders; whether `ext-apps` works with the 1.x SDK; current Bedrock model IDs and prices; US SMS registration (not needed, email only).

## 21. Persistent rules to copy into `CLAUDE.md`

```
- Source of truth: BRIEF.md. Do Phase 0 spikes first.
- Pin @modelcontextprotocol/sdk 1.x. Accept initialize versions 2025-03-26 and 2025-11-25. Stateless.
- MCP tool calls: DynamoDB only, p95 < 500 ms. No Bedrock on the hot path.
- Never write "confirmed". Fail closed to unsure / needs_human.
- Keep FRICTION_LOG.md and PRODUCT_FEEDBACK.md updated as you build.
- Label simulated Alexa+ everywhere. Never invent API shapes; verify or mark unverified.
```
