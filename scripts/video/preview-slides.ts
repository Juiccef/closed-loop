// Renders the static video slides to PNGs for review: npx tsx scripts/video/preview-slides.ts
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { architectureHtml, endCardHtml } from './slides';

await mkdir('video/out/stills', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
for (const [name, html] of [['architecture', architectureHtml], ['end-card', endCardHtml]] as const) {
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `video/out/stills/${name}.png` });
}
await browser.close();
