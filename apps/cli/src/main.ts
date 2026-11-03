#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { LEVELS, TRIGGERS, isLevel, isTrigger, type EventEnvelope, type PushEventResponse, type StatusResponse } from '@protea/protocol';
import { api, defaultDataDir, resolveClient, stream, type ClientOptions } from './client.js';
import { bold, dim, formatEvent, formatStatus, green, red } from './format.js';

const HELP = `protea — Protea personal assistant runtime

Usage:
  protea serve [--data-dir DIR]                 run the daemon
  protea status                                 show runtime status
  protea events push <text…> [--level N] [--trigger T] [--no-wait] [--timeout SEC]
                                                send a console message and print the replies
  protea events tail [--since CURSOR] [--level N] [--source ID]
                                                follow events, batches and outputs live
  protea events ls [--limit N] [--state S]      list recent events

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
