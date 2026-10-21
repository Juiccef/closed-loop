# Voiceover narration (ElevenLabs)

Seven clips, one per scene of [demo-script.md](demo-script.md). Each is sized to its slot at about 2.5 words per second, leaving room for the on-screen action. Written for text-to-speech: "Alexa Plus" and "nine one one" are spelled out so they are read correctly. Margaret is always referred to by name.

Voice: Carolyn (warm, grounded American narrator), model `eleven_v4`. Generated in the ElevenLabs flow "Closed Loop narration".

| # | Slot | Words | Text |
|---|---|---|---|
| 1 | 0:00–0:15 | 41 | A reminder can ask the question. It never learns whether the loop closed. Closed Loop is an MCP server for an Alexa Plus add-on. It records what Margaret actually said, follows up later, and tells the family only when the loop stays open. |
| 2 | 0:15–0:35 | 38 | Margaret's daughter, Dana, writes the check-ins in her own words. They're read aloud, so medication names and doses are turned away. Dana chooses who gets emailed, and when. And Margaret's consent is recorded. Without it, nothing runs. |
| 3 | 0:35–1:10 | 57 | Add-ons can't speak first, so a household routine starts the conversation. This is a simulated Alexa Plus client, making real MCP calls, shown on the right. Margaret says: I think so, maybe after lunch. That isn't a yes. The planner picks a tool, and the server records exactly what was said. Later, at one o'clock. |
| 4 | 1:10–1:35 | 28 | Five hours later, the follow-up Margaret asked for comes first. Now it's a clear yes, recorded as reported by the person. Never as confirmed, because nobody checked. |
| 5 | 1:35–2:10 | 50 | A day passes, and the lunchtime check was never answered. Every minute, EventBridge Scheduler runs a tick. The window closes, and Amazon SES emails Dana in plain words: we did not hear back. This is not an emergency alert. One click acknowledges it, and the emails stop. |
| 6 | 2:10–2:35 | 44 | If Margaret sounds confused, the only reply is Dana's own calming words, with no more questions, and Dana gets a gentle note that a call may help. Emergency words get one fixed answer: call nine one one. It never pretends to be an emergency service. |
| 7 | 2:35–2:50 | 44 | The same endpoint passes the official MCP Inspector, and links accounts with OAuth, the way Alexa Plus add-ons do. It runs on Lambda, DynamoDB, EventBridge and SES. What Alexa Plus needs next is a consent-based way for add-ons to speak first. |

If AWS raises the Bedrock quota before recording, scene 7 can say "Lambda, DynamoDB, EventBridge, SES and Bedrock". Until then, leave Bedrock out: the deployed planner is falling back to rules.

## Editing tips

- Lay the clips on the timeline at the scene start times and trim the screen recording to fit the voice, not the other way round.
- Leave the simulator's "Read assistant lines aloud" off while recording, so the assistant does not talk over the narrator.
- No music is needed. If you add any, it must be royalty-free and licensed for this use.
