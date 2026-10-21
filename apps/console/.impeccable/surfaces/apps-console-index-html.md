---
version: 1
slug: "apps-console-index-html"
primary_target: "apps/console/index.html"
related_targets: ["apps/simulator/index.html","apps/index.html"]
---

# Closed Loop web UI (console, simulator, landing, sign-in, acknowledge, MCP card)

Mode: Operate (console, simulator, sign-in, acknowledge, card); landing is a two-door chooser into them.
Audience: a family caregiver first (short, worried sessions on a laptop), hackathon judges second (3-minute video at 1920x1080, 125% scaling).
Constraints: all JS/recorder IDs and data attributes stay; honest wording and the three required labels stay; WCAG 2.2 AA, axe zero in light and dark.
Direction: user-pinned canon. Amazon product UI (Cloudscape conventions) with Apple polish. Sits alongside the AWS Management Console and Apple's iCloud web apps / System Settings; their craft level is the bar.

## Direction contract

THESIS: The caregiver's day as a console-grade status view: every check-in is a status indicator (the loop ring plus words), arranged in Cloudscape's app layout with Apple's large titles and grouped lists. Refuses the warm-paper serif "care app" look and the metric-tile SaaS dashboard.

OWN-WORLD: Grouped grey ground (#f2f3f5), white containers with 16px radius and a soft offset shadow, dark top navigation (#0f141a), one action blue (#0972d3) for primary actions, links and selection; status colours green, amber, red, grey only where they mean something. System SF stack throughout, SF Mono only for protocol traffic and codes. Pill buttons, 2px blue focus ring, hairline separators inside lists.

STORY: Dana learns today's state in one line, scans the ledger, acknowledges an open loop, rewrites a check-in, and leaves calmer. A judge sees a product that could ship in an AWS or Apple portfolio and believes the honesty claims because the status language is precise.

FIRST VIEWPORT: Console: 56px dark top nav (ring mark, product name, link to the simulated client); 248px side navigation listing the seven sections with a current marker; content column with a 34px bold large title "Margaret's check-ins", date beneath, an overview container of four key-value pairs (status, plan, emails today, household time), then the Today container whose rows lead with the ring status indicator. Primary action: "I've been in touch" on rows that need it. Simulator: same top nav, a full-width simulated-client notice bar, three columns (conversation, clock + loops + email, MCP traffic code panel).

FORM: Canon, played straight (user-pinned standing exit, not a rolled direction). Signature move: the loop ring as the status icon everywhere, closing (arc to full circle, then dot) when a loop closes. seed: none (not rolled: the user pinned the direction, which beats the roll)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
