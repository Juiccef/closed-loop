# Closed Loop on a real Echo Show

This runs Closed Loop on your own Echo Show as a **classic Alexa custom skill** in the development stage. The skill is a thin client of the same live MCP server the simulator uses. It is **not an Alexa+ add-on**: add-on tooling is partner-only (FRICTION_LOG #6), and a development-stage custom skill on the developer's own device is the documented way to run on real hardware today.

**Label to show on screen while filming:**

> Real Echo Show. Closed Loop runs here as a classic Alexa custom skill (development stage, on our own device) that calls the same Closed Loop MCP server. It is not an Alexa+ add-on. The reminder uses the Alexa Reminders API, which MCP add-ons can't use.

The Echo Show card says the same thing in its footer.

## How it works

1. Alexa hears what the person says. A catch-all intent passes the words to the skill as Alexa transcribed them.
2. The skill runs the same rules planner the simulator uses, which picks the MCP tool call.
3. The skill makes that call on the live server (`/mcp`, Streamable HTTP) with the existing MCP bearer token, so it acts for the shared `demo` household (Margaret, with Dana as first contact and Sam as second).
4. Alexa reads the server's `say` text exactly as returned. Crisis, self-harm, and distress lines are never changed. If the server can't be reached, emergency and self-harm wording still get the fixed 911 and 988 lines.
5. On an Echo Show, a card shows the same result as the MCP App card: the ring's shape for the status, a title, and a sub line. The voice works without it.
6. **Alexa speaks first through the Reminders API.** The skill can set a reminder for one minute from now (for filming) and a daily reminder at the start of each family check-in. The reminder speaks its text, for example *"Margaret, it's time for your lunchtime check. Say: Alexa, open Closed Loop."* It does not open the skill itself, so it tells Margaret what to say.

Code: `packages/alexa-skill/`. Skill package: `packages/alexa-skill/skill-package/`. Tests: `test/alexa-skill.test.ts`.

## What you need

- Your Echo Show, set up on your Amazon account.
- The Alexa app on your phone, signed in with the same Amazon account.
- An Amazon Developer account that uses **the same Amazon login** as the Echo. A development-stage skill is only available on devices registered to the developer's own account.

## Step 1. Sign in to the Alexa developer console

1. Go to https://developer.amazon.com/alexa/console/ask.
2. Sign in with the same Amazon account your Echo Show uses.
3. If it's your first time, Amazon asks you to fill in a developer profile. Do that yourself; nothing in this repo creates accounts.

## Step 2. Create the skill and copy its skill ID

1. Click **Create Skill**.
2. Name: `Closed Loop`. Locale: **English (US)**.
3. Type of experience: **Other**. Model: **Custom**. Hosting: **Provision your own**. Then **Create skill**, and choose **Start from Scratch** if it asks for a template.
4. Go back to the skills list. Under the skill name, click **Copy Skill ID**. It looks like `amzn1.ask.skill.` followed by a long ID.

(The console's button names can change; the skill ID and "Provision your own" are the parts that matter.)

## Step 3. Put the skill ID in `.env` and deploy

1. Add one line to `.env` in the main checkout (never commit `.env`):

   ```
   ALEXA_SKILL_ID=amzn1.ask.skill.paste-yours-here
   ```

2. Deploy (or ask the main Claude session to). The skill function is only created when `ALEXA_SKILL_ID` is set:

   ```bash
   npm install
   ```

   ```bash
   npm run deploy
   ```

3. The deploy prints its outputs at the end. Copy **SkillFunctionArn**, for example `arn:aws:lambda:us-east-1:123456789012:function:closed-loop-alexa-skill`.

Keep `ALEXA_SKILL_ID` in `.env`: a later deploy without it removes the skill function.

The deploy gives the function an Alexa Skills Kit trigger locked to your skill ID, and the code checks the skill ID on every request as well. Requests for any other skill are refused.

## Step 4. Paste the interaction model

1. In the developer console, open your skill: **Build** tab, **Interaction Model**, **JSON Editor**.
2. Replace everything there with the contents of `packages/alexa-skill/skill-package/interactionModels/custom/en-US.json`.
3. Click **Save Model**. The invocation name is `closed loop`.

## Step 5. Reminders permission, the screen, and the endpoint

All on the **Build** tab:

1. **Permissions** (under Tools): turn on **Reminders**. This is the `alexa::alerts:reminders:skill:readwrite` permission.
2. **Interfaces**: turn on **Alexa Presentation Language** and select the Hub (Echo Show) viewport profiles. Click **Save Interfaces**.
3. **Endpoint**: choose **AWS Lambda ARN** and paste the SkillFunctionArn from step 3 into **Default Region**. Click **Save Endpoints**.
4. Click **Build Model** (or **Build skill**) and wait for "Build Successful".

If you use the ASK CLI instead, `packages/alexa-skill/skill-package/skill.json` has the same settings. Replace `ACCOUNT_ID` in the endpoint with your AWS account ID first.

## Step 6. Turn on testing

On the **Test** tab, set **Skill testing is enabled in** to **Development**.

## Step 7. Allow reminders in the Alexa app

1. In the Alexa app: **More**, then **Skills & Games**, then **Your Skills**, then the **Dev** tab, then **Closed Loop**.
2. Open **Settings** (or **Manage permissions**) and turn on **Reminders**.

The menu names in the Alexa app change between versions. If you can't find it, ask the Echo to set a reminder (step 9). If permission is missing, Alexa says so and sends a card to the Alexa app with the permission switch on it.

## Step 8. Try it in the console simulator

On the **Test** tab, type or say:

- `open closed loop`
- `if I haven't said good night by nine thirty let Dana know`, then `yes`
- `ask closed loop how Mom is doing`

The console's simulator may not ring reminders or show permission cards; test reminders on the Echo (unverified either way).

## Step 9. Try it on the Echo Show

Say **"Alexa, open Closed Loop."** You should hear today's due check-in in the family's words, or *"There are no check-ins right now. What would you like to do?"*, with a card on screen.

## Before filming (main session, with `.env`)

The skill uses the shared `demo` household, whose clock is the deployment-wide demo clock. Reminders ring in real time, so the demo clock must be at real time (offset 0):

```bash
set -a; source .env; set +a; URL=https://nt6jtrc2lercifde5e7plppofi0blcaw.lambda-url.us-east-1.on.aws
```

```bash
curl -s -H "authorization: Bearer $ADMIN_TOKEN" "$URL/admin/clock"
```

If `offsetSeconds` isn't 0, reset it:

```bash
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"reset":true}' "$URL/admin/clock"
```

To start the demo household's day fresh (this deletes today's answers and Margaret's own check-ins in the shared `demo` household only; visitor households are untouched):

```bash
curl -s -X POST -H "authorization: Bearer $ADMIN_TOKEN" "$URL/admin/seed"
```

To watch what the Echo recorded (the ledger the console would show):

```bash
curl -s -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/households/demo/ledger?days=1"
```

The browser console and simulator now open per-visitor households only, so they don't show the shared `demo` household that the Echo uses.

Things to know:

- **Household time is New York time** (the demo household's time zone), and so are the reminders and the deadline you set.
- **"Good night" only counts within 6 hours before the time you set.** "By nine thirty" listens from 3:30 pm to 9:30 pm New York time. Pick a time a few hours after you start filming.
- **Missed family check-ins email Dana too**, up to 3 emails a day. Re-seeding mid-afternoon can close the morning and lunch windows at the next tick and email Dana about them. To keep the daily limit free for the email in Margaret's name, answer the family check-ins on the Echo first.
- **Emergency and distress lines send Dana a real note.** Film them last, or warn Dana's inbox.

## Filming checklist

- [ ] Echo Show: volume around 6, Do Not Disturb off, screen clean.
- [ ] The on-screen label above, in the edit or on a card in shot.
- [ ] Phone showing Dana's inbox (the `SEED_L1_EMAIL` address).
- [ ] Demo clock at offset 0 (above). Fresh seed if you want a clean day.
- [ ] Reminders allowed for Closed Loop in the Alexa app.
- [ ] Do a full dry run once; real ASR may hear names differently ("Dana" as "Donna"). The preview always reads back what was heard before anything is set.

## Exact lines to say

Say each line after the previous answer finishes. Lines in quotes after the arrow are what the server says today; your takes may differ slightly by time of day.

**1. Margaret sets up a check-in in Margaret's own words** (any time before 9:30 pm):

- "Alexa, open Closed Loop."
  - → today's due check-in, or *"There are no check-ins right now. What would you like to do?"*
- "If I haven't said good night by nine thirty, let Dana know."
  - → *"If you haven't said good night by 9:30 pm tonight, I'll email Dana. Should I set that up?"*
- "Yes."
  - → *"Okay, it's set. Say good night any time before 9:30 pm tonight. If I don't hear it, I'll email Dana."*

Use the two-step form above, not "Alexa, ask Closed Loop if I haven't said...": Alexa may drop the "if". The skill puts a dropped "if" back, but the two-step form is safer on camera.

**2. Alexa speaks first** (the Reminders API):

- "Alexa, ask Closed Loop to remind me to check in in one minute."
  - → *"Okay. In 1 minute, I'll remind you to check in."*
- Wait a minute. The Echo plays a reminder: *"Margaret, it's time for your check-in. Say: Alexa, open Closed Loop."* (Alexa adds its own reminder chime and wording around it.)
- "Alexa, open Closed Loop."

Optional, for the daily version: "Alexa, ask Closed Loop to set my daily reminders." → *"Okay. I've set daily reminders at 8 am, noon, and 6 pm. Each one will ask you to open Closed Loop."* Asking again doesn't add duplicates.

**3. An honest answer** (while a family check-in is due, for example the morning one, 8 am to 2 pm):

- "Alexa, open Closed Loop."
  - → *"Good morning, Margaret. Have you done your morning routine yet?"*
- "I think so, maybe after lunch."
  - → *"Okay. I'll ask again around 1 pm."* (recorded as said later, not done)

**4. Good night** (between 3:30 pm and 9:30 pm):

- "Alexa, tell Closed Loop good night."
  - → *"Good night. I've noted it, so Dana won't be emailed about it."*

**5. Dana asks** (the family speaker):

- "Alexa, ask Closed Loop how Mom is doing."
  - → *"Here is what Margaret's check-ins recorded today. … Margaret's “good night” by 9:30 pm: reported by the person. These are Margaret's own answers, recorded as said."*

On one device, the skill treats a question about "Mom" (or Margaret, Grandma) as the family speaking. It only reads the day; it never answers for Margaret. In real life Dana would ask from Dana's own Echo.

**6. Safety lines** (film last; these send Dana a real note):

- "I'm scared." (during a check-in) → *"You're safe at home, Margaret. Dana will give you a call this evening."*
- "I've fallen and I can't get up." → *"If this is an emergency, please call 911 now."*

After a safety line the skill ends the session, so the next "Alexa, ..." goes to Alexa itself (for example, to call someone).

## What is verified and what isn't

Verified against Amazon's documentation:

- Reminders API: `POST /v1/alerts/reminders`, `SCHEDULED_RELATIVE` with `offsetInSeconds`, `SCHEDULED_ABSOLUTE` with `timeZoneId` and `recurrence.recurrenceRules` (`FREQ=DAILY;BYHOUR=…`), `alertInfo.spokenInfo.content`, `pushNotification.status`; reminders can only be created in session; error codes `MAX_REMINDERS_EXCEEDED`, `DEVICE_NOT_SUPPORTED`, `NOT_IN_SESSION`. Request types come from Amazon's `ask-sdk-model`.
- The permission name `alexa::alerts:reminders:skill:readwrite` and the `AskForPermissionsConsent` card.
- APL: `Alexa.Presentation.APL.RenderDocument`, sent only when the device lists `Alexa.Presentation.APL` in `supportedInterfaces`; AVG path properties; viewport profile sizes in `skill.json`.
- Leaving `shouldEndSession` unset on a screen device keeps the card up for up to 30 seconds with the microphone closed.
- SAM `AlexaSkill` event with `SkillId`; the local SAM transform puts the condition on the function, its role, and the Alexa permission.

Unverified (not documented, or only testable on the device):

- Which status code the Reminders API returns when the permission hasn't been granted. The skill treats any 401 (except `NOT_IN_SESSION`) or other 403 as "ask for permission".
- How a classic skill's catch-all slot behaves on an Echo running Alexa+. Another entry runs a development-stage custom skill on an Echo Show under Alexa+, so skills do run there.
- Whether Alexa drops "if" after "ask Closed Loop", and how it transcribes "nine thirty" ("nine thirty", "9:30", or "9 30"). The skill handles each of these.
- The exact wording and chime Alexa plays around a reminder's text.
- Developer console and Alexa app menu names.
- Whether the console simulator rings reminders.
