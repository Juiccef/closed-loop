---
name: Closed Loop
description: Daily check-ins that close the loop. A console-grade status view for family caregivers, with a simulated Alexa+ client.
colors:
  action-blue: "#0972d3"
  action-blue-hover: "#065bb0"
  action-blue-press: "#044a91"
  action-blue-soft: "#eaf3fc"
  grouped-ground: "#f2f3f5"
  surface: "#ffffff"
  surface-inset: "#f7f8fa"
  fill: "#eceef1"
  fill-hover: "#e1e4e8"
  ink: "#0f141a"
  slate-secondary: "#5b6573"
  separator: "#e3e6ea"
  control-border: "#8c939d"
  reported-green: "#037f0c"
  reported-green-soft: "#ebf6ec"
  past-window-amber: "#8d6605"
  past-window-amber-soft: "#fcf5e3"
  human-red: "#d01a1a"
  human-red-soft: "#fdeeee"
  console-night: "#0f141a"
  console-night-row: "#222a35"
  console-night-dim: "#96a1ae"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.022em"
  container-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  row-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  protocol:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "8px"
  callout: "12px"
  container: "16px"
  pill: "999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "16px"
  container-x: "24px"
  section: "24px"
  page-x: "40px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "7px 18px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.action-blue-hover}"
  button-normal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.action-blue}"
    rounded: "{rounded.pill}"
    padding: "7px 18px"
    height: "38px"
  button-normal-hover:
    backgroundColor: "{colors.action-blue-soft}"
    textColor: "{colors.action-blue-hover}"
  button-danger-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.human-red}"
    rounded: "{rounded.pill}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
    height: "40px"
  container:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.container}"
    padding: "20px 24px"
  top-navigation:
    backgroundColor: "{colors.console-night}"
    textColor: "#f2f3f5"
    height: "56px"
  side-navigation-item-current:
    backgroundColor: "{colors.action-blue-soft}"
    textColor: "{colors.action-blue-hover}"
    rounded: "{rounded.control}"
  chip:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "32px"
  traffic-pane:
    backgroundColor: "{colors.console-night}"
    textColor: "#e6e9ee"
    typography: "{typography.protocol}"
    rounded: "{rounded.container}"
---

# Design System: Closed Loop

## Overview

**Creative North Star: "The Honest Status Console"**

Closed Loop looks like a product from a large, careful platform team: Amazon's product-UI conventions (app layout, containers with headers, status indicators that pair an icon with words, pill buttons, a dark top navigation bar) with Apple's polish (the system San Francisco type, large titles, grouped inset lists, quiet materials). The caregiver opens it worried and short on time; the interface answers "what happened today" in one line and never sounds more certain than the person did.

Every check-in's state is drawn as the loop ring, the product's mark: open with a gap while it waits, closed with a dot when the person reported it, red with a mark when a human should call. The ring is the status icon everywhere, from the ledger to the MCP App card, and it is always paired with the exact recorded words.

**Key Characteristics:**
- Grouped grey ground, white containers, one dark navigation bar.
- One action colour (blue) for primary actions, links, selection, and open loops.
- Status colours appear only where they carry meaning, and always with words.
- System type throughout; monospace only for protocol traffic and link codes.
- Dense where the job is reading (traffic, activity), generous where the job is deciding (ledger, consent).

## Colors

Restrained: cool neutrals plus one blue, with three status hues reserved for meaning.

