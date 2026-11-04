import path from 'node:path';
import WebSocket from 'ws';
import type {
  BatchInfo,
  BudgetStatus,
  ConfigResponse,
  EventEnvelope,
  ForkInfo,
  LogRecord,
  PluginStatus,
  SecretInfo,
  SkillInfo,
  WsServerMessage,
} from '@protea/protocol';
import { listRuns, queryLogFile, type LogFilter } from '@protea/core';
import { api, defaultDataDir, readStdin, type ClientOptions } from './client.js';
import { bold, dim, formatBatch, formatEvent, formatFork, formatLog, formatPlugin, formatSkill, green, oneLine, red, yellow } from './format.js';

/** The parsed flags main.ts passes through (parseArgs values). */
export type Flags = Record<string, string | boolean | string[] | undefined>;

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

function intArg(v: string | undefined, what: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n)) throw new Error(`${what} must be an integer`);
  return n;
}

/** A value on the command line: JSON when it parses (numbers, booleans, null, lists), text otherwise. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** "a.b.c" + value → { a: { b: { c: value } } } (a JSON Merge Patch). */
export function patchFor(dotted: string, value: unknown): Record<string, unknown> {
  const keys = dotted.split('.').filter(Boolean);
  if (keys.length === 0) throw new Error('a config path is required, e.g. scheduler.levels.1.debounceMs');
  return keys.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>;
}

