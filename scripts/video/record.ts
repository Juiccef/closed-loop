// Records the demo video's screen track by driving the real app, scene by scene, timed to the narration.
// Usage: npm run video:record -- <base_url>     (the deployed Function URL, or http://localhost:5173)
// A Chrome window opens. If the site asks for the access code, type it there once; everything after that is automatic.
// Each group of scenes is recorded in its own tab (its own video file) so frame-drop drift cannot accumulate;
// assemble.ts also rescales each file's timeline from wall-clock time to video time.
// Output: video/out/*.webm and video/out/marks.json.

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { ackUrlBuilder } from '@closed-loop/core';
import { architectureHtml, endCardHtml } from './slides';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'video', 'out');
const NARRATION = join(ROOT, 'video', 'narration');
const BASE = (process.argv[2] ?? '').replace(/\/$/, '');
if (!BASE) {
  console.error('Usage: npm run video:record -- <base_url>');
  process.exit(2);
}
const ORIGIN = new URL(BASE).origin;
const LOCAL = /localhost|127\.0\.0\.1/.test(BASE);

const env: Record<string, string> = {};
for (const line of (await readFile(join(ROOT, '.env'), 'utf8')).split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const ADMIN = LOCAL ? 'local-dev' : env.ADMIN_TOKEN!;
const MCP_TOKEN = LOCAL ? 'local-dev-mcp' : env.MCP_BEARER_TOKEN!;
const ACK_SECRET = LOCAL ? 'local-dev-ack-secret' : env.ACK_LINK_SECRET!;

const AUDIO_DELAY = 0.3; // narration starts this long after each scene begins
const durations = [1, 2, 3, 4, 5, 6, 7].map((n) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(NARRATION, `scene-${n}.mp3`)], { encoding: 'utf8' }).trim()),
);
console.log(`narration: ${durations.map((d) => d.toFixed(1)).join(' + ')} = ${durations.reduce((a, b) => a + b, 0).toFixed(1)} s`);

