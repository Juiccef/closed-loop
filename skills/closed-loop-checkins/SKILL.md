---
name: closed-loop-checkins
description: Run daily check-ins for an older adult through the Closed Loop MCP server, and answer a family member's "how is Mom doing?", without ever recording or saying more than the person actually said. Use when the closed-loop MCP tools (get_due_checkins, record_response, defer_checkin, get_my_status, pause_checkins, get_family_summary, set_my_checkin, cancel_my_checkin) are connected.
---

# Closed Loop check-ins

Closed Loop asks a few check-in questions a family wrote, records the answer honestly, follows up later, and emails family only when a check-in stays open. The server enforces most rules below, but the conversation is yours: follow them so what you say matches what is recorded.

Reminders and check-ins only. It is not an emergency alert system, and no answer does not mean an emergency.

## Who you are talking to

- **The person** (their own device): they can be asked check-ins and can answer, defer, or pause them, and set up or cancel check-ins of their own.
- **A family member** (their own device, linked as family): they can only hear how the day went. If they try to answer for the person ("yes, she did it"), do not call `record_response`. Say that only the person can answer their own check-ins, and offer to read what was recorded. A family member can never set up, change, or cancel the person's own check-ins.

## Asking (the person)

1. Call `get_due_checkins`. Ask each returned `prompt` exactly as written, one at a time, in order. Never reword it and never ask the same one twice in a turn.
2. Map the reply to one `response` and pass their own words as `utterance` (max 200 characters):

| They say | response |
|---|---|
| "Yes, all done." / "Yep, I did it this morning." | `done` |
| "I think so", "probably", "I don't remember", "sort of" | `unsure` (never `done`) |
| "Not yet." | `not_yet` |
| "No, I don't want to." | `no` |
| Confused, scared, "I want to go home", "who are you?" | `needs_help` |
| "Help!", "I need help" (not "help me with the remote") | `needs_help` |
| A fall, chest pain, can't breathe, wanting to die | `needs_help` |

3. If they name a time ("after lunch", "in an hour", "this evening"), call `defer_checkin` with the matching `until` (`in_30_min`, `in_1_hour`, `after_lunch`, `this_afternoon`, `this_evening`) instead of recording an answer.
4. Read back the returned `say` text as is.

When unsure between two responses, choose the less certain one. The server downgrades hedged "done" replies to `unsure` anyway; matching it keeps your words and the record the same.

## Distress and emergencies

- If `record_response` returns a `calmingLine`, read the returned `say` and **ask nothing else** in this conversation. It is the family's own words; after a bare "Help!" it also ends with the 911 line.
- If they sound upset, ask for help, or use emergency words when no check-in is in progress, still call `record_response`: no `occurrenceId`, response `needs_help`, and their words. The server records it and tells the family, and the returned `say` is the line to read.
- If `nextStep` is `call_emergency_services`, say the returned line exactly ("If this is an emergency, please call 911 now."; self-harm wording also gets the 988 line). Do not add advice, and do not promise that anyone is coming.
- Never say the family "has been alerted" unless the result says a note will be sent (`family_will_be_told`).

## Words you never use

Never say a check-in was "confirmed", "verified", or "taken". The record says what was said: "reported by the person", "said later", "said they would, not sure", "no response", "needs human contact", "acknowledged by family". Use those phrases.

## Check-ins the person sets up

The person can set up a check-in of their own: "If I haven't said good night by ten, let Dana know."

1. Call `set_my_checkin` with `phrase` ("good night"), `by` in 24-hour `HH:MM` ("22:00"), `tell` (the contact's first name or relation, if given), `repeat` (`tonight`, or `daily` for "every night"), and their words as `utterance`. This only previews; nothing is stored.
2. Read the returned `say` exactly and wait for the person's answer. Never make the second call without asking.
3. Call `set_my_checkin` again with only the returned `confirmToken` and the person's own answer as `utterance`. The server creates it only for a clear yes; anything else leaves nothing set. Read back `say`.
4. These are never asked. When the person later says the phrase ("Good night"), call `get_my_status` if you do not already know the check-in's `occurrenceId` (it is in `mine`), then `record_response` with that `occurrenceId`, `response` `done`, and their words.
5. "Cancel my good night check": `cancel_my_checkin` with the phrase. Always honor it.

If `nextStep` is `call_emergency_services` here too, say the returned line exactly and stop.

## Status and pausing

- "How am I doing today?" or "who sees this?": call `get_my_status` and read its `say`.
- "Stop asking today" or "pause for a day": call `pause_checkins` (`today` or `24_hours`) without asking why.

## Family asking about the day

Call `get_family_summary` and read its `say` exactly. Each check-in comes with its recorded wording; do not upgrade it ("not sure" is not "done", "no response" is not "missed on purpose"). If it says a call may help, say so plainly, without alarm.

## Speaking first

MCP add-ons have no documented way to speak first. Start check-ins only when the person, a household routine, or the user starts the conversation.

## Connecting

The server is a stateless Streamable HTTP MCP endpoint (protocol 2025-11-25 or 2025-03-26) at `/mcp`. With Claude Code:

```bash
claude mcp add --transport http closed-loop https://<your-deployment>/mcp --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Copy this folder to `~/.claude/skills/closed-loop-checkins/` (or a project's `.claude/skills/`) so the agent loads these rules when the tools are in use.
