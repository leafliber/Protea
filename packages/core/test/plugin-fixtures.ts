import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PluginManifest } from '@protea/protocol';
import {
  Bus,
  EventStore,
  KvRepo,
  OwnerRegistry,
  EventGateway,
  PluginHost,
  SecretStore,
  ToolDispatcher,
  ToolRegistry,
  openDatabase,
  resolveDevLoader,
  silentLogger,
  systemClock,
  type PluginHostSettings,
  type PluginSettings,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const SDK_URL = pathToFileURL(path.join(REPO, 'packages/plugin-sdk/src/index.ts')).href;
export const DEV_LOADER = resolveDevLoader() as string;

/**
 * A plugin written against the real SDK, run as a child process. Behaviour is driven by
 * its config so one fixture covers tools, events, crashes, slow stops and health failures.
 */
export const FIXTURE_CODE = (version: string) => `
import { definePlugin, runPlugin } from '${SDK_URL}';
const VERSION = ${JSON.stringify(version)};
const HANG_STOP = process.env.FX_HANG_STOP === '1';
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve('aborted'); }, { once: true });
});
runPlugin(definePlugin({
  displayName: 'Fixture',
  async start(host) {
    const c = host.config;
    if (c.crashOnStart) process.exit(3);
    if (c.crashAfterMs) setTimeout(() => process.exit(4), c.crashAfterMs);
    if (c.pushOnStart) {
      await host.events.push({ type: 'fx.started', ts: new Date().toISOString(), level: c.pushLevel ?? 3, trigger: c.pushTrigger ?? 'flush', text: 'fixture ' + VERSION + ' started', dedupeKey: 'start-' + VERSION });
    }
  },
  async stop() {
    if (HANG_STOP) await new Promise(() => {});
  },
  tools: [
    { name: 'fx_echo', description: 'Echo the text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: (i) => 'echo: ' + i.text },
    { name: 'fx_version', description: 'Report the code version.', inputSchema: { type: 'object' }, flags: { readOnly: true },
      handler: () => VERSION },
    { name: 'fx_slow', description: 'Wait.', inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } }, flags: { interruptible: true },
      handler: async (i, ctx) => (await sleep(i.ms ?? 200, ctx.signal)) === 'aborted' ? { text: 'partial', partial: true } : 'slept' },
    { name: 'fx_crash', description: 'Exit.', inputSchema: { type: 'object' }, handler: () => { setTimeout(() => process.exit(7), 5); return new Promise(() => {}); } },
    { name: 'fx_env', description: 'Environment names.', inputSchema: { type: 'object' }, handler: () => Object.keys(process.env).sort().join(',') },
    { name: 'fx_secret', description: 'Secret length.', inputSchema: { type: 'object' }, handler: (_i, _c, host) => String((host.secret('FX_TOKEN') ?? '').length) },
    { name: 'fx_push', description: 'Push an event.', inputSchema: { type: 'object' },
      handler: async (i, _c, host) => JSON.stringify(await host.events.push({ type: 'fx.note', ts: new Date().toISOString(), level: i.level ?? 1, trigger: i.trigger ?? 'flush', text: i.text ?? 'note', senderKey: i.senderKey })) },
    { name: 'fx_kv', description: 'Read kv.', inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      handler: async (i, _c, host) => JSON.stringify(await host.kv.get(i.key)) },
    { name: 'fx_config', description: 'Current config.', inputSchema: { type: 'object' }, handler: (_i, _c, host) => JSON.stringify(host.config) },
    { name: 'fx_login', description: 'Report a finished sign-in.', inputSchema: { type: 'object' },
      handler: async (i, _c, host) => { await host.login.complete(i); return 'completed'; } },
  ],
  login: {
    start: () => ({ state: 'waiting', qr: 'https://example.test/qr' }),
    status: (host) => (host.secret('FX_TOKEN') ? { state: 'connected', account: 'fx-account' } : { state: 'idle' }),
    submit: (_host, code) => ({ state: 'waiting', message: 'got ' + code }),
    cancel: () => ({ state: 'idle' }),
  },
  envPromptVars: (host) => ({ greeting: host.config.greeting ?? 'hello' }),
  async onConfigChanged(host, patch) { await host.kv.set('lastPatch', patch); },
  async onEventsSettled(host, events) {
    const prev = (await host.kv.get('settled')) ?? [];
    await host.kv.set('settled', [...prev, ...events.map((e) => e.cursor + ':' + e.outcome)]);
  },
  async health(host) {
    if (host.config.hangHealth) await new Promise(() => {});
    return { ok: true };
  },
}));
`;

export interface FixtureOptions {
  id?: string;
  version?: string;
  manifest?: Partial<PluginManifest>;
  schema?: Record<string, unknown>;
}

export function writeFixture(root: string, opts: FixtureOptions = {}): string {
  const id = opts.id ?? 'fx';
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: PluginManifest = {
    id,
    kind: 'connector',
    api: 1,
    version: '1.0.0',
    runtime: { exec: 'node', args: ['main.mjs'] },
    level: 1,
    tools: ['fx_echo', 'fx_version', 'fx_slow', 'fx_crash', 'fx_env', 'fx_secret', 'fx_push', 'fx_kv', 'fx_config', 'fx_login'],
    sideEffectTools: ['fx_push'],
    configSchema: './config.schema.json',
    healthcheck: { intervalMs: 60_000, timeoutMs: 5000 },
    ...opts.manifest,
  };
  fs.writeFileSync(path.join(dir, 'protea.plugin.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(dir, 'config.schema.json'),
    JSON.stringify(
      opts.schema ?? {
        type: 'object',
        properties: {
          greeting: { type: 'string' },
          mode: { type: 'string', 'x-hot': false },
          crashOnStart: { type: 'boolean' },
          crashAfterMs: { type: 'integer' },
          pushOnStart: { type: 'boolean' },
          hangHealth: { type: 'boolean' },
          token: { type: 'string', 'x-secret': true },
        },
      },
    ),
  );
  fs.writeFileSync(path.join(dir, 'ENV_PROMPT.md'), '## Fixture\nGreeting: {{greeting}}\n');
  fs.writeFileSync(path.join(dir, 'main.mjs'), FIXTURE_CODE(opts.version ?? 'v1'));
  return dir;
}

export const FAST_HOST: Partial<PluginHostSettings> = {
  restartBackoffMs: [30, 30, 30, 30, 30],
  maxCrashes: 5,
  stableAfterMs: 60_000,
  drainTimeoutMs: 2000,
  initializeTimeoutMs: 15_000,
  stopTimeoutMs: 1000,
};

export function makeHostHarness(opts: { settings?: Record<string, PluginSettings>; host?: Partial<PluginHostSettings>; env?: NodeJS.ProcessEnv } = {}) {
  const signIns: Array<[string, string | null]> = [];
  const dir = tmpDir('protea-plugins-');
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  const bus = new Bus();
  const store = new EventStore(db, bus, { runId: 'r', clock: systemClock });
  const tools = new ToolRegistry();
  const secrets = new SecretStore(path.join(dir, 'secrets'), opts.env ?? {});
  const owner = new OwnerRegistry([{ plugin: 'fx', senderKey: 'fx:owner' }]);
  const persisted: Array<[string, boolean]> = [];
  const host = new PluginHost({
    store,
    bus,
    gateway: new EventGateway({ store, owner, log: silentLogger(), clock: systemClock, timezone: 'UTC' }),
    owner,
    kv: new KvRepo(db),
    tools,
    log: silentLogger(),
    clock: systemClock,
    dataDir: dir,
    timezone: 'UTC',
    settings: { ...FAST_HOST, ...opts.host },
    secrets,
    roots: [{ dir: pluginsDir, origin: 'data' }],
    dev: { loader: DEV_LOADER },
    onEnabledChanged: (id, enabled) => persisted.push([id, enabled]),
    onOwnerSignIn: (id, senderKey) => signIns.push([id, senderKey]),
  });
  const settingsOf = (id: string): PluginSettings | undefined => opts.settings?.[id];
  const dispatcher = new ToolDispatcher(tools, silentLogger(), 10_000);
  const states: string[] = [];
  bus.on('plugin.changed', (s) => states.push(`${s.id}:${s.state}`));
  return {
    dir,
    pluginsDir,
    db,
    bus,
    store,
    tools,
    secrets,
    owner,
    host,
    dispatcher,
    states,
    persisted,
    signIns,
    settingsOf,
    rescan: () => host.rescan(settingsOf),
    call: async (name: string, input: unknown = {}, signal = new AbortController().signal) => {
      const r = await dispatcher.runAll([{ type: 'tool_use', id: `t_${Math.random()}`, name, input }], {
        signal,
        sessionId: 'main',
        batchId: 'b',
        batchLevel: 1,
      });
      return r.results[0] as { content: string; is_error?: boolean };
    },
    close: async () => {
      await host.stopAll();
      db.close();
    },
  };
}
