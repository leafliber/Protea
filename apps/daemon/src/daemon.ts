import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Bus,
  BatchRepo,
  ContextAssembler,
  EventStore,
  InprocPluginHost,
  KvRepo,
  MainSession,
  OwnerRegistry,
  Scheduler,
  SecretStore,
  SessionRepo,
  SystemSegments,
  ToolDispatcher,
  ToolRegistry,
  Transcript,
  UsageRepo,
  createLogger,
  createProvider,
  ensurePersona,
  errorMessage,
  isoInZone,
  kernelTools,
  loadConfig,
  loadPersona,
  mainTranscriptPath,
  newId,
  openDatabase,
  reconcileDeliveries,
  systemClock,
  type Clock,
  type Db,
  type Logger,
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
  plugins: InprocPluginHost;
  console: ConsolePlugin;
  tools: ToolRegistry;
  status(): StatusResponse;
  stop(reason?: string): Promise<void>;
}

function defaultPersonaDir(env: NodeJS.ProcessEnv): string {
  if (env['PROTEA_ASSETS_DIR']) return path.join(env['PROTEA_ASSETS_DIR'], 'personas', 'default');
  // apps/daemon/{src,dist}/daemon.* → repository root
  return fileURLToPath(new URL('../../../personas/default/', import.meta.url));
}

/**
 * Assemble and start the daemon, following docs/10-architecture/16-deployment.md §5.
 * Returns once the control plane listens and the scheduler runs.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const env = opts.env ?? process.env;
  const dataDir = path.resolve(opts.dataDir);
  for (const d of ['sessions', 'runs', 'plugin-data', 'overrides']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const lock = acquireLock(dataDir);

  const runId = newId();
  const runDir = path.join(dataDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const { config, sources, warnings } = loadConfig(dataDir, env);
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
  new SessionRepo(db).upsert({
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
  const plugins = new InprocPluginHost({ store, bus, owner, kv, tools, log, clock, dataDir, timezone: tz });
  const consolePlugin = new ConsolePlugin();
  if (config.plugins['console']?.enabled !== false) plugins.register(consolePlugin, config.plugins['console']?.config ?? {});
  if (config.plugins['cron']?.enabled !== false) plugins.register(new CronPlugin(), config.plugins['cron']?.config ?? {});

  const personaDir = path.join(dataDir, 'persona');
  if (ensurePersona(personaDir, defaultPersonaDir(env)).created) log.info({ dir: personaDir }, 'installed the default persona');
  const persona = loadPersona(personaDir);

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
    };
  };
  for (const spec of kernelTools({ store, status })) tools.register('core', spec);
  await plugins.startAll();

  const segments = new SystemSegments({
    persona,
    plugins,
    timezone: tz,
    overridesDir: path.join(dataDir, 'overrides'),
    log: log.child({ component: 'context' }),
  });
  const effort = config.providers.anthropic.effort.main;
  main = new MainSession({
    transcript,
    store,
    batches,
    usage,
    bus,
    provider,
    assembler: new ContextAssembler(segments, tools),
    dispatcher: new ToolDispatcher(tools, log.child({ component: 'tools' })),
    log: log.child({ component: 'session' }),
    clock,
    rounds: config.session.rounds,
    backoffMs: config.session.backoffMs,
    effortFor: (level: Level) => effort[level],
    status: () => ({ now: isoInZone(clock.now(), tz), phase: main.phase, pending: store.pendingCounts() }),
    pushInternal: (input) => {
      plugins.pushInternal(input);
    },
  });
  const scheduler = new Scheduler({
    store,
    bus,
    main,
    batches,
    levels: config.scheduler.levels,
    log: log.child({ component: 'scheduler' }),
    clock,
  });

  // Control plane.
  const token = secrets.ensure(config.control.adminTokenSecret);
  if (token.generated) log.warn({ file: token.file }, 'generated an admin token for the control API');
  const ready = (): { ready: boolean; reasons: string[] } => {
    const reasons: string[] = [];
    const h = provider.health();
    if (!h.ready) reasons.push(`provider: ${h.problem ?? 'not ready'}`);
    for (const p of plugins.status()) if (p.state === 'failed') reasons.push(`plugin ${p.id}: ${p.error ?? 'failed'}`);
    return { ready: reasons.length === 0, reasons };
  };
  const app = createControlApp({
    adminToken: token.value,
    bus,
    store,
    log: log.child({ component: 'control' }),
    transcript: () => transcript,
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
  log.info(
    { url: server.url, dataDir, provider: provider.id, model: provider.modelFor('main'), config: sources, providerReady: provider.health().ready },
    'daemon started',
  );

  let stopping: Promise<void> | null = null;
  const stop = (reason = 'stop requested'): Promise<void> => {
    stopping ??= (async () => {
      log.info({ reason }, 'stopping');
      plugins.pushInternal({ type: 'daemon.stopping', level: 4, trigger: 'store', text: `Daemon stopping: ${reason}.` });
      scheduler.drain();
      const finished = await main.drain(config.daemon.shutdown.graceMs);
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
    config,
    db,
    bus,
    store,
    transcript,
    main,
    scheduler,
    plugins,
    console: consolePlugin,
    tools,
    status,
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
