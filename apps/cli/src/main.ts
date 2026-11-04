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
  type McpServerStatus,
  type McpToolInfo,
  type PluginStatus,
  type SkillInfo,
  type PushEventResponse,
  type StatusResponse,
} from '@protea/protocol';
import { api, defaultDataDir, resolveClient, stream, type ClientOptions } from './client.js';
import { backupCommand, dropPrivileges, healthcheckCommand, migrateCommand, replayCommand, restoreCommand } from './admin.js';
import { devPlugin } from './dev-plugin.js';
import { opsCommand } from './ops.js';
import { bold, dim, formatApproval, formatEvent, formatFork, formatMcp, formatMcpTool, formatPlugin, formatSkill, formatStatus, green, red, yellow } from './format.js';

const HELP = `protea — Protea personal assistant runtime

Usage:
  protea serve [--data-dir DIR]                 run the daemon
  protea migrate                                migrate the database schema (snapshot first; the image's entrypoint runs it)
  protea healthcheck                            exit 0 when the local daemon answers /healthz (the image's HEALTHCHECK)
  protea backup [--to DIR | --to GIT_URL] [--archive] [--include-workspace] [--include-runs]
                                                online backup of the data directory (default <data>/backups; never secrets/ or cache/);
                                                a Git URL pushes config.yaml, persona/, memory/ and skills/ instead
  protea restore <backup-dir|.tar.gz> [--force] put a backup back (daemon stopped; replaced files are moved aside)
  protea replay [--from C] [--to C] [--provider recorded|echo|config] [--run ID] [--out DIR]
                                                re-run delivered events offline in their original batches (no side effects)
  protea status [--json]                        show runtime status
  protea events push <text…> [--level N] [--trigger T] [--no-wait] [--timeout SEC]
                                                send a console message and print the replies
  protea events tail [--since CURSOR] [--level N] [--source ID]
                                                follow events, batches and outputs live
  protea events ls [--limit N] [--state S]      list recent events
  protea events show <cursor>                   an event, its delivery and full text
  protea events promote <cursor> [--trigger T]  deliver a waiting event sooner (default flush)
  protea events withdraw <cursor>               withdraw an event that has not reached the model
  protea batches [ls] [--limit N]               recent batches
  protea batches show <id>                      a batch: its events and model rounds
  protea sessions [ls]                          the main session and forks
  protea sessions handoff [--reason R]          hand the main conversation off now
  protea forks [ls]                             list unfinished and recently ended forks
  protea forks show <id>                        show a fork and its transcript
  protea forks spawn <goal…> [--level N] [--model fork|main|cheap]
  protea forks cancel|pause|resume <id>
  protea plugins [ls]                           list plugins and their state
  protea plugins show <id>                      manifest, tools and configuration
  protea plugins install <dir> [--disabled]     install a plugin directory into the data volume
  protea plugins install --git URL [--ref R] [--subdir D] | --tarball URL
  protea plugins logs <id> [--limit N] [--level L]
  protea plugins enable|disable|reload|restart <id>
  protea plugins config <id> <json>             replace a plugin's configuration (validated, saved)
  protea plugins uninstall <id> [--keep-data]   remove a disabled data-volume plugin
  protea mcp [ls]                               list MCP servers
  protea mcp add <id> [--env K=V]… [--trust T] -- <command> [args…]
                                                add a local (stdio) MCP server, e.g. -- uvx mcp-server-fetch
  protea mcp add <id> --http URL [--header K=V]… [--bearer SECRET] [--oauth] [--trust T]
                                                add a remote (Streamable HTTP) MCP server
  protea mcp rm <id>                            remove a server (its tools leave at the next turn)
  protea mcp tools <id>                         list a server's tools
  protea mcp enable|disable|restart <id>
  protea mcp auth <id>                          start the OAuth authorization; prints the URL to open
  protea skills [ls]                            list skills (and rejected skill directories)
  protea skills show <name>                     print a skill's SKILL.md and files
  protea skills install <dir> | --git URL [--ref R] [--subdir D]
                                                install a skill into the data volume
  protea skills enable|disable <name>           show or hide a skill in the catalog
  protea skills rm <name>                       remove an installed skill
  protea approvals [ls] [--state S]             list approval requests
  protea approvals approve|deny <id>            decide an approval request
  protea config get [path] [--sources [--all]]  effective configuration (secrets redacted) or where values come from
  protea config set <path> <value>              change config.yaml (validated; JSON values, e.g. 500, true, [1,2])
  protea config unset <path>
  protea secrets [ls]                           secret names and where they come from (never values)
  protea secrets set <NAME>                     store a secret, read from stdin
  protea secrets rm <NAME>
  protea scheduler [status] | pause | resume    pause or resume event delivery (events keep being stored)
  protea scheduler discard --levels 3,4         drop pending events at those levels
  protea budget                                 spend per level and the hard cap (rolling 24 h), held events
  protea budget release [--levels 2,3,4] [--hard-cap] [--hours 24]
                                                lift enforcement for a while; held events are delivered again
  protea memory [ls] | cat <path> | put <path> | search <query…>
  protea persona [ls] | cat <file> | put <file> SOUL.md, OPERATING.md, USER.md, … (put reads stdin)
  protea logs [--level L] [--component C] [--plugin P] [--q TEXT] [--since 15m] [--run ID] [--follow] [--json]
                                                daemon logs through the API (--follow streams over WebSocket)
  protea logq [same filters] [--run ID | --all] read <data>/runs/*/log.jsonl directly (no daemon needed)
  protea runs                                   run directories (logs, shutdown records, crash reports)
  protea audit [--kind K] [--limit N]           side effects, approvals and control API writes
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
    env: { type: 'string', multiple: true },
    header: { type: 'string', multiple: true },
    http: { type: 'string' },
    bearer: { type: 'string' },
    oauth: { type: 'boolean' },
    trust: { type: 'string' },
    git: { type: 'string' },
    ref: { type: 'string' },
    subdir: { type: 'string' },
    tarball: { type: 'string' },
    reason: { type: 'string' },
    levels: { type: 'string' },
    hours: { type: 'string' },
    to: { type: 'string' },
    from: { type: 'string' },
    'include-workspace': { type: 'boolean' },
    'include-runs': { type: 'boolean' },
    archive: { type: 'boolean' },
    force: { type: 'boolean' },
    provider: { type: 'string' },
    out: { type: 'string' },
    'hard-cap': { type: 'boolean' },
    model: { type: 'string' },
    component: { type: 'string' },
    plugin: { type: 'string' },
    q: { type: 'string' },
    run: { type: 'string' },
    kind: { type: 'string' },
    batch: { type: 'string' },
    session: { type: 'string' },
    tool: { type: 'string' },
    follow: { type: 'boolean', short: 'f' },
    json: { type: 'boolean' },
    sources: { type: 'boolean' },
    all: { type: 'boolean' },
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
  const s = await api<StatusResponse>(client(), 'GET', '/api/status');
  console.log(values.json ? JSON.stringify(s, null, 2) : formatStatus(s));
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
                  : kind === 'paused' || kind === 'resumed'
                    ? `by ${String(data['by'])}`
                    : kind === 'discarded'
                      ? `${(data['cursors'] as number[]).length} event(s) at L${(data['levels'] as number[]).join(',')} by ${String(data['by'])}`
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

function pairs(list: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`--${what} takes KEY=VALUE, got "${item}"`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

async function mcp(sub: string | undefined, args: string[]): Promise<number> {
  const o = client();
  const id = args[0];
  if (sub === undefined || sub === 'ls') {
    const { servers } = await api<{ servers: McpServerStatus[] }>(o, 'GET', '/api/mcp/servers');
    if (servers.length === 0) console.log(dim('no MCP servers; add one with: protea mcp add <id> -- <command> [args…]'));
    for (const m of servers) console.log(formatMcp(m));
    return 0;
  }
  if (!id) throw new Error(`mcp ${sub} needs a server id`);
  const path = `/api/mcp/servers/${encodeURIComponent(id)}`;
  switch (sub) {
    case 'add': {
      const entry: Record<string, unknown> = {};
      if (values.http) {
        entry['transport'] = 'streamable-http';
        entry['url'] = values.http;
        const headers = pairs(values.header, 'header');
        if (Object.keys(headers).length) entry['headers'] = headers;
        if (values.bearer) entry['auth'] = { type: 'bearer', token: `\${secret:${values.bearer}}` };
        if (values.oauth) entry['auth'] = { type: 'oauth' };
      } else {
        const [command, ...cmdArgs] = args.slice(1);
        if (!command) throw new Error('mcp add needs a command after "--", e.g. protea mcp add fetch -- uvx mcp-server-fetch');
        entry['command'] = command;
        entry['args'] = cmdArgs;
        const env = pairs(values.env, 'env');
        if (Object.keys(env).length) entry['env'] = env;
      }
      if (values.trust) entry['trust'] = values.trust;
      if (values.disabled) entry['enabled'] = false;
      const t0 = Date.now();
      const s = await api<McpServerStatus>(o, 'POST', '/api/mcp/servers', { id, ...entry });
      console.log(formatMcp(s));
      if (s.state === 'running') console.log(dim(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s; the model sees ${s.tools.length} tools from the next turn`));
      if (s.state === 'auth_required') console.log(yellow(`open the URL above to authorize, or run: protea mcp auth ${id}`));
      return s.state === 'running' || s.state === 'auth_required' || s.state === 'stopped' ? 0 : 1;
    }
    case 'rm':
      await api(o, 'DELETE', path);
      console.log(`removed ${id}`);
      return 0;
    case 'tools': {
      const { tools } = await api<{ tools: McpToolInfo[] }>(o, 'GET', `${path}/tools`);
      if (tools.length === 0) console.log(dim('no tools'));
      for (const t of tools) console.log(formatMcpTool(t));
      return 0;
    }
    case 'enable':
    case 'disable':
    case 'restart':
      console.log(formatMcp(await api<McpServerStatus>(o, 'POST', `${path}/${sub}`)));
      return 0;
    case 'auth': {
      const r = await api<{ authorizeUrl?: string; state: string }>(o, 'POST', `${path}/oauth/start`);
      if (r.authorizeUrl) console.log(`Open this URL to authorize ${id}:\n\n  ${r.authorizeUrl}\n`);
      else console.log(`${id}: ${r.state}`);
      return 0;
    }
  }
  throw new Error(`unknown mcp command: ${sub}`);
}

