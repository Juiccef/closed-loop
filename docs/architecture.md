# Architecture and design decisions

## Components

| Component | Runs on | Job |
|---|---|---|
| Web function | Lambda (arm64, Node 22, 2048 MB) behind one Function URL | `/mcp` (MCP server), console API, signed acknowledge links, admin clock, planner, static pages |
| Tick function | Lambda, invoked by EventBridge Scheduler every minute | Creates the day's check-in occurrences, closes windows, runs the escalation ladder, sends SES email |
| Classifier function | Lambda, DynamoDB Streams with an event filter on new `UTT#` items | Bedrock second opinion on what the person said; can only move a record toward caution |
| Table | DynamoDB, on-demand, single table, TTL, Streams (`NEW_IMAGE`) | Households, consent, check-ins, ladder, occurrences, utterances, audit events, alert counters, clock |
| Keep-warm | EventBridge Scheduler every 5 minutes | One warm instance of the web function (cold start is 0.56–0.64 s; Alexa+ requires < 500 ms) |

## Why one Function URL for MCP and the console

The simulator page must call the MCP endpoint (so the MCP function must allow the page's origin), and the page must learn the MCP endpoint's address. With two Function URLs, each function's environment references the other's URL, and CloudFormation rejects the cycle. Path-routing one URL removes the cycle and the CORS configuration; the MCP hot path is unchanged (DynamoDB only). The tick and classifier stay separate functions.

## Data model (one table)

| Item | PK | SK |
|---|---|---|
| Household | `H#<id>` | `META` |
| Consent record | `H#<id>` | `CONSENT#<recordedAt>` |
| Check-in definition | `H#<id>` | `CHK#<id>` |
| Ladder | `H#<id>` | `LADDER` |
| Occurrence | `H#<id>` | `OCC#<yyyy-mm-dd>#<checkinId>#<windowIdx>` |
| Utterance (≤200 chars, TTL 30 days) | `H#<id>` | `UTT#<occurrenceId>#<at>` |
| Audit event (TTL 90 days) | `H#<id>` | `EVT#<at>#<suffix>` |
| Daily alert counter (TTL) | `H#<id>` | `CAP#<yyyy-mm-dd>` |
| Tick registry | `REGISTRY` | `H#<id>` |
| Simulated clock offset | `CLOCK` | `GLOBAL` |

Every occurrence write is conditional on `version`. A tool call reads the clock, household, consent, check-ins, and ladder in one parallel round trip, then today's occurrences in a second query.

## Occurrence state machine

```
SCHEDULED ──ask──▶ PROMPTED ──"done"──────────▶ REPORTED_DONE
                      │  ├──"later"/"not yet"──▶ DEFERRED ──(deferUntil passes)──▶ re-asked
                      │  ├──"no"───────────────▶ DECLINED   (not re-asked)
                      │  ├──hedged / unclear────▶ UNSURE     (re-asked after the interval)
                      │  └──distress / crisis───▶ NEEDS_HUMAN (sticky until acknowledged; family note)
window closes without REPORTED_DONE ─▶ MISSED (open reason recorded) ─▶ ESCALATED_L1 ─▶ ACKNOWLEDGED
second consecutive unacknowledged day ─▶ ESCALATED_L2 (second contact also told)
paused during the window ─▶ PAUSED (no email)
```

- **Open reasons** decide the wording: `not_reached` (never asked: no conversation happened), `no_answer` (asked, no reply), `said_later`, `not_sure`, `declined`. The ledger never says someone was asked unless `promptedAt` is set.
- **Re-asks** need the caregiver's interval to have passed since the last ask or answer, and stop at the caregiver's maximum. Follow-ups the person asked for come before newly opened check-ins.
- **A late "done"** after the window closed is recorded as *reported by the person (after the window closed)*, cancels any unsent email, and resets the L2 count.
- **L2 escalation** counts consecutive days on which the loop stayed open **and nobody acknowledged**. If the first contact acknowledges, the second contact is not pulled in.

## Sending email exactly once

1. Closing a window is a conditional write: `PROMPTED` (version n) → `MISSED`, `alertStatus: pending` (version n+1). Two ticks racing: one wins, the other gets a conflict and skips.
2. Delivery claims the alert with another conditional write: `pending` → `sending`. Only the winner sends.
3. The daily cap is an atomic `ADD ... IF count < cap` on the counter item.
4. After SES responds, the occurrence moves to `ESCALATED_L1/L2` with `alertStatus: sent`, or `failed` with an attempt count (retried up to 3 times). A claim older than 5 minutes is considered stale and retried.
5. Quiet hours (outside demo mode) hold the alert in `waiting_quiet_hours`. Needs-human notes are never held by the cap or quiet hours, but they count toward the day's total.

Tested by running three ticks concurrently (`test/engine.test.ts`) and by a five-way race on the cap against real DynamoDB (`test/store-contract.test.ts`).

## The simulated clock

There is one `now()`: real time plus an offset stored in the `CLOCK` item. The MCP server, tick, console, and ack page all use it, so moving the clock in the simulator moves the whole system. The admin endpoint runs a tick immediately after a move, which is exactly what the minute schedule does in the background. Acknowledge-link expiry uses real time, not the simulated clock.

## Planner and classifier (Bedrock)

- **Planner**: the browser sends what the person said, the check-in being answered, and the live MCP `tools/list`. The planner converts the tool schemas into Converse `toolSpec`s (`toolChoice: any`, temperature 0, one attempt, 4-second timeout) and returns the tool call. The browser then makes the MCP call itself. On any error it falls back to the rules planner and reports why.
- **Classifier**: a forced `classify` tool returns one of `done | later | not_yet | no | unsure | distress | crisis`. `reviewDecision()` maps that to *agrees*, *flagged_done*, or *escalated_needs_human*; a model failure changes nothing.

Both are deployed and pass Bedrock's request validation; the account's daily token quota is 0, so today both fall back (FRICTION_LOG #7).

## What is deliberately not here

- No server-initiated elicitation, sampling, or MCP Tasks.
- No free-text tool ("ask anything"), no unbounded strings.
- No medical content: no drug names, doses, or advice anywhere in tool text or caregiver-authored prompts (linted).
- No claim that Alexa can speak first, or that this runs on real Alexa+.
