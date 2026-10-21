# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: a family caregiver** (in the demo, Dana) who sets up daily check-ins for a parent who lives alone (Margaret) and acts on what comes back. Their job: see at a glance which check-ins closed and which stayed open today, acknowledge an alert once they have been in touch, write or adjust check-ins in their own words, choose who gets emailed, and record or revoke the parent's consent. They use it in short sessions, often worried, often on a laptop between other things.
- **Secondary: hackathon judges** watching the 3-minute demo video and opening the live demo. They evaluate the same screens; the design serves the caregiver's real job and the demo shows that job.

## Product Purpose

Closed Loop is a self-hosted MCP server for an Alexa+ add-on, plus a caregiver console and a simulated Alexa+ client. It asks a few check-in questions the family wrote, records what the person actually said, follows up later, and emails a family member only when a loop stays open. Success: the caregiver learns the truth about the day without being alarmed by noise, and nothing is ever recorded as more certain than it was said.

## Positioning

Most reminders ask and never learn whether the loop closed. Closed Loop's ledger is honest by construction: a hedged "I think so" is recorded as "said they would, not sure", never as done; "no response" distinguishes "not reached" from "asked, no answer"; distress gets the family's own calming words instead of more questions. It is explicitly not an emergency alert system.

## Operating Context

- Caregiver console: today's ledger, check-in editor (with wording lint), contacts and escalation ladder, consent record, link a voice assistant (OAuth link codes), pause and delete data, activity log.
- Simulated Alexa+ client (demo centerpiece): conversation captions, a "who is speaking" switch (the person, or a family member asking from their own assistant), a simulated clock (+1 hour, +5 hours, +1 day), today's loops, family email panel, live MCP JSON-RPC traffic pane, MCP App cards.
- Landing page, OAuth sign-in page, and acknowledge page (opened from family emails).
- Demo video recorded at 1920×1080 (browser at 125% scaling), narrated, opening with the problem in sourced numbers (`docs/impact.md`).

## Capabilities and Constraints

- Static vanilla HTML/CSS/JS in `apps/` (no build step), served by the same Lambda as the MCP endpoint; `apps/shared/base.css` and `apps/shared/app.js` are shared.
- JavaScript depends on existing element IDs, classes, and data attributes (e.g. `#ledger-today`, `#traffic`, `.chip[data-say]`, `[data-adv]`, `.checkin[data-id]`, `#demo-start`); the video recorder (`scripts/video/record.ts`) depends on them too.
- Fonts may load from Google Fonts only; other assets inline.
- Wording rules: never "confirmed" or "taken"; ledger statuses are "reported by the person", "said later", "said they would, not sure", "no response (not reached / asked, no answer)", "needs human contact", "acknowledged by …".

## Brand Commitments

- Name: Closed Loop. Mark: a ring that is open (a gap) or closed.
- Required labels on every relevant surface: "Simulated Alexa+ client. Not Amazon software…", "Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.", "Check-in conversations are started by the person, a household routine, or the simulator…".
- The person is referred to by name or "they"; no assumed pronouns.
- No Amazon or Alexa logos or device skins.
- Visual direction requested by the user (binding): look professional, like Amazon's product UI (Cloudscape conventions) combined with Apple's polish; not "vibe-coded".

## Evidence on Hand

- Working app, deployed on AWS; 102 automated tests; axe-core zero violations recorded in `docs/accessibility.md`.
- Demo narration audio in `video/narration/`. No testimonials, customers, or usage numbers exist; do not invent any.

## Product Principles

1. Never more certain than what was said.
2. Tell a human only when a loop stays open; calm by default, never alarming.
3. The family is in charge, with the person's consent; off means off.
4. Honest about limits: simulated client, not an emergency service, no proactive speech.
5. Accessible to everyone who might need it.

## Accessibility & Inclusion

WCAG 2.2 AA: axe-core zero violations in light and dark, full keyboard use, visible focus, status never conveyed by color alone, large default text, labelled controls and errors tied to fields. A design choice, not a claim that blind or low-vision users asked for it.
