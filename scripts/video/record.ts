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
import { architectureHtml, dedicationHtml, endCardHtml, problemHtml, skillHtml, titleHtml } from './slides';

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
const DEDICATION_SECONDS = 6.5; // scene 0: the opening card, silent
const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
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
  // Saved after every clip, so a failure late in a run keeps what was recorded.
  await writeFile(join(OUT, 'marks.json'), JSON.stringify({ audioDelay: AUDIO_DELAY, durations, clips }, null, 2));
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

/** Starts a fresh demo day and waits until the page is on the new household (the page already has one at 7:55 am). */
async function freshDay() {
  const before = await page.evaluate(() => sessionStorage.getItem('closed-loop-household'));
  await page.click('#demo-start');
  await page.waitForFunction((b) => {
    const now = sessionStorage.getItem('closed-loop-household');
    return !!now && now !== b && /7:5\d am/.test(document.querySelector('#clock-time')?.textContent ?? '');
  }, before, { timeout: 60_000 });
  await wait(1500); // let the page settle on the new household before anything else is pressed
}

// ---- Setup (not part of the video) ----

// The access code comes from .env (never printed). It is in session storage before any page script runs, so the
// access dialog never appears and nobody has to type it.
await context.addInitScript({
  content: `try { if (location.origin === ${JSON.stringify(ORIGIN)}) sessionStorage.setItem('closed-loop-access-code', ${JSON.stringify(ADMIN)}); } catch (e) {}`,
});
await newClip();
await page.goto(`${BASE}/simulator/`);
await simulatorReady();
await freshDay();
await page.click('[data-adv="3600"]');
await page.waitForFunction(() => /8:5\d am/.test(document.querySelector('#clock-time')?.textContent ?? ''), null, { timeout: 30_000 });
// Each visitor gets a demo household of their own; every scene tab opens on this one.
const HID = await page.evaluate(() => sessionStorage.getItem('closed-loop-household'));
if (!HID) throw new Error('the simulator did not report its demo household');
await context.addInitScript({
  content: `try { if (location.origin === ${JSON.stringify(ORIGIN)}) sessionStorage.setItem('closed-loop-household', ${JSON.stringify(HID)}); } catch (e) {}`,
});
const setupVideo = page.video();
await page.close(); // setup tab: its recording is deleted
await setupVideo?.delete();

// ---- Scene 0: dedication (on screen only, no narration); Scene 1: the problem, in sourced numbers; Scene 2: landing ----
await newClip();
await page.setContent(dedicationHtml, { waitUntil: 'networkidle' });
pos = { x: 1900, y: 1060 }; // off screen: no cursor on the opening slides
await begin(0);
await at(DEDICATION_SECONDS);
current.scenes.at(-1)!.end = (Date.now() - pageT0) / 1000;
await page.setContent(problemHtml, { waitUntil: 'networkidle' });
await begin(1);
for (const [t, step] of [[0.4, 1], [6.1, 2]] as const) {
  await at(t);
  await page.evaluate((n) => (document.body.dataset.step = String(n)), step);
}
await end(1, 0.9);
await page.setContent(titleHtml, { waitUntil: 'networkidle' });
await page.mouse.move(1900, 1060); // keep the cursor out of the title
await begin(2);
for (const [t, step] of [[0.5, 1], [5.6, 2]] as const) {
  await at(t);
  await page.evaluate((n) => (document.body.dataset.step = String(n)), step);
}
pos = { x: 1900, y: 1060 };
await end(2);
await closeClip('clip-1');

// ---- Scene 3: console (contact rows with email addresses are never on screen) ----
await newClip();
await page.goto(`${BASE}/console/?household=${HID}#checkins`);
await page.locator('.checkin[data-id="morning"]').waitFor();
await wait(800);
await begin(3);
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
await end(3);
await closeClip('clip-2');

// ---- Scenes 4–6 in one tab, so the conversation stays on screen ----
await newClip();
await page.goto(`${BASE}/simulator/`);
await simulatorReady();

// Scene 4: routine start, hedged answer, deferral
await begin(4);
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
await end(4);

// Scene 5: +5 hours, follow-up first, clear yes
await begin(5);
await at(0.4);
await click(page.locator('[data-adv="18000"]'));
await at(2.2);
await click(page.locator('#routine'));
await at(5.2);
await click(page.locator('.chip', { hasText: 'Yes, done.' }));
await at(8.6);
await point(page.locator('.app-card').last());
await end(5, 1.0);

