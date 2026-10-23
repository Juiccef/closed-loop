# Echo Show footage for the demo video

Put the phone clips here, named by shot. Landscape, the Echo Show screen filling most of the frame, phone held still (a stand helps), the room quiet so Alexa is clearly heard. Any phone format works (`.mov`, `.mp4`, `.m4v`; 1080p or 4K; 30 or 60 fps). The clips are not committed.

| File | Shot | Keep it to |
|---|---|---|
| `a.mov` | The reminder rings and Alexa speaks first | about 8 s |
| `b.mov` | "If I haven't said good night by ten thirty, let Dana know" → Alexa reads it back → "Yes" | about 10 s |
| `c.mov` | "Alexa, tell Closed Loop good night" → the card on screen | about 7 s |
| `d.mov` *(optional)* | "Alexa, ask Closed Loop how Mom is doing" | about 8 s |
| `e.mov` *(optional)* | "I think so, maybe after lunch" | about 8 s |

Start each clip a second before the first word and stop a second after the last. Trim points and the caption under each clip are in `cut.json` (`start` and `end` in seconds; `null` means the whole clip).

Build the hero segment, then the video:

```bash
npx tsx scripts/video/echo.ts            # a, b, c  →  video/echo/build/hero.mp4
npx tsx scripts/video/echo.ts --with d,e # also the optional shots
npm run video:assemble                   # follows video/cut.json
```

Every frame of the hero carries the label from `cut.json`: real Echo Show, a classic Alexa custom skill in development stage calling the same MCP server, not an Alexa+ add-on (wording from `docs/echo-show.md`).
