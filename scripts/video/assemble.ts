// Cuts video/out/raw.webm into the recorded scenes, lays each narration clip over its scene, and joins them.
// Usage: npm run video:assemble        Output: video/out/closed-loop-demo.mp4 (1920x1080, H.264 + AAC)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'video', 'out');
const marks = JSON.parse(await readFile(join(OUT, 'marks.json'), 'utf8')) as {
  audioDelay: number;
  durations: number[];
  clips: Array<{ file: string; wall: number; scenes: Array<{ n: number; start: number; end: number }> }>;
};
const probe = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

// Recordings drop frames under load, so a clip's video timeline is slightly shorter than wall-clock time.
// Map wall-clock marks onto each clip's own timeline linearly. A file longer than wall time only has a frozen
// tail (the recorder flushing after the page closes), so it is never stretched.
const recorded = marks.clips.flatMap((clip) => {
  const file = join(OUT, clip.file);
  const scale = Math.min(1, probe(file) / clip.wall);
  return clip.scenes.map((s) => ({ n: s.n, file, start: s.start * scale, end: s.end * scale, scale }));
});

// The final order: video/cut.json lists recorded scenes by number and ready-made segments by file
// (the Echo Show hero, built by echo.ts), e.g. [{"scene":0},{"file":"video/echo/build/hero.mp4"},{"scene":1}].
// Without it, every recorded scene in recording order.
type Item = { scene: number } | { file: string };
const cutFile = join(ROOT, 'video', 'cut.json');
const order: Item[] = existsSync(cutFile) ? (JSON.parse(await readFile(cutFile, 'utf8')) as { order: Item[] }).order : recorded.map((s) => ({ scene: s.n }));
const scenes = order.map((item) => {
  if ('file' in item) return { ready: join(ROOT, item.file) };
  const s = recorded.find((r) => r.n === item.scene);
  if (!s) throw new Error(`scene ${item.scene} is in video/cut.json but was not recorded`);
  return s;
});

/** A short dip to black between scenes; a longer fade at the very start and end. */
function fadesFor(dur: number, first: boolean, last: boolean): string {
  const inD = first ? 0.6 : 0.3;
  const outD = last ? 1.2 : 0.3;
  return `fade=t=in:st=0:d=${inD},fade=t=out:st=${(dur - outD).toFixed(2)}:d=${outD}`;
}

const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const delayMs = Math.round(marks.audioDelay * 1000);
const parts: string[] = [];

for (const [i, item] of scenes.entries()) {
  const first = i === 0;
  const last = i === scenes.length - 1;
  if ('ready' in item) {
    // A ready-made 1920x1080 segment (the Echo Show hero): re-encoded with the same settings so the parts join cleanly.
    const out = join(OUT, `part-${i}.mp4`);
    const len = probe(item.ready);
    const vf = `fps=30,scale=1920:1080,setsar=1,${fadesFor(len, first, last)},format=yuv420p`;
    ffmpeg(['-i', item.ready, '-vf', vf, '-af', 'aresample=48000', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out]);
    parts.push(out);
    console.log(`segment ${item.ready.replace(ROOT + '/', '')}: ${probe(out).toFixed(1)} s`);
    continue;
  }
  const s = item;
  const dur = +(s.end - s.start).toFixed(3);
  const fades = fadesFor(dur, first, last);
  const video = `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos,setsar=1${fades ? `,${fades}` : ''},format=yuv420p[v]`;
  // Scene 0 (the opening card) has no narration: lay silence under it.
  const silent = s.n === 0;
  const audio = silent
    ? `[1:a]atrim=0:${dur}[a]`
    : `[1:a]aresample=48000,adelay=${delayMs}:all=1,apad,atrim=0:${dur}${last ? `,afade=t=out:st=${(dur - 1.0).toFixed(2)}:d=1.0` : ''}[a]`;
  const out = join(OUT, `scene-${s.n}.mp4`);
  ffmpeg([
    '-i', s.file,
    ...(silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : ['-i', join(ROOT, 'video', 'narration', `scene-${s.n}.mp3`)]),
    '-filter_complex', `${video};${audio}`,
    '-map', '[v]', '-map', '[a]',
    '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    out,
  ]);
  parts.push(out);
  console.log(`scene ${s.n}: ${dur.toFixed(1)} s (${silent ? 'no narration' : `narration ${marks.durations[s.n - 1]!.toFixed(1)} s`}, clip timeline scale ${s.scale.toFixed(3)})`);
}

const list = join(OUT, 'parts.txt');
await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
const final = join(OUT, 'closed-loop-demo.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final], { encoding: 'utf8' }).trim());
const mm = Math.floor(total / 60);
const ss = (total % 60).toFixed(1).padStart(4, '0');
console.log(`\nvideo/out/closed-loop-demo.mp4: ${mm}:${ss}${total >= 180 ? '  (OVER 3:00, trim something)' : ' (under 3:00)'}`);
