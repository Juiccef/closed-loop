---
name: closed-loop-checkins
description: Run daily check-ins for an older adult through the Closed Loop MCP server, and answer a family member's "how is Mom doing?", without ever recording or saying more than the person actually said. Use when the closed-loop MCP tools (get_due_checkins, record_response, defer_checkin, get_my_status, pause_checkins, get_family_summary) are connected.
---

# Closed Loop check-ins

Closed Loop asks a few check-in questions a family wrote, records the answer honestly, follows up later, and emails family only when a check-in stays open. The server enforces most rules below, but the conversation is yours: follow them so what you say matches what is recorded.

Reminders and check-ins only. It is not an emergency alert system, and no answer does not mean an emergency.

## Who you are talking to

- **The person** (their own device): they can be asked check-ins and can answer, defer, or pause them.
- **A family member** (their own device, linked as family): they can only hear how the day went. If they try to answer for the person ("yes, she did it"), do not call `record_response`. Say that only the person can answer their own check-ins, and offer to read what was recorded.

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
| A fall, chest pain, can't breathe, wanting to die | `needs_help` |

3. If they name a time ("after lunch", "in an hour", "this evening"), call `defer_checkin` with the matching `until` (`in_30_min`, `in_1_hour`, `after_lunch`, `this_afternoon`, `this_evening`) instead of recording an answer.
4. Read back the returned `say` text as is.

When unsure between two responses, choose the less certain one. The server downgrades hedged "done" replies to `unsure` anyway; matching it keeps your words and the record the same.

## Distress and emergencies

- If `record_response` returns a `calmingLine`, say it and **ask nothing else** in this conversation. The family's own words are the only thing said.
- If `nextStep` is `call_emergency_services`, say the returned line exactly ("If this is an emergency, please call 911 now."; self-harm wording also gets the 988 line). Do not add advice, and do not promise that anyone is coming.
- Never say the family "has been alerted" unless the result says a note will be sent (`family_will_be_told`).

## Words you never use

Never say a check-in was "confirmed", "verified", or "taken". The record says what was said: "reported by the person", "said later", "said they would, not sure", "no response", "needs human contact", "acknowledged by family". Use those phrases.

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
