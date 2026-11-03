import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  ProcessPlugin,
  allowedTriggers,
  checkConformance,
  createLogger,
  loadManifest,
  resolveDevLoader,
} from '@protea/core';
import { PLUGIN_TO_HOST, RPC_ERRORS, RpcError, type EventInput, type Level, type LogParams, type RpcHandler, type ToolDecl } from '@protea/protocol';
import { bold, cyan, dim, green, red, yellow } from './format.js';

function assetsDir(): string {
  return process.env['PROTEA_ASSETS_DIR'] ?? fileURLToPath(new URL('../../../', import.meta.url));
}

const HELP = `commands:
  tools                       list the plugin's tools
  call <tool> [json]          call a tool
  config <json>               send config/changed with a new configuration
  settle <cursor> [outcome]   send events/settled for a pushed event
  env                         show the environment prompt variables
  health                      send a health check
  quit                        stop the plugin and exit`;

/**
 * `protea dev-plugin <dir>`: a minimal host for plugin development (docs/10-architecture/07-plugin-system.md §8).
 * Prints every pushed event and log line, and takes commands on stdin. `--check` runs the conformance checks instead.
 */
export async function devPlugin(dir: string, opts: { check: boolean; config?: Record<string, unknown>; owners: string[] }): Promise<number> {
  const root = path.resolve(dir);
  const loader = resolveDevLoader();
  const dev = loader ? { loader } : undefined;
  const pythonPath = path.join(assetsDir(), 'sdks', 'python');

  if (opts.check) {
    const r = await checkConformance(root, { ...(dev ? { dev } : {}), pythonPath, ...(opts.config ? { probe: { config: opts.config } } : {}) });
    for (const c of r.checks) console.log(`${c.ok ? green('✓') : red('✗')} ${c.name}${c.detail && !c.ok ? `\n    ${dim(c.detail)}` : ''}`);
    console.log(r.ok ? green(`${r.plugin}: all ${r.checks.length} checks passed`) : red(`${r.plugin}: ${r.checks.filter((c) => !c.ok).length} check(s) failed`));
    return r.ok ? 0 : 1;
  }

  const loaded = loadManifest(root, 'data');
  const m = loaded.manifest;
  if (!m || loaded.errors.length > 0) {
    console.error(red(`invalid plugin: ${loaded.errors.join('; ')}`));
    return 1;
  }
  for (const w of loaded.warnings) console.error(yellow(`manifest: ${w}`));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `protea-dev-${m.id}-`));
  const kv = new Map<string, unknown>();
  let cursor = 0;
  const levelCap = (m.level ?? 4) as Level;
  const owners = new Set(opts.owners);
  const handlers: Record<string, RpcHandler> = {
    [PLUGIN_TO_HOST.eventsPush]: (p) => {
      const e = p as EventInput;
      const level = Math.max(e.level, levelCap);
      cursor++;
      console.log(`${cyan(`◆ #${cursor}`)} ${bold(e.type)} L${level}${level !== e.level ? dim(` (asked L${e.level})`) : ''} ${e.trigger}${e.senderKey ? dim(` from ${e.senderKey}${owners.has(e.senderKey) ? ' (owner)' : ''}`) : ''}${e.dedupeKey ? dim(` key=${e.dedupeKey}`) : ''}`);
      console.log(`  ${e.text.split('\n').join('\n  ')}`);
      return { cursor, effectiveLevel: level, effectiveTrigger: e.trigger, deduped: false, warnings: [] };
    },
    [PLUGIN_TO_HOST.log]: (p) => {
      const l = p as LogParams;
      console.log(dim(`[${l.level}] ${l.msg}${l.fields ? ` ${JSON.stringify(l.fields)}` : ''}`));
    },
    [PLUGIN_TO_HOST.kvGet]: (p) => ({ value: kv.get((p as { key: string }).key) ?? null }),
    [PLUGIN_TO_HOST.kvSet]: (p) => (kv.set((p as { key: string }).key, (p as { value: unknown }).value), {}),
    [PLUGIN_TO_HOST.kvDelete]: (p) => (kv.delete((p as { key: string }).key), {}),
    [PLUGIN_TO_HOST.ownerResolve]: (p) => ({ role: owners.has((p as { senderKey: string }).senderKey) ? 'owner' : 'unknown' }),
    [PLUGIN_TO_HOST.secretsExists]: (p) => ({ exists: process.env[(p as { name: string }).name] !== undefined }),
    [PLUGIN_TO_HOST.approvalsDecide]: (p) => {
      const d = p as { id: string; decision: string; senderKey: string };
      if (!owners.has(d.senderKey)) throw new RpcError(RPC_ERRORS.Unauthorized, 'only the owner can decide approvals');
      console.log(yellow(`⚖ approval ${d.id}: ${d.decision} by ${d.senderKey}`));
      return { ok: true, state: d.decision === 'approve' ? 'approved' : 'denied' };
    },
  };
  const runtime = m.runtime as NonNullable<typeof m.runtime>;
  let exec = runtime.exec;
  let args = runtime.args ?? [];
  if (dev && runtime.dev) {
    exec = runtime.dev.exec ?? exec;
    args = runtime.dev.args ?? args;
  }
  if (exec === 'node') {
    exec = process.execPath;
    if (dev) args = ['--conditions=source', '--import', dev.loader, ...args];
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v; // a developer's own shell: pass it on
  env['PYTHONPATH'] = [pythonPath, env['PYTHONPATH']].filter(Boolean).join(path.delimiter);
  env['PYTHONUNBUFFERED'] = '1';
  const log = createLogger({ level: 'info', format: 'pretty' });
  const proc = new ProcessPlugin({
    id: m.id,
    exec,
    args,
    cwd: runtime.cwd ? path.resolve(root, runtime.cwd) : root,
    env,
    log,
    handlers,
    initializeTimeoutMs: 20_000,
    health: { intervalMs: 0, timeoutMs: 5000 },
    onUnexpectedExit: (reason) => {
      console.error(red(`plugin exited: ${reason}`));
      process.exit(1);
    },
  });
  const started = await proc.start({
    pluginId: m.id,
    config: opts.config ?? {},
    dataDir,
    hostDataDir: dataDir,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: 'en',
    hostCapabilities: ['events', 'kv', 'owner', 'approvals'],
    modelFacts: { mainModel: 'dev' },
    levelCap,
    allowedTriggers: allowedTriggers(m),
  });
  console.log(green(`${m.id} ${m.version} running (pid ${proc.pid}); data in ${dataDir}`));
  console.log(dim(`capabilities: ${JSON.stringify(started.init.capabilities)}`));
  console.log(dim(`tools: ${started.tools.map((t: ToolDecl) => t.name).join(', ') || 'none'}\n${HELP}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  const prompt = (): void => {
    if (!closed) rl.prompt();
  };
  const quit = async (): Promise<never> => {
    rl.close();
    await proc.stop('dev host exit', 3000);
    process.exit(0);
  };
  process.on('SIGINT', () => void quit());
  prompt();
  for await (const line of rl) {
    const [cmd, ...restParts] = line.trim().split(/\s+/);
    const rest = line.trim().slice((cmd ?? '').length).trim();
    try {
      switch (cmd) {
        case undefined:
        case '':
          break;
        case 'tools':
          for (const t of (await proc.request<{ tools: ToolDecl[] }>('tools/list', {})).tools) {
            console.log(`${bold(t.name)} ${dim(JSON.stringify(t.flags ?? {}))}\n  ${t.description}\n  ${dim(JSON.stringify(t.inputSchema))}`);
          }
          break;
        case 'call': {
          const [name] = restParts;
          const json = rest.slice((name ?? '').length).trim();
          const r = await proc.callTool(name ?? '', json ? (JSON.parse(json) as unknown) : {}, { sessionId: 'main', batchId: 'b_dev', batchLevel: 1 }, new AbortController().signal);
          console.log(r.failed ? red(r.text) : r.text);
          break;
        }
        case 'config':
          await proc.configChanged(JSON.parse(rest) as Record<string, unknown>, JSON.parse(rest) as Record<string, unknown>);
          console.log(dim('config sent'));
          break;
        case 'settle':
          proc.settled([{ cursor: Number(restParts[0]), outcome: (restParts[1] ?? 'delivered') as 'delivered' }]);
          break;
        case 'env':
          console.log(JSON.stringify(await proc.envPrompt('en'), null, 2));
          break;
        case 'health':
          console.log(JSON.stringify(await proc.request('health', {})));
          break;
        case 'quit':
        case 'exit':
          await quit();
          break;
        default:
          console.log(HELP);
      }
    } catch (err) {
      console.log(red((err as Error).message));
    }
    prompt();
  }
  await quit();
  return 0;
}
