# The video's opening: Alexa developer console take, or Echo Show footage

**Current opening: Amazon's Alexa developer console.** Sign in once (`npx tsx scripts/video/console.ts login`; your password is typed by you, in the window it opens), then record the take and build the segment:

```bash
T_SET=3.0 T_YES=12.3 T_NIGHT=14.6 T_END=20.5 npx tsx scripts/video/console.ts record
npx tsx scripts/video/echo.ts --console
npm run video:assemble
```

The console take has no sound, so `video/narration/hero.mp3` plays over it. Every frame is labelled as the developer console simulator, not a real device.

## Echo Show footage (optional, replaces the console take)

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
