// Bundles the Lambda functions into dist/<name>/index.mjs (ESM, arm64, Node 22). AWS SDK v3 comes from the runtime.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import './gen-static';

const ROOT = join(import.meta.dirname, '..');
const targets = {
  web: 'packages/api/src/lambda.ts',
  tick: 'packages/tick/src/lambda.ts',
  classifier: 'packages/classifier/src/lambda.ts',
};

for (const [name, entry] of Object.entries(targets)) {
  const outdir = join(ROOT, 'dist', name);
  await rm(outdir, { recursive: true, force: true });
  const r = await build({
    entryPoints: [join(ROOT, entry)],
    outfile: join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    metafile: true,
    logLevel: 'warning',
  });
  const [, out] = Object.entries(r.metafile.outputs).find(([file]) => file.endsWith('.mjs'))!;
  console.log(`built ${name}: ${Math.round(out.bytes / 1024)} KB`);
}
