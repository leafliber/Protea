#!/usr/bin/env node
// Bundle an out-of-process plugin into one self-contained file (dist/main.js), so the
// plugin directory can be copied anywhere, e.g. installed into a data volume.
import path from 'node:path';
import { build } from 'esbuild';

const dir = path.resolve(process.argv[2] ?? '.');
const outdir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(dir, 'dist');
await build({
  entryPoints: [path.join(dir, 'src', 'main.ts')],
  outfile: path.join(outdir, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['source'],
  sourcemap: 'inline',
  legalComments: 'none',
  logLevel: 'warning',
  // Bundled CommonJS dependencies may call require().
  banner: { js: "import { createRequire as __protea_cr } from 'node:module'; const require = __protea_cr(import.meta.url);" },
});
console.log(`bundled ${path.relative(process.cwd(), path.join(outdir, 'main.js'))}`);
