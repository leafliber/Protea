#!/usr/bin/env node
// Bundle an out-of-process plugin into one self-contained file (dist/main.js), so the
// plugin directory can be copied anywhere, e.g. installed into a data volume.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const dir = path.resolve(process.argv[2] ?? '.');
const outdir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(dir, 'dist');
// Per-plugin needs ("protea": { "bundle": { ... } } in its package.json): `external` leaves out
// modules its code paths never load; `packageJsonOf` names a bundled package that reads its own
// package.json at run time, so a copy has to sit next to the bundle.
const manifest = path.join(dir, 'package.json');
const options = fs.existsSync(manifest) ? (JSON.parse(fs.readFileSync(manifest, 'utf8')).protea?.bundle ?? {}) : {};
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
  ...(options.external ? { external: options.external } : {}),
  // Bundled CommonJS dependencies may call require().
  banner: { js: "import { createRequire as __protea_cr } from 'node:module'; const require = __protea_cr(import.meta.url);" },
});
if (options.packageJsonOf) fs.copyFileSync(createRequire(manifest).resolve(`${options.packageJsonOf}/package.json`), path.join(outdir, 'package.json'));
console.log(`bundled ${path.relative(process.cwd(), path.join(outdir, 'main.js'))}`);
