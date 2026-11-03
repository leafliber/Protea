import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApprovalService,
  AuditLog,
  Bus,
  BatchRepo,
  BudgetTracker,
  ContextAssembler,
  ForkManager,
  EventStore,
  PluginHost,
  KvRepo,
  MainSession,
  OwnerRegistry,
  PermissionGuard,
  PermissionPolicy,
  Scheduler,
  SecretStore,
  SessionRepo,
  SystemSegments,
  ToolDispatcher,
  ToolRegistry,
  Transcript,
  UsageRepo,
  approvalTools,
  createLogger,
  createProvider,
  ensurePersona,
  errorMessage,
  forkTools,
  isoInZone,
  kernelTools,
  loadConfig,
  loadPersona,
  mainTranscriptPath,
  newId,
  openDatabase,
  reconcileDeliveries,
  resolveDevLoader,
  setConfigValue,
  systemClock,
  watchPaths,
  type Clock,
  type Db,
  type Logger,
  type PluginSettings,
  type ProteaConfig,
  type Provider,
} from '@protea/core';
import { createControlApp, startControlServer, type ControlServer } from '@protea/control';
import { ConsolePlugin } from '@protea/plugin-console';
import { CronPlugin } from '@protea/plugin-cron';
import type { Level, StatusResponse } from '@protea/protocol';
import { acquireLock } from './lock.js';

export const VERSION = '0.1.0';

export interface DaemonOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Override the configured provider (tests). */
  provider?: Provider;
  /** Override control.listen, e.g. "127.0.0.1:0" (tests). */
  listen?: string;
  logger?: Logger;
  clock?: Clock;
}

