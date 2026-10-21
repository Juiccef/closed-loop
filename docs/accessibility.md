# Accessibility

Accessibility is a requirement for the caregiver console, not a stretch goal. It is a design choice; this project does not claim that blind or low-vision users asked for it.

## What the console does

- **Readable by default:** the system San Francisco type at 16 px (17 px for ledger rows and statuses), buttons 38 px tall (32 px for small ones) and inputs 40 px, all above the WCAG 2.2 AA 24 px target minimum.
- **Semantic structure:** landmarks (`header`, `nav`, `main`, `footer`), one `h1` per page, section headings, ordered lists for the ledger and activity, a skip link.
- **Every control is labelled.** Field help and errors are tied to inputs with `aria-describedby`; invalid fields get `aria-invalid`. Wording advice from the lint appears as you type, in a polite live region.
- **Status is never color alone.** Each check-in's ring changes shape (open with a gap, closed with a dot, dotted, marked) and is always next to the words ("reported by the person", "no response (not reached)").
- **Keyboard:** everything works with Tab, Shift+Tab, Enter, and Space. Visible 2 px focus ring with an offset, themed for the dark navigation bar and traffic pane. Dialogs (`<dialog>`) trap focus and return it. Scrollable regions are focusable. Background polling never re-renders a form while focus is inside it.
- **Buttons say what they do**, with hidden context for screen readers ("I've been in touch: acknowledge your morning routine, 2026-10-21"). Visible text is always part of the accessible name.
- **Motion** respects `prefers-reduced-motion`. **Themes:** light and dark, both checked for contrast.

## axe-core results

axe-core 4 (WCAG 2.0/2.1/2.2 A and AA plus best practices) run in Chromium at the demo viewport (1536×864) by `scripts/axe-all.ts`, after the redesign to the current design system (DESIGN.md). The console runs with a check-in expanded and a link code shown; the simulator runs after a routine, a reply with its MCP App card, and an OAuth link card.

| Page | Light | Dark |
|---|---|---|
| Landing `/` | 0 violations | 0 violations |
| Console `/console/` | 0 violations | 0 violations |
| Simulator `/simulator/` | 0 violations | 0 violations |
| Sign-in `/oauth/authorize` | 0 violations | 0 violations |
| Acknowledge page `/ack` | 0 violations | 0 violations |

Issues found and fixed during the redesign audit: blue text on the light-blue selected state (4.29:1, now the darker blue), a footer link on the grey ground (4.33:1, links now use the darker blue), and the simulated-client notice bar sitting outside any landmark (now an `aside`). Earlier audits fixed contrast on a dark-mode button, unfocusable scrollable JSON blocks, an acknowledge-button `aria-label` that did not contain the visible text, and a missing `h1` on the simulator.

To rerun: start `npm run dev`, then

```bash
npx tsx scripts/axe-all.ts http://localhost:5173 local-dev "<an /ack link from out/emails>"
```

The script bypasses the sign-in page's CSP only inside the test browser so axe can be injected.
