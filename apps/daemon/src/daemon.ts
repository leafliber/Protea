import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountStore,
  ApprovalService,
  JudgeContextSource,
  ModelPermissionJudge,
  PermissionModes,
  AuditLog,
  Bus,
  BatchRepo,
  BudgetTracker,
  BusTrail,
  Board,
  ContextAssembler,
  DreamRunner,
  EventGateway,
  IdleMaintenance,
  ForkManager,
  EventStore,
  Handoff,
  MemoryIndex,
  MemoryStore,
  Persona,
  RedactingProvider,
  TracingProvider,
  traceBus,
  PluginHost,
  ProviderRecorder,
  KvRepo,
  OutputLog,
  LogRing,
  MainSession,
  OutboundLimiter,
  ChatHub,
  batchSteps,
  cacheHitRatio,
  describeRequest,
  readBatchRecords,
  redactValues,
  withWebchatIdentities,
  OwnerRegistry,
  PermissionGuard,
  McpManager,
  PermissionPolicy,
  Scheduler,
  SkillRegistry,
  SecretStore,
  SessionRepo,
  SystemSegments,
  ToolDispatcher,
  ToolExposure,
  clientSearchTools,
  ToolRegistry,
  ToolStatsRepo,
  Transcript,
  UsageRepo,
  approvalTools,
  approvalView,
  ChangeRequestService,
  changeTools,
  mcpChangeAdapter,
  skillChangeAdapter,
  pluginChangeAdapter,
  configSources,
  createBackup,
  createDiagnostics,
  diagnosticsDir,
  listDiagnostics,
  createLogger,
  createMetrics,
  contextLimits,
  PROTOCOL_DEFAULT_URL,
  PROVIDER_PRESETS,
  compactProfile,
  createProvider,
  defaultProfile,
  isProfileId,
  migrateLegacyProviders,
  newSetupCode,
  normalizeProviderProfile,
  probeProfile,
  providerKeySecretName,
  replaceConfigValue,
  ensureMemoryDir,
  estimateMessagesTokens,
  ensurePersona,
  errorMessage,
  forkTools,
  gitBackup,
  isoInZone,
  kernelTools,
  BlobStore,
  ImageResolvingProvider,
  browserPreset,
  viewImageTool,
  WidgetStore,
  kvNamespace,
  listBackups,
  loadConfig,
  mainTranscriptPath,
  memoryTools,
  newId,
  normalizeMcpServer,
  openDatabase,
  parseCidr,
  patchConfigFile,
  pruneRuns,
  reconcileDeliveries,
  resolveDevLoader,
  secretsEpoch,
  setConfigValue,
  skillTools,
  systemClock,
  transcriptSeq,
  watchPaths,
  writeCrashReport,
  writeShutdownReport,
  type Clock,
  type Db,
  type InternalEventInput,
  type Logger,
  type McpServerSettings,
  type Metrics,
  type PluginSettings,
  type ProteaConfig,
  type Provider,
  type ProviderProfile,
  type ProviderRouter,
  type ToolGuard,
} from '@protea/core';
import { authenticate, createControlApp, createWebSocketEndpoint, startControlServer, type AuthDeps, type ControlServer, type ProviderOps } from '@protea/control';
import { ConsolePlugin } from '@protea/plugin-console';
import { WebchatPlugin } from '@protea/plugin-webchat';
import { CronPlugin } from '@protea/plugin-cron';
import { PROVIDER_PROTOCOLS, type Level, type ModelRole, type ProviderProtocolName, type ProvidersResponse, type ScheduleRun, type StatusResponse } from '@protea/protocol';
import { acquireLock } from './lock.js';

export const VERSION = '0.1.0';

/** The one-time code that authorizes creating the first admin account (secrets/PROTEA_SETUP_CODE). */
export const SETUP_SECRET = 'PROTEA_SETUP_CODE';

const PROTOCOL_LABELS: Record<ProviderProtocolName, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  echo: 'Echo（离线开发）',
};

/** First-run banner on stdout (not through the logger, so the code stays out of every log file). */
function setupBanner(url: string, code: string): string {
  const line = '='.repeat(64);
  return [
    '',
    line,
    '  Protea first-run setup / 首次设置',
    `  Open ${url}/ and create the admin account with this setup code:`,
    `  打开 ${url}/ ，用下面的设置码创建管理员账号：`,
    '',
    `      ${code}`,
    '',
    '  Also stored in secrets/PROTEA_SETUP_CODE; it stops working once the account exists.',
    '  同时保存在 secrets/PROTEA_SETUP_CODE；账号建好后作废。',
    line,
    '',
    '',
  ].join('\n');
}

/** The port of an address like "0.0.0.0:7788". */
function listenPort(listen: string): number | undefined {
  const n = Number(listen.slice(listen.lastIndexOf(':') + 1));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface DaemonOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Override the configured provider (tests). */
  provider?: Provider;
  /** Override control.listen, e.g. "127.0.0.1:0" (tests). */
  listen?: string;
  logger?: Logger;
  /** Replaces the permission guard (offline replay answers every tool call from the recording). */
  toolGuard?: ToolGuard;
  /** Node.js process metrics on /metrics (default on; tests that start many daemons turn it off). */
  processMetrics?: boolean;
  /**
   * Where the first-run setup banner (with the setup code) goes; default stdout unless
   * observability.logLevel is silent. It bypasses the logger, so the code is in no log file.
   */
  announce?: (text: string) => void;
  clock?: Clock;
}

