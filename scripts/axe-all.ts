// Accessibility audit: axe-core on every page, light and dark, at the demo viewport.
// Usage: npm run dev (in another terminal), then: npx tsx scripts/axe-all.ts [base-url] [access-code] [ack-url]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const CODE = process.argv[3] ?? 'local-dev';
const ACK = process.argv[4];
const axeSource = await readFile(join(import.meta.dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const authorize = `${BASE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'simulator', redirect_uri: `${BASE}/simulator/linked.html`, scope: 'mcp:tools', state: 'audit', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', resource: `${BASE}/mcp` })}`;

async function prepare(page: Page, name: string) {
  if (name === 'console') {
    await page.locator('.checkin').first().waitFor();
    await page.evaluate(() => ((document.querySelector('.checkin') as HTMLDetailsElement).open = true));
    await page.click('#make-code');
    await page.waitForTimeout(500);
  }
  if (name === 'simulator') {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#traffic .t-method')).some((e) => e.textContent?.includes('tools/list')));
    await page.click('#routine');
    await page.waitForTimeout(1500);
    await page.click('.chip >> nth=0');
    await page.waitForTimeout(2500);
    await page.click('#link-oauth');
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector('#traffic details')?.setAttribute('open', ''));
  }
  if (name === 'simulator tour') {
    // Mid-tour, so done, current, and upcoming steps are all on screen.
    const ready = (label: string) =>
      page.waitForFunction((l) => document.querySelector('#tour-next')?.getAttribute('aria-disabled') === 'false' && document.querySelector('#tour-next')?.textContent?.startsWith(l), label, { timeout: 20_000 });
    await ready('Start:');
    await page.click('#tour-next');
    await ready('Next: Good night');
    await page.click('#tour-next');
    await ready('Next: Dana asks');
    await page.waitForTimeout(400); // the button's color transition as it re-enables
  }
}

const pages: Array<[string, string]> = [
  ['landing', `${BASE}/`],
  ['console', `${BASE}/console/`],
  ['simulator', `${BASE}/simulator/`],
  ['simulator tour', `${BASE}/simulator/?tour=good-night`],
  ['sign-in', authorize],
  ...(ACK ? ([['acknowledge', ACK]] as Array<[string, string]>) : []),
];

const browser = await chromium.launch();
let total = 0;
for (const scheme of ['light', 'dark'] as const) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, colorScheme: scheme, bypassCSP: true });
  await context.addInitScript(`try { sessionStorage.setItem('closed-loop-access-code', ${JSON.stringify(CODE)}); } catch {}`);
  for (const [name, url] of pages) {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle').catch(() => {});
    await prepare(page, name);
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      // @ts-expect-error axe is injected above
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
      return r.violations.map((v: { id: string; impact: string; nodes: Array<{ target: string[]; failureSummary?: string }> }) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1, 2).join(' ').trim()}`) }));
    });
    total += violations.length;
    console.log(`${scheme.padEnd(5)} ${name.padEnd(15)} ${violations.length ? `${violations.length} violation(s)` : '0 violations'}`);
    for (const v of violations) console.log(`   ${v.id} (${v.impact})\n     ${v.nodes.join('\n     ')}`);
    await page.close();
  }
  await context.close();
}
await browser.close();
process.exit(total ? 1 : 0);
