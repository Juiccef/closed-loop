# Demo video script (target 2:50, never over 3:00)

English, no music (or only royalty-free music you have rights to), no Amazon or Alexa logos. Keep the "Simulated" stamp visible whenever the simulator is on screen. Record at 1920×1080 with the browser at 100% zoom; the simulator is laid out for that width.

## Before recording

1. `npm run deploy` (or `npm run dev` for a local take). Open the simulator and the console in two tabs. Have Gmail open in a third tab, showing the inbox of the verified SES address.
2. In the simulator press **Start a fresh demo day at 7:55 am**, then **+1 hour** once (08:55). Clear the transcript by reloading if needed.
3. Turn **Read assistant lines aloud** on if your browser voice sounds good; otherwise leave captions only.
4. Have a terminal ready with the Inspector command (see 2:35).

## Shot list

| Time | On screen | Do | Say (voiceover) |
|---|---|---|---|
| 0:00–0:15 | Landing page `/` | Let the ring close. | "Reminders ask. Nobody learns whether the loop closed. Closed Loop is an MCP server for an Alexa+ add-on that records what an older adult actually said, follows up, and tells family only when the loop stays open. Alexa+ add-on tooling is partner-only, so this is a real MCP server driven by a simulated client." |
| 0:15–0:35 | Console → Check-ins | Open "your morning routine". In the question field type "take your pills" and let the lint warn; change it back to generic wording. Scroll to **Who we email**, then **Consent**. | "Dana writes the check-ins in her own words. They are read aloud, so medication words and doses are rejected. She chooses who is emailed, and her mother's consent is recorded. Without it, nothing runs." |
| 0:35–1:10 | Simulator at 8:55 | Press **Simulate morning routine start**. Reply chip **"I think so, maybe after lunch"**. Point at the traffic pane: planner → `defer_checkin`, then `tools/call`. Point at the card *said later · ask again at 13:00*. | "A household routine starts the turn; the add-on cannot speak first. Margaret hedges. That is not a yes. The planner picks a tool, and the browser makes a real MCP call over Streamable HTTP. The ledger records exactly what she said: later, at one." |
| 1:10–1:35 | Simulator | Press **+5 hours**, then the routine button. The follow-up comes first. Reply **"Yes, done."** The ring closes. | "Five hours later the follow-up comes first. Now it is a clear yes, recorded as reported by the person, never as confirmed: nobody checked." |
| 1:35–2:10 | Simulator → Gmail → ack page → console | Press **+1 day**. The traffic pane shows the tick closing windows. Switch to Gmail, open "Check-in update: your lunchtime check". Click **Acknowledge**, then **Yes, I've been in touch**. Back in the console the entry reads *acknowledged by Dana*. | "A day passes and the lunchtime check was never answered. The scheduler closes the window and SES emails Dana in plain words: we did not hear back, this is not an emergency alert. One click acknowledges it, and the ladder stops." |
| 2:10–2:35 | Simulator | Routine button, then chip **"I want to go home. Where is everyone?"**. Then **"I fell and I can't get up."** | "If Margaret sounds confused, she hears Dana's own calming line and no more questions, and Dana gets a neutral note. Emergency words get one fixed line: call 911. It never pretends to be an emergency service." |
| 2:35–2:50 | Terminal, then the README architecture | Run the Inspector `tools/list` against the deployed `/mcp`. Show the architecture diagram. | "The same endpoint answers the official MCP Inspector. It runs on Lambda, DynamoDB, EventBridge Scheduler, SES, and Bedrock. What Alexa+ needs next is a consent-gated way for add-ons to speak first." |

## Inspector command for 2:35

```bash
npx @modelcontextprotocol/inspector@2.11.0 --cli "$MCP_URL" --transport http --header "Authorization: Bearer $MCP_BEARER_TOKEN" --method tools/list
```

## If something goes wrong on camera

- Email has not arrived: SES can take up to a minute. The Family email panel in the simulator shows the send as soon as the tick runs.
- Wrong time of day: **Start a fresh demo day** resets the household and puts the clock at 7:55 am.
