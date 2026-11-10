import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency direction of the workspace (docs/40-plan/02-repo-layout.md). Inside core only
 * imports that survive compilation count: `import type` is erased, so modules may share
 * interfaces freely while apps/daemon/src/daemon.ts connects the objects at run time.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORE_SRC = path.join(ROOT, 'packages/core/src');

/** Core modules from the bottom up. A module may import at run time only from lower layers. */
const LAYERS: ReadonlyArray<readonly string[]> = [
  ['util'],
  ['settings'],
  ['auth', 'bus', 'config', 'db', 'events', 'memory', 'observability', 'permissions', 'persona', 'skills'],
  ['backup', 'context', 'diagnostics', 'mcp', 'tools'],
  ['plugins', 'providers'],
  ['session'],
  ['forks', 'maintenance', 'scheduler'],
];
const LAYER_OF = new Map(LAYERS.flatMap((mods, layer) => mods.map((m) => [m, layer] as const)));

/** Pure settings and their normalization: what `config` may read from the modules above it. */
const isSettingsFile = (rel: string): boolean => /(^|\/)settings\.ts$/.test(rel) || rel === 'providers/profiles.ts';
const moduleOf = (rel: string): string => (isSettingsFile(rel) ? 'settings' : (rel.split('/')[0] as string).replace(/\.ts$/, ''));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

const RUNTIME_IMPORT =
  /^import\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|^export\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Runtime imports between core source files, as paths relative to packages/core/src. */
function coreEdges(): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const file of sourceFiles(CORE_SRC)) {
    const from = path.relative(CORE_SRC, file);
    if (from === 'index.ts') continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(RUNTIME_IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3]) as string;
      if (!spec.startsWith('.')) continue;
      edges.push({ from, to: path.relative(CORE_SRC, path.resolve(path.dirname(file), spec)).replace(/\.js$/, '.ts') });
    }
  }
  return edges;
}

const WORKSPACE_IMPORT = /\bfrom\s+['"]@protea\/([a-z-]+)|\bimport\(\s*['"]@protea\/([a-z-]+)/g;

const OUT_OF_PROCESS_PLUGINS = fs
  .readdirSync(path.join(ROOT, 'plugins'))
  .filter((id) => !['console', 'cron'].includes(id))
  .map((id): [string, string[]] => [`plugins/${id}/src`, ['plugin-sdk', 'protocol']]);

/** Which @protea packages each source tree may name, type imports included. */
const BOUNDARIES: Array<[string, string[]]> = [
  ['packages/protocol/src', []],
  ['packages/plugin-sdk/src', ['protocol']],
  ['packages/core/src', ['protocol']],
  ['packages/control/src', ['core', 'protocol']],
  ['plugins/console/src', ['core', 'protocol']],
  ['plugins/cron/src', ['core', 'protocol']],
  ['apps/web/src', ['protocol']],
  ['apps/daemon/src', ['control', 'core', 'plugin-console', 'plugin-cron', 'protocol']],
  ['apps/cli/src', ['core', 'daemon', 'protocol']],
  ...OUT_OF_PROCESS_PLUGINS,
];

describe('dependency direction', () => {
  it('reads the real import graph', () => {
    expect(coreEdges()).toContainEqual({ from: 'scheduler/scheduler.ts', to: 'session/main-session.ts' });
    expect(OUT_OF_PROCESS_PLUGINS.length).toBeGreaterThan(0);
  });

  it('gives every core module a layer', () => {
    const files = sourceFiles(CORE_SRC).map((f) => path.relative(CORE_SRC, f)).filter((f) => f !== 'index.ts');
    expect([...new Set(files.map(moduleOf))].filter((m) => !LAYER_OF.has(m))).toEqual([]);
  });

  it('keeps runtime imports inside core pointing to lower layers', () => {
    const upward = coreEdges().filter(({ from, to }) => {
      const a = moduleOf(from);
      const b = moduleOf(to);
      return a !== b && (LAYER_OF.get(b) as number) >= (LAYER_OF.get(a) as number);
    });
    expect(upward.map(({ from, to }) => `${from} -> ${to}`)).toEqual([]);
  });

  it('keeps each workspace package to its allowed dependencies', () => {
    const broken: string[] = [];
    for (const [dir, allowed] of BOUNDARIES) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(WORKSPACE_IMPORT)) {
          const pkg = (m[1] ?? m[2]) as string;
          if (!allowed.includes(pkg)) broken.push(`${path.relative(ROOT, file)} -> @protea/${pkg}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
