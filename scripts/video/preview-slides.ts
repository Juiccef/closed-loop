// Renders the static video slides to PNGs for review: npx tsx scripts/video/preview-slides.ts
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { architectureHtml, dedicationHtml, endCardHtml, problemHtml, skillHtml } from './slides';

await mkdir('video/out/stills', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
const skill = skillHtml(await readFile('skills/closed-loop-checkins/SKILL.md', 'utf8'));
for (const [name, html] of [['dedication', dedicationHtml], ['problem', problemHtml], ['skill', skill], ['architecture', architectureHtml], ['end-card', endCardHtml]] as const) {
  await page.setContent(html, { waitUntil: 'networkidle' });
  if (name === 'problem') await page.evaluate(() => (document.body.dataset.step = '2'));
  await page.waitForTimeout(name === 'dedication' ? 3200 : 900);
  await page.screenshot({ path: `video/out/stills/${name}.png` });
}
await browser.close();
