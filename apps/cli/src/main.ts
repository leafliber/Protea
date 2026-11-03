#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  LEVELS,
  TRIGGERS,
  isLevel,
  isTrigger,
  type ApprovalInfo,
  type EventEnvelope,
  type ForkInfo,
  type PluginStatus,
  type PushEventResponse,
  type StatusResponse,
} from '@protea/protocol';
import { api, defaultDataDir, resolveClient, stream, type ClientOptions } from './client.js';
import { devPlugin } from './dev-plugin.js';
import { bold, dim, formatApproval, formatEvent, formatFork, formatPlugin, formatStatus, green, red, yellow } from './format.js';

const HELP = `protea — Protea personal assistant runtime

Usage:
  protea serve [--data-dir DIR]                 run the daemon
  protea status                                 show runtime status
  protea events push <text…> [--level N] [--trigger T] [--no-wait] [--timeout SEC]
                                                send a console message and print the replies
  protea events tail [--since CURSOR] [--level N] [--source ID]
                                                follow events, batches and outputs live
  protea events ls [--limit N] [--state S]      list recent events
  protea forks [ls]                             list unfinished and recently ended forks
  protea forks show <id>                        show a fork and its transcript
  protea forks cancel <id>                      cancel a fork
  protea plugins [ls]                           list plugins and their state
  protea plugins install <dir> [--disabled]     install a plugin directory into the data volume
  protea plugins enable|disable|reload|restart <id>
  protea plugins config <id> <json>             replace a plugin's configuration (validated, saved)
  protea plugins uninstall <id> [--keep-data]   remove a disabled data-volume plugin
  protea approvals [ls] [--state S]             list approval requests
  protea approvals approve|deny <id>            decide an approval request
  protea dev-plugin <dir> [--check] [--config JSON] [--owner KEY]
                                                run a plugin under a minimal host (or check its protocol conformance)

Common options:
  --url URL        control API (default $PROTEA_URL or http://127.0.0.1:7788)
  --token TOKEN    admin token (default $PROTEA_ADMIN_TOKEN or <data-dir>/secrets/PROTEA_ADMIN_TOKEN)
  --data-dir DIR   data directory (default $PROTEA_DATA_DIR, /data, or ./protea-data)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-dir': { type: 'string' },
    url: { type: 'string' },
    token: { type: 'string' },
    level: { type: 'string' },
    trigger: { type: 'string' },
    since: { type: 'string' },
    source: { type: 'string' },
    state: { type: 'string' },
    limit: { type: 'string' },
    timeout: { type: 'string' },
    'no-wait': { type: 'boolean' },
    disabled: { type: 'boolean' },
    'keep-data': { type: 'boolean' },
    check: { type: 'boolean' },
    config: { type: 'string' },
    owner: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

function client(): ClientOptions {
  return resolveClient({
    ...(values.url !== undefined ? { url: values.url } : {}),
    ...(values.token !== undefined ? { token: values.token } : {}),
    ...(values['data-dir'] !== undefined ? { dataDir: values['data-dir'] } : {}),
  });
}

function intFlag(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

async function serve(): Promise<void> {
  const { runDaemon } = await import('@protea/daemon');
  await runDaemon({ dataDir: values['data-dir'] ?? defaultDataDir() });
}

async function status(): Promise<void> {
  console.log(formatStatus(await api<StatusResponse>(client(), 'GET', '/api/status')));
}

async function push(textParts: string[]): Promise<number> {
  const text = textParts.join(' ').trim();
  if (!text) throw new Error('nothing to send');
  const level = intFlag('level', values.level);
  if (level !== undefined && !isLevel(level)) throw new Error(`--level must be one of ${LEVELS.join(', ')}`);
  if (values.trigger !== undefined && !isTrigger(values.trigger)) throw new Error(`--trigger must be one of ${TRIGGERS.join(', ')}`);
  const o = client();
  const wait = !values['no-wait'];
  const timeoutMs = (intFlag('timeout', values.timeout) ?? 300) * 1000;

  const ac = new AbortController();
  const it = wait ? stream(o, '/api/stream', ac.signal) : null;
  if (it) await it.next(); // the "hello" message: we are subscribed before pushing
  const res = await api<PushEventResponse>(o, 'POST', '/api/events', {
    text,
    ...(level !== undefined ? { level } : {}),
    ...(values.trigger !== undefined ? { trigger: values.trigger } : {}),
  });
  console.error(dim(`→ #${res.cursor} L${res.effectiveLevel} ${res.effectiveTrigger}${res.deduped ? ' (duplicate)' : ''}`));
  for (const w of res.warnings) console.error(dim(`  ${w}`));
  if (!it || res.deduped || res.effectiveTrigger === 'store' || res.effectiveTrigger === 'piggyback') {
    ac.abort();
    return 0;
  }

  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let mine: string | null = null;
  try {
    for await (const m of it) {
      const data = JSON.parse(m.data || '{}') as Record<string, unknown>;
      if ((m.event === 'batch.started' || m.event === 'batch.extended') && (data['cursors'] as number[]).includes(res.cursor)) {
        mine = String(data['batchId']);
      } else if (m.event === 'phase' && mine && data['batchId'] === mine) {
        if (data['phase'] === 'model') console.error(dim(`… thinking (round ${String(data['round'] ?? '?')})`));
        else if (data['phase'] === 'tools') console.error(dim('… running tools'));
        else if (data['phase'] === 'backoff') console.error(dim('… model unavailable, retrying'));
      } else if (m.event === 'output') {
        console.log(`${bold('◂')} ${String(data['text'])}`);
      } else if (m.event === 'batch.ended' && data['batchId'] === mine) {
        const reason = String(data['endReason']);
        const ok = ['end_turn', 'ends_turn'].includes(reason);
        console.error((ok ? dim : red)(`■ ${reason} after ${String(data['rounds'])} round(s)`));
        return ok ? 0 : 1;
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  console.error(red(`no reply within ${timeoutMs / 1000}s`));
  return 2;
}

async function tail(): Promise<void> {
  const o = client();
  const since = intFlag('since', values.since);
  const level = intFlag('level', values.level);
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  try {
    for await (const m of stream(o, `/api/stream${since !== undefined ? `?since=${since}` : ''}`, ac.signal)) {
      const data = JSON.parse(m.data || '{}') as Record<string, unknown>;
      switch (m.event) {
        case 'hello':
          console.error(dim(`connected to run ${String(data['runId'])}`));
          break;
        case 'event': {
          const e = data as unknown as EventEnvelope;
          if (level !== undefined && e.effLevel > level) break;
          if (values.source !== undefined && e.source !== values.source) break;
          console.log(formatEvent(e));
          break;
        }
        case 'settled':
          console.log(dim(`  ${(data['cursors'] as number[]).map((c) => `#${c}`).join(' ')} → ${String(data['outcome'])}`));
          break;
        case 'batch.started':
          console.log(green(`▶ ${String(data['batchId'])} L${String(data['level'])} ${String(data['reason'])} [${(data['cursors'] as number[]).join(',')}]`));
          break;
        case 'batch.ended':
          console.log(dim(`■ ${String(data['batchId'])} ${String(data['endReason'])} (${String(data['rounds'])} rounds)`));
          break;
        case 'phase':
          if (data['phase'] !== 'idle') console.log(dim(`  · ${String(data['phase'])}${data['round'] ? ` ${String(data['round'])}` : ''}`));
          break;
        case 'output':
          console.log(`${bold('◂')} ${dim(`${String(data['plugin'])}:`)} ${String(data['text'])}`);
          break;
        case 'scheduler': {
          const kind = String(data['kind']);
          const detail =
            kind === 'preempt' || kind === 'interrupt'
              ? `#${String(data['cursor'])} (L${String(data['level'])}) cut ${String(data['batchId'])} (L${String(data['batchLevel'])}, ${String(data['phase'])})`
              : kind === 'aged'
                ? (data['cursors'] as number[]).map((c) => `#${c}`).join(' ')
                : kind === 'storm_cooldown'
                  ? String(data['source'])
                  : (data['forkIds'] as string[]).join(' ');
          console.log(yellow(`  ⚡ ${kind} ${detail}`));
          break;
        }
        case 'fork':
          console.log(dim(`  ⑂ ${formatFork(data as unknown as ForkInfo)}`));
          break;
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  }
}

async function ls(): Promise<void> {
  const limit = intFlag('limit', values.limit) ?? 20;
  const q = new URLSearchParams({ limit: String(limit), ...(values.state ? { state: values.state } : {}) });
  const { events } = await api<{ events: EventEnvelope[] }>(client(), 'GET', `/api/events?${q.toString()}`);
  for (const e of [...events].reverse()) console.log(formatEvent(e));
}

async function forks(sub: string | undefined, id: string | undefined): Promise<number> {
  const o = client();
  if (sub === undefined || sub === 'ls') {
    const { forks: all } = await api<{ forks: ForkInfo[] }>(o, 'GET', '/api/sessions/forks');
    if (all.length === 0) console.log(dim('no forks'));
    for (const f of all) console.log(formatFork(f));
    return 0;
  }
  if (!id) throw new Error(`forks ${sub} needs a fork id`);
  if (sub === 'cancel') {
    console.log(formatFork(await api<ForkInfo>(o, 'POST', `/api/sessions/forks/${encodeURIComponent(id)}/cancel`)));
    return 0;
  }
  if (sub === 'show') {
    console.log(formatFork(await api<ForkInfo>(o, 'GET', `/api/sessions/forks/${encodeURIComponent(id)}`)));
    const t = await api<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }>(
      o,
      'GET',
      `/api/sessions/${encodeURIComponent(id)}/transcript?from=0&limit=500`,
    );
    for (const m of t.messages) {
      for (const b of m.content) {
        const body =
          b['type'] === 'text'
            ? String(b['text'])
            : b['type'] === 'tool_use'
              ? `→ ${String(b['name'])} ${JSON.stringify(b['input'])}`
              : b['type'] === 'tool_result'
                ? `← ${typeof b['content'] === 'string' ? b['content'] : JSON.stringify(b['content'])}`
                : `[${String(b['type'])}]`;
        console.log(`${m.role === 'assistant' ? bold('assistant') : dim('user')}  ${body}`);
      }
    }
    return 0;
  }
  throw new Error(`unknown forks command: ${sub}`);
}

async function plugins(sub: string | undefined, args: string[]): Promise<number> {
  const o = client();
  const id = args[0];
  if (sub === undefined || sub === 'ls') {
    const { plugins: all } = await api<{ plugins: PluginStatus[] }>(o, 'GET', '/api/plugins');
    for (const p of all) console.log(formatPlugin(p));
    return 0;
  }
  if (!id) throw new Error(`plugins ${sub} needs ${sub === 'install' ? 'a directory' : 'a plugin id'}`);
  switch (sub) {
    case 'install': {
      const { resolve } = await import('node:path');
      console.log(formatPlugin(await api<PluginStatus>(o, 'POST', '/api/plugins', { path: resolve(id), enable: !values.disabled })));
      return 0;
    }
    case 'enable':
    case 'disable':
    case 'reload':
    case 'restart':
      console.log(formatPlugin(await api<PluginStatus>(o, 'POST', `/api/plugins/${encodeURIComponent(id)}/${sub}`)));
      return 0;
    case 'config': {
      if (!args[1]) throw new Error('plugins config needs a JSON object');
      console.log(formatPlugin(await api<PluginStatus>(o, 'PATCH', `/api/plugins/${encodeURIComponent(id)}/config`, { config: JSON.parse(args[1]) as unknown })));
      return 0;
    }
    case 'uninstall': {
      const r = await api<{ replacedBy: PluginStatus | null }>(o, 'DELETE', `/api/plugins/${encodeURIComponent(id)}${values['keep-data'] ? '?keepData=true' : ''}`);
      console.log(`uninstalled ${id}${r.replacedBy ? ` (the built-in ${id} is back: ${r.replacedBy.state})` : ''}`);
      return 0;
    }
  }
  throw new Error(`unknown plugins command: ${sub}`);
}

async function approvals(sub: string | undefined, id: string | undefined): Promise<number> {
  const o = client();
  if (sub === undefined || sub === 'ls') {
    const q = values.state ? `?state=${encodeURIComponent(values.state)}` : '';
    const { approvals: all } = await api<{ approvals: ApprovalInfo[] }>(o, 'GET', `/api/approvals${q}`);
    if (all.length === 0) console.log(dim('no approval requests'));
    for (const a of all) console.log(formatApproval(a));
    return 0;
  }
  if (sub !== 'approve' && sub !== 'deny') throw new Error(`unknown approvals command: ${sub}`);
  if (!id) throw new Error(`approvals ${sub} needs an id`);
  console.log(formatApproval(await api<ApprovalInfo>(o, 'POST', `/api/approvals/${encodeURIComponent(id)}/decide`, { decision: sub })));
  return 0;
}

async function main(): Promise<number> {
  const [cmd, sub, ...rest] = positionals;
  if (values.version) {
    const { VERSION } = await import('@protea/daemon');
    console.log(VERSION);
    return 0;
  }
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case 'serve':
      await serve();
      return -1; // keep running
    case 'status':
      await status();
      return 0;
    case 'events':
      if (sub === 'push') return push(rest);
      if (sub === 'tail') return tail().then(() => 0);
      if (sub === 'ls') return ls().then(() => 0);
      break;
    case 'forks':
      return forks(sub, rest[0]);
    case 'plugins':
      return plugins(sub, rest);
    case 'approvals':
      return approvals(sub, rest[0]);
    case 'dev-plugin':
      if (!sub) break;
      return devPlugin(sub, {
        check: !!values.check,
        ...(values.config !== undefined ? { config: JSON.parse(values.config) as Record<string, unknown> } : {}),
        owners: values.owner ? values.owner.split(',') : [],
      });
  }
  console.error(`unknown command: ${positionals.join(' ')}\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(red(`error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  },
);
