# Accessibility

Accessibility is a requirement for the caregiver console, not a stretch goal. It is a design choice; this project does not claim that blind or low-vision users asked for it.

## What the console does

- **Large by default:** 18 px base text, Atkinson Hyperlegible for body text, 44 px minimum targets.
- **Semantic structure:** landmarks (`header`, `nav`, `main`, `footer`), one `h1` per page, section headings, ordered lists for the ledger and activity, a skip link.
- **Every control is labelled.** Field help and errors are tied to inputs with `aria-describedby`; invalid fields get `aria-invalid`. Wording advice from the lint appears as you type, in a polite live region.
- **Status is never color alone.** Each check-in's ring changes shape (open with a gap, closed with a dot, dotted, marked) and is always next to the words ("reported by the person", "no response (not reached)").
- **Keyboard:** everything works with Tab, Shift+Tab, Enter, and Space. Visible 3 px focus outline. Dialogs (`<dialog>`) trap focus and return it. Scrollable regions are focusable. Background polling never re-renders a form while focus is inside it.
- **Buttons say what they do**, with hidden context for screen readers ("I've been in touch: acknowledge your morning routine, 2026-10-21"). Visible text is always part of the accessible name.
- **Motion** respects `prefers-reduced-motion`. **Themes:** light and dark, both checked for contrast.

## axe-core results

axe-core 4 run in a real browser (in-app Chromium) against the local build, with every `<details>` expanded.

| Page | Light | Dark |
|---|---|---|
| Landing `/` | 0 violations | 0 violations |
| Simulator `/simulator/` | 0 violations | 0 violations |
| Console `/console/` (with acknowledge buttons present) | 0 violations | 0 violations |
| Acknowledge page `/ack` | 0 violations | 0 violations |

Issues found and fixed during the audit: white text on the light terracotta button in dark mode (2.46:1, now a dark ink token), scrollable JSON blocks not keyboard-focusable, an `aria-label` on acknowledge buttons that did not contain the visible text, and a missing `h1` on the simulator.

To rerun: start `npm run dev`, open a page, and in the browser console run:

```js
await new Promise((r) => document.head.append(Object.assign(document.createElement('script'), { src: '/__dev/axe.min.js', onload: r })));
(await axe.run()).violations
```

(`/__dev/axe.min.js` is served by the local dev server only.)