// Scene 6: +1 day, the tick, the email as sent, acknowledge
await begin(6);
await at(0.4);
await click(page.locator('[data-adv="86400"]'));
await page.locator('#mail li .subj').first().waitFor({ timeout: 20_000 });
const ledger = (await (await fetch(`${BASE}/api/households/${HID}/ledger?days=2`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as {
  today: string;
  items: Array<{ occurrenceId: string; checkinId: string; date: string; canAcknowledge: boolean }>;
};
const lunch = ledger.items.find((i) => i.checkinId === 'lunch' && i.date !== ledger.today && i.canAcknowledge);
if (!lunch) throw new Error('no unacknowledged lunch check from the previous day');
const ackUrl = ackUrlBuilder(BASE, ACK_SECRET)(HID, lunch.occurrenceId, 'dana');
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
await end(6, 1.2);
await closeClip('clip-3');

// ---- Scene 7: distress, then emergency words ----
await newClip();
await page.goto(`${BASE}/simulator/`);
await simulatorReady();
await begin(7);
await at(0.5);
await click(page.locator('#routine'));
await at(2.4);
await click(page.locator('.chip', { hasText: 'I want to go home' }));
await at(10.2);
await click(page.locator('.chip', { hasText: "I fell and I can't get up" }));
await at(14.2);
await point(page.locator('#loops'));
await end(7, 1.0);

// Scene 8: Dana asks from Dana's own assistant; hears the record; cannot answer for Margaret
await begin(8);
await at(0.6);
await click(page.locator('label:has(#speaker-family)'));
await at(2.8);
await click(page.locator('.chip', { hasText: 'How is Mom doing today?' }));
await at(5.6);
await point(page.locator('.app-card').last());
await at(10.9);
await click(page.locator('.chip', { hasText: 'Yes, Mom did it.' }));
await at(13.2);
await point(page.locator('.cap.assistant').last());
await end(8, 1.0);
await closeClip('clip-4');

// ---- Scene 9: Inspector, OAuth sign-in page, architecture, end card ----
await newClip();
await page.setContent(terminalHtml, { waitUntil: 'networkidle' });
await wait(500);
pos = { x: 1500, y: 820 };
await begin(9);
await at(3.9);
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
await at(7.6);
await page.setContent(skillHtml(await readFile(join(ROOT, 'skills', 'closed-loop-checkins', 'SKILL.md'), 'utf8')), { waitUntil: 'networkidle' });
await page.mouse.move(pos.x, pos.y);
await at(10.6);
await page.setContent(architectureHtml, { waitUntil: 'networkidle' });
await page.mouse.move(pos.x, pos.y);
await at(15.4);
await page.setContent(endCardHtml, { waitUntil: 'networkidle' });
await moveTo(1600, 950, 8);
await end(9, 3.2);
await closeClip('clip-5');

// ---- Scene 10: Margaret's own good-night check-in passes 10 pm: Dana is emailed, in Margaret's name ----
// A fresh household for this scene, with the family's daily check-ins switched off (as the guided tour does), so
// the only loop on screen is the one Margaret set up. The set-up itself happens before the scene starts.
await newClip();
await page.goto(`${BASE}/simulator/`);
await simulatorReady();
await freshDay();
const hid10 = (await page.evaluate(() => sessionStorage.getItem('closed-loop-household')))!; // its family check-ins are switched off below
const adminApi = (path: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${ADMIN}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  }).then((r) => r.json());
const view10 = (await adminApi(`/api/households/${hid10}`)) as { checkins: Array<{ id: string; active: boolean; author?: string }> };
for (const c of view10.checkins.filter((c) => c.active && c.author !== 'person')) {
  await adminApi(`/api/households/${hid10}/checkins/${c.id}`, { method: 'PUT', body: { ...c, active: false } });
}
await click(page.locator('.chip', { hasText: "If I haven't said good night by ten, let Dana know." }));
await page.locator('.cap.assistant').last().waitFor();
await wait(2500);
await page.fill('#say-input', 'Yes, please.');
await page.press('#say-input', 'Enter');
await wait(3000);
// Off camera: to 9:55 pm with the page's own clock buttons (each runs the same tick EventBridge runs, and redraws).
for (const [adv, shows] of [['18000', /12:5\d pm/], ['18000', /5:5\d pm/], ['3600', /6:5\d pm/], ['3600', /7:5\d pm/], ['3600', /8:5\d pm/], ['3600', /9:5\d pm/]] as const) {
  await page.click(`[data-adv="${adv}"]`);
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('#clock-time')?.textContent ?? ''), shows.source, { timeout: 45_000 });
}
await wait(1500);
await begin(10);
await at(0.6);
await point(page.locator('#loops'));
await at(3.0);
await click(page.locator('[data-adv="3600"]'));
await page.locator('#mail li', { hasText: 'asked us to let you know' }).first().waitFor({ timeout: 20_000 });
await at(5.0);
await point(page.locator('#mail li', { hasText: 'asked us to let you know' }).first());
await at(8.8);
await point(page.locator('#loops'));
await end(10, 1.0);
await closeClip('clip-6');

// ---- Finish ----
await context.close();
await browser.close();
await writeFile(join(OUT, 'marks.json'), JSON.stringify({ audioDelay: AUDIO_DELAY, durations, clips }, null, 2));
console.log(`recorded ${clips.reduce((n, c) => n + c.scenes.length, 0)} scenes in ${clips.length} clips → video/out/`);