export interface Daemon {
  runId: string;
  url: string;
  adminToken: string;
  /** Console accounts and sign-in sessions. */
  accounts: AccountStore;
  /** The provider router (null when the options supplied a provider). */
  providers: ProviderRouter | null;
  dataDir: string;
  config: ProteaConfig;
  db: Db;
  bus: Bus;
  store: EventStore;
  /** The single entry point for events into the store. */
  gateway: EventGateway;
  /** The current main transcript (a handoff replaces it). */
  readonly transcript: Transcript;
  main: MainSession;
  scheduler: Scheduler;
  plugins: PluginHost;
  approvals: ApprovalService;
  audit: AuditLog;
  forks: ForkManager;
  budget: BudgetTracker;
  console: ConsolePlugin;
  webchat: WebchatPlugin;
  chat: ChatHub;
  tools: ToolRegistry;
  mcp: McpManager;
  skills: SkillRegistry;
  memory: MemoryStore;
  memoryIndex: MemoryIndex;
  board: Board;
  dream: DreamRunner;
  maintenance: IdleMaintenance;
  persona: Persona;
  /** Resolves once the MCP servers configured at start have been tried (they start in the background). */
  mcpReady: Promise<void>;
  /** This run's directory (<data>/runs/<runId>): log.jsonl, transcript.jsonl, shutdown.json, crash/. */
  runDir: string;
  /** The last log lines of this run. */
  logs: LogRing;
  /** The last bus records (crash reports). */
  trail: BusTrail;
  log: Logger;
  /** Secret values out of text bound for disk (crash reports). */
  redact(text: string): string;
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

/** The built web console: $PROTEA_WEB_DIR or apps/web/dist next to the shipped assets. */
function webDir(env: NodeJS.ProcessEnv, assets: string): string {
  return env['PROTEA_WEB_DIR'] ? path.resolve(env['PROTEA_WEB_DIR']) : path.join(assets, 'apps', 'web', 'dist');
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
  for (const d of ['sessions/forks', 'runs', 'plugins', 'plugin-data', 'overrides', 'skills', 'workspace']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const lock = acquireLock(dataDir);

  const runId = newId();
  const runDir = path.join(dataDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  // Provider settings of the layout before profiles move to providers.profiles (logged below).
  let migratedProviders: string[] = [];
  let migrationError: string | null = null;
  try {
    migratedProviders = migrateLegacyProviders(dataDir, path.join(dataDir, 'secrets'));
  } catch (err) {
    migrationError = errorMessage(err);
  }
  const loadedConfig = loadConfig(dataDir, env);
  const { sources, warnings } = loadedConfig;
  let config = loadedConfig.config;
  const logRing = new LogRing();
  const secrets = new SecretStore(path.join(dataDir, 'secrets'), env);
  // Secret values never reach a log destination (terminal, log.jsonl, the in-memory ring).
  const redactLine = (line: string): string => secrets.redactJsonText(line);
  const log =
    opts.logger ??
    createLogger({
      level: config.observability.logLevel,
      format: config.observability.logFormat,
      file: path.join(runDir, 'log.jsonl'),
      fileMaxBytes: Math.round(config.observability.logRotateMb * 1048576),
      fileKeep: config.observability.logRotateKeep,
      sinks: [logRing],
      base: { run: runId },
      redact: redactLine,
    });
  for (const w of warnings) log.warn(w);
  if (migratedProviders.length > 0) log.warn({ changes: migratedProviders }, 'provider settings migrated to provider profiles');
  if (migrationError) log.error({ err: migrationError }, 'could not migrate the old provider settings');
  const prunedRuns = pruneRuns(path.join(dataDir, 'runs'), config.observability.keepRuns, runId);
  if (prunedRuns.length > 0) log.info({ removed: prunedRuns.length }, 'old run directories removed');
  const clock = opts.clock ?? systemClock;
  const tz = config.daemon.timezone;

  const { db, migration } = openDatabase(path.join(dataDir, 'protea.db'));
  if (migration.applied.length > 0) log.info({ applied: migration.applied }, 'database migrated');
  const bus = new Bus((topic, err) => log.error({ topic, err: errorMessage(err) }, 'bus listener failed'));
  // Metadata-only trace lines for events, batches and approvals (observability.logEventText adds event text).
  traceBus(bus, log.child({ component: 'trace' }), { eventText: () => config.observability.logEventText });
  const trail = new BusTrail(bus);
  const store = new EventStore(db, bus, { runId, clock });
  const batches = new BatchRepo(db);
  const usage = new UsageRepo(db);
  const kv = new KvRepo(db);
  const outputs = new OutputLog(db);
  try {
    const recovered = outputs.backfillFromTranscripts(path.join(dataDir, 'sessions'));
    if (recovered > 0) log.info({ recovered }, 'console replies recovered from the transcripts for the chat page');
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'could not recover earlier console replies');
  }
  // Before the split the web chat was the console plugin: its history keeps showing as the web chat.
  outputs.ensureChatSplit();

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
  const ownerIdentities = (identities: typeof config.owner.identities): typeof config.owner.identities => {
    const r = withWebchatIdentities(identities);
    if (r.added) log.warn('owner.identities names console but not webchat; treating the same senders as the owner in the web chat. Add { plugin: webchat, senderKey: "*" } to config.yaml');
    return r.identities;
  };
  const owner = new OwnerRegistry(ownerIdentities(config.owner.identities));
  if (!owner.hasAny()) log.warn('owner.identities is empty: no event can reach level 1');
  const gateway = new EventGateway({ store, owner, log: log.child({ component: 'events' }), clock, timezone: tz });
  const pushInternal = (input: InternalEventInput) => gateway.pushInternal(input);
  // Invariant I-7: no request carries a secret value, whatever path it took into the context.
  const redactedNames = new Set<string>();
  const blobs = new BlobStore({ dir: path.join(dataDir, 'blobs'), db, clock, maxImageBytes: () => config.vision.maxImageKb * 1024 });
  // Profiles per role (providers.*); rebuilt when their settings or keys change, no restart needed.
  const router: ProviderRouter | null = opts.provider ? null : createProvider(() => config.providers, secrets);
  // Innermost wrapper: nothing outside it sees image bytes.
  const baseProvider: Provider = new ImageResolvingProvider(opts.provider ?? (router as ProviderRouter), blobs, (role) => (router ? router.visionFor(role) : true));
  const fallbackProfile = defaultProfile('anthropic');
  const effortOf = (role: ModelRole, level: Level = 2) =>
    router ? router.effort(role, level) : role === 'main' ? fallbackProfile.effort.main[level] : fallbackProfile.effort[role];
  // Recording sits inside the redaction, so provider.jsonl never holds a secret value.
  const recordMode = config.observability.recordProvider;
  const recorded = recordMode === 'off' ? baseProvider : new ProviderRecorder(baseProvider, path.join(runDir, 'provider.jsonl'), recordMode);
  if (recordMode !== 'off') log.warn({ mode: recordMode, file: path.join(runDir, 'provider.jsonl') }, 'recording model calls (observability.recordProvider)');
  const redacting = new RedactingProvider(recorded, secrets, (names) => {
    const fresh = names.filter((n) => !redactedNames.has(n));
    if (fresh.length === 0) return;
    for (const n of fresh) redactedNames.add(n);
    log.warn({ secrets: fresh }, 'secret values were redacted from a model request');
    pushInternal({
      type: 'secret.redacted',
      level: 4,
      trigger: 'store',
      text: `The value of secret(s) ${fresh.join(', ')} appeared in text bound for the model and was replaced with [REDACTED:<name>].`,
    });
  });
  // Outermost: one "model call" log line per request (role, tokens, cache share, time).
  const provider = new TracingProvider(redacting, log.child({ component: 'model' }));
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
  const widgets = new WidgetStore(db);
  const chat = new ChatHub({
    tools,
    bus,
    outputs,
    log: log.child({ component: 'chat' }),
    clock,
    blobs,
    workspace: path.join(dataDir, 'workspace'),
    widgets,
    limits: () => ({
      maxImages: config.vision.maxImagesPerMessage,
      maxImageBytes: config.vision.maxImageKb * 1024,
      widgets: config.chat.widgets,
      widgetMaxBytes: config.chat.widgetMaxKb * 1024,
    }),
    publicUrl: () => config.control.publicUrl,
  });
  const plugins = new PluginHost({
    blobs,
    chat,
    store,
    bus,
    outputs,
    gateway,
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
    onOwnerSignIn: (id, senderKey) => {
      const identities = [...config.owner.identities.filter((i) => i.plugin !== id), ...(senderKey !== null ? [{ plugin: id, senderKey }] : [])];
      config.owner = { ...config.owner, identities };
      persist(['owner', 'identities'], identities);
      owner.update(ownerIdentities(identities));
    },
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
  const webchatPlugin = new WebchatPlugin();
  const builtinSettings = (id: string): PluginSettings => config.plugins[id] ?? { enabled: true, config: {} };
  plugins.register(consolePlugin, builtinSettings('console').config, builtinSettings('console').enabled);
  plugins.register(webchatPlugin, builtinSettings('webchat').config, builtinSettings('webchat').enabled);
  const cronPlugin = new CronPlugin();
  cronPlugin.onChange = (id) => bus.emit('schedule.changed', { id });
  plugins.register(cronPlugin, builtinSettings('cron').config, builtinSettings('cron').enabled);
  await plugins.rescan(settingsOf);

  // Permissions, approvals and audit (docs/10-architecture/14-security-and-permissions.md).
  // MCP servers (docs/10-architecture/09-mcp-integration.md); they start in the background below.
  let controlUrl = '';
  const mcp = new McpManager({
    keepImage: (data, server) => {
      const r = blobs.putImage(Buffer.from(data, 'base64'), `mcp:${server}`);
      return r.ok ? { handle: r.blob.handle, mime: r.blob.mime } : { reason: r.reason };
    },
    tools,
    bus,
    log: log.child({ component: 'mcp' }),
    clock,
    dataDir,
    version: VERSION,
    secrets,
    settings: () => config.mcp,
    supervision: () => config.pluginHost,
    pushInternal,
    pushEvent: (server, input) => {
      gateway.push({ source: `mcp:${server}`, maxLevel: 4 }, { ...input, ts: new Date(clock.now()).toISOString() });
    },
    redirectUrl: () => `${(config.control.publicUrl ?? controlUrl).replace(/\/$/, '')}/api/mcp/oauth/callback`,
  });

  const audit = new AuditLog(db, clock);
  const policy = new PermissionPolicy(config.permissions, {
    askByDefault: (def) => plugins.isAskByDefault(def),
    ownerConfigured: () => owner.hasAny(),
    annotations: (def) => mcp.policyFor(def),
  });
  const approvals = new ApprovalService({
    db,
    bus,
    audit,
    clock,
    log: log.child({ component: 'approvals' }),
    ttlMs: () => config.permissions.approvalTtlMs,
    grantMaxMs: () => config.permissions.grantMaxMs,
    deliver: (a, platforms) => plugins.requestApproval(a, platforms),
    resolved: (a) => plugins.approvalResolved(a),
    describe: (r) => {
      const def = tools.get(r.tool) ?? { name: r.tool, owner: r.owner, inputSchema: {} };
      return approvalView(def, r.input, { language: config.daemon.language, redact: (text) => secrets.redact(text) });
    },
    pushInternal,
    redact: (text) => secrets.redact(text),
  });
  plugins.attachApprovals(approvals);
  // ask / auto / bypass / locked (docs/20-decisions/ADR-0015-permission-modes-and-auto-review.md).
  const modes = new PermissionModes({
    kv: kvNamespace(kv, 'permissions'),
    audit,
    bus,
    clock,
    log: log.child({ component: 'permissions' }),
    settings: () => config.permissions,
    persistBaseline: async (mode) => {
      replaceConfigValue(dataDir, ['permissions', 'mode'], mode, env);
      await reloadConfig();
    },
    judgeStatus: () => {
      const health = router ? router.healthFor('judge') : provider.health();
      return { model: provider.modelFor('judge'), ready: health.ready, ...(health.problem !== undefined ? { problem: health.problem } : {}) };
    },
    notifyOwner: (text) => void chat.notifyOwner(text),
  });
  plugins.attachPermissionModes(modes);
  const judge = new ModelPermissionJudge({
    provider,
    effort: () => effortOf('judge'),
    settings: () => config.permissions.auto,
    onUsage: (res, req) => {
      const now = clock.now();
      const rec = {
        at: new Date(now).toISOString(),
        atMs: now,
        provider: res.provider ?? provider.id,
        model: res.model,
        role: 'judge' as const,
        sessionId: req.sessionId,
        batchId: req.batchId,
        level: req.level,
        ...res.usage,
        stopReason: res.stopReason,
        ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
      };
      usage.record(rec);
      bus.emit('usage.recorded', rec);
    },
  });

  const personaDir = path.resolve(dataDir, config.persona.dir);
  if (ensurePersona(personaDir, path.join(assets, 'personas', 'default')).created) log.info({ dir: personaDir }, 'installed the default persona');
  const persona = new Persona(personaDir, log.child({ component: 'persona' }));
  await persona.loadHooks();

  // Memory (docs/10-architecture/11-memory-and-persona.md): files under /data/memory, a full-text index, the INDEX.md segment.
  const memoryDir = path.join(dataDir, 'memory');
  if (ensureMemoryDir(memoryDir, path.join(assets, 'personas', 'default', 'memory')).created) log.info({ dir: memoryDir }, 'created the memory directory');
  let memoryIndex: MemoryIndex | null = null;
  const memory = new MemoryStore(memoryDir, (paths) => memoryIndex?.update(paths));
  memoryIndex = new MemoryIndex(db, memory, () => new Date(clock.now()).toISOString(), () => clock.now());
  const memoryKv = kvNamespace(kv, 'memory');
  const board = new Board(db, memoryKv, () => config.memory.board, () => new Date(clock.now()).toISOString());
  // INDEX.md is in the cached system prefix, so a new version goes live only at chosen moments.
  let publishedIndex = memory.readText('INDEX.md') ?? null;
  let indexPublishPending = false;
  const synced = memoryIndex.sync();
  if (synced.indexed + synced.removed > 0) log.info(synced, 'memory index updated');

  // Skills (docs/10-architecture/10-skills.md): built-in → data volume → plugins → MCP prompts.
  const skills = new SkillRegistry({
    roots: () => [
      { dir: path.join(assets, 'skills'), origin: 'builtin' },
      { dir: path.join(dataDir, 'skills'), origin: 'user' },
      ...plugins.skillRoots(),
    ],
    userDir: path.join(dataDir, 'skills'),
    disabled: () => new Set(config.skills.disabled),
    mcpPrompts: () => config.skills.mcpPrompts,
    toolNames: () => tools.list().map((t) => t.name),
    prompts: mcp,
    kv: kvNamespace(kv, 'skills'),
    log: log.child({ component: 'skills' }),
    clock,
    onChanged: (names) => bus.emit('skills.changed', { names }),
  });

  const budget = new BudgetTracker({
    usage,
    settings: config.budget,
    bus,
    log: log.child({ component: 'budget' }),
    clock,
    pushInternal,
    kv: kvNamespace(kv, 'budget'),
    store,
  });
  // Budget enforcement decides the delivery mode of new events.
  gateway.setAdmission((ev) => budget.admit(ev));
  const segments = new SystemSegments({
    persona: () => persona.current,
    hooks: () => persona.hooks,
    memoryIndex: () => publishedIndex,
    plugins,
    timezone: tz,
    overridesDir: path.join(dataDir, 'overrides'),
    log: log.child({ component: 'context' }),
    permissions: () => policy.summary(tools.list(), modes.current()),
    extraEnv: () => {
      // Tools held back for a provider without tool search: the model is told what it can look up.
      const catalog = exposure.catalog('main');
      return [...mcp.envSegments(), ...(catalog ? [{ id: 'mcp-catalog', text: catalog }] : [])];
    },
    skills: () => skills.catalog(),
  });
  // Plugin, MCP, skill and policy changes reach the system prefix at the next turn boundary.
  bus.on('plugin.changed', () => {
    skills.rescan();
    segments.refresh();
  });
  bus.on('mcp.changed', () => {
    skills.rescan();
    segments.refresh();
  });
  bus.on('skills.changed', () => segments.refresh());
  const applyPublishedIndex = (): void => {
    indexPublishPending = false;
    const text = memory.readText('INDEX.md') ?? null;
    if (text === publishedIndex) return;
    publishedIndex = text;
    segments.refresh();
  };
  // Not during a batch: a new prefix would move the thinking floor in the middle of it.
  const publishIndex = (): void => {
    if (main.busy) indexPublishPending = true;
    else applyPublishedIndex();
  };
  const dispatcher = new ToolDispatcher(tools, log.child({ component: 'tools' }));
  dispatcher.setImageLimit(() => config.vision.maxImagesPerMessage);
  bus.on('permission.mode', () => segments.refresh());
  dispatcher.setGuard(
    opts.toolGuard ??
      new PermissionGuard(policy, approvals, audit, modes, {
        judge,
        context: new JudgeContextSource({ db, parentBatch: (id) => forks.parentBatch(id) }),
        timeoutMs: () => config.permissions.auto.timeoutMs,
        refusal: (level) => budget.forkRefusal(level),
      }),
  );
  const outbound = new OutboundLimiter({
    perMinute: () => config.pluginHost.outboundPerMinute,
    isConnector: (owner) => plugins.get(owner)?.kind === 'connector',
    clock,
    log: log.child({ component: 'tools' }),
    pushInternal,
  });
  dispatcher.setLimiter((def, use) => outbound.check(def, use));
  // Tool inputs and results can carry what the model is never shown: keep it off the run stream too.
  dispatcher.setTrace((t) => bus.emit('tool.call', redactValues(t, secrets)));
  let lastMainUsage: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null = null;
  bus.on('usage.recorded', (u) => {
    if (u.role === 'main') lastMainUsage = u;
  });
  const toolStats = new ToolStatsRepo(db);
  let metrics: Metrics | null = null;
  dispatcher.observe((name, ms, failed) => {
    toolStats.record(name, ms, failed, new Date(clock.now()).toISOString());
    metrics?.toolCall(name, ms, failed);
  });
  // Tool search: past context.toolSearch.threshold tools, MCP tools load on demand.
  const exposure = new ToolExposure({
    tools,
    settings: () => config.context.toolSearch,
    usage: (name) => toolStats.calls(name),
    supported: (role) => provider.supportsToolSearch?.(role) ?? false,
    ownerNote: (owner) => mcp.instructionsOf(owner),
  });
  for (const spec of clientSearchTools(exposure, tools)) tools.register('core', spec);
  mcp.setDeferredProbe((name) => exposure.isDeferred(name));
  const forks = new ForkManager({
    dir: path.join(dataDir, 'sessions', 'forks'),
    dataDir,
    sessions,
    usage,
    bus,
    provider,
    tools,
    exposure,
    dispatcher,
    log: log.child({ component: 'forks' }),
    clock,
    timezone: tz,
    settings: config.scheduler.forks,
    backoffMs: config.session.backoffMs,
    effortFor: (role) => effortOf(role),
    system: () => segments.forkSegments(),
    prefixSalt: () => secretsEpoch(secrets),
    pushInternal,
    spawnGate: (level) => budget.forkRefusal(level),
  });

  const startedAt = clock.now();
  const roundsNow = (): { soft: number; hard: number } => {
    const custom = persona.hooks?.rounds;
    if (custom) {
      try {
        const r = custom();
        if (Number.isInteger(r?.soft) && Number.isInteger(r?.hard) && r.soft > 0 && r.hard >= r.soft) return r;
        log.warn({ rounds: r }, 'persona rounds hook returned invalid limits; using session.rounds');
      } catch (err) {
        log.warn({ err: errorMessage(err) }, 'persona rounds hook failed; using session.rounds');
      }
    }
    return config.session.rounds;
  };
  const reloadPersona = async (): Promise<void> => {
    try {
      if (await persona.reload()) {
        segments.refresh();
        bus.emit('persona.changed', { files: ['persona'] });
        log.info('persona reloaded; it applies from the next model request');
      }
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'persona reload failed');
    }
  };
  const limits = () => contextLimits(config.context.handoff, provider.contextWindow('main'), router ? router.maxOutputTokens('main') : fallbackProfile.maxOutputTokens);
  let main: MainSession;
  const contextTokens = (): number => {
    const t = main.currentTranscript;
    const base = t.sinceLastUsage();
    return base ? base.tokens + estimateMessagesTokens(base.after) : estimateMessagesTokens(t.messages);
  };
  const mainProtocol = (): string | null => {
    const id = router?.profileFor('main');
    return id ? (config.providers.profiles[id]?.protocol ?? null) : null;
  };
  const accounts = new AccountStore(db, () => clock.now());
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
        id: router?.profileFor('main') ?? provider.id,
        ...(mainProtocol() ? { protocol: mainProtocol() as ProviderProtocolName } : {}),
        mainModel: provider.modelFor('main'),
        ready: h.ready,
        ...(h.problem !== undefined ? { problem: h.problem } : {}),
      },
      setupRequired: accounts.setupRequired(),
      plugins: plugins.status(),
      mcp: mcp.status(),
      skills: { listed: skills.listedNames().length, rejected: skills.list().filter((k) => k.errors.length > 0).length },
      tools: (() => {
        const deferred = exposure.deferredNames().length;
        return { total: tools.list().filter((d) => !d.clientSearch).length, deferred, ...(deferred > 0 ? { search: exposure.modeFor('main') } : {}) };
      })(),
      context: (() => {
        const t = main.currentTranscript;
        const lim = limits();
        return {
          transcript: path.basename(t.file),
          handoffs: transcriptSeq(t.file) - 1,
          estimatedTokens: contextTokens(),
          softTokens: lim.soft,
          hardTokens: lim.hard,
          ...(maintenance.lastCompaction ? { lastCompaction: maintenance.lastCompaction } : {}),
        };
      })(),
      memory: { files: memoryIndex?.size ?? 0, board: { open: board.open().length, rev: board.rev }, dream: dream.status() },
      persona: { hooks: persona.hooks !== null, ...(persona.hooksProblem ? { problem: persona.hooksProblem } : {}) },
      usage24h: usage.totalsSince(clock.now() - 86_400_000),
      scheduler: { paused: scheduler.paused, cooldowns: scheduler.cooldowns() },
      forks: forks.list(),
      budget: budget.status(),
      chat: { platforms: chat.list(), ...(chat.lastPlatform ? { last: chat.lastPlatform } : {}) },
    };
  };
  for (const spec of kernelTools({ store, status })) tools.register('core', spec);
  tools.register('core', viewImageTool({ blobs, workspace: path.join(dataDir, 'workspace'), maxBytes: () => config.vision.maxImageKb * 1024 }));
  for (const spec of forkTools(forks, { maxTurns: config.scheduler.forks.maxTurns })) tools.register('core', spec);
  for (const spec of approvalTools({ approvals, policy, tools, modes, platforms: () => plugins.approvalPlatforms() })) tools.register('core', spec);
  // Tools whose calls need approval take `_approval` (why, and where to ask).
  tools.setApprovalMeta((d) => policy.decide(d).policy === 'ask');
  // The assistant proposes changes to its own capabilities; an administrator decides them (ADR-0019).
  const workspaceDir = path.join(dataDir, 'workspace');
  const changes = new ChangeRequestService({
    db,
    bus,
    audit,
    clock,
    log: log.child({ component: 'changes' }),
    dir: path.join(dataDir, 'changes'),
    pushInternal,
    redact: (text) => secrets.redact(text),
    secretSet: (name) => secrets.get(name) !== undefined,
    adapters: {
      mcp: mcpChangeAdapter({
        servers: () => config.mcp.servers,
        put: (id, entry) => putMcpServer(id, entry),
        setEnabled: (id, enabled) => setMcpEnabled(id, enabled),
        describe: (id) => {
          const s = mcp.get(id);
          if (!s) return 'not configured';
          return `${s.enabled ? s.state : 'disabled'}${s.state === 'running' ? ` with ${s.tools.length} tools` : ''}${s.error ? ` (${s.error})` : ''}`;
        },
      }),
      skill: skillChangeAdapter({
        get: (name) => skills.get(name),
        dirOf: (name) => skills.dirOf(name),
        install: (dir) => skills.install(dir),
        uninstall: (name) => skills.uninstall(name),
        setEnabled: (name, enabled) => setSkillEnabled(name, enabled),
        workspace: workspaceDir,
      }),
      plugin: pluginChangeAdapter({
        get: (id) => plugins.get(id),
        dirOf: (id) => plugins.dirOf(id),
        install: (dir, o) => plugins.install(dir, o),
        uninstall: async (id, o) => {
          await plugins.uninstall(id, o);
          await plugins.rescan(settingsOf);
        },
        enable: (id) => plugins.enable(id),
        disable: (id) => plugins.disable(id),
        config: (id) => config.plugins[id]?.config ?? {},
        setConfig: (id, cfg) => setPluginConfig(id, cfg),
        workspace: workspaceDir,
      }),
    },
  });
  for (const spec of changeTools(changes)) tools.register('core', spec);
  for (const spec of skillTools(skills)) tools.register('core', spec);
  for (const spec of memoryTools({ store: memory, index: memoryIndex, board, clock, timezone: tz, nativeType: config.memory.nativeTool })) tools.register('core', spec);
  await plugins.startAll();
  skills.rescan();
  const mcpReady = mcp.apply(config.mcp.servers).catch((err: unknown) => log.error({ err: errorMessage(err) }, 'MCP servers not applied'));

