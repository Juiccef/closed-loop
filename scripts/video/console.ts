// Records Closed Loop in Amazon's Alexa developer console simulator (the skill's Test tab), as the video's opening.
// The sign-in is yours: this never types a password. The session is kept in a local browser profile
// (video/echo/build/console-profile, not committed) so later runs don't ask again.
//
//   npx tsx scripts/video/console.ts login    opens the console; sign in; it saves a snapshot of the Test page and closes
//   npx tsx scripts/video/console.ts record   drives the simulator and records video/echo/build/console.webm

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(import.meta.dirname, '..', '..');
const BUILD = join(ROOT, 'video', 'echo', 'build');
const PROFILE = join(BUILD, 'console-profile');
const mode = process.argv[2] ?? 'login';

const env: Record<string, string> = {};
for (const line of (await readFile(join(ROOT, '.env'), 'utf8')).split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const SKILL = env.ALEXA_SKILL_ID;
if (!SKILL?.startsWith('amzn1.ask.skill.')) throw new Error('ALEXA_SKILL_ID is not set in .env');
const TEST_URL = `https://developer.amazon.com/alexa/console/ask/test/${SKILL}/development/en_US/`;
const onTestPage = (url: string) => url.includes('/alexa/console/ask/test/');

await mkdir(BUILD, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1536, height: 864 },
  deviceScaleFactor: 1.25,
  args: ['--window-size=1560,980'],
  ...(mode === 'record' ? { recordVideo: { dir: BUILD, size: { width: 1920, height: 1080 } } } : {}),
});
const t0 = Date.now(); // the recording starts with the context
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(TEST_URL);

if (!onTestPage(page.url())) {
  console.log('\n>>> Sign in to the Alexa developer console in the browser window. Waiting (up to 15 minutes)…\n');
  await page.waitForURL((u) => onTestPage(u.toString()), { timeout: 15 * 60_000 });
}
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(4000);

if (mode === 'login') {
  // A snapshot of the Test page, so the recording steps can be written against what is really there.
  const out = join(BUILD, 'console-snapshot');
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: join(out, 'test-page.png') });
  const outline = await page.evaluate(() => {
    const rows: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, input, textarea, select, [role="switch"], [role="tab"], [role="combobox"], label, h1, h2, h3'))) {
      const e = el as HTMLElement;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const text = (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || (e as HTMLInputElement).value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      rows.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : ''}${e.getAttribute('data-testid') ? `[data-testid=${e.getAttribute('data-testid')}]` : ''} @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}  ${text}`);
    }
    return rows.join('\n');
  });
  await writeFile(join(out, 'outline.txt'), outline);
  console.log(`Signed in. Snapshot saved to video/echo/build/console-snapshot/ (${outline.split('\n').length} controls).`);
  await context.close();
  process.exit(0);
}

// ---- Record: tidy the page, then type each line as Margaret, then as Dana ----
const shots = join(BUILD, 'console-shots');
await mkdir(shots, { recursive: true });
const marks: Array<{ line: string; at: number }> = [];
const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

async function tidy() {
  // Tidy the page for filming: dismiss the console's tip, hide the JSON panels, and fold away the personalization
  // notice and section (this skill doesn't use personalization), so the simulated Echo Show screen is fully in view.
  await page.locator('text=Got it').first().click({ timeout: 3000 }).catch(() => {});
  if (await page.locator('label', { hasText: 'Skill I/O' }).locator('input:checked').count()) await page.locator('label', { hasText: 'Skill I/O' }).click();
  await page.waitForTimeout(600);
  // The personalization notice and section are embedded frames (this skill doesn't use personalization): hide them.
  await page.evaluate(() => {
    for (const f of Array.from(document.querySelectorAll('iframe'))) if ((f.getAttribute('src') || '').includes('/personalization')) (f as HTMLElement).style.display = 'none';
  });
    // Before the first reply, the empty device display shows a "template not available" placeholder: keep it blank.
  for (const frame of page.frames()) {
    await frame
      .getByText('The template is not available', { exact: false })
      .first()
      .evaluate((el) => ((el as HTMLElement).style.visibility = 'hidden'), undefined, { timeout: 1500 })
      .catch(() => {});
  }
  // The floating chat button sits over the bottom right of the Echo screen.
  await page
    .evaluate(() => {
      let el = document.elementFromPoint(innerWidth - 50, innerHeight - 100) as HTMLElement | null;
      while (el && getComputedStyle(el).position !== 'fixed') el = el.parentElement;
      if (el && el.getBoundingClientRect().width < 200) el.style.display = 'none';
    })
    .catch(() => {});
  await page.waitForTimeout(800);
}
await tidy();
await shot('0-ready');

// The good-night deadline must still be ahead on the household clock: the next full hour, at least 45 minutes away.
const clock = (await (await fetch('https://nt6jtrc2lercifde5e7plppofi0blcaw.lambda-url.us-east-1.on.aws/admin/clock', { headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } })).json()) as { localNow: string };
const [h, m] = clock.localNow.slice(11, 16).split(':').map(Number);
const deadlineH = (h! + (m! > 15 ? 2 : 1)) % 24;
const WORDS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
const spoken = WORDS[deadlineH % 12]!;
const input = page.locator('input[placeholder="Type or click and hold the mic"]');
async function sayLine(line: string, delay = 35) {
  await input.click();
  await input.pressSequentially(line, { delay });
  await page.keyboard.press('Enter');
}

// Off camera: clear any earlier good-night check-in, then reload for an empty conversation.
await sayLine('ask closed loop to cancel my good night check', 10);
await page.waitForTimeout(6000);
await page.reload();
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(3000);
await tidy();
await shot('0-ready');

// The take, timed to the narration (scripts/video narration "hero": console, set up, yes, good night).
const take0 = Date.now();
const at = async (sec: number) => {
  const ms = take0 + sec * 1000 - Date.now();
  if (ms > 0) await page.waitForTimeout(ms);
};
const start = (take0 - t0) / 1000;
await at(Number(process.env.T_SET ?? 3.0));
await sayLine(`ask closed loop if I haven't said good night by ${spoken} let Dana know`);
await at(Number(process.env.T_YES ?? 11.0));
await sayLine('yes', 120);
await at(Number(process.env.T_NIGHT ?? 15.6));
await sayLine('tell closed loop good night');
await at(Number(process.env.T_END ?? 23.0));
await shot('end');
marks.push({ line: 'take', at: start });
marks.push({ line: 'end', at: (Date.now() - t0) / 1000 });
await writeFile(join(BUILD, 'console-marks.json'), JSON.stringify({ marks, deadline: spoken, wall: (Date.now() - t0) / 1000 }, null, 2));
const video = page.video();
await context.close();
if (video) {
  await rename(await video.path(), join(BUILD, 'console.webm'));
  console.log('recorded: video/echo/build/console.webm');
}
