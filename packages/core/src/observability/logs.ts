import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** One parsed log line (pino JSON): at least time, level, msg; usually run and component. */
export type LogEntry = Record<string, unknown> & { time: number; level: number; msg: string };

export const LOG_LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

export function levelName(level: number): string {
  return Object.entries(LOG_LEVELS).find(([, n]) => n === level)?.[0] ?? String(level);
}

/**
 * What `GET /api/logs`, the WebSocket `logs` topic and `protea logq` filter on
 * (docs/10-architecture/15-observability.md §2). All conditions must hold.
 */
export interface LogFilter {
  /** Minimum level: a name (`warn`) or a number (40). */
  level?: string | number;
  component?: string;
  plugin?: string;
  /** Case-insensitive substring of the whole JSON line. */
  q?: string;
  /** Epoch milliseconds, inclusive. */
  since?: number;
  until?: number;
  /** Exact field matches, e.g. { batch: "01J…" }; values compare as strings. */
  fields?: Record<string, string>;
}

function minLevel(l: string | number | undefined): number {
  if (l === undefined) return 0;
  if (typeof l === 'number') return l;
  const n = LOG_LEVELS[l.toLowerCase()] ?? Number(l);
  if (!Number.isFinite(n)) throw new Error(`unknown log level "${l}"`);
  return n;
}

/** Compile a filter once; throws on an unknown level name. */
export function logMatcher(f: LogFilter): (e: LogEntry, line?: string) => boolean {
  const min = minLevel(f.level);
  const q = f.q?.toLowerCase();
  const fields = Object.entries(f.fields ?? {});
  return (e, line) => {
    if (e.level < min) return false;
    if (f.component !== undefined && e['component'] !== f.component) return false;
    if (f.plugin !== undefined && e['plugin'] !== f.plugin) return false;
    if (f.since !== undefined && e.time < f.since) return false;
    if (f.until !== undefined && e.time > f.until) return false;
    for (const [k, v] of fields) if (String(e[k]) !== v) return false;
    if (q && !(line ?? JSON.stringify(e)).toLowerCase().includes(q)) return false;
    return true;
  };
}

export function parseLogLine(line: string): LogEntry | null {
  if (!line.startsWith('{')) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o['level'] !== 'number' || typeof o['time'] !== 'number') return null;
    return { ...o, msg: typeof o['msg'] === 'string' ? o['msg'] : '' } as LogEntry;
  } catch {
    return null;
  }
}

/**
 * The last N log lines of this run, in memory, plus live listeners. It is a pino
 * destination (`write(line)`), so it sees exactly what the run's log.jsonl gets.
 */
export class LogRing {
  private readonly buf: LogEntry[] = [];
  private readonly listeners = new Set<(e: LogEntry) => void>();

  constructor(readonly capacity = 5_000) {}

  write(line: string): void {
    for (const l of line.split('\n')) {
      const e = parseLogLine(l);
      if (!e) continue;
      this.buf.push(e);
      if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
      for (const fn of [...this.listeners]) {
        try {
          fn(e);
        } catch {
          // a broken listener must never break logging
        }
      }
    }
  }

  /** Matching entries, oldest first, at most `limit` (the newest ones). */
  query(f: LogFilter = {}, limit = 200): LogEntry[] {
    const match = logMatcher(f);
    const out: LogEntry[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.buf[i] as LogEntry;
      if (match(e)) out.push(e);
    }
    return out.reverse();
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Matching lines of a log.jsonl file, oldest first, at most `limit` (the newest ones). */
export async function queryLogFile(file: string, f: LogFilter = {}, limit = 200): Promise<LogEntry[]> {
  const match = logMatcher(f);
  const out: LogEntry[] = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const e = parseLogLine(line);
    if (!e || !match(e, line)) continue;
    out.push(e);
    if (out.length > limit) out.shift();
  }
  return out;
}

export interface RunInfo {
  id: string;
  /** Time of the first log line (or the directory's mtime when the log is empty). */
  startedAt: string;
  logBytes: number;
  crashes: number;
  hasShutdown: boolean;
}

/** Run directories under <data>/runs, newest first (run ids are ULIDs, so they sort by time). */
export function listRuns(runsDir: string): RunInfo[] {
  if (!fs.existsSync(runsDir)) return [];
  const out: RunInfo[] = [];
  for (const id of fs.readdirSync(runsDir)) {
    const dir = path.join(runsDir, id);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const log = path.join(dir, 'log.jsonl');
    const logBytes = fs.existsSync(log) ? fs.statSync(log).size : 0;
    let startedAt = st.mtime.toISOString();
    if (logBytes > 0) {
      const fd = fs.openSync(log, 'r');
      try {
        const head = Buffer.alloc(Math.min(logBytes, 4096));
        fs.readSync(fd, head, 0, head.length, 0);
        const first = parseLogLine(head.toString('utf8').split('\n')[0] ?? '');
        if (first) startedAt = new Date(first.time).toISOString();
      } finally {
        fs.closeSync(fd);
      }
    }
    const crashDir = path.join(dir, 'crash');
    out.push({
      id,
      startedAt,
      logBytes,
      crashes: fs.existsSync(crashDir) ? fs.readdirSync(crashDir).length : 0,
      hasShutdown: fs.existsSync(path.join(dir, 'shutdown.json')),
    });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** Delete all but the newest `keep` run directories (never `current`). Returns the removed ids. */
export function pruneRuns(runsDir: string, keep: number, current: string): string[] {
  const removed: string[] = [];
  for (const r of listRuns(runsDir).slice(keep)) {
    if (r.id === current) continue;
    fs.rmSync(path.join(runsDir, r.id), { recursive: true, force: true });
    removed.push(r.id);
  }
  return removed;
}
