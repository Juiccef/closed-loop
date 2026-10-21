# Demo video script (target 2:50, never over 3:00)

English, no music (or only royalty-free music you have rights to), no Amazon or Alexa logos. Keep the "Simulated" stamp visible whenever the simulator is on screen. Record at 1920×1080 with the browser at 100% zoom; the simulator is laid out for that width.

## Before recording

1. `npm run deploy` (or `npm run dev` for a local take). Open the simulator and the console in two tabs. Have Gmail open in a third tab, showing the inbox of the verified SES address.
2. In the simulator press **Start a fresh demo day at 7:55 am**, then **+1 hour** once (08:55). Clear the transcript by reloading if needed.
3. Leave **Read assistant lines aloud** off: the narrator carries the audio.
4. Have a terminal ready with the Inspector command (see 2:35).

## Shot list

The voiceover is seven ElevenLabs clips; their exact text is in [narration.md](narration.md). Record the screen without sound, then lay each clip at its scene's start time.

| Time | Clip | On screen | Do |
|---|---|---|---|
| 0:00–0:15 | 1 | Landing page `/` | Let the ring close. |
| 0:15–0:35 | 2 | Console → Check-ins, then Who we email, then Consent | Open "your morning routine". In the question field type "take your pills" and let the lint warn; change it back. Scroll through **Who we email** and **Consent**. |
| 0:35–1:10 | 3 | Simulator at 8:55 | Press **Simulate morning routine start**. Click the chip **"I think so, maybe after lunch"**. Point the cursor at the traffic pane (planner → `defer_checkin`, then `tools/call`) and at the card *Said later · Ask again at 13:00*. |
| 1:10–1:35 | 4 | Simulator | Press **+5 hours**, then the routine button. The follow-up comes first. Click **"Yes, done."** The ring closes. |
| 1:35–2:10 | 5 | Simulator → Gmail → acknowledge page → console | Press **+1 day**; the traffic pane shows the tick. Switch to Gmail and open "Check-in update: your lunchtime check". Click **Acknowledge**, then **Yes, I've been in touch**. Back in the console the entry reads *acknowledged by Dana*. |
| 2:10–2:35 | 6 | Simulator | Routine button, then **"I want to go home. Where is everyone?"**, then **"I fell and I can't get up."** |
| 2:35–2:50 | 7 | Terminal, then the simulator's **Link with OAuth 2.1** (optional), then the README architecture diagram | Run the Inspector `tools/list` against the deployed `/mcp`. Optionally show the sign-in page with a link code for two seconds. End on the architecture diagram. |

## Inspector command for 2:35

```bash
npx @modelcontextprotocol/inspector@2.11.0 --cli "$MCP_URL" --transport http --header "Authorization: Bearer $MCP_BEARER_TOKEN" --method tools/list
```

## If something goes wrong on camera

- Email has not arrived: SES can take up to a minute. The Family email panel in the simulator shows the send as soon as the tick runs.
- Wrong time of day: **Start a fresh demo day** resets the household and puts the clock at 7:55 am.