function getPath(obj: unknown, dotted: string): unknown {
  let node = obj;
  for (const k of dotted.split('.').filter(Boolean)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

/** The remote source of an install from --git / --tarball (with --ref, --subdir). */
function sourceFlags(f: Flags, local: string | undefined): Record<string, unknown> {
  const subdir = str(f, 'subdir');
  if (str(f, 'git')) return { source: 'git', url: str(f, 'git'), ...(str(f, 'ref') ? { ref: str(f, 'ref') } : {}), ...(subdir ? { subdir } : {}) };
  if (str(f, 'tarball')) return { source: 'tarball', url: str(f, 'tarball'), ...(subdir ? { subdir } : {}) };
  if (!local) throw new Error('give a directory, --git URL or --tarball URL');
  return { path: path.resolve(local), ...(subdir ? { subdir } : {}) };
}

function logFilter(f: Flags): LogFilter {
  const out: LogFilter = {};
  for (const k of ['level', 'component', 'plugin', 'q'] as const) if (str(f, k)) out[k] = str(f, k) as string;
  const since = str(f, 'since');
  if (since) {
    // 15m, 2h, 1d, or a date
    const m = /^(\d+)([smhd])$/.exec(since);
    const t = m ? Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd'] : Date.parse(since);
    if (Number.isNaN(t)) throw new Error('--since takes 15m, 2h, 1d or a date');
    out.since = t;
  }
  const fields: Record<string, string> = {};
  for (const k of ['batch', 'session', 'cursor', 'tool']) if (str(f, k)) fields[k] = str(f, k) as string;
  if (Object.keys(fields).length) out.fields = fields;
  return out;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

function printLogs(logs: LogRecord[], json: boolean): void {
  for (const e of logs) console.log(json ? JSON.stringify(e) : formatLog(e));
}

/** Subscribe over /ws and print until interrupted. */
function follow(o: ClientOptions, subscribe: string[], onMessage: (m: WsServerMessage) => void, extra: Record<string, unknown> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${o.url.replace(/^http/, 'ws')}/ws`, { headers: { authorization: `Bearer ${o.token}` } });
    process.on('SIGINT', () => ws.close());
    ws.on('open', () => ws.send(JSON.stringify({ subscribe, ...extra })));
    ws.on('message', (raw) => onMessage(JSON.parse(String(raw)) as WsServerMessage));
    ws.on('close', () => resolve(0));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`WebSocket refused: ${res.statusCode}`)));
    ws.on('error', (err) => reject(new Error(`cannot reach the daemon at ${o.url}: ${err.message}`)));
  });
}

/**
 * M5 commands (docs/10-architecture/13-control-plane.md §6). Returns null for commands it
 * does not know, so main.ts can fall through to its own.
 */
export async function opsCommand(cmd: string, sub: string | undefined, args: string[], f: Flags, client: () => ClientOptions): Promise<number | null> {
  const json = f['json'] === true;
  switch (cmd) {
    case 'events': {
      const cursor = args[0];
      if (sub === 'show') {
        const r = await api<{ event: EventEnvelope; delivery: { outcome: string; batchId: string | null; at: string } | null }>(client(), 'GET', `/api/events/${intArg(cursor, 'cursor')}`);
        if (json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(formatEvent(r.event));
          console.log(dim(`source ${r.event.source} · received ${r.event.receivedAt}${r.delivery ? ` · ${r.delivery.outcome}${r.delivery.batchId ? ` in ${r.delivery.batchId}` : ''} at ${r.delivery.at}` : ''}`));
          console.log(`\n${r.event.text}`);
        }
        return 0;
      }
      if (sub === 'promote' || sub === 'withdraw') {
        const body = sub === 'promote' ? { trigger: str(f, 'trigger') ?? 'flush' } : undefined;
        const r = await api<{ event: EventEnvelope }>(client(), 'POST', `/api/events/${intArg(cursor, 'cursor')}/${sub}`, body);
        console.log(formatEvent(r.event));
        return 0;
      }
      return null;
    }
    case 'batches': {
      const o = client();
      if (sub === undefined || sub === 'ls') {
        const { batches } = await api<{ batches: BatchInfo[] }>(o, 'GET', `/api/batches${query({ limit: str(f, 'limit') ?? 20 })}`);
        for (const b of [...batches].reverse()) console.log(formatBatch(b));
        return 0;
      }
      if (sub === 'show') {
        if (!args[0]) throw new Error('batches show needs a batch id');
        const r = await api<{ batch: BatchInfo; events: EventEnvelope[]; rounds: Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd?: number; stopReason?: string }> }>(
          o,
          'GET',
          `/api/batches/${encodeURIComponent(args[0])}`,
        );
        console.log(formatBatch(r.batch));
        for (const e of r.events) console.log(`  ${formatEvent(e)}`);
        r.rounds.forEach((u, i) =>
          console.log(dim(`  round ${i + 1}: ${u.model} in ${u.inputTokens} (cache ${u.cacheReadTokens}) out ${u.outputTokens}${u.costUsd !== undefined ? ` $${u.costUsd.toFixed(4)}` : ''} ${u.stopReason ?? ''}`)),
        );
        return 0;
      }
      return null;
    }
    case 'sessions': {
      const o = client();
      if (sub === 'handoff') {
        const reason = str(f, 'reason');
        const r = await api<Record<string, unknown>>(o, 'POST', '/api/sessions/main/handoff', reason ? { reason } : {});
        if (r['scheduled']) console.log('a batch is running; the handoff happens at the start of the next one');
        else if (r['handedOff']) console.log(`handed off to ${String(r['transcript'])}: ${String(r['dropped'])} message(s) into /memories/${String(r['notes'])}, ${String(r['kept'])} kept`);
        else console.log('nothing to hand off yet (only the latest batch is in the conversation)');
        return 0;
      }
      if (sub === undefined || sub === 'ls' || sub === 'forks') {
        const { sessions } = await api<{ sessions: Array<Record<string, unknown>> }>(o, 'GET', '/api/sessions');
        for (const s of sessions) console.log(s['kind'] === 'main' ? `${bold('main')} ${String(s['phase'])}${s['batchId'] ? ` (${String(s['batchId'])})` : ''}` : formatFork(s as unknown as ForkInfo));
        return 0;
      }
      return null;
    }
    case 'forks': {
      const o = client();
      if (sub === 'spawn') {
        const goal = args.join(' ').trim();
        if (!goal) throw new Error('forks spawn needs a goal');
        const level = str(f, 'level');
        const model = str(f, 'model');
        console.log(formatFork(await api<ForkInfo>(o, 'POST', '/api/sessions/forks', { goal, ...(level ? { level: Number(level) } : {}), ...(model ? { model } : {}) })));
        return 0;
      }
      if (sub === 'pause' || sub === 'resume') {
        if (!args[0]) throw new Error(`forks ${sub} needs a fork id`);
        console.log(formatFork(await api<ForkInfo>(o, 'POST', `/api/sessions/forks/${encodeURIComponent(args[0])}/${sub}`)));
        return 0;
      }
      return null;
    }
    case 'plugins': {
      if (sub === 'install' && (str(f, 'git') || str(f, 'tarball'))) {
        console.log(formatPlugin(await api<PluginStatus>(client(), 'POST', '/api/plugins', { ...sourceFlags(f, args[0]), enable: f['disabled'] !== true })));
        return 0;
      }
      if (sub === 'show') {
        if (!args[0]) throw new Error('plugins show needs a plugin id');
        const o = client();
        const id = encodeURIComponent(args[0]);
        const p = await api<PluginStatus & { manifest: Record<string, unknown> | null }>(o, 'GET', `/api/plugins/${id}`);
        const cfg = await api<{ config: Record<string, unknown>; coldKeys: string[] }>(o, 'GET', `/api/plugins/${id}/config`);
        console.log(formatPlugin(p));
        if (p.manifest?.['description']) console.log(dim(`  ${oneLine(String(p.manifest['description']), 140)}`));
        if (p.tools.length) console.log(`  tools: ${p.tools.join(', ')}`);
        console.log(`  config: ${JSON.stringify(cfg.config)}${cfg.coldKeys.length ? dim(` (changing ${cfg.coldKeys.join(', ')} reloads the plugin)`) : ''}`);
        return 0;
      }
      if (sub === 'logs') {
        if (!args[0]) throw new Error('plugins logs needs a plugin id');
        const { logs } = await api<{ logs: LogRecord[] }>(client(), 'GET', `/api/plugins/${encodeURIComponent(args[0])}/logs${query({ limit: str(f, 'limit') ?? 100, level: str(f, 'level') })}`);
        printLogs(logs, json);
        return 0;
      }
      return null;
    }
    case 'skills': {
      if (sub === 'install' && (str(f, 'git') || str(f, 'tarball'))) {
        console.log(formatSkill(await api<SkillInfo>(client(), 'POST', '/api/skills', sourceFlags(f, args[0]))));
        return 0;
      }
      return null;
    }
    case 'config': {
      const o = client();
      if (sub === undefined || sub === 'get') {
        const r = await api<ConfigResponse>(o, 'GET', '/api/config');
        const key = args[0];
        if (f['sources'] === true) {
          for (const [k, src] of Object.entries(r.sources)) if (!key || k === key || k.startsWith(`${key}.`)) if (src !== 'defaults' || f['all'] === true) console.log(`${k} ${dim(src)}`);
          return 0;
        }
        const value = key ? getPath(r.config, key) : r.config;
        if (value === undefined) throw new Error(`no config key ${key ?? ''}`);
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        return 0;
      }
      if (sub === 'set' || sub === 'unset') {
        const key = args[0];
        if (!key || (sub === 'set' && args[1] === undefined)) throw new Error(sub === 'set' ? 'config set <path> <value>' : 'config unset <path>');
        const r = await api<{ changed: string[]; restartRequired: string[] }>(o, 'PATCH', '/api/config', patchFor(key, sub === 'set' ? parseValue(args.slice(1).join(' ')) : null));
        if (r.changed.length === 0) console.log(dim('no change'));
        else console.log(`${green('saved')} ${r.changed.join(', ')}${r.restartRequired.length ? yellow(` · takes effect after a restart (${r.restartRequired.join(', ')})`) : dim(' · applied')}`);
        return 0;
      }
      return null;
    }
    case 'secrets': {
      const o = client();
      if (sub === undefined || sub === 'ls') {
        const { secrets } = await api<{ secrets: SecretInfo[] }>(o, 'GET', '/api/secrets');
        if (secrets.length === 0) console.log(dim('no secrets'));
        for (const s of secrets) console.log(`${s.name.padEnd(28)} ${dim(s.source)}${s.shadowedFile ? yellow(' (the environment overrides the stored file)') : ''}`);
        return 0;
      }
      const name = args[0];
      if (!name) throw new Error(`secrets ${sub} needs a NAME`);
      if (sub === 'set') {
        if (process.stdin.isTTY) console.error(dim(`type the value of ${name}, then Ctrl-D:`));
        const value = (await readStdin()).trim();
        if (!value) throw new Error('empty value');
        await api(o, 'PUT', `/api/secrets/${encodeURIComponent(name)}`, value, { text: true });
        console.log(`${green('saved')} ${name} ${dim('(plugins and MCP servers that use it pick it up when they restart)')}`);
        return 0;
      }
      if (sub === 'rm') {
        const r = await api<{ stillSetByEnvironment: boolean }>(o, 'DELETE', `/api/secrets/${encodeURIComponent(name)}`);
        console.log(`removed ${name}${r.stillSetByEnvironment ? yellow(' (still set by the environment)') : ''}`);
        return 0;
      }
      return null;
    }
    case 'scheduler': {
      const o = client();
      if (sub === undefined || sub === 'status') {
        const r = await api<{ paused: string | null; cooldowns: Array<{ source: string; untilMs: number }>; pending: Record<string, number> }>(o, 'GET', '/api/scheduler');
        console.log(`delivery ${r.paused ? red(`paused by ${r.paused}`) : green('running')}`);
        console.log(`pending  ${Object.entries(r.pending).map(([l, n]) => `L${l}=${n}`).join(' ')}`);
        for (const c of r.cooldowns) console.log(yellow(`cooldown ${c.source} until ${new Date(c.untilMs).toISOString()}`));
        return 0;
      }
      if (sub === 'pause' || sub === 'resume') {
        const r = await api<{ paused: string | null; changed: boolean }>(o, 'POST', `/api/scheduler/${sub}`);
        console.log(r.paused ? `delivery paused by ${r.paused}${r.changed ? '' : dim(' (already)')}` : `delivery running${r.changed ? '' : dim(' (already)')}`);
        return 0;
      }
      if (sub === 'discard') {
        const levels = (str(f, 'levels') ?? args.join(',')).split(',').filter(Boolean).map(Number);
        if (levels.length === 0) throw new Error('scheduler discard --levels 3,4');
        const r = await api<{ discarded: number }>(o, 'POST', '/api/scheduler/discard', { levels });
        console.log(`discarded ${r.discarded} pending event(s)`);
        return 0;
      }
      return null;
    }
    case 'budget': {
      if (sub === 'release') {
        const levels = str(f, 'levels')?.split(',').map((x) => intArg(x.trim(), '--levels'));
        const hours = str(f, 'hours') !== undefined ? Number(str(f, 'hours')) : undefined;
        const r = await api<{ levels: number[]; hardCap: boolean; until: string; promoted: number[] }>(client(), 'POST', '/api/budget/release', {
          ...(levels ? { levels } : {}),
          ...(f['hard-cap'] === true ? { hardCap: true } : {}),
          ...(hours !== undefined ? { hours } : {}),
        });
        const what = [...r.levels.map((l) => `L${l}`), ...(r.hardCap ? ['the hard cap'] : [])].join(', ');
        console.log(green(`released ${what} until ${r.until}; ${r.promoted.length} held event(s) returned to delivery`));
        return 0;
      }
      if (sub !== undefined) return null;
      const r = await api<{ settings: Record<string, unknown>; status: BudgetStatus }>(client(), 'GET', '/api/budget');
      const s = r.status;
      const cap =
        s.hardDailyUsd === null
          ? ''
          : ` · hard cap $${s.hardDailyUsd}${s.hardCapReached ? red(' REACHED') : ''}${s.hardCapReleasedUntil ? yellow(` (released until ${s.hardCapReleasedUntil})`) : ''}`;
      console.log(`daily ${s.dailyUsd === null ? 'unlimited' : `$${s.dailyUsd}`} · spent $${s.spentUsd.toFixed(4)} in 24 h${cap}${s.enforced ? '' : dim(' (tracked, not enforced)')}`);
      for (const [l, b] of Object.entries(s.levels)) {
        const pct = (b.usedRatio ?? 0) * 100;
        const used = b.limitUsd === null ? dim(' unlimited') : ` / $${b.limitUsd.toFixed(2)} (${pct >= 100 ? red(`${pct.toFixed(0)}%`) : `${pct.toFixed(0)}%`})`;
        const extra = (b.held ? yellow(` · ${b.held} held`) : '') + (b.releasedUntil ? yellow(` · released until ${b.releasedUntil}`) : '');
        console.log(`L${l} $${b.spentUsd.toFixed(4)}${used}${extra}`);
      }
      return 0;
    }
    case 'logs': {
      const o = client();
      const filter = logFilter(f);
      if (f['follow'] === true) {
        return follow(o, ['logs'], (m) => {
          if (m.topic === 'log') printLogs([m.data], json);
          else if (m.topic === 'error') console.error(red(m.data.message));
        }, { logFilter: { ...(filter.level !== undefined ? { level: filter.level } : {}), ...(filter.component ? { component: filter.component } : {}), ...(filter.plugin ? { plugin: filter.plugin } : {}), ...(filter.q ? { q: filter.q } : {}) } });
      }
      const { logs } = await api<{ logs: LogRecord[] }>(
        o,
        'GET',
        `/api/logs${query({ ...Object.fromEntries(Object.entries(filter).filter(([k]) => k !== 'fields' && k !== 'since')), ...(filter.since ? { since: filter.since } : {}), ...(filter.fields ?? {}), limit: str(f, 'limit') ?? 200, run: str(f, 'run') } as Record<string, string | number | undefined>)}`,
      );
      printLogs(logs, json);
      return 0;
    }
    case 'logq': {
      // Offline: reads <data>/runs/*/log.jsonl directly, no daemon needed.
      const runsDir = path.join(str(f, 'data-dir') ?? defaultDataDir(), 'runs');
      const runs = listRuns(runsDir);
      if (runs.length === 0) throw new Error(`no runs under ${runsDir}`);
      const pick = f['all'] === true ? [...runs].reverse() : [runs.find((r) => r.id === str(f, 'run')) ?? (str(f, 'run') ? null : runs[0])].filter((r) => r !== null && r !== undefined);
      if (pick.length === 0) throw new Error(`no run ${str(f, 'run') ?? ''}`);
      const limit = Number(str(f, 'limit') ?? 200);
      const filter = logFilter(f);
      for (const r of pick) {
        const logs = await queryLogFile(path.join(runsDir, r.id, 'log.jsonl'), filter, limit);
        if (pick.length > 1 && logs.length > 0 && !json) console.log(bold(`— run ${r.id} (${r.startedAt})`));
        printLogs(logs, json);
      }
      return 0;
    }
    case 'runs': {
      const { current, runs } = await api<{ current: string; runs: Array<{ id: string; startedAt: string; logBytes: number; crashes: number; hasShutdown: boolean }> }>(client(), 'GET', '/api/runs');
      for (const r of runs) {
        const tags = [r.id === current ? green('current') : r.hasShutdown ? dim('clean stop') : yellow('no shutdown record'), r.crashes ? red(`${r.crashes} crash report(s)`) : ''].filter(Boolean).join(' ');
        console.log(`${r.id} ${dim(r.startedAt)} ${dim(`${Math.round(r.logBytes / 1024)} KB`)} ${tags}`);
      }
      return 0;
    }
    case 'memory':
    case 'persona': {
      const o = client();
      const base = cmd === 'memory' ? '/api/memory' : '/api/persona';
      if (sub === undefined || sub === 'ls') {
        const { files } = await api<{ files: Array<{ path: string; size: number; mtime: string }> }>(o, 'GET', cmd === 'memory' ? '/api/memory/tree' : '/api/persona/files');
        for (const x of files) console.log(`${x.path.padEnd(40)} ${dim(`${x.size} B${x.mtime ? ` · ${x.mtime}` : ''}`)}`);
        return 0;
      }
      if (sub === 'search' && cmd === 'memory') {
        const { hits } = await api<{ hits: Array<{ path: string; snippet: string }> }>(o, 'GET', `/api/memory/search${query({ q: args.join(' '), limit: str(f, 'limit') })}`);
        if (hits.length === 0) console.log(dim('no matches'));
        for (const h of hits) console.log(`${bold(h.path)}\n  ${dim(oneLine(h.snippet, 160))}`);
        return 0;
      }
      const file = args[0];
      if (!file) throw new Error(`${cmd} ${sub} needs a file path`);
      if (sub === 'cat') {
        const r = await api<{ text: string }>(o, 'GET', `${base}/file${query({ path: file })}`);
        process.stdout.write(r.text.endsWith('\n') ? r.text : `${r.text}\n`);
        return 0;
      }
      if (sub === 'put') {
        if (process.stdin.isTTY) console.error(dim(`type the new contents of ${file}, then Ctrl-D:`));
        const text = await readStdin();
        const r = await api<{ path: string }>(o, 'PUT', `${base}/file${query({ path: file })}`, text, { text: true });
        console.log(`${green('saved')} ${r.path}${cmd === 'persona' ? dim(' (applies from the next model request)') : ''}`);
        return 0;
      }
      return null;
    }
    case 'audit': {
      const { audit } = await api<{ audit: Array<{ id: number; at: string; kind: string; tool?: string; owner?: string; summary?: string; outcome?: string }> }>(
        client(),
        'GET',
        `/api/audit${query({ kind: str(f, 'kind'), limit: str(f, 'limit') ?? 50 })}`,
      );
      for (const a of [...audit].reverse()) console.log(`${dim(a.at)} ${a.kind.padEnd(18)} ${a.tool ?? ''} ${oneLine(a.summary ?? '', 100)} ${dim([a.owner, a.outcome].filter(Boolean).join(' · '))}`);
      return 0;
    }
  }
  return null;
}