  main = new MainSession({
    maxImagesPerEvent: () => config.vision.maxImagesPerMessage,
    transcript,
    store,
    batches,
    usage,
    bus,
    provider,
    assembler: new ContextAssembler(segments, tools, exposure, () =>
      config.context.compaction.enabled ? { triggerTokens: config.context.compaction.triggerTokens, instructions: config.context.compaction.instructions } : null,
    ),
    dispatcher,
    log: log.child({ component: 'session' }),
    clock,
    // Persona hooks may set the round limits; read on every batch.
    rounds: {
      get soft() {
        return roundsNow().soft;
      },
      get hard() {
        return roundsNow().hard;
      },
    },
    backoffMs: config.session.backoffMs,
    effortFor: (level: Level) => effortOf('main', level),
    status: () => ({
      now: isoInZone(clock.now(), tz),
      phase: main.phase,
      pending: store.pendingCounts(),
      budget: budget.remainingPercent(),
      forks: forks.activeCount(),
      ...(chat.lastPlatform ? { lastChat: chat.lastPlatform } : {}),
    }),
    pushInternal,
    showsChatDrafts: (platform) => chat.showsDrafts(platform),
    board,
    handoff: new Handoff({
      provider,
      memory,
      sessionsDir: path.join(dataDir, 'sessions'),
      dataDir,
      log: log.child({ component: 'handoff' }),
      clock,
      timezone: tz,
      settings: () => config.context.handoff,
      hooks: () => persona.hooks,
      cheapEffort: () => effortOf('cheap'),
      redact: (text) => secrets.redact(text),
      onNotesUsage: (res, level) => {
        const now = clock.now();
        const rec = {
          at: new Date(now).toISOString(),
          atMs: now,
          provider: provider.id,
          model: res.model,
          role: 'cheap' as const,
          sessionId: 'main',
          level,
          ...res.usage,
          stopReason: res.stopReason,
          ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
        };
        usage.record(rec);
        bus.emit('usage.recorded', rec);
      },
    }),
    limits,
    prefixSalt: () => secretsEpoch(secrets),
    onHandoff: (r) => {
      // The conversation starts over here, so a new prefix costs nothing extra.
      applyPublishedIndex();
      sessions.upsert({
        id: 'main',
        kind: 'main',
        state: 'active',
        transcriptPath: path.relative(dataDir, r.transcript.file),
        createdAt: new Date(clock.now()).toISOString(),
      });
    },
    onBatchEnd: (stats) => {
      const hook = persona.hooks?.onBatchEnd;
      if (hook) void Promise.resolve(hook(stats)).catch((err: unknown) => log.warn({ err: errorMessage(err) }, 'persona onBatchEnd failed'));
    },
  });
  const dream = new DreamRunner({
    forks,
    kv: memoryKv,
    memory,
    bus,
    clock,
    timezone: tz,
    settings: () => config.memory.dream,
    budgetRefusal: () => budget.forkRefusal(4),
    onCompleted: publishIndex,
    notify: gateway,
    log: log.child({ component: 'dream' }),
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
    agingExempt: (cursor) => budget.isHeld(cursor),
  });
  const maintenance = new IdleMaintenance({
    main,
    bus,
    urgentPending: () => {
      const pending = store.pendingCounts();
      return pending[0] + pending[1] + pending[2];
    },
    paused: () => scheduler.paused !== null,
    budgetRefusal: () => budget.forkRefusal(4),
    settings: () => config.context.idleCompaction,
    cacheHorizonMs: () => provider.cacheHorizonMs?.('main'),
    clock,
    log: log.child({ component: 'maintenance' }),
    onTick: () => {
      if (indexPublishPending && !main.busy) applyPublishedIndex();
    },
    dream,
  });
  // An operator pause outlives restarts (it is shown in the status and the console).
  const schedulerKv = kvNamespace(kv, 'scheduler');
  const pausedBy = schedulerKv.get<string>('paused');
  if (typeof pausedBy === 'string') {
    scheduler.pause(pausedBy, { record: false });
    log.warn({ by: pausedBy }, 'event delivery is paused (since before the restart); resume it from the console or with protea scheduler resume');
  }
  const schedulerOps = {
    get paused() {
      return scheduler.paused;
    },
    pause: (by: string) => {
      const changed = scheduler.pause(by);
      if (changed) schedulerKv.set('paused', by);
      return changed;
    },
    resume: (by: string) => {
      const changed = scheduler.resume(by);
      if (changed) schedulerKv.delete('paused');
      return changed;
    },
    discard: (levels: readonly number[], by: string) => scheduler.discard(levels as Level[], by),
    cooldowns: () => scheduler.cooldowns(),
  };

