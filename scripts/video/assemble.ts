// Cuts video/out/raw.webm into the recorded scenes, lays each narration clip over its scene, and joins them.
// Usage: npm run video:assemble        Output: video/out/closed-loop-demo.mp4 (1920x1080, H.264 + AAC)

import { execFileSync } from 'node:child_process';
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
const scenes = marks.clips.flatMap((clip) => {
  const file = join(OUT, clip.file);
  const scale = Math.min(1, probe(file) / clip.wall);
  return clip.scenes.map((s) => ({ n: s.n, file, start: s.start * scale, end: s.end * scale, scale }));
});

const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const delayMs = Math.round(marks.audioDelay * 1000);
const parts: string[] = [];

for (const [i, s] of scenes.entries()) {
  const dur = +(s.end - s.start).toFixed(3);
  const first = i === 0;
  const last = i === scenes.length - 1;
  const fades = [first ? 'fade=t=in:st=0:d=0.6' : '', last ? `fade=t=out:st=${(dur - 1.2).toFixed(2)}:d=1.2` : ''].filter(Boolean).join(',');
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