async function skills(sub: string | undefined, args: string[]): Promise<number> {
  const o = client();
  const name = args[0];
  if (sub === undefined || sub === 'ls') {
    const { skills: all } = await api<{ skills: SkillInfo[] }>(o, 'GET', '/api/skills');
    if (all.length === 0) console.log(dim('no skills'));
    for (const k of all) console.log(formatSkill(k));
    return 0;
  }
  if (!name) throw new Error(`skills ${sub} needs ${sub === 'install' ? 'a directory' : 'a skill name'}`);
  const path = `/api/skills/${encodeURIComponent(name)}`;
  switch (sub) {
    case 'show': {
      const k = await api<SkillInfo & { body?: string; files?: Array<{ path: string; bytes: number }> }>(o, 'GET', path);
      console.log(formatSkill(k));
      if (k.body) console.log(`\n${k.body}`);
      if (k.files?.length) console.log(dim(`files: ${k.files.map((f) => f.path).join(', ')}`));
      return 0;
    }
    case 'install': {
      const { resolve } = await import('node:path');
      console.log(formatSkill(await api<SkillInfo>(o, 'POST', '/api/skills', { path: resolve(name) })));
      return 0;
    }
    case 'enable':
    case 'disable':
      console.log(formatSkill(await api<SkillInfo>(o, 'POST', `${path}/${sub}`)));
      return 0;
    case 'rm': {
      const r = await api<{ replacedBy: SkillInfo | null }>(o, 'DELETE', path);
      console.log(`removed ${name}${r.replacedBy ? ` (the ${r.replacedBy.origin} ${name} is back)` : ''}`);
      return 0;
    }
  }
  throw new Error(`unknown skills command: ${sub}`);
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
  dropPrivileges();
  if (values.version) {
    const { VERSION } = await import('@protea/daemon');
    console.log(VERSION);
    return 0;
  }
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  const handled = await opsCommand(cmd, sub, rest, values, client);
  if (handled !== null) return handled;
  switch (cmd) {
    case 'serve':
      await serve();
      return -1; // keep running
    case 'migrate':
      return migrateCommand(values['data-dir'] ?? defaultDataDir());
    case 'healthcheck':
      return healthcheckCommand(values['data-dir'] ?? defaultDataDir(), values.url);
    case 'backup':
      return backupCommand(values['data-dir'] ?? defaultDataDir(), {
        ...(values.to !== undefined ? { to: values.to } : {}),
        ...(values['include-workspace'] ? { includeWorkspace: true } : {}),
        ...(values['include-runs'] ? { includeRuns: true } : {}),
        ...(values.archive ? { archive: true } : {}),
      });
    case 'restore':
      return restoreCommand(values['data-dir'] ?? defaultDataDir(), sub, !!values.force);
    case 'replay': {
      const from = intFlag('from', values.from);
      const to = intFlag('to', values.to);
      return replayCommand(values['data-dir'] ?? defaultDataDir(), {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(values.provider !== undefined ? { provider: values.provider } : {}),
        ...(values.run !== undefined ? { run: values.run } : {}),
        ...(values.out !== undefined ? { out: values.out } : {}),
      });
    }
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
    case 'mcp':
      return mcp(sub, rest);
    case 'skills':
      return skills(sub, rest);
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
