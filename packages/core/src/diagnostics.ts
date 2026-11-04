import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { listRuns } from './observability/logs.js';

/**
 * Diagnostics bundle (docs/10-architecture/15-observability.md §8): one .tar.gz with what is
 * needed to understand a problem from a real deployment — logs of recent runs, crash and
 * shutdown records, a metadata export of the event store, usage with cache shares, batches,
 * audit, live status and metrics. Conversation content (event text, handoff notes, transcripts,
 * recorded model calls) is only included when asked for. `secrets/` is never read, and every
 * file passes through the secret filter before it is written.
 */

export const DIAG_FORMAT = 1;
export const DIAG_NAME_RE = /^protea-diag-\d{8}T\d{6}Z(-\d{1,3})?\.tar\.gz$/;

export interface DiagnosticsOptions {
  dataDir: string;
  version: string;
  /** Hours of events, usage, batches, approvals and audit to include (default 72). */
  sinceHours?: number;
  /** Newest run directories to include (default 5). */
  runs?: number;
  /** Event text, handoff notes, approval/audit summaries and session summaries. */
  content?: boolean;
  /** runs/<id>/provider.jsonl (recorded model calls, which hold conversation content). */
  recordings?: boolean;
  /** Session transcripts written in the window (conversation content). */
  transcripts?: boolean;
  /** Snapshots from the running daemon, by file name: objects become JSON, strings stay text. */
  live?: Record<string, unknown>;
  /** Applied to the text of every file (secret values). */
  redact: (text: string) => string;
  /** Directory for the archive (default <data>/exports). */
  out?: string;
  /** Archives kept in the default directory (default 10). */
  keep?: number;
  now?: Date;
}

export interface DiagnosticsManifest {
  format: number;
  createdAt: string;
  protea: string;
  image: string | null;
  node: string;
  platform: string;
  since: string;
  options: { sinceHours: number; runs: number; content: boolean; recordings: boolean; transcripts: boolean };
  files: Array<{ path: string; bytes: number }>;
  notes: string[];
}

export interface DiagnosticsResult {
  name: string;
  path: string;
  bytes: number;
  manifest: DiagnosticsManifest;
}

export function diagnosticsDir(dataDir: string): string {
  return path.join(dataDir, 'exports');
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function clip(text: unknown, n: number): unknown {
  return typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text;
}

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`tar failed: ${(stderr || err.message).trim()}`));
      else resolve();
    });
  });
}

function dirBytes(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const name of fs.readdirSync(p)) n += dirBytes(path.join(p, name));
  return n;
}

function walk(root: string, rel = ''): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(path.join(root, r));
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push({ path: r, bytes: st.size });
  }
  return out;
}

/** Files under `dir` (recursively) modified at or after `sinceMs`. */
function recentFiles(dir: string, sinceMs: number, rel = ''): string[] {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(dir, rel))) {
    const r = rel ? path.join(rel, name) : name;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...recentFiles(dir, sinceMs, r));
    else if (st.isFile() && st.mtimeMs >= sinceMs && !name.startsWith('.tmp-')) out.push(r);
  }
  return out;
}

type Row = Record<string, unknown>;

function usageTotals(rows: Row[]): Record<string, unknown> {
  const t = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const r of rows) {
    t.calls++;
    t.inputTokens += Number(r['input_tokens'] ?? 0);
    t.outputTokens += Number(r['output_tokens'] ?? 0);
    t.cacheReadTokens += Number(r['cache_read_tokens'] ?? 0);
    t.cacheWriteTokens += Number(r['cache_write_tokens'] ?? 0);
    t.costUsd += Number(r['cost_usd'] ?? 0);
  }
  const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return { ...t, costUsd: Math.round(t.costUsd * 1e6) / 1e6, cacheHit: prompt > 0 ? Math.round((t.cacheReadTokens / prompt) * 1000) / 1000 : null };
}

function countBy(rows: Row[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r[key] ?? '');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function groupUsage(rows: Row[], key: (r: Row) => string): Record<string, unknown> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  return Object.fromEntries([...groups].map(([k, g]) => [k, usageTotals(g)]));
}

