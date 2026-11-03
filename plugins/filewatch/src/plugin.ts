import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { definePlugin, type Host, type PluginDefinition } from '@protea/plugin-sdk';

export interface FilewatchConfig {
  paths?: string[];
  debounceMs?: number;
  level?: 3 | 4;
  ignore?: string[];
}

interface FileInfo {
  size: number;
  mtimeMs: number;
}
type Snapshot = Record<string, FileInfo>;

const DEFAULT_IGNORE = ['.*', '*~', '*.tmp', '*.part', '*.swp'];
const MAX_FILES = 5000;
const MAX_LISTED = 50;

function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Files below `root` (relative paths), skipping ignored names. */
export function scan(root: string, ignore: RegExp[]): Snapshot {
  const out: Snapshot = {};
  let count = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX_FILES) return;
      if (ignore.some((re) => re.test(e.name))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out[path.relative(root, full)] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
          count++;
        } catch {
          // removed while scanning
        }
      }
    }
  };
  walk(root);
  return out;
}

export interface Change {
  kind: 'added' | 'changed' | 'removed';
  file: string;
  size?: number;
}

export function diff(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [f, info] of Object.entries(after)) {
    const prev = before[f];
    if (!prev) changes.push({ kind: 'added', file: f, size: info.size });
    else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) changes.push({ kind: 'changed', file: f, size: info.size });
  }
  for (const f of Object.keys(before)) if (!(f in after)) changes.push({ kind: 'removed', file: f });
  return changes.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Watches folders and reports what changed as one aggregated event per quiet period
 * (docs/10-architecture/08-event-source-plugins.md §2: file changes are L3/L4 debounce).
 * Changes made while the plugin was stopped are reported at start.
 */
export function createFilewatchPlugin(): PluginDefinition<FilewatchConfig> {
  const roots = new Map<string, { snapshot: Snapshot; watcher: fs.FSWatcher | null; timer: ReturnType<typeof setTimeout> | null }>();
  let ignore: RegExp[] = [];

  const resolveRoots = (host: Host<FilewatchConfig>): string[] =>
    (host.config.paths ?? ['inbox']).map((p) => (path.isAbsolute(p) ? p : path.join(host.hostDataDir, p)));

  async function report(host: Host<FilewatchConfig>, root: string, changes: Change[], note = ''): Promise<void> {
    if (changes.length === 0) return;
    const sign = { added: '+', changed: '~', removed: '-' } as const;
    const lines = changes.slice(0, MAX_LISTED).map((c) => `${sign[c.kind]} ${c.file}${c.size !== undefined ? ` (${formatSize(c.size)})` : ''}`);
    if (changes.length > MAX_LISTED) lines.push(`… and ${changes.length - MAX_LISTED} more`);
    const level = host.config.level ?? 3;
    const key = crypto
      .createHash('sha256')
      .update(root + JSON.stringify(changes.map((c) => [c.kind, c.file, c.size ?? null, roots.get(root)?.snapshot[c.file]?.mtimeMs ?? null])))
      .digest('hex')
      .slice(0, 32);
    await host.events.push({
      type: 'filewatch.changed',
      ts: new Date().toISOString(),
      level,
      trigger: level === 3 ? 'debounce' : 'piggyback',
      text: `${changes.length} file(s) ${note}in ${root}:\n${lines.join('\n')}`,
      dedupeKey: key,
      meta: { root, added: changes.filter((c) => c.kind === 'added').length, changed: changes.filter((c) => c.kind === 'changed').length, removed: changes.filter((c) => c.kind === 'removed').length },
    });
  }

  async function rescan(host: Host<FilewatchConfig>, root: string): Promise<void> {
    const state = roots.get(root);
    if (!state) return;
    const next = scan(root, ignore);
    const changes = diff(state.snapshot, next);
    state.snapshot = next;
    if (changes.length === 0) return;
    await report(host, root, changes, 'changed ');
    await host.kv.set(`snapshot:${root}`, next);
  }

  /** Resolve a tool path inside one of the watched folders, or throw. */
  function inside(rel: string | undefined): { root: string; full: string } {
    const all = [...roots.keys()];
    if (all.length === 0) throw new Error('no folder is watched');
    if (!rel) return { root: all[0] as string, full: all[0] as string };
    for (const root of all) {
      const full = path.resolve(path.isAbsolute(rel) ? rel : path.join(root, rel));
      if (full === root || full.startsWith(root + path.sep)) return { root, full };
    }
    throw new Error(`${rel} is outside the watched folders (${all.join(', ')})`);
  }

  return definePlugin<FilewatchConfig>({
    displayName: 'File watcher',
    async start(host) {
      ignore = (host.config.ignore ?? DEFAULT_IGNORE).map(globRe);
      for (const root of resolveRoots(host)) {
        fs.mkdirSync(root, { recursive: true });
        const before = (await host.kv.get<Snapshot>(`snapshot:${root}`)) ?? null;
        const now = scan(root, ignore);
        roots.set(root, { snapshot: now, watcher: null, timer: null });
        if (before) await report(host, root, diff(before, now), 'changed while the watcher was stopped ');
        await host.kv.set(`snapshot:${root}`, now);
        const state = roots.get(root);
        if (!state) continue;
        state.watcher = fs.watch(root, { recursive: true }, () => {
          if (state.timer) clearTimeout(state.timer);
          state.timer = setTimeout(() => {
            state.timer = null;
            rescan(host, root).catch((err: Error) => host.log.warn('rescan failed', { root, err: err.message }));
          }, host.config.debounceMs ?? 2000);
        });
        state.watcher.on('error', (err) => host.log.warn('watch error', { root, err: err.message }));
      }
    },
    stop() {
      for (const s of roots.values()) {
        s.watcher?.close();
        if (s.timer) clearTimeout(s.timer);
      }
      roots.clear();
    },
    envPromptVars: (host) => ({ folders: resolveRoots(host).join(', ') }),
    tools: [
      {
        name: 'fw_list',
        description: 'List the files of a watched folder (or a subfolder of it).',
        inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } },
        flags: { readOnly: true },
        handler: (i: { path?: string }) => {
          const { full } = inside(i.path);
          const files = Object.entries(scan(full, ignore));
          if (files.length === 0) return `${full} is empty`;
          return files
            .slice(0, 200)
            .map(([f, info]) => `${f}  ${formatSize(info.size)}  ${new Date(info.mtimeMs).toISOString()}`)
            .join('\n');
        },
      },
      {
        name: 'fw_read',
        description: 'Read a text file from a watched folder.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' }, max_bytes: { type: 'integer', minimum: 1, maximum: 200_000, default: 20_000 } },
        },
        flags: { readOnly: true },
        handler: (i: { path: string; max_bytes?: number }) => {
          const { full } = inside(i.path);
          const st = fs.statSync(full);
          if (!st.isFile()) return { text: `${i.path} is not a file`, failed: true };
          const max = i.max_bytes ?? 20_000;
          const fd = fs.openSync(full, 'r');
          try {
            const buf = Buffer.alloc(Math.min(max, st.size));
            fs.readSync(fd, buf, 0, buf.length, 0);
            if (buf.includes(0)) return `${i.path} is a binary file (${formatSize(st.size)})`;
            const text = buf.toString('utf8');
            return st.size > max ? `${text}\n[… ${st.size - max} more bytes]` : text;
          } finally {
            fs.closeSync(fd);
          }
        },
      },
    ],
  });
}