### Primary
- **Action Blue** (#0972d3): primary buttons, the open-loop ring, selection. Text in this blue sits only on white; on tinted fills and the grey ground use **Action Blue Hover** (#065bb0) for 4.5:1.

### Status
- **Reported Green** (#037f0c): "reported by the person" rings and wording, the active plan.
- **Past-window Amber** (#8d6605): a loop still open after its window; plans that need attention.
- **Human Red** (#d01a1a): "needs human contact" and destructive actions only.
- **Slate Secondary** (#5b6573): waiting, paused, acknowledged, and all secondary text.

### Neutral
- **Grouped Ground** (#f2f3f5), **Surface** (#ffffff), **Surface Inset** (#f7f8fa) for quoted words and previews, **Fill** (#eceef1) for chips, assistant bubbles and segmented tracks, **Separator** (#e3e6ea) for hairlines, **Control Border** (#8c939d, 3:1 against white) for inputs.
- **Console Night** (#0f141a): the top navigation and the MCP traffic pane, the same colour so the protocol view reads as part of the product's chrome.

Dark mode keeps the roles and lifts the hues (blue #5aa7f0, green #4cc35a, amber #e5b941, red #ff7a7a) on #0e1013 ground and #1a1d22 surfaces; text on filled blue and red buttons turns dark.

**The Words-First Rule.** No status is shown by colour alone. Every ring sits beside its recorded wording; every status indicator has an icon shape and a label.

**The One Blue Rule.** Blue means "you can act" or "still open". It never decorates.

## Typography

**Display Font:** the system San Francisco stack (SF Pro Display on Apple platforms, Segoe UI or Roboto elsewhere)
**Body Font:** the same stack (SF Pro Text)
**Label/Mono Font:** ui-monospace / SF Mono, for JSON-RPC traffic, endpoint paths and link codes only

**Character:** one well-tuned sans for everything, as in Apple and AWS product UI. Hierarchy comes from size and weight steps, never from a second family.

### Hierarchy
- **Large Title** (700, 34px, -0.022em): one per page, the person's name ("Margaret's check-ins"). 56px on the landing page.
- **Container Title** (700, 20px): each container's heading.
- **Row Title** (600, 17px): check-in labels in the ledger and lists; recorded wording beneath it in 600 and the status colour.
- **Body** (400, 16px, 1.5): descriptions and messages. Conversation bubbles are 16px.
- **Label** (600, 14px): form labels, key-value terms.
- **Caption** (400, 13px): help text, metadata, timestamps (tabular numerals).
- **Protocol** (mono, 12px): traffic rows and JSON.

**The Sentence-Case Rule.** Stored wording is lowercase ("reported by the person"); the UI capitalises only the first letter with `::first-letter`, so the recorded words are never rewritten.

## Layout

- **Console:** sticky 56px top navigation; 248px side navigation with the current section marked; content column centred at max 74rem with 40px side padding; one container per job, 24px apart. Under 1000px the side navigation becomes a sticky scrolling tab row.
- **Simulator:** top navigation, a full-width simulated-client notice bar, then three columns (conversation 1.1fr, clock/loops/email 0.84fr, traffic 1.06fr) whose two outer panes fill the viewport and scroll inside, leaving the footer notices visible at 1536×864. Two columns under 1180px, one under 760px.
- **Containers:** 20px top / 24px side padding for the header; lists run full-bleed inside the container with hairline separators and 24px row insets.
- **Rhythm:** 4/8/16/24px steps; more space above a container title than below it.

## Elevation & Depth

Flat with one lift. Containers carry a single soft offset shadow (`0 1px 2px` plus a `0 2px 12px` ambient), never a border as well; in dark mode the shadow is dropped for a 1px #2a2f36 border. Dialogs, toasts and hovered doors on the landing page use the high elevation (`0 4px 12px` + `0 16px 48px`). No glass, no blur.

## Shapes

- Containers 16px, callouts and alerts 12px, controls 8px.
- Buttons, chips, the reply input and badges are full pills.
- The loop ring: 3.4px stroke on a 24-unit circle, round caps; open states leave a gap, closed states are a full circle.

## Components

- **Buttons:** primary is filled Action Blue with white text; normal is white with a 2px blue outline and blue text; destructive is the normal shape in Human Red (filled red only inside a confirm dialog). 38px tall, 32px small. Disabled turns to Fill with slate text.
- **Inputs:** 40px, 1px Control Border, 8px radius, blue border on focus plus the global 2px focus ring.
- **Switch:** a checkbox with `role="switch"`, 44×26, blue when on.
- **Status indicator (`.pill`):** icon mask plus 600-weight label: check-circle green (active), pause slate (paused), warning amber (needs attention).
- **Alert (`.notice`):** info icon, Action Blue Soft fill, 1px blue-tinted border, 12px radius. Carries the required "not an emergency alert system" label.
- **Badge (`.stamp`):** amber-soft pill, used for "Simulated" and "Simulated time".
- **Ledger row:** ring, row title, recorded wording in the status colour, facts separated by middots, quoted words on Surface Inset, one action on the right ("I've been in touch").
- **Segmented button group:** the clock controls; Fill track, transparent segments, white lift on hover.
- **Conversation:** assistant bubbles on Fill, the person's replies on Action Blue, system lines as small centred captions.
- **Traffic pane:** Console Night, kind tags as small tinted mono labels (MCP green, planner indigo, MCP App blue, tick amber, error red), rotating chevrons.

**The Ring-Closes Rule.** The only authored motion: when a loop's state changes to closed, its ring sweeps shut (0.8s ease-out) and the dot lands. Everything else is a 150–250ms state transition.

## Do's and Don'ts

### Do:
- **Do** pair every ring and colour with the exact recorded wording.
- **Do** keep blue for actions and open loops only.
- **Do** keep the three required labels visible on every relevant surface: simulated client, not an emergency alert system, who starts conversations.
- **Do** keep text on tinted fills at Action Blue Hover or darker so it holds 4.5:1.
- **Do** use system type and size/weight steps for hierarchy.

### Don't:
- **Don't** use Amazon or Alexa logos, device skins, or the Amazon orange.
- **Don't** add kickers or eyebrows above headings; the date and context go beneath the title.
- **Don't** use coloured side stripes on rows or alerts; status lives in the ring and the words.
- **Don't** draw icons with Unicode glyphs or emoji; use the masked SVG set or inline SVG.
- **Don't** return to the warm paper, serif, and terracotta look this system replaced.
- **Don't** write "confirmed" or "taken" anywhere in the interface.
