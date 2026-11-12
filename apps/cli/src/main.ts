#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  LEVELS,
  TRIGGERS,
  isLevel,
  isTextBlock,
  isTrigger,
  type ApprovalGrantInfo,
  type ApprovalInfo,
  type ChangeRequestDetail,
  type ChangeRequestInfo,
  type ChatDraftUpdate,
  type ChatReplyParts,
  type ContentBlock,
  type EventEnvelope,
  type ForkInfo,
  type McpServerStatus,
  type McpToolInfo,
  type PermissionModeInfo,
  type PluginLoginView,
  type PluginStatus,
  type SkillInfo,
  type PushEventResponse,
  type StatusResponse,
} from '@protea/protocol';
import { ChatPrinter } from './chat-printer.js';
import { api, defaultDataDir, resolveClient, stream, type ClientOptions } from './client.js';
import { backupCommand, diagCommand, dropPrivileges, healthcheckCommand, migrateCommand, replayCommand, restoreCommand } from './admin.js';
import { devPlugin } from './dev-plugin.js';
import { accountsCommand } from './accounts.js';
import { opsCommand } from './ops.js';
import { bold, dim, formatApproval, formatChange, formatEvent, formatFork, formatMcp, formatMcpTool, formatPlugin, formatSkill, formatStatus, green, red, yellow } from './format.js';

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
  protea diag [--since 72h] [--runs 5] [--content] [--transcripts] [--recordings] [--out FILE|DIR] [--offline]
                                                diagnostics bundle (.tar.gz in <data>/exports): logs, crash records, event
                                                metadata, usage and cache shares, audit, live status and metrics; no secrets
  protea setup [--user NAME]                    first run: show the setup code, or create the admin account here
                                                (the password is read without echo, or from stdin)
  protea accounts [ls]                          console accounts
  protea accounts add <user> [--readonly]       add an account (password from the terminal or stdin)
  protea accounts passwd <user>                 set a new password (signs the account out everywhere)
  protea accounts role <user> admin|readonly
  protea accounts rm <user>
  protea providers [ls]                         model provider profiles, the default, per-role choices
  protea providers presets                      vendors with their protocol and endpoint
  protea providers set <id> [--preset P] [--protocol anthropic|openai-chat|openai-responses|echo]
                         [--base-url URL] [--model M | --main M --fork M --cheap M --judge M] [--key-stdin] [--no-key]
                         [--label TEXT] [--default]
                                                add or change a provider (the first one becomes the default),
                                                e.g. protea providers set deepseek --model deepseek-chat --key-stdin
  protea providers use <id>                     make it the default
  protea providers role main|fork|cheap|judge <id|default>
                                                a different provider for one role
  protea providers test <id> | models <id>      a tiny test request, or the endpoint's model names
  protea providers rm <id>
  protea status [--json]                        show runtime status
  protea chat <text…> [--interrupt] [--timeout SEC]  talk to the assistant in the web chat
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
  protea plugins always-load|on-demand <id>     keep a plugin's tools out of tool search, or let them be deferred
  protea plugins config <id> <json>             replace a plugin's configuration (validated, saved)
  protea plugins uninstall <id> [--keep-data]   remove a disabled data-volume plugin
  protea plugins login <id>                     sign in to a plugin (shows a QR code; e.g. wechat, qq)
  protea plugins logout <id>                    forget that sign-in and the owner it named
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
  protea approvals approve|deny <id> [--for 1h]  decide an approval request; --for also allows its tool family for that long
  protea approvals grants                       list time-limited grants
  protea approvals revoke <grant>               end a grant early
  protea changes [ls] [--state S]               list what the assistant proposed for its MCP servers, skills and plugins
  protea changes show <id>                      print a change request: reason, both versions, staged files
  protea changes approve|reject <id> [--reason TEXT]
                                                decide a change request (approving applies it at once); --reason is a note for the assistant
  protea mcp preset browser [--no-sandbox]      add the bundled browser (image target "browser")
  protea sandbox serve [--socket P] [--workspace P] [--home P]   run the sandbox agent (the sandbox container's command)
  protea sandbox run <command>                  run a command in the sandbox from here (operators; a session of its own)
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
  protea memory [ls] | cat <path> | put <path> | search <query…> [--scope notes|raw|all]
                                                core/owner.md and core/rules.md are resident (2000 / 4000 characters)
  protea persona [ls] | cat <file> | put <file> SOUL.md, OPERATING.md, plugins/<id>/ENV_PROMPT.md (put reads stdin)
  protea logs [--level L] [--component C] [--plugin P] [--q TEXT] [--since 15m] [--run ID] [--follow] [--json]
                                                daemon logs through the API (--follow streams over WebSocket)
  protea logq [same filters] [--run ID | --all] read <data>/runs/*/log.jsonl directly (no daemon needed)
  protea runs                                   run directories (logs, shutdown records, crash reports)
  protea mode [ask|auto|bypass|locked] [--for 2h]
                                                show or switch who clears calls that need approval; --for makes it temporary (bypass requires it)
  protea audit [--kind K] [--limit N]           side effects, approvals and control API writes
  protea dev-plugin <dir> [--check] [--config JSON] [--owner KEY]
                                                run a plugin under a minimal host (or check its protocol conformance)

Common options:
  --url URL        control API (default $PROTEA_URL or http://127.0.0.1:7788)
  --token TOKEN    API token (default $PROTEA_ADMIN_TOKEN or <data-dir>/secrets/PROTEA_ADMIN_TOKEN);
                   the web console signs in with an account instead
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
    interrupt: { type: 'boolean' },
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
    for: { type: 'string' },
    'no-sandbox': { type: 'boolean' },
    socket: { type: 'string' },
    home: { type: 'string' },
    workspace: { type: 'string' },
    'include-runs': { type: 'boolean' },
    archive: { type: 'boolean' },
    force: { type: 'boolean' },
    provider: { type: 'string' },
    out: { type: 'string' },
    'hard-cap': { type: 'boolean' },
    runs: { type: 'string' },
    content: { type: 'boolean' },
    recordings: { type: 'boolean' },
    transcripts: { type: 'boolean' },
    offline: { type: 'boolean' },
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
    user: { type: 'string' },
    readonly: { type: 'boolean' },
    preset: { type: 'string' },
    protocol: { type: 'string' },
    'base-url': { type: 'string' },
    main: { type: 'string' },
    fork: { type: 'string' },
    cheap: { type: 'string' },
    judge: { type: 'string' },
    label: { type: 'string' },
    'key-stdin': { type: 'boolean' },
    'no-key': { type: 'boolean' },
    default: { type: 'boolean' },
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
  const it = wait ? stream(o, '/api/stream?trace=1', ac.signal) : null;
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
      } else if (m.event === 'model.response' && data['batchId'] === mine) {
        // An injection is not a conversation: the answer is the model's text.
        const said = modelText(data);
        if (said) console.log(`${bold('◂')} ${said}`);
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

function modelText(data: Record<string, unknown>): string {
  return (data['content'] as ContentBlock[])
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Write in the web chat and print what the assistant sends back with `chat_send`. */
async function chat(textParts: string[]): Promise<number> {
  const text = textParts.join(' ').trim();
  if (!text) throw new Error('nothing to send');
  const o = client();
  const timeoutMs = (intFlag('timeout', values.timeout) ?? 300) * 1000;
  const ac = new AbortController();
  // Only a terminal gets replies as they are written; a pipe gets each finished reply on its own.
  const it = stream(o, process.stdout.isTTY ? '/api/stream?drafts=1' : '/api/stream', ac.signal);
  const printer = new ChatPrinter((s) => process.stdout.write(s), (s) => console.error(dim(s)));
  await it.next(); // the "hello" message: we are subscribed before sending
  const res = await api<PushEventResponse>(o, 'POST', '/api/chat/messages', { text, ...(values.interrupt ? { trigger: 'interrupt' } : {}) });
  const timer = setTimeout(() => {
    ac.abort();
    printer.close();
  }, timeoutMs);
  let mine: string | null = null;
  let replied = false;
  try {
    for await (const m of it) {
      const data = JSON.parse(m.data || '{}') as Record<string, unknown>;
      if ((m.event === 'batch.started' || m.event === 'batch.extended') && (data['cursors'] as number[]).includes(res.cursor)) {
        mine = String(data['batchId']);
      } else if (m.event === 'chat.draft' && data['platform'] === 'webchat' && data['batchId'] === mine) {
        printer.draft(data as unknown as ChatDraftUpdate);
      } else if (m.event === 'output' && data['plugin'] === 'webchat' && data['channel'] === 'chat' && data['batchId'] === mine) {
        replied = true;
        printer.final(String(data['text']), typeof data['callId'] === 'string' ? data['callId'] : undefined, data as ChatReplyParts);
      } else if (m.event === 'batch.ended' && data['batchId'] === mine) {
        printer.close();
        const reason = String(data['endReason']);
        if (['end_turn', 'ends_turn'].includes(reason)) {
          if (!replied) console.error(dim('(read, no reply)'));
          return 0;
        }
        console.error(red(`■ ${reason}`));
        return 1;
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
    for await (const m of stream(o, `/api/stream?trace=1${since !== undefined ? `&since=${since}` : ''}`, ac.signal)) {
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
        case 'model.response': {
          const said = modelText(data);
          if (said) console.log(`  ${dim('model:')} ${said}`);
          break;
        }
        case 'tool.call':
          if (data['phase'] === 'start') console.log(dim(`  → ${String(data['name'])} ${JSON.stringify(data['input'])}`));
          else console.log((data['isError'] ? red : dim)(`  ← ${String(data['name'])} (${String(data['ms'])} ms) ${String(data['result']).slice(0, 200)}`));
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

/** Follow a plugin's sign-in in the terminal until it ends. */
async function pluginLogin(o: ReturnType<typeof client>, id: string): Promise<number> {
  const base = `/api/plugins/${encodeURIComponent(id)}/login`;
  let view = await api<PluginLoginView>(o, 'POST', base, {});
  let shown: string | undefined;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (view.qr && view.qr.text !== shown) {
      shown = view.qr.text;
      console.log(`${view.qr.terminal}\n${view.qr.text}`);
    }
    if (view.message && view.state !== 'unavailable') console.log(dim(view.message));
    switch (view.state) {
      case 'connected':
        console.log(`signed in${view.account ? ` as ${view.account}` : ''}`);
        return 0;
      case 'already_bound':
        return 0;
      case 'failed':
      case 'idle':
        console.error(`not signed in${view.message ? `: ${view.message}` : ''}`);
        return 1;
      case 'need_code': {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const code = await rl.question('number shown on the phone: ');
        rl.close();
        view = await api<PluginLoginView>(o, 'POST', `${base}/code`, { code });
        continue;
      }
      default:
        break;
    }
    await new Promise((r) => setTimeout(r, 2000));
    const previous = view.message;
    view = await api<PluginLoginView>(o, 'GET', base);
    if (view.message === previous) delete view.message;
  }
  await api(o, 'POST', `${base}/cancel`, {}).catch(() => undefined);
  console.error('timed out waiting for the sign-in');
  return 1;
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
    case 'always-load':
    case 'on-demand':
      console.log(formatPlugin(await api<PluginStatus>(o, 'POST', `/api/plugins/${encodeURIComponent(id)}/${sub}`)));
      return 0;
    case 'config': {
      if (!args[1]) throw new Error('plugins config needs a JSON object');
      console.log(formatPlugin(await api<PluginStatus>(o, 'PATCH', `/api/plugins/${encodeURIComponent(id)}/config`, { config: JSON.parse(args[1]) as unknown })));
      return 0;
    }
    case 'login':
      return pluginLogin(o, id);
    case 'logout':
      console.log(formatPlugin(await api<PluginStatus>(o, 'DELETE', `/api/plugins/${encodeURIComponent(id)}/login`)));
      return 0;
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
    case 'preset': {
      if (id !== 'browser') throw new Error(`unknown preset ${id}; there is: browser`);
      const s = await api<McpServerStatus>(o, 'POST', '/api/mcp/presets/browser', values['no-sandbox'] ? { noSandbox: true } : {});
      console.log(formatMcp(s));
      for (const w of s.warnings ?? []) console.log(yellow(w));
      return s.state === 'running' ? 0 : 1;
    }
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

/** "90", "30m", "1h" as milliseconds. A bare number means minutes. */
function parseDuration(text: string): number {
  const m = /^(\d+)\s*(m|min|h|hr)?$/i.exec(text.trim());
  if (!m || Number(m[1]) <= 0) throw new Error(`--for needs a duration like 30m or 1h (got ${text})`);
  return Number(m[1]) * (/^h/i.test(m[2] ?? '') ? 3_600_000 : 60_000);
}

/** Change requests: the assistant proposes, an administrator decides (ADR-0019). */
async function changes(sub: string | undefined, id: string | undefined): Promise<number> {
  const o = client();
  if (sub === undefined || sub === 'ls') {
    const q = values.state ? `?state=${encodeURIComponent(values.state)}` : '';
    const { changes: all } = await api<{ changes: ChangeRequestInfo[] }>(o, 'GET', `/api/changes${q}`);
    if (all.length === 0) console.log(dim('no change requests'));
    for (const c of all) console.log(formatChange(c));
    return 0;
  }
  if (!id) throw new Error(`changes ${sub} needs an id`);
  const at = `/api/changes/${encodeURIComponent(id)}`;
  if (sub === 'show') {
    const c = await api<ChangeRequestDetail>(o, 'GET', at);
    console.log(formatChange(c));
    console.log(`${dim('reason:')} ${c.reason}`);
    if (c.source) console.log(`${dim('source:')} ${c.source}`);
    for (const w of c.warnings) console.log(yellow(`! ${w}`));
    for (const sec of c.secrets ?? []) console.log(`${dim('secret:')} ${sec.name} ${sec.set ? green('set') : red('not set')}`);
    if (c.stale) console.log(red('the target changed since this was proposed: approving applies nothing'));
    if (c.before !== null) console.log(`${bold('— before —')}\n${c.before}`);
    if (c.after !== null) console.log(`${bold('— after —')}\n${c.after}`);
    for (const f of c.files ?? []) console.log(`${dim('file:')} ${f.path} ${dim(`${f.size} bytes`)}`);
    return 0;
  }
  if (sub !== 'approve' && sub !== 'reject') throw new Error(`unknown changes command: ${sub}`);
  console.log(formatChange(await api<ChangeRequestDetail>(o, 'POST', `${at}/decide`, { decision: sub, ...(values.reason !== undefined ? { note: values.reason } : {}) })));
  return 0;
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
  if (sub === 'grants') {
    const { grants } = await api<{ grants: ApprovalGrantInfo[] }>(o, 'GET', '/api/approvals/grants');
    if (grants.length === 0) console.log(dim('no grants'));
    for (const g of grants) console.log(`${g.id} ${g.active ? green('active') : dim(g.revokedAt ? 'revoked' : 'ended')} ${g.family} until ${g.expiresAt} ${dim(`from ${g.approvalId} by ${g.decidedBy}`)}`);
    return 0;
  }
  if (sub === 'revoke') {
    if (!id) throw new Error('approvals revoke needs a grant id');
    const g = await api<ApprovalGrantInfo>(o, 'POST', `/api/approvals/grants/${encodeURIComponent(id)}/revoke`);
    console.log(`${g.id} revoked (${g.family})`);
    return 0;
  }
  if (sub !== 'approve' && sub !== 'deny') throw new Error(`unknown approvals command: ${sub}`);
  if (!id) throw new Error(`approvals ${sub} needs an id`);
  console.log(
    formatApproval(
      await api<ApprovalInfo>(o, 'POST', `/api/approvals/${encodeURIComponent(id)}/decide`, {
        decision: sub,
        ...(values.for !== undefined && sub === 'approve' ? { grantMs: parseDuration(values.for) } : {}),
      }),
    ),
  );
  return 0;
}

async function permissionMode(mode: string | undefined): Promise<number> {
  const o = client();
  const i =
    mode === undefined
      ? await api<PermissionModeInfo>(o, 'GET', '/api/permissions/mode')
      : await api<PermissionModeInfo>(o, 'POST', '/api/permissions/mode', { mode, ...(values.for !== undefined ? { forMs: parseDuration(values.for) } : {}) });
  console.log(`${bold(i.mode)}${i.override ? ` until ${i.override.until}, then ${i.baseline} ${dim(`(set by ${i.override.by})`)}` : ''}`);
  if (i.paused) console.log(yellow(`auto is paused: ${i.paused.reason}; run "protea mode auto" to resume`));
  if (i.mode === 'auto' || i.paused) {
    const { judge, since, allowed, held } = i.auto;
    console.log(`judge ${judge.model}${judge.ready ? '' : ` ${red(`not ready: ${judge.problem ?? 'unknown'}`)}`}`);
    console.log(dim(`since ${since}: ${allowed} allowed, ${held} sent to you`));
  }
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
  const handled = (await accountsCommand(cmd, sub, rest, values, client)) ?? (await opsCommand(cmd, sub, rest, values, client));
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
    case 'diag': {
      const runs = intFlag('runs', values.runs);
      return diagCommand(values['data-dir'] ?? defaultDataDir(), {
        ...(values.since !== undefined ? { since: values.since } : {}),
        ...(runs !== undefined ? { runs } : {}),
        ...(values.content ? { content: true } : {}),
        ...(values.recordings ? { recordings: true } : {}),
        ...(values.transcripts ? { transcripts: true } : {}),
        ...(values.out !== undefined ? { out: values.out } : {}),
        ...(values.url !== undefined ? { url: values.url } : {}),
        ...(values.token !== undefined ? { token: values.token } : {}),
        ...(values.offline ? { offline: true } : {}),
      });
    }
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
    case 'chat':
      return chat([...(sub !== undefined ? [sub] : []), ...rest]);
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
    case 'changes':
      return changes(sub, rest[0]);
    case 'mode':
      return permissionMode(sub);
    case 'sandbox': {
      const { SandboxAgent, SandboxClient, DEFAULT_SANDBOX_SOCKET } = await import('@protea/sandbox');
      if (sub === 'run') {
        if (rest.length === 0) throw new Error('sandbox run needs a command');
        const client = new SandboxClient({ socket: values.socket ?? process.env['PROTEA_SANDBOX_SOCKET'] ?? DEFAULT_SANDBOX_SOCKET, connectWaitMs: 5000 });
        client.start();
        try {
          const r = await client.run({ runId: 'cli', session: 'operator', command: rest.join(' '), timeoutMs: 120_000, captureBytes: 1 << 20 });
          process.stdout.write(r.stdout);
          process.stderr.write(r.stderr);
          return r.exitCode ?? 1;
        } finally {
          client.stop();
        }
      }
      if (sub !== 'serve') break;
      const agent = new SandboxAgent({
        socket: values.socket ?? process.env['PROTEA_SANDBOX_SOCKET'] ?? DEFAULT_SANDBOX_SOCKET,
        home: values.home ?? process.env['HOME'] ?? '/home/protea',
        workspace: values.workspace ?? '/workspace',
        log: (msg, fields) => console.error(`[sandbox] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
      });
      await agent.start();
      const stop = (): void => void agent.stop().finally(() => process.exit(0));
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return -1;
    }
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