  metrics = createMetrics({
    bus,
    store,
    clock,
    version: VERSION,
    runId,
    plugins: () => plugins.status(),
    mcp: () => mcp.status(),
    forks: () => forks.list(),
    budget: () => budget.status(),
    cacheHitRatio: (role) => usage.totalsSince(clock.now() - 86_400_000, { role }).cacheHitRatio,
    contextTokens,
    processMetrics: opts.processMetrics !== false,
    dbFile: path.join(dataDir, 'protea.db'),
  });

  // Control plane.
  const startControl = { ...config.control };
  const allowCidrs = startControl.allowCidrs.map((c) => parseCidr(c));
  if (allowCidrs.length > 0) log.info({ allowCidrs: startControl.allowCidrs }, 'the control plane only answers these addresses (and loopback)');
  const token = secrets.ensure(config.control.adminTokenSecret);
  if (token.generated) log.warn({ file: token.file }, 'generated an admin token for the control API');
  const ready = (): { ready: boolean; reasons: string[] } => {
    const reasons: string[] = [];
    const h = provider.health();
    if (!h.ready) reasons.push(`provider: ${h.problem ?? 'not ready'}`);
    for (const p of plugins.status()) if (p.enabled && p.state === 'failed') reasons.push(`plugin ${p.id}: ${p.error ?? 'failed'}`);
    for (const m of mcp.status()) if (m.enabled && m.state === 'failed') reasons.push(`mcp ${m.id}: ${m.error ?? 'failed'}`);
    for (const id of config.observability.requiredPlugins) {
      const p = plugins.get(id);
      if (!p || p.state !== 'running') reasons.push(`required plugin ${id}: ${p ? p.state : 'not installed'}`);
    }
    try {
      // SQLite must take a write lock (disk full, read-only volume and lock trouble show here).
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    } catch (err) {
      reasons.push(`database: ${errorMessage(err)}`);
    }
    if (scheduler.paused !== null) reasons.push(`event delivery paused by ${scheduler.paused}`);
    return { ready: reasons.length === 0, reasons };
  };

