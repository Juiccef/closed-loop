# Voiceover narration (ElevenLabs)

Nine clips, one per narrated scene of the demo video, after a silent opening card. The opening states the problem with sourced numbers ([impact.md](impact.md)); every figure on screen shows its source. Written for text-to-speech: "Alexa Plus" and "nine one one" are spelled out so they are read correctly. People are referred to by name, never by an assumed pronoun.

Voice: Carolyn (warm, grounded American narrator), model `eleven_v4`. Generated in the ElevenLabs flow "Closed Loop narration".

| # | Seconds | Text |
|---|---|---|
| 0 | 6.5 | *(No narration.)* On screen: "For my grandmother." / "She had dementia. This is what I wish we'd had while she still lived at home." |
| 1 | 10.7 | One in four older Americans with dementia or mild cognitive impairment lives alone. Nearly thirteen million family members and friends care for them, unpaid. *(Cut from the 20.3 s take; the 7.4 million and Alexa Together sentences were removed to make room for the opening card. Both figures stay in the submission text.)* |
| 2 | 16.3 | A reminder can ask the question. It never learns whether the loop closed. Closed Loop is an MCP server for an Alexa Plus add-on. It records what Margaret actually said, follows up later, and tells the family only when the loop stays open. |
| 3 | 16.2 | Margaret's daughter, Dana, writes the check-ins in everyday words. They're read aloud, so medication names and doses are turned away. Dana chooses who gets emailed, and when. And Margaret's consent is recorded. Without it, nothing runs. |
| 4 | 23.5 | Add-ons can't speak first, so a household routine starts the conversation. This is a simulated Alexa Plus client, making real MCP calls, shown on the right. Margaret says: I think so, maybe after lunch. That isn't a yes. The planner picks a tool, and the server records exactly what was said. Later, at one o'clock. |
| 5 | 11.8 | Five hours later, the follow-up Margaret asked for comes first. Now it's a clear yes, recorded as reported by the person. Never as confirmed, because nobody checked. |
| 6 | 19.3 | A day passes, and the lunchtime check was never answered. Every minute, EventBridge Scheduler runs a tick. The window closes, and Amazon SES emails Dana in plain words: we did not hear back. This is not an emergency alert. One click acknowledges it, and the emails stop. |
| 7 | 17.9 | If Margaret sounds confused, the only reply is Dana's own calming words, with no more questions, and Dana gets a gentle note that a call may help. Emergency words get one fixed answer: call nine one one. It never pretends to be an emergency service. |
| 8 | 15.6 | From Dana's own Alexa, Dana asks: how is Mom doing today? Dana hears exactly what was recorded. Needs human contact; a call may help. And Dana's Alexa can't answer for Margaret. Only Margaret can. |
| 9 | 15.0 | The same endpoint passes the official MCP Inspector, links accounts with OAuth the way Alexa Plus add-ons do, and ships an Agent Skill for any agent. It runs on Lambda, DynamoDB, EventBridge and SES. *(Cut from the 20.7 s take after "SES": the "speak first" ask is gone now that the Echo Show shows a workaround.)* |
| 10 | 10.3 | And if Margaret never says good night? Once ten o'clock passes, Dana gets an email in Margaret's name, because Margaret asked for it. Even in quiet hours. |

The Echo Show hero has no narration: the clips keep Alexa's own voice, and each carries a caption and the "real device, classic Alexa skill, not an Alexa+ add-on" label ([video/echo/README.md](../video/echo/README.md)). The final order is in [video/cut.json](../video/cut.json).

If AWS raises the Bedrock quota before recording, scene 9 can say "Lambda, DynamoDB, EventBridge, SES and Bedrock". Until then, leave Bedrock out: the deployed planner is falling back to rules.

## Editing tips

- Lay the clips on the timeline at the scene start times and trim the screen recording to fit the voice, not the other way round.
- Leave the simulator's "Read assistant lines aloud" off while recording, so the assistant does not talk over the narrator.
- No music is needed. If you add any, it must be royalty-free and licensed for this use.