// Real MCP Inspector output for scene 7, captured before recording.
console.log('running MCP Inspector against the endpoint…');
const inspectorRaw = execFileSync(
  'npx',
  ['-y', '@modelcontextprotocol/inspector@2.11.0', '--cli', `${BASE}/mcp`, '--transport', 'http', '--header', `Authorization: Bearer ${MCP_TOKEN}`, '--method', 'tools/list'],
  { encoding: 'utf8', timeout: 180_000, cwd: ROOT },
);
const inspectorTools: Array<{ name: string }> = JSON.parse(inspectorRaw).tools;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const terminalHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#0f141a;color:#e6e9ee;font:17px/1.55 ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace;-webkit-font-smoothing:antialiased;padding:48px 64px}
.bar{display:flex;gap:8px;margin-bottom:28px}.bar i{width:13px;height:13px;border-radius:50%;background:#353d49;display:block}
.p{color:#8ee0a8}.c{color:#96a1ae}.k{color:#9cd1ff}pre{margin:0;white-space:pre-wrap}
</style></head><body><div class="bar"><i></i><i></i><i></i></div><pre><span class="p">$</span> npx @modelcontextprotocol/inspector@2.11.0 --cli ${esc(BASE)}/mcp \\
    --transport http --header "Authorization: Bearer $MCP_BEARER_TOKEN" --method tools/list

${esc(inspectorRaw.split('\n').slice(0, 16).join('\n'))}
<span class="c">  …</span>

<span class="c"># ${inspectorTools.length} tools from the live endpoint:</span> ${inspectorTools.map((t) => `<span class="k">${esc(t.name)}</span>`).join(', ')}</pre></body></html>`;

// A visible cursor, since recordings do not show the real one. Passed as a string: tsx wraps named functions
// in an `__name` helper that does not exist inside the page.
const CURSOR_SCRIPT = `(function () {
  function install() {
    if (document.getElementById('__demo_cursor')) return;
    var c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;left:-60px;top:-60px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(9,114,211,.22);border:2.5px solid rgba(9,114,211,.95);z-index:2147483647;pointer-events:none;transition:transform .12s ease,background .12s ease;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', function (e) { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', function () { c.style.transform = 'scale(.7)'; c.style.background = 'rgba(9,114,211,.55)'; }, true);
    addEventListener('mouseup', function () { c.style.transform = ''; c.style.background = 'rgba(9,114,211,.22)'; }, true);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
})();`;

// ---- Browser ----

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--window-size=1560,980'] });
const context = await browser.newContext({
  viewport: { width: 1536, height: 864 },
  deviceScaleFactor: 1.25,
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
await context.addInitScript({ content: CURSOR_SCRIPT });

type SceneMark = { n: number; start: number; end: number };
type Clip = { file: string; wall: number; scenes: SceneMark[] };
const clips: Clip[] = [];

let page!: Page;
let pageT0 = 0;
let sceneStart = 0;
let current!: Clip;
let pos = { x: 1180, y: 300 };

const wait = (ms: number) => page.waitForTimeout(ms);
async function newClip() {
  page = await context.newPage();
  pageT0 = Date.now();
  current = { file: '', wall: 0, scenes: [] };
}
async function closeClip(name: string) {
  const video = page.video()!;
  const wall = (Date.now() - pageT0) / 1000;
  await page.close();
  const file = `${name}.webm`;
  await rename(await video.path(), join(OUT, file));
  current.file = file;
  current.wall = wall;
  clips.push(current);
}
async function moveTo(x: number, y: number, steps = 28) {
  await page.mouse.move(x, y, { steps });
  pos = { x, y };
}
async function centerOf(loc: Locator, timeout = 10_000) {
  await loc.scrollIntoViewIfNeeded({ timeout });
  const b = await loc.boundingBox({ timeout });
  if (!b) throw new Error('element not visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** Moves the cursor to an element. Only guides the eye, so an element that keeps re-rendering is skipped. */
async function point(loc: Locator) {
  try {
    const c = await centerOf(loc, 2500);
    await moveTo(c.x, c.y);
  } catch {
    console.log('  (pointer skipped: element was re-rendering)');
  }
}
async function click(loc: Locator) {
  const c = await centerOf(loc);
  await moveTo(c.x, c.y);
  await wait(160);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
}
async function begin(n: number) {
  await page.mouse.move(pos.x, pos.y); // show the cursor where the last scene left it
  sceneStart = Date.now();
  current.scenes.push({ n, start: (sceneStart - pageT0) / 1000, end: 0 });
  console.log(`scene ${n}`);
}
async function at(seconds: number) {
  const ms = sceneStart + seconds * 1000 - Date.now();
  if (ms > 0) await wait(ms);
}
async function end(n: number, tail = 0.7) {
  await at(AUDIO_DELAY + durations[n - 1]! + tail);
  current.scenes.at(-1)!.end = (Date.now() - pageT0) / 1000;
}
async function simulatorReady() {
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#traffic .t-method')).some((e) => e.textContent?.includes('tools/list')), null, { timeout: 60_000 });
  await wait(800);
}

// ---- Setup (not part of the video) ----

await newClip();
await page.goto(`${BASE}/simulator/`);
const dialog = page.locator('.access-dialog');
if (await dialog.isVisible({ timeout: 4000 }).catch(() => false)) {
  console.log('\n>>> Type the access code in the browser window and press Continue. Waiting…\n');
  await dialog.waitFor({ state: 'detached', timeout: 10 * 60_000 });
}
await simulatorReady();
// Carry the access code to the scene tabs, as a browser does for a link opened in a new tab.
const code = await page.evaluate(() => sessionStorage.getItem('closed-loop-access-code'));
if (code) {
  await context.addInitScript({
    content: `try { if (location.origin === ${JSON.stringify(ORIGIN)}) sessionStorage.setItem('closed-loop-access-code', ${JSON.stringify(code)}); } catch (e) {}`,
  });
}
await page.click('#demo-start');
await page.waitForFunction(() => /7:5\d am/.test(document.querySelector('#clock-time')?.textContent ?? ''), null, { timeout: 30_000 });
await page.click('[data-adv="3600"]');
await page.waitForFunction(() => /8:5\d am/.test(document.querySelector('#clock-time')?.textContent ?? ''), null, { timeout: 30_000 });
const setupVideo = page.video();
await page.close(); // setup tab (includes typing the access code): its recording is deleted
await setupVideo?.delete();

// ---- Scene 1: landing ----
await newClip();
await page.goto(`${BASE}/`);
await page.waitForLoadState('load');
await begin(1);
await at(1.2);
await moveTo(1180, 300, 40);
await at(9.5);
await point(page.locator('.door', { hasText: 'Simulated client' }));
await at(12.8);
await point(page.locator('.door', { hasText: 'Caregiver console' }));
await end(1);
await closeClip('clip-1');

// ---- Scene 2: console (contact rows with email addresses are never on screen) ----
await newClip();
await page.goto(`${BASE}/console/#checkins`);
await page.locator('.checkin[data-id="morning"]').waitFor();
await wait(800);
await begin(2);
await at(0.8);
await click(page.locator('.checkin[data-id="morning"] > summary'));
await at(2.6);
const prompt = page.locator('#chk-morning-prompt');
await click(prompt);
await prompt.selectText();
await prompt.pressSequentially('Good morning, Margaret. Did you take your pills?', { delay: 38 });
await at(6.2);
await point(page.locator('#chk-morning-prompt-err'));
await at(8.8);
await page.evaluate(() => {
  const el = document.querySelector('#ladder-form')!;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 92, behavior: 'instant' as ScrollBehavior });
});
await point(page.locator('#l1-group legend'));
await at(12.2);
await page.evaluate(() => {
  const el = document.querySelector('#consent')!;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 92, behavior: 'instant' as ScrollBehavior });
});
await point(page.locator('#consent-current'));
await end(2);
await closeClip('clip-2');

// ---- Scenes 3–5 in one tab, so the conversation stays on screen ----
await newClip();
await page.goto(`${BASE}/simulator/`);
await simulatorReady();

// Scene 3: routine start, hedged answer, deferral
await begin(3);
await at(1.2);
await click(page.locator('#routine'));
await at(7.0);
await point(page.locator('#traffic > li').first());
await at(10.6);
await click(page.locator('.chip', { hasText: 'I think so, maybe after lunch' }));
await at(15.8);
await point(page.locator('#traffic > li', { hasText: 'planner' }).first());
await at(19.6);
await point(page.locator('.app-card').last());
await end(3);

// Scene 4: +5 hours, follow-up first, clear yes
await begin(4);
await at(0.4);
await click(page.locator('[data-adv="18000"]'));
await at(2.2);
await click(page.locator('#routine'));
await at(5.2);
await click(page.locator('.chip', { hasText: 'Yes, done.' }));
await at(8.6);
await point(page.locator('.app-card').last());
await end(4, 1.0);

// Scene 5: +1 day, the tick, the email as sent, acknowledge
await begin(5);
await at(0.4);
await click(page.locator('[data-adv="86400"]'));
await page.locator('#mail li .subj').first().waitFor({ timeout: 20_000 });
const ledger = (await (await fetch(`${BASE}/api/households/demo/ledger?days=2`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
  today: string;
  items: Array<{ occurrenceId: string; checkinId: string; date: string; canAcknowledge: boolean }>;
};
const lunch = ledger.items.find((i) => i.checkinId === 'lunch' && i.date !== ledger.today && i.canAcknowledge);
if (!lunch) throw new Error('no unacknowledged lunch check from the previous day');
const ackUrl = ackUrlBuilder(BASE, ACK_SECRET)('demo', lunch.occurrenceId, 'dana');
await at(3.2);
await point(page.locator('#traffic > li').first());
await at(6.8);
await point(page.locator('#mail li', { hasText: 'lunchtime' }).first());
await at(11.2);
await page.goto(ackUrl);
await at(12.4);
await point(page.locator('button[type="submit"]'));
await at(14.8);
await click(page.locator('button[type="submit"]'));
await end(5, 1.2);
await closeClip('clip-3');

// ---- Scene 6: distress, then emergency words ----
await newClip();
await page.goto(`${BASE}/simulator/`);
await simulatorReady();
await begin(6);
await at(0.5);
await click(page.locator('#routine'));
await at(2.4);
await click(page.locator('.chip', { hasText: 'I want to go home' }));
await at(10.2);
await click(page.locator('.chip', { hasText: "I fell and I can't get up" }));
await at(14.2);
await point(page.locator('#loops'));
await end(6, 1.0);
await closeClip('clip-4');

// ---- Scene 7: Inspector, OAuth sign-in page, architecture, end card ----
await newClip();
await page.setContent(terminalHtml, { waitUntil: 'networkidle' });
await wait(500);
pos = { x: 1500, y: 820 };
await begin(7);
await at(5.4);
const authParams = new URLSearchParams({
  response_type: 'code',
  client_id: 'simulator',
  redirect_uri: `${BASE}/simulator/linked.html`,
  scope: 'mcp:tools',
  state: 'demo',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  resource: `${BASE}/mcp`,
});
await page.goto(`${BASE}/oauth/authorize?${authParams}`);
await point(page.locator('#link-code'));
await at(9.6);
await page.setContent(architectureHtml, { waitUntil: 'networkidle' });
await page.mouse.move(pos.x, pos.y);
await at(14.2);
await page.setContent(endCardHtml, { waitUntil: 'networkidle' });
await moveTo(1600, 950, 8);
await end(7, 1.8);
await closeClip('clip-5');

// ---- Finish ----
await context.close();
await browser.close();
await writeFile(join(OUT, 'marks.json'), JSON.stringify({ audioDelay: AUDIO_DELAY, durations, clips }, null, 2));
console.log(`recorded ${clips.reduce((n, c) => n + c.scenes.length, 0)} scenes in ${clips.length} clips → video/out/`);