export interface Daemon {
  runId: string;
  url: string;
  adminToken: string;
  dataDir: string;
  config: ProteaConfig;
  db: Db;
  bus: Bus;
  store: EventStore;
  transcript: Transcript;
  main: MainSession;
  scheduler: Scheduler;
  plugins: PluginHost;
  approvals: ApprovalService;
  audit: AuditLog;
  forks: ForkManager;
  budget: BudgetTracker;
  console: ConsolePlugin;
  tools: ToolRegistry;
  status(): StatusResponse;
  /** Re-read config.yaml now (the file watcher also does this on change). */
  reloadConfig(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

/** Shipped assets (default persona, built-in plugins, Python SDK): $PROTEA_ASSETS_DIR or the repository root. */
function assetsDir(env: NodeJS.ProcessEnv): string {
  if (env['PROTEA_ASSETS_DIR']) return path.resolve(env['PROTEA_ASSETS_DIR']);
  // apps/daemon/{src,dist}/daemon.* → repository root
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/** Development mode runs plugin sources through tsx: PROTEA_DEV=1, or the daemon itself runs from source. */
function devLoader(env: NodeJS.ProcessEnv): string | null {
  if (env['PROTEA_DEV'] === '0') return null;
  if (env['PROTEA_DEV'] === '1' || import.meta.url.endsWith('.ts')) return resolveDevLoader();
  return null;
}

/**
 * Assemble and start the daemon, following docs/10-architecture/16-deployment.md §5.
 * Returns once the control plane listens and the scheduler runs.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const env = opts.env ?? process.env;
  const dataDir = path.resolve(opts.dataDir);
  for (const d of ['sessions/forks', 'runs', 'plugins', 'plugin-data', 'overrides']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const lock = acquireLock(dataDir);

  const runId = newId();
  const runDir = path.join(dataDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const loadedConfig = loadConfig(dataDir, env);
  const { sources, warnings } = loadedConfig;
  let config = loadedConfig.config;
  const log =
    opts.logger ??
    createLogger({
      level: config.observability.logLevel,
      format: config.observability.logFormat,
      file: path.join(runDir, 'log.jsonl'),
      base: { run: runId },
    });
  for (const w of warnings) log.warn(w);
  const clock = opts.clock ?? systemClock;
  const tz = config.daemon.timezone;

  const { db, migration } = openDatabase(path.join(dataDir, 'protea.db'));
  if (migration.applied.length > 0) log.info({ applied: migration.applied }, 'database migrated');
  const bus = new Bus((topic, err) => log.error({ topic, err: errorMessage(err) }, 'bus listener failed'));
  const store = new EventStore(db, bus, { runId, clock });
  const batches = new BatchRepo(db);
  const usage = new UsageRepo(db);
  const kv = new KvRepo(db);

  // Transcript and recovery.
  const discarded = (rec: Record<string, unknown>): void =>
    fs.appendFileSync(path.join(runDir, 'transcript.jsonl'), `${JSON.stringify({ ...rec, at: new Date().toISOString() })}\n`);
  const transcriptFile = mainTranscriptPath(path.join(dataDir, 'sessions'));
  const { transcript, report } = Transcript.open(transcriptFile, { onDiscarded: discarded });
  if (report.terminatedLastLine || report.truncatedBytes > 0 || report.actions.length > 0 || report.placeholderResults.length > 0) {
    log.warn({ ...report }, 'transcript repaired');
  }
  const reconciled = reconcileDeliveries(store, transcript);
  if (reconciled.delivered + reconciled.reverted > 0) log.info(reconciled, 'reconciled deliveries with the transcript');
  const sessions = new SessionRepo(db);
  sessions.upsert({
    id: 'main',
    kind: 'main',
    state: 'active',
    transcriptPath: path.relative(dataDir, transcriptFile),
    createdAt: new Date(clock.now()).toISOString(),
  });

  // Capabilities.
  const owner = new OwnerRegistry(config.owner.identities);
  if (!owner.hasAny()) log.warn('owner.identities is empty: no event can reach level 1');
  const secrets = new SecretStore(path.join(dataDir, 'secrets'), env);
  const provider = opts.provider ?? createProvider(config, secrets);
  const tools = new ToolRegistry();
  const assets = assetsDir(env);
  const loader = devLoader(env);
  const settingsOf = (id: string): PluginSettings | undefined => config.plugins[id];
  const persist = (keyPath: Array<string | number>, value: unknown): void => {
    try {
      setConfigValue(dataDir, keyPath, value);
    } catch (err) {
      log.error({ key: keyPath.join('.'), err: errorMessage(err) }, 'could not write config.yaml');
    }
  };
  const plugins = new PluginHost({
    store,
    bus,
    owner,
    kv,
    tools,
    log: log.child({ component: 'plugins' }),
    clock,
    dataDir,
    timezone: tz,
    language: config.daemon.language,
    settings: config.pluginHost,
    secrets,
    mainModel: () => provider.modelFor('main'),
    roots: [
      { dir: path.join(assets, 'plugins'), origin: 'builtin' },
      { dir: path.join(dataDir, 'plugins'), origin: 'data' },
    ],
    ...(loader ? { dev: { loader } } : {}),
    pythonPath: path.join(assets, 'sdks', 'python'),
    // Keep the running configuration in step with the file, without waiting for the watcher.
    onEnabledChanged: (id, enabled) => {
      config.plugins[id] = { config: config.plugins[id]?.config ?? {}, enabled };
      persist(['plugins', id, 'enabled'], enabled);
    },
    onUninstalled: (id) => {
      delete config.plugins[id];
      persist(['plugins', id], undefined);
    },
  });
  const consolePlugin = new ConsolePlugin();
  const builtinSettings = (id: string): PluginSettings => config.plugins[id] ?? { enabled: true, config: {} };
  plugins.register(consolePlugin, builtinSettings('console').config, builtinSettings('console').enabled);
  plugins.register(new CronPlugin(), builtinSettings('cron').config, builtinSettings('cron').enabled);
  await plugins.rescan(settingsOf);

  // Permissions, approvals and audit (docs/10-architecture/14-security-and-permissions.md).
  const audit = new AuditLog(db, clock);
  const policy = new PermissionPolicy(config.permissions, {
    askByDefault: (def) => plugins.isAskByDefault(def),
    ownerConfigured: () => owner.hasAny(),
  });
  const approvals = new ApprovalService({
    db,
    bus,
    audit,
    clock,
    log: log.child({ component: 'approvals' }),
    ttlMs: () => config.permissions.approvalTtlMs,
    deliver: (a) => plugins.requestApproval(a),
    pushInternal: (input) => {
      plugins.pushInternal(input);
    },
    redact: (text) => secrets.redact(text),
  });
  plugins.attachApprovals(approvals);

  const personaDir = path.join(dataDir, 'persona');
  if (ensurePersona(personaDir, path.join(assets, 'personas', 'default')).created) log.info({ dir: personaDir }, 'installed the default persona');
  const persona = loadPersona(personaDir);
  const pushInternal = (input: Parameters<PluginHost['pushInternal']>[0]): void => {
    plugins.pushInternal(input);
  };

  const budget = new BudgetTracker({ usage, settings: config.budget, bus, log: log.child({ component: 'budget' }), clock, pushInternal });
  const segments = new SystemSegments({
    persona,
    plugins,
    timezone: tz,
    overridesDir: path.join(dataDir, 'overrides'),
    log: log.child({ component: 'context' }),
    permissions: () => policy.summary(tools.list()),
  });
  // Plugin and policy changes reach the system prefix at the next turn boundary.
  bus.on('plugin.changed', () => segments.refresh());
  const dispatcher = new ToolDispatcher(tools, log.child({ component: 'tools' }));
  dispatcher.setGuard(new PermissionGuard(policy, approvals, audit));
  const effort = config.providers.anthropic.effort;
  const forks = new ForkManager({
    dir: path.join(dataDir, 'sessions', 'forks'),
    dataDir,
    sessions,
    usage,
    bus,
    provider,
    tools,
    dispatcher,
    log: log.child({ component: 'forks' }),
    clock,
    settings: config.scheduler.forks,
    backoffMs: config.session.backoffMs,
    effortFor: (role) => (role === 'main' ? effort.main[2] : effort[role]),
    system: () => segments.forkSegments(),
    pushInternal,
  });

  const startedAt = clock.now();
  let main: MainSession;
  const status = (): StatusResponse => {
    const h = provider.health();
    return {
      runId,
      version: VERSION,
      startedAt: isoInZone(startedAt, tz),
      uptimeSec: Math.round((clock.now() - startedAt) / 1000),
      phase: main.phase,
      batchId: main.currentBatchId,
      pending: store.pendingCounts(),
      provider: {
        id: provider.id,
        mainModel: provider.modelFor('main'),
        ready: h.ready,
        ...(h.problem !== undefined ? { problem: h.problem } : {}),
      },
      plugins: plugins.status(),
      usage24h: usage.totalsSince(clock.now() - 86_400_000),
      forks: forks.list(),
      budget: budget.status(),
    };
  };
  for (const spec of kernelTools({ store, status })) tools.register('core', spec);
  for (const spec of forkTools(forks, { maxTurns: config.scheduler.forks.maxTurns })) tools.register('core', spec);
  for (const spec of approvalTools({ approvals, policy, tools })) tools.register('core', spec);
  await plugins.startAll();

  main = new MainSession({
    transcript,
    store,
    batches,
    usage,
    bus,
    provider,
    assembler: new ContextAssembler(segments, tools),
    dispatcher,
    log: log.child({ component: 'session' }),
    clock,
    rounds: config.session.rounds,
    backoffMs: config.session.backoffMs,
    effortFor: (level: Level) => effort.main[level],
    status: () => ({
      now: isoInZone(clock.now(), tz),
      phase: main.phase,
      pending: store.pendingCounts(),
      budget: budget.remainingPercent(),
      forks: forks.activeCount(),
    }),
    pushInternal,
  });
  const scheduler = new Scheduler({
    store,
    bus,
    main,
    batches,
    levels: config.scheduler.levels,
    preemptStorm: config.scheduler.preemptStorm,
    log: log.child({ component: 'scheduler' }),
    clock,
    pushInternal,
  });

  // Control plane.
  const token = secrets.ensure(config.control.adminTokenSecret);
  if (token.generated) log.warn({ file: token.file }, 'generated an admin token for the control API');
  const ready = (): { ready: boolean; reasons: string[] } => {
    const reasons: string[] = [];
    const h = provider.health();
    if (!h.ready) reasons.push(`provider: ${h.problem ?? 'not ready'}`);
    for (const p of plugins.status()) if (p.enabled && p.state === 'failed') reasons.push(`plugin ${p.id}: ${p.error ?? 'failed'}`);
    return { ready: reasons.length === 0, reasons };
  };

  // Hot configuration (docs/30-specs/04-config-reference.md §4).
  const HOT_SECTIONS = new Set(['owner', 'permissions', 'plugins']);
  const reloadConfig = async (): Promise<void> => {
    let next: ProteaConfig;
    try {
      next = loadConfig(dataDir, env).config;
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'config.yaml is invalid; keeping the running configuration');
      return;
    }
    const prev = config;
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    config = next;
    owner.update(next.owner.identities);
    policy.update(next.permissions);
    segments.refresh();
    const ids = new Set([...Object.keys(prev.plugins), ...Object.keys(next.plugins), ...plugins.status().map((p) => p.id)]);
    for (const id of ids) {
      try {
        await plugins.applySettings(id, next.plugins[id]);
      } catch (err) {
        log.error({ plugin: id, err: errorMessage(err) }, 'plugin settings not applied');
      }
    }
    const cold = (Object.keys(next) as Array<keyof ProteaConfig>).filter(
      (k) => !HOT_SECTIONS.has(k) && JSON.stringify(prev[k]) !== JSON.stringify(next[k]),
    );
    if (cold.length > 0) log.warn({ sections: cold }, 'these configuration changes take effect after a restart');
    log.info('configuration reloaded');
  };
  const setPluginConfig = async (id: string, cfg: Record<string, unknown>): Promise<void> => {
    await plugins.updateConfig(id, cfg);
    config.plugins[id] = { enabled: plugins.get(id)?.enabled ?? false, config: cfg };
    persist(['plugins', id, 'config'], cfg);
  };
  const app = createControlApp({
    adminToken: token.value,
    bus,
    store,
    log: log.child({ component: 'control' }),
    transcript: () => transcript,
    forks,
    plugins,
    approvals,
    rescanPlugins: () => plugins.rescan(settingsOf),
    setPluginConfig,
    status,
    ready,
    pushConsole: (req, senderKey) =>
      consolePlugin.receive(req.text, {
        senderKey,
        ...(req.level !== undefined ? { level: req.level } : {}),
        ...(req.trigger !== undefined ? { trigger: req.trigger } : {}),
        ...(req.tags !== undefined ? { tags: req.tags } : {}),
      }),
  });
  let server: ControlServer;
  try {
    server = await startControlServer(app, opts.listen ?? config.control.listen);
  } catch (err) {
    await plugins.stopAll();
    transcript.close();
    db.close();
    lock.release();
    throw err;
  }

  const waiting = Object.values(store.pendingCounts()).reduce((a, b) => a + b, 0);
  plugins.pushInternal({
    type: 'daemon.started',
    level: 4,
    trigger: 'piggyback',
    text: `Protea ${VERSION} started (run ${runId}); ${waiting} event(s) were waiting${main.needsResume() ? ' and an interrupted batch is resuming' : ''}.`,
  });
  scheduler.start();
  forks.recover();
  forks.start();
  const unwatch = [
    watchPaths([{ path: dataDir, filter: (name) => name === 'config.yaml' }], () => void reloadConfig(), {
      onError: (err) => log.warn({ err: err.message }, 'config watcher error'),
    }),
    watchPaths([{ path: path.join(dataDir, 'plugins'), recursive: true }], () => void plugins.rescan(settingsOf), {
      debounceMs: 500,
      onError: (err) => log.warn({ err: err.message }, 'plugin directory watcher error'),
    }),
  ];
  const expiry = setInterval(() => approvals.expireDue(), 60_000);
  expiry.unref();
  log.info(
    { url: server.url, dataDir, provider: provider.id, model: provider.modelFor('main'), config: sources, providerReady: provider.health().ready },
    'daemon started',
  );

  let stopping: Promise<void> | null = null;
  const stop = (reason = 'stop requested'): Promise<void> => {
    stopping ??= (async () => {
      log.info({ reason }, 'stopping');
      for (const off of unwatch) off();
      clearInterval(expiry);
      plugins.pushInternal({ type: 'daemon.stopping', level: 4, trigger: 'store', text: `Daemon stopping: ${reason}.` });
      scheduler.drain();
      const graceMs = config.daemon.shutdown.graceMs;
      const [finished] = await Promise.all([main.drain(graceMs), forks.stop(graceMs)]);
      if (!finished) log.warn('the running batch was aborted at shutdown; it resumes on the next start');
      await plugins.stopAll();
      await server.close();
      transcript.close();
      db.close();
      lock.release();
      log.info('stopped');
    })();
    return stopping;
  };

  return {
    runId,
    url: server.url,
    adminToken: token.value,
    dataDir,
    get config() {
      return config;
    },
    db,
    bus,
    store,
    transcript,
    main,
    scheduler,
    plugins,
    approvals,
    audit,
    forks,
    budget,
    console: consolePlugin,
    tools,
    status,
    reloadConfig,
    stop,
  };
}

/** Run until SIGTERM/SIGINT (the `protea serve` entry point). */
export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const daemon = await startDaemon(opts);
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    signals++;
    if (signals > 1) process.exit(130);
    void daemon.stop(`received ${sig}`).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