  // Hot configuration (docs/30-specs/04-config-reference.md §4).
  const HOT_SECTIONS = new Set(['owner', 'permissions', 'plugins', 'mcp', 'skills', 'context', 'budget', 'providers', 'chat']);
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
    owner.update(ownerIdentities(next.owner.identities));
    policy.update(next.permissions);
    budget.updateSettings(next.budget);
    segments.refresh();
    const ids = new Set([...Object.keys(prev.plugins), ...Object.keys(next.plugins), ...plugins.status().map((p) => p.id)]);
    for (const id of ids) {
      try {
        await plugins.applySettings(id, next.plugins[id]);
      } catch (err) {
        log.error({ plugin: id, err: errorMessage(err) }, 'plugin settings not applied');
      }
    }
    try {
      await mcp.apply(next.mcp.servers);
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'MCP settings not applied');
    }
    skills.rescan();
    if (JSON.stringify(prev.providers) !== JSON.stringify(next.providers)) {
      router?.refresh();
      log.info({ default: next.providers.default, roles: next.providers.roles, profiles: Object.keys(next.providers.profiles) }, 'model providers changed; they apply from the next request');
    }
    if (JSON.stringify(prev.chat) !== JSON.stringify(next.chat)) chat.refresh('chat settings changed');
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
  const putMcpServer = async (id: string, entry: Record<string, unknown> | null): Promise<void> => {
    const servers: Record<string, McpServerSettings> = { ...config.mcp.servers };
    if (entry === null) delete servers[id];
    else servers[id] = normalizeMcpServer(id, entry);
    config.mcp = { ...config.mcp, servers };
    persist(['mcp', 'servers', id], entry ?? undefined);
    await mcp.apply(servers);
  };
  const setMcpEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const cur = config.mcp.servers[id];
    if (!cur) throw new Error(`MCP server ${id} is not configured`);
    config.mcp = { ...config.mcp, servers: { ...config.mcp.servers, [id]: { ...cur, enabled } } };
    persist(['mcp', 'servers', id, 'enabled'], enabled);
    await mcp.apply(config.mcp.servers);
  };
  const setMcpAlwaysLoad = async (id: string, on: boolean): Promise<void> => {
    const cur = config.mcp.servers[id];
    if (!cur) throw new Error(`MCP server ${id} is not configured`);
    const { alwaysLoad: _was, ...rest } = cur;
    config.mcp = { ...config.mcp, servers: { ...config.mcp.servers, [id]: on ? { ...rest, alwaysLoad: true } : rest } };
    persist(['mcp', 'servers', id, 'alwaysLoad'], on ? true : undefined);
    await mcp.apply(config.mcp.servers);
  };
  const setSkillEnabled = (name: string, enabled: boolean): void => {
    const disabled = new Set(config.skills.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    config.skills = { ...config.skills, disabled: [...disabled].sort() };
    persist(['skills', 'disabled'], config.skills.disabled);
    skills.refreshCatalog();
  };
  // Configuration, secrets and policy views for the control API (docs/30-specs/05-control-api.md).
  const redactJson = <T>(value: T): T => JSON.parse(secrets.redact(JSON.stringify(value))) as T;
  const configOps = {
    get: () => ({
      config: redactJson(config) as unknown as Record<string, unknown>,
      layers: sources,
      sources: configSources(dataDir, env),
      hot: [...HOT_SECTIONS].sort(),
    }),
    patch: async (patch: Record<string, unknown>) => {
      const { changed } = patchConfigFile(dataDir, patch, env);
      // Apply now rather than waiting for the file watcher.
      await reloadConfig();
      const restartRequired = [...new Set(changed.map((k) => k.split('.')[0] as string))].filter((k) => !HOT_SECTIONS.has(k));
      return { changed, restartRequired };
    },
  };
  const secretOps = {
    list: () => secrets.list(),
    set: (name: string, value: string) => {
      secrets.set(name, value);
      router?.refresh();
      log.info({ secret: name }, 'secret written through the control API');
    },
    delete: (name: string) => {
      if (name === config.control.adminTokenSecret) throw new Error('the admin token cannot be deleted through the API; replace it instead');
      const r = secrets.delete(name);
      router?.refresh();
      if (r.removed) log.info({ secret: name }, 'secret deleted through the control API');
      return r;
    },
  };
  // Model providers for the control API (/api/providers): profiles in config.yaml, keys as secrets.
  const providerOperations = (): ProviderOps | undefined => {
    const r = router;
    if (!r) return undefined;
    const keyOf = (p: ProviderProfile) => {
      if (p.apiKeySecret === null) return { required: false, set: false, source: null };
      const e = secrets.list().find((x) => x.name === p.apiKeySecret);
      return { required: true, set: !!e, source: e?.source ?? null };
    };
    const view = (): ProvidersResponse => {
      const states = r.states();
      const h = r.health();
      return {
        default: config.providers.default,
        roles: config.providers.roles,
        profiles: states.map((st) => ({
          id: st.id,
          profile: st.profile as unknown as ProvidersResponse['profiles'][number]['profile'],
          endpoint: st.profile.protocol === 'echo' ? null : (st.profile.baseUrl ?? PROTOCOL_DEFAULT_URL[st.profile.protocol]),
          roles: st.roles,
          key: keyOf(st.profile),
          ready: st.health.ready,
          ...(st.health.problem !== undefined ? { problem: st.health.problem } : {}),
        })),
        presets: PROVIDER_PRESETS.map((x) => ({ ...x })),
        protocols: PROVIDER_PROTOCOLS.map((id) => ({ id, label: PROTOCOL_LABELS[id], defaultUrl: PROTOCOL_DEFAULT_URL[id] })),
        defaults: Object.fromEntries(PROVIDER_PROTOCOLS.map((id) => [id, defaultProfile(id, 'new')])) as unknown as ProvidersResponse['defaults'],
        ready: h.ready,
        ...(h.problem !== undefined ? { problem: h.problem } : {}),
      };
    };
    const apply = async (what: string, fields: Record<string, unknown>): Promise<ProvidersResponse> => {
      await reloadConfig();
      r.refresh();
      log.info(fields, what);
      return view();
    };
    return {
      view,
      put: async (id, req) => {
        if (!isProfileId(id)) throw new Error('a provider id is lower-case letters, digits and "-" (at most 32), starting with a letter');
        const full = normalizeProviderProfile(id, req.profile);
        replaceConfigValue(dataDir, ['providers', 'profiles', id], compactProfile(id, full), env);
        if (req.makeDefault || config.providers.default === null) replaceConfigValue(dataDir, ['providers', 'default'], id, env);
        let key: 'stored' | 'removed' | 'kept' = 'kept';
        if (full.apiKeySecret && typeof req.apiKey === 'string' && req.apiKey.trim() !== '') {
          secrets.set(full.apiKeySecret, req.apiKey.trim());
          key = 'stored';
        } else if (full.apiKeySecret && req.apiKey === null) {
          secrets.delete(full.apiKeySecret);
          key = 'removed';
        }
        return apply('provider profile saved', { provider: id, protocol: full.protocol, models: full.models, key });
      },
      remove: async (id) => {
        const p = config.providers.profiles[id];
        if (!p) throw new Error(`no provider "${id}"`);
        const others = Object.keys(config.providers.profiles).filter((x) => x !== id);
        // The next configured profile takes over as the default (never the built-in echo by itself).
        if (config.providers.default === id) replaceConfigValue(dataDir, ['providers', 'default'], others.find((x) => x !== 'echo') ?? null, env);
        for (const [role, pid] of Object.entries(config.providers.roles)) if (pid === id) replaceConfigValue(dataDir, ['providers', 'roles', role], undefined, env);
        replaceConfigValue(dataDir, ['providers', 'profiles', id], undefined, env);
        const shared = others.some((x) => config.providers.profiles[x]?.apiKeySecret === p.apiKeySecret);
        if (p.apiKeySecret === providerKeySecretName(id) && !shared) secrets.delete(p.apiKeySecret);
        return apply('provider profile removed', { provider: id });
      },
      select: async (req) => {
        if (req.default !== undefined) replaceConfigValue(dataDir, ['providers', 'default'], req.default, env);
        for (const [role, id] of Object.entries(req.roles ?? {})) replaceConfigValue(dataDir, ['providers', 'roles', role], id ?? undefined, env);
        return apply('provider selection changed', { ...(req.default !== undefined ? { default: req.default } : {}), ...(req.roles ? { roles: req.roles } : {}) });
      },
      probe: async (req, what) => {
        const saved = config.providers.profiles[req.id];
        const p = req.profile ? normalizeProviderProfile(isProfileId(req.id) ? req.id : 'new', req.profile) : saved;
        if (!p) throw new Error(`no provider "${req.id}"`);
        const res = await probeProfile(req.id, p, secrets, { what, ...(req.apiKey ? { apiKey: req.apiKey } : {}), ...(req.role ? { role: req.role } : {}) });
        log.info({ provider: req.id, protocol: p.protocol, what, ok: res.ok, ms: res.ms, ...(res.ok ? { model: res.model } : { kind: res.kind, status: res.status }) }, 'provider probe');
        return res;
      },
    };
  };

  // Console accounts. Until the first admin account exists, a one-time setup code (printed at
  // start, kept in secrets/PROTEA_SETUP_CODE) lets the console create it.
  const setupPending = accounts.setupRequired();
  if (setupPending && !secrets.get(SETUP_SECRET)) secrets.set(SETUP_SECRET, newSetupCode());
  if (!setupPending && secrets.list().some((x) => x.name === SETUP_SECRET && x.source === 'file')) secrets.delete(SETUP_SECRET);
  const authDeps: AuthDeps = {
    tokens: () => ({ adminToken: token.value, readonlyToken: secrets.get(startControl.readonlyTokenSecret) ?? null }),
    accounts,
    setup: {
      code: () => (accounts.setupRequired() ? (secrets.get(SETUP_SECRET) ?? null) : null),
      complete: (username) => {
        secrets.delete(SETUP_SECRET);
        audit.record({ kind: 'control_write', summary: `setup: admin account ${username} created`, owner: `console:${username}`, outcome: '201' });
        log.info({ username }, 'admin account created with the setup code; the code is no longer valid');
      },
    },
  };
  const providerOps = providerOperations();
  const wsEndpoint = createWebSocketEndpoint({
    bus,
    store,
    log: log.child({ component: 'ws' }),
    authenticate: (authorization, cookie) => authenticate(authDeps, authorization, cookie),
    runId: () => runId,
    logs: logRing,
    allowCidrs: () => allowCidrs,
  });
  const app = createControlApp({
    auth: authDeps,
    ...(providerOps ? { providers: providerOps } : {}),
    audit,
    metrics,
    // control is a cold section: these keep their start-up values until a restart.
    publicMetrics: () => startControl.publicMetrics,
    allowCidrs: () => allowCidrs,
    webDir: () => webDir(env, assets),
    batches,
    usage,
    scheduler: schedulerOps,
    schedules: {
      list: () => cronPlugin.infos(),
      get: (id) => cronPlugin.infoOf(id),
      create: (input) => cronPlugin.create(input),
      update: (id, patch) => cronPlugin.update(id, patch, 'operator'),
      remove: (id) => cronPlugin.removeBy(id, 'operator'),
      run: (id) => cronPlugin.runNow(id),
      preview: (input) => cronPlugin.preview(input),
      // A firing is its cron.tick event: the dedupe key starts with the schedule's id.
      runs: (id) =>
        (
          db
            .prepare("SELECT cursor, received_at, state, batch_id, dedupe_key FROM events WHERE source = 'cron' AND type = 'cron.tick' AND dedupe_key LIKE ? ESCAPE '\\' ORDER BY cursor DESC LIMIT 20")
            .all(`${id.replace(/[\\%_]/g, '\\$&')}@%`) as Array<{ cursor: number; received_at: string; state: ScheduleRun['state']; batch_id: string | null; dedupe_key: string }>
        ).map((r) => ({ cursor: r.cursor, at: r.received_at, state: r.state, ...(r.batch_id ? { batchId: r.batch_id } : {}), ...(r.dedupe_key.includes('@manual:') ? { manual: true } : {}) })),
    },
    config: configOps,
    secrets: secretOps,
    permissions: () => ({
      settings: config.permissions,
      mode: modes.info(),
      tools: tools.list().map((t) => ({ name: t.name, owner: t.owner, ...policy.decide(t) })),
    }),
    permissionModes: modes,
    budget: () => ({ settings: config.budget, status: budget.status() }),
    budgetRelease: (o) =>
      budget.release({
        by: o.by,
        ...(o.levels !== undefined ? { levels: o.levels as Level[] } : {}),
        ...(o.hardCap !== undefined ? { hardCap: o.hardCap } : {}),
        ...(o.hours !== undefined ? { hours: o.hours } : {}),
      }),
    logs: { ring: logRing, runsDir: path.join(dataDir, 'runs'), runId },
    backups: {
      dir: path.join(dataDir, 'backups'),
      list: () => listBackups(dataDir).map(({ path: _p, ...b }) => b),
      create: async (o) => {
        const r = await createBackup({ dataDir, version: VERSION, ...o });
        log.info({ path: r.path, files: r.manifest.files, bytes: r.manifest.bytes }, 'backup written');
        return { path: r.path, manifest: r.manifest as unknown as Record<string, unknown> };
      },
      git: async (url) => {
        const r = await gitBackup({ dataDir, url });
        log.info({ commit: r.commit, changed: r.changed }, 'git backup pushed');
        return r;
      },
    },
    diagnostics: {
      dir: diagnosticsDir(dataDir),
      list: () => listDiagnostics(diagnosticsDir(dataDir)).map(({ path: _p, ...d }) => d),
      create: async (o) => {
        const r = await createDiagnostics({
          dataDir,
          version: VERSION,
          redact: redactLine,
          ...o,
          live: {
            'status.json': status(),
            'config.effective.json': configOps.get(),
            'metrics.prom': metrics ? await metrics.render() : null,
            'plugins.json': plugins.status(),
            'mcp.json': mcp.status(),
            'forks.json': forks.list(),
            'budget.json': budget.status(),
          },
        });
        log.info({ path: r.path, bytes: r.bytes, files: r.manifest.files.length, ...r.manifest.options }, 'diagnostics bundle written');
        return { name: r.name, bytes: r.bytes, manifest: r.manifest as unknown as Record<string, unknown> };
      },
    },
    persona,
    onPersonaWrite: () => void reloadPersona(),
    bus,
    store,
    chat: outputs,
    batchSteps: (id) => redactValues(batchSteps(readBatchRecords(path.join(dataDir, 'sessions'), id), outputs.forBatch(id)), secrets),
    sessionContext: (id, page) => {
      const req = id === 'main' ? main.previewRequest() : forks.previewRequest(id);
      if (!req) return undefined;
      const lim = limits();
      return redactValues(
        describeRequest(id, req, {
          model: provider.modelFor(req.role),
          ownerOf: (name) => tools.get(name)?.owner,
          ...page,
          ...(id === 'main' ? { limits: { softTokens: lim.soft, hardTokens: lim.hard }, cacheHitRatio: lastMainUsage ? cacheHitRatio(lastMainUsage) : null } : {}),
        }),
        secrets,
      );
    },
    log: log.child({ component: 'control' }),
    transcript: () => main.currentTranscript,
    handoff: (reason) => main.requestHandoff(reason),
    memory: {
      store: memory,
      index: memoryIndex,
      board,
      dream,
      onWrite: (rel) => {
        audit.record({ kind: 'memory_write', summary: `/memories/${rel}`, owner: 'console:admin' });
        if (rel === 'INDEX.md') publishIndex();
      },
      onBoardWrite: (receipt) => audit.record({ kind: 'memory_write', summary: `board: ${receipt}`, owner: 'console:admin' }),
    },
    forks,
    plugins,
    approvals,
    changes,
    rescanPlugins: () => plugins.rescan(settingsOf),
    setPluginConfig,
    mcp,
    putMcpServer,
    setMcpEnabled,
    setMcpAlwaysLoad,
    skills,
    setSkillEnabled,
    status,
    ready,
    pushConsole: (req, senderKey) =>
      consolePlugin.receive(req.text, {
        senderKey,
        ...(req.level !== undefined ? { level: req.level } : {}),
        ...(req.trigger !== undefined ? { trigger: req.trigger } : {}),
        ...(req.tags !== undefined ? { tags: req.tags } : {}),
      }),
    pushChat: (req, senderKey) => webchatPlugin.receive(req.text, { senderKey, ...(req.trigger ? { trigger: req.trigger } : {}), ...(req.images ? { blobs: req.images } : {}), ...(req.answer ? { answer: req.answer } : {}) }),
    blobs,
    widgets,
    browserPreset: (o) =>
      browserPreset({
        dataDir,
        ...(o.noSandbox ? { noSandbox: true } : {}),
        ...(listenPort(config.control.listen) !== undefined ? { controlPort: listenPort(config.control.listen) as number } : {}),
        ...(env['PLAYWRIGHT_BROWSERS_PATH'] ? { browsersPath: env['PLAYWRIGHT_BROWSERS_PATH'] } : {}),
      }),
    browserAvailable: () => env['PROTEA_IMAGE'] === undefined || env['PROTEA_IMAGE'] === 'browser',
  });
  let server: ControlServer;
  try {
    server = await startControlServer(app, opts.listen ?? config.control.listen, { upgrade: wsEndpoint.handleUpgrade });
    controlUrl = server.url;
  } catch (err) {
    wsEndpoint.close();
    metrics.close();
    await mcp.stopAll();
    await plugins.stopAll();
    transcript.close();
    db.close();
    lock.release();
    throw err;
  }

  if (setupPending) {
    const code = secrets.get(SETUP_SECRET) ?? '';
    const where = config.control.publicUrl ?? server.url.replace('//0.0.0.0:', '//127.0.0.1:').replace('//[::]:', '//127.0.0.1:');
    const announce = opts.announce ?? (config.observability.logLevel === 'silent' ? null : (text: string) => void process.stdout.write(text));
    announce?.(setupBanner(where, code));
    log.warn({ file: path.join(dataDir, 'secrets', SETUP_SECRET) }, 'no admin account yet: open the console and create one with the setup code (printed once at start, also in the file)');
  }

  const waiting = Object.values(store.pendingCounts()).reduce((a, b) => a + b, 0);
  pushInternal({
    type: 'daemon.started',
    level: 4,
    trigger: 'piggyback',
    text: `Protea ${VERSION} started (run ${runId}); ${waiting} event(s) were waiting${main.needsResume() ? ' and an interrupted batch is resuming' : ''}.`,
  });
  scheduler.start();
  // The old conversation shows a reply tool that no longer exists; start the first one after the split without those examples.
  if (main.currentTranscript.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use' && b['name'] === 'con_send'))) {
    log.info('compacting the conversation once: it still uses the removed con_send tool');
    void main.requestHandoff('the reply tool changed to chat_send').catch((err: unknown) => log.warn({ err: errorMessage(err) }, 'could not compact the conversation after the chat split'));
  }
  forks.recover();
  forks.start();
  dream.start();
  maintenance.start();
  const unwatch = [
    watchPaths([{ path: dataDir, filter: (name) => name === 'config.yaml' }], () => void reloadConfig(), {
      onError: (err) => log.warn({ err: err.message }, 'config watcher error'),
    }),
    watchPaths([{ path: path.join(dataDir, 'plugins'), recursive: true }], () => void plugins.rescan(settingsOf), {
      debounceMs: 500,
      onError: (err) => log.warn({ err: err.message }, 'plugin directory watcher error'),
    }),
    watchPaths([{ path: path.join(dataDir, 'skills'), recursive: true }], () => skills.rescan(), {
      debounceMs: 300,
      onError: (err) => log.warn({ err: err.message }, 'skills directory watcher error'),
    }),
    // Persona edits (SOUL.md, OPERATING.md, USER.md, env prompt overrides, hooks) reach the prefix at the next request.
    watchPaths([{ path: personaDir, recursive: true }], () => void reloadPersona(), {
      debounceMs: 300,
      onError: (err) => log.warn({ err: err.message }, 'persona directory watcher error'),
    }),
    // The owner may edit memory files directly; keep the search index in step.
    watchPaths([{ path: memoryDir, recursive: true, filter: (name) => name === null || !path.basename(name).startsWith('.tmp-') }], () => {
      memoryIndex?.sync();
    }, {
      debounceMs: 500,
      onError: (err) => log.warn({ err: err.message }, 'memory directory watcher error'),
    }),
  ];
  const expiry = setInterval(() => {
    approvals.expireDue();
    modes.current();
  }, 60_000);
  expiry.unref();
  const sweepBlobs = (): void => {
    const days = config.vision.blobRetentionDays;
    if (days <= 0) return;
    try {
      const removed = blobs.sweep(days * 86_400_000);
      if (removed > 0) log.info({ removed }, 'expired images removed');
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'could not remove expired images');
    }
  };
  sweepBlobs();
  const blobSweep = setInterval(sweepBlobs, 3_600_000);
  blobSweep.unref();
  log.info(
    { url: server.url, dataDir, provider: router?.profileFor('main') ?? provider.id, model: provider.modelFor('main'), config: sources, providerReady: provider.health().ready },
    'daemon started',
  );

  let stopping: Promise<void> | null = null;
  const stop = (reason = 'stop requested'): Promise<void> => {
    stopping ??= (async () => {
      log.info({ reason }, 'stopping');
      const t0 = clock.now();
      const steps: Record<string, number> = {};
      const step = async (name: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
        const s0 = clock.now();
        try {
          await fn();
        } catch (err) {
          log.warn({ step: name, err: errorMessage(err) }, 'shutdown step failed');
        }
        steps[name] = clock.now() - s0;
      };
      const before = { phase: main.phase, batchId: main.currentBatchId, pending: store.pendingCounts(), forks: forks.activeCount() };
      for (const off of unwatch) off();
      clearInterval(expiry);
      clearInterval(blobSweep);
      maintenance.stop();
      dream.stop();
      pushInternal({ type: 'daemon.stopping', level: 4, trigger: 'store', text: `Daemon stopping: ${reason}.` });
      scheduler.drain();
      const graceMs = config.daemon.shutdown.graceMs;
      let finished = true;
      await step('drain', async () => {
        [finished] = await Promise.all([main.drain(graceMs), forks.stop(graceMs)]);
      });
      if (!finished) log.warn('the running batch was aborted at shutdown; it resumes on the next start');
      await step('mcp', () => mcp.stopAll());
      await step('plugins', () => plugins.stopAll());
      wsEndpoint.close();
      await step('server', () => server.close());
      try {
        writeShutdownReport(runDir, {
          at: new Date(clock.now()).toISOString(),
          reason,
          durationMs: clock.now() - t0,
          steps,
          before,
          batchFinished: finished,
          plugins: plugins.status().map((p) => ({ id: p.id, state: p.state, ...(p.error ? { error: p.error } : {}) })),
          mcp: mcp.status().map((m) => ({ id: m.id, state: m.state })),
          forks: forks.list().filter((f) => f.state === 'paused' || f.state === 'queued').map((f) => ({ id: f.id, state: f.state })),
        }, redactLine);
      } catch (err) {
        log.warn({ err: errorMessage(err) }, 'could not write shutdown.json');
      }
      metrics.close();
      budget.close();
      trail.close();
      main.currentTranscript.close();
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
    accounts,
    providers: router,
    dataDir,
    get config() {
      return config;
    },
    db,
    bus,
    store,
    gateway,
    get transcript() {
      return main.currentTranscript;
    },
    main,
    scheduler,
    plugins,
    approvals,
    audit,
    forks,
    budget,
    console: consolePlugin,
    webchat: webchatPlugin,
    chat,
    tools,
    mcp,
    skills,
    memory,
    memoryIndex,
    board,
    dream,
    maintenance,
    persona,
    mcpReady,
    runDir,
    logs: logRing,
    trail,
    log,
    redact: redactLine,
    status,
    reloadConfig,
    stop,
  };
}

/** Run until SIGTERM/SIGINT (the `protea serve` entry point). */
export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const daemon = await startDaemon(opts);
  // Crash reports go to <run>/crash/ (docs/10-architecture/15-observability.md §4). An uncaught
  // exception ends the process (the next start resumes the interrupted batch); a stray rejected
  // promise is reported and the daemon keeps running.
  process.on('uncaughtException', (err) => {
    const file = writeCrashReport(daemon.runDir, err, daemon.trail, { kind: 'uncaughtException' }, daemon.redact);
    daemon.log.fatal({ err: errorMessage(err), report: file }, 'uncaught exception; exiting');
    setTimeout(() => process.exit(1), 100).unref();
  });
  process.on('unhandledRejection', (reason) => {
    const file = writeCrashReport(daemon.runDir, reason, daemon.trail, { kind: 'unhandledRejection' }, daemon.redact);
    daemon.log.error({ err: errorMessage(reason), report: file }, 'unhandled promise rejection');
  });
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
