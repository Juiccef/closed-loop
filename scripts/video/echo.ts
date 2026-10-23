// Builds the hero segment from phone footage of the real Echo Show: video/echo/build/hero.mp4 (1920x1080, 30 fps, H.264 + AAC).
// Usage: npx tsx scripts/video/echo.ts [--with d,e] [--placeholder] [--console]
//   --console: the take recorded in Amazon's Alexa developer console (scripts/video/console.ts), with its narration.
//   Clips: video/echo/a.mov (or .mp4/.m4v), b, c (and optional d, e). Trim points and captions: video/echo/cut.json.
//   Each clip is fitted on the dark ground with its caption and the required label on screen the whole time.
//   The clips keep their own sound (Alexa speaking); there is no voiceover over them.
//   --placeholder renders a 25 s slate instead, so the full cut can be checked before the footage arrives.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(import.meta.dirname, '..', '..');
const ECHO = join(ROOT, 'video', 'echo');
const WORK = join(ECHO, 'build'); // not video/out: the recorder empties that folder when it starts
const args = process.argv.slice(2);
const placeholder = args.includes('--placeholder');
const extra = (args[args.indexOf('--with') + 1] ?? '').split(',').filter((x) => args.includes('--with') && x);

type Clip = { file: string; caption: string; start: number; end: number | null };
const cut = JSON.parse(await readFile(join(ECHO, 'cut.json'), 'utf8')) as {
  label: string;
  clips: Clip[];
  optional: Clip[];
  console: { caption: string; label: string; tag: string; narration: string; delay: number };
};
const clips = [...cut.clips, ...cut.optional.filter((c) => extra.includes(c.file))];

const SYS = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif";
const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const FOOT_H = 150; // the band under the footage: caption and label
const overlayHtml = (caption: string, label = cut.label, tag = 'Real device') => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:${SYS};-webkit-font-smoothing:antialiased}
.band{position:absolute;left:0;right:0;bottom:0;height:${FOOT_H}px;background:#0f141a;display:flex;flex-direction:column;justify-content:center;padding:0 72px;box-sizing:border-box;border-top:1px solid #232b36}
.cap{color:#f2f3f5;font-size:30px;font-weight:600;letter-spacing:-.01em;margin:0 0 10px}
.lbl{display:flex;align-items:center;gap:14px;color:#b6bec9;font-size:19px;margin:0}
.tag{flex:none;font-size:15px;font-weight:700;color:#0f141a;background:#e5b941;border-radius:999px;padding:3px 10px}
</style></head><body><div class="band"><p class="cap">${esc(caption)}</p><p class="lbl"><span class="tag">${esc(tag)}</span>${esc(label)}</p></div></body></html>`;

const ffmpeg = (a: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const probe = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

await mkdir(WORK, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
async function overlay(name: string, caption: string, label?: string, tag?: string) {
  await page.setContent(overlayHtml(caption, label, tag), { waitUntil: 'networkidle' });
  const png = join(WORK, `${name}-overlay.png`);
  await page.screenshot({ path: png, omitBackground: true });
  return png;
}

const parts: string[] = [];
if (args.includes('--console')) {
  // The console take has no sound (browser recordings carry none): the narration plays over it.
  const take = JSON.parse(await readFile(join(WORK, 'console-marks.json'), 'utf8')) as { marks: Array<{ line: string; at: number }>; wall: number };
  const src = join(WORK, 'console.webm');
  const scale = Math.min(1, probe(src) / take.wall);
  const start = take.marks.find((m) => m.line === 'take')!.at * scale;
  const end = take.marks.find((m) => m.line === 'end')!.at * scale;
  const dur = +(end - start).toFixed(3);
  const c = cut.console;
  const png = await overlay('console', c.caption, c.label, c.tag);
  const out = join(WORK, 'console.mp4');
  const fit = `scale=1920:${1080 - FOOT_H - 24}:force_original_aspect_ratio=decrease,setsar=1`;
  ffmpeg([
    '-ss', start.toFixed(3), '-t', String(dur), '-i', src,
    '-i', join(ROOT, c.narration),
    '-f', 'lavfi', '-i', `color=c=0x0f141a:s=1920x1080:r=30:d=${dur}`,
    '-i', png,
    '-filter_complex',
    `[0:v]fps=30,${fit}[f];[2:v][f]overlay=(W-w)/2:(${1080 - FOOT_H}-h)/2[b];[b][3:v]overlay=0:0,format=yuv420p[v];[1:a]aresample=48000,adelay=${Math.round(c.delay * 1000)}:all=1,apad,atrim=0:${dur}[a]`,
    '-map', '[v]', '-map', '[a]', '-t', String(dur), ...ENCODE, out,
  ]);
  parts.push(out);
  console.log(`console take: ${dur.toFixed(1)} s`);
} else if (placeholder) {
  const png = await overlay('placeholder', 'Echo Show footage goes here (about 25 seconds: clips a, b, c)');
  const out = join(WORK, 'placeholder.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x1a1d22:s=1920x1080:r=30:d=25', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', png, '-filter_complex', '[0:v][2:v]overlay=0:0,format=yuv420p[v]', '-map', '[v]', '-map', '1:a', '-t', '25', ...ENCODE, out]);
  parts.push(out);
} else {
  for (const c of clips) {
    const src = ['mov', 'mp4', 'm4v', 'MOV', 'MP4'].map((ext) => join(ECHO, `${c.file}.${ext}`)).find((f) => existsSync(f));
    if (!src) throw new Error(`missing video/echo/${c.file}.mov (or .mp4)`);
    const start = c.start ?? 0;
    const end = c.end ?? probe(src);
    const dur = +(end - start).toFixed(3);
    const png = await overlay(c.file, c.caption);
    const out = join(WORK, `${c.file}.mp4`);
    // Footage fitted into the area above the band, centered, on the dark ground; phone audio leveled.
    const fit = `scale=1920:${1080 - FOOT_H - 24}:force_original_aspect_ratio=decrease,setsar=1`;
    ffmpeg([
      '-ss', String(start), '-t', String(dur), '-i', src,
      '-f', 'lavfi', '-i', `color=c=0x0f141a:s=1920x1080:r=30:d=${dur}`,
      '-i', png,
      '-filter_complex',
      `[0:v]fps=30,${fit}[f];[1:v][f]overlay=(W-w)/2:(${1080 - FOOT_H}-h)/2[b];[b][2:v]overlay=0:0,format=yuv420p[v];[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`,
      '-map', '[v]', '-map', '[a]', '-t', String(dur), ...ENCODE, out,
    ]);
    parts.push(out);
    console.log(`${c.file}: ${dur.toFixed(1)} s from ${src.replace(ROOT + '/', '')}`);
  }
}
await browser.close();

const list = join(WORK, 'parts.txt');
await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
const hero = join(WORK, 'hero.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', hero]);
console.log(`video/echo/build/hero.mp4: ${probe(hero).toFixed(1)} s${placeholder ? ' (placeholder)' : ''}`);
