#!/usr/bin/env node
// Pack an out-of-process plugin into a directory that `protea plugins install` takes as is: the
// bundle (dist/main.js) plus the files the plugin reads at run time, without sources, tests or
// node_modules. Used for the optional plugins (optional-plugins/), which the image does not ship.
//
//   node scripts/pack-plugin.mjs optional-plugins/dida365            # → dist/plugins/dida365
//   node scripts/pack-plugin.mjs optional-plugins/dida365 /tmp/out   # → /tmp/out
//
// The files left out are the ones the Dockerfile leaves out of the built-in plugins.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/pack-plugin.mjs <plugin-dir> [out-dir]');
  process.exit(2);
}
const dir = path.resolve(src);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'protea.plugin.json'), 'utf8'));
const out = path.resolve(process.argv[3] ?? path.join(root, 'dist', 'plugins', manifest.id));
const SKIP = new Set(['src', 'test', 'shims', 'node_modules', 'dist', 'package.json']);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(dir)) {
  if (SKIP.has(name) || /^tsconfig.*\.json$/.test(name)) continue;
  fs.cpSync(path.join(dir, name), path.join(out, name), { recursive: true });
}
// A Node plugin (src/main.ts) is bundled into the copy.
if (fs.existsSync(path.join(dir, 'src', 'main.ts'))) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'bundle-plugin.mjs'), dir, path.join(out, 'dist')], { stdio: 'inherit' });
}
console.log(`packed ${manifest.id} ${manifest.version} → ${path.relative(process.cwd(), out) || '.'}`);