export async function createDiagnostics(o: DiagnosticsOptions): Promise<DiagnosticsResult> {
  const now = o.now ?? new Date();
  const sinceHours = o.sinceHours ?? 72;
  if (!(sinceHours > 0)) throw new Error('sinceHours must be a positive number');
  const runsWanted = o.runs ?? 5;
  const content = o.content === true;
  const recordings = o.recordings === true;
  const transcripts = o.transcripts === true;
  const sinceMs = now.getTime() - sinceHours * 3600_000;
  const since = new Date(sinceMs).toISOString();
  const dataDir = path.resolve(o.dataDir);
  const parent = path.resolve(o.out ?? diagnosticsDir(dataDir));
  // Two bundles in the same second get -2, -3, … appended.
  let name = `protea-diag-${stamp(now)}`;
  for (let i = 2; fs.existsSync(path.join(parent, `${name}.tar.gz`)) || fs.existsSync(path.join(parent, `.tmp-${name}`)); i++) {
    if (i > 999) throw new Error('too many diagnostics bundles in one second');
    name = `protea-diag-${stamp(now)}-${i}`;
  }
  const archive = path.join(parent, `${name}.tar.gz`);
  const work = path.join(parent, `.tmp-${name}`);
  const root = path.join(work, name);
  fs.mkdirSync(root, { recursive: true });

  const target = (rel: string): string => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };
  const writeText = (rel: string, text: string): void => fs.writeFileSync(target(rel), o.redact(text));
  const writeJson = (rel: string, v: unknown): void => writeText(rel, `${JSON.stringify(v, null, 2)}\n`);
  const writeJsonl = (rel: string, rows: unknown[]): void => writeText(rel, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  /** Line by line, so large logs never sit in memory whole. */
  const copyRedacted = async (src: string, rel: string): Promise<void> => {
    const out = fs.createWriteStream(target(rel));
    const rl = readline.createInterface({ input: fs.createReadStream(src, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!out.write(`${o.redact(line)}\n`)) await new Promise<void>((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  };
  const notes: string[] = [
    'secrets/ is never read; every file passed through the secret filter (known values become [REDACTED:<name>]).',
    content
      ? 'content: event text (clipped to 4000 chars), handoff notes and approval/audit summaries are included.'
      : 'no content: events carry metadata and their length only; handoff notes, approval and audit summaries are left out.',
  ];

  try {
    // —— System and configuration ——
    const sizes: Record<string, number> = {};
    for (const item of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
      if (item.startsWith('.tmp-')) continue;
      sizes[item] = item === 'secrets' ? 0 : dirBytes(path.join(dataDir, item));
    }
    writeJson('system.json', {
      protea: o.version,
      image: process.env['PROTEA_IMAGE'] ?? null,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      os: `${os.type()} ${os.release()}`,
      cpus: os.cpus().length,
      memoryMb: { total: Math.round(os.totalmem() / 1048576), free: Math.round(os.freemem() / 1048576) },
      loadavg: os.loadavg(),
      uptimeSec: Math.round(os.uptime()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dataDirBytes: sizes,
      envNames: Object.keys(process.env).filter((k) => k.startsWith('PROTEA_') && !k.startsWith('PROTEA_SECRET_')).sort(),
    });
    const configFile = path.join(dataDir, 'config.yaml');
    if (fs.existsSync(configFile)) writeText('config.yaml', fs.readFileSync(configFile, 'utf8'));
    for (const [file, v] of Object.entries(o.live ?? {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string') writeText(`live/${file}`, v);
      else writeJson(`live/${file}`, v);
    }

    // —— Run directories: logs, shutdown and crash records ——
    const runs = listRuns(path.join(dataDir, 'runs')).slice(0, runsWanted);
    for (const r of runs) {
      const dir = path.join(dataDir, 'runs', r.id);
      // log.jsonl and its rotated files (log.1.jsonl, …), the shutdown record; recordings and
      // discarded transcript records only when asked (they hold conversation content).
      const wanted = (f: string): boolean =>
        /^log(\.\d+)?\.jsonl$/.test(f) || f === 'shutdown.json' || (recordings && f === 'provider.jsonl') || (content && f === 'transcript.jsonl');
      for (const f of fs.readdirSync(dir).filter(wanted).sort()) await copyRedacted(path.join(dir, f), `runs/${r.id}/${f}`);
      const crashDir = path.join(dir, 'crash');
      if (fs.existsSync(crashDir)) {
        for (const f of fs.readdirSync(crashDir)) await copyRedacted(path.join(crashDir, f), `runs/${r.id}/crash/${f}`);
      }
    }

    // —— Event store (read-only; safe while the daemon runs) ——
    const dbFile = path.join(dataDir, 'protea.db');
    if (fs.existsSync(dbFile)) {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        db.pragma('busy_timeout = 5000');
        const all = (sql: string, ...args: unknown[]): Row[] => db.prepare(sql).all(...args) as Row[];
        const has = (table: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        const events = all(
          `SELECT cursor, run, received_at, ts, type, source, origin, level, trigger, eff_level, eff_trigger, state, sender_role,
                  correlation, ephemeral, batch_id, tags, length(text) AS chars${content ? ', text, meta, sender_key' : ''}
             FROM events WHERE received_at >= ? ORDER BY cursor`,
          since,
        ).map((e) => (content ? { ...e, text: clip(e['text'], 4000), meta: clip(e['meta'], 4000) } : e));
        writeJsonl('db/events.jsonl', events);
        writeJsonl('db/deliveries.jsonl', all('SELECT * FROM deliveries WHERE at >= ? ORDER BY cursor', since));
        const batches = all('SELECT * FROM batches WHERE started_at >= ? ORDER BY started_at', since);
        writeJsonl('db/batches.jsonl', batches);
        const usage = all('SELECT * FROM usage WHERE at_ms >= ? ORDER BY id', sinceMs);
        writeJsonl('db/usage.jsonl', usage);
        writeJsonl(
          'db/sessions.jsonl',
          all('SELECT * FROM sessions ORDER BY created_at').map((s) => (content ? s : { ...s, summary: s['summary'] ? `(${String(s['summary']).length} chars)` : null })),
        );
        let approvals: Row[] = [];
        if (has('approvals')) {
          approvals = all('SELECT * FROM approvals WHERE created_at >= ? ORDER BY seq', since);
          writeJsonl('db/approvals.jsonl', approvals.map((a) => (content ? a : { ...a, summary: null, reason: null })));
        }
        if (has('audit')) {
          writeJsonl(
            'db/audit.jsonl',
            all('SELECT * FROM audit WHERE at >= ? ORDER BY id', since).map((a) => (content ? a : { ...a, summary: null, detail: null })),
          );
        }
        if (has('tool_stats')) writeJsonl('db/tool_stats.jsonl', all('SELECT * FROM tool_stats ORDER BY calls DESC'));
        writeJsonl('db/schema_version.jsonl', all('SELECT * FROM schema_version ORDER BY version'));
        const ended = batches.filter((b) => b['ended_at']);
        writeJson('summary.json', {
          since,
          events: {
            total: events.length,
            byState: countBy(events, 'state'),
            byLevel: countBy(events, 'eff_level'),
            bySource: countBy(events, 'source'),
            byType: countBy(events, 'type'),
            downgraded: events.filter((e) => e['eff_level'] !== e['level']).length,
          },
          handoffs: events.filter((e) => e['type'] === 'session.handoff').length,
          batches: {
            total: batches.length,
            byEndReason: countBy(ended, 'end_reason'),
            byLevel: countBy(batches, 'level'),
            avgRounds: ended.length ? Math.round((ended.reduce((n, b) => n + Number(b['rounds'] ?? 0), 0) / ended.length) * 100) / 100 : null,
          },
          usage: { total: usageTotals(usage), byRole: groupUsage(usage, (u) => String(u['role'])), byModel: groupUsage(usage, (u) => String(u['model'])) },
          approvals: countBy(approvals, 'state'),
          runs: runs.map((r) => ({ id: r.id, startedAt: r.startedAt, logBytes: r.logBytes, crashes: r.crashes, cleanShutdown: r.hasShutdown })),
        });
      } finally {
        db.close();
      }
    } else notes.push('no protea.db in the data directory');

    // —— Conversation content, only when asked ——
    if (content) {
      const notesDir = path.join(dataDir, 'memory', 'handoff');
      for (const f of recentFiles(notesDir, sinceMs)) await copyRedacted(path.join(notesDir, f), `memory/handoff/${f}`);
    }
    if (transcripts) {
      const sessionsDir = path.join(dataDir, 'sessions');
      for (const f of recentFiles(sessionsDir, sinceMs)) await copyRedacted(path.join(sessionsDir, f), `sessions/${f}`);
    }

    const manifest: DiagnosticsManifest = {
      format: DIAG_FORMAT,
      createdAt: now.toISOString(),
      protea: o.version,
      image: process.env['PROTEA_IMAGE'] ?? null,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      since,
      options: { sinceHours, runs: runsWanted, content, recordings, transcripts },
      files: walk(root),
      notes,
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await tar(['-czf', archive, '-C', work, name]);
    if (o.out === undefined) pruneDiagnostics(parent, o.keep ?? 10);
    return { name: `${name}.tar.gz`, path: archive, bytes: fs.statSync(archive).size, manifest };
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

/** Sort key: the timestamp, then the same-second counter (none = 1). */
function order(name: string): string {
  const m = /(\d{8}T\d{6}Z)(?:-(\d+))?/.exec(name);
  return m ? `${m[1]}-${(m[2] ?? '1').padStart(3, '0')}` : name;
}

/** Archives in `dir`, newest first. */
export function listDiagnostics(dir: string): Array<{ name: string; path: string; bytes: number; createdAt: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => DIAG_NAME_RE.test(n))
    .sort((a, b) => order(b).localeCompare(order(a)))
    .map((name) => {
      const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
      const createdAt = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : '';
      return { name, path: path.join(dir, name), bytes: fs.statSync(path.join(dir, name)).size, createdAt };
    });
}

/** Keep the newest `keep` archives in `dir`. */
export function pruneDiagnostics(dir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const d of listDiagnostics(dir).slice(keep)) {
    fs.rmSync(d.path, { force: true });
    removed.push(d.name);
  }
  return removed;
}
