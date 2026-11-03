import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventInput, Level } from '@protea/protocol';
import {
  BatchRepo,
  BudgetTracker,
  Bus,
  ContextAssembler,
  EventStore,
  ForkManager,
  InprocPluginHost,
  KvRepo,
  MainSession,
  OwnerRegistry,
  Scheduler,
  ScriptedProvider,
  SessionRepo,
  ToolDispatcher,
  ToolRegistry,
  Transcript,
  UsageRepo,
  defaultConfig,
  forkTools,
  kernelTools,
  openDatabase,
  reconcileDeliveries,
  silentLogger,
  systemClock,
  textReply,
  type BudgetSettings,
  type ForkSchedulerSettings,
  type LevelSettings,
  type PreemptStormSettings,
  type Provider,
  type ScriptStep,
  type ToolSpec,
} from '../src/index.js';

export function tmpDir(prefix = 'protea-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const FAST_LEVELS: Record<Level, LevelSettings> = {
  0: { debounceMs: 0, maxWaitMs: 0 },
  1: { debounceMs: 20, maxWaitMs: 0 },
  2: { debounceMs: 30, maxWaitMs: 0 },
  3: { debounceMs: 40, maxWaitMs: 0 },
  4: { debounceMs: null, maxWaitMs: 0 },
};

export interface HarnessOptions {
  dir?: string;
  steps?: ScriptStep[];
  provider?: Provider;
  levels?: Record<Level, LevelSettings>;
  rounds?: { soft: number; hard: number };
  backoffMs?: number[];
  extraTools?: ToolSpec<never>[];
  start?: boolean;
  preemptStorm?: PreemptStormSettings;
  forks?: Partial<ForkSchedulerSettings>;
  budget?: Partial<BudgetSettings>;
  outputTap?: (delta: string) => void;
}

/** A Core assembled the way the daemon does it, minus HTTP, with a scripted provider. */
export function makeHarness(opts: HarnessOptions = {}) {
  const dir = opts.dir ?? tmpDir();
  const log = silentLogger();
  const listenerErrors: unknown[] = [];
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  const bus = new Bus((_t, err) => listenerErrors.push(err));
  const store = new EventStore(db, bus, { runId: 'test-run', clock: systemClock });
  const batches = new BatchRepo(db);
  const usage = new UsageRepo(db);
  const kv = new KvRepo(db);
  const discarded: Record<string, unknown>[] = [];
  const { transcript, report } = Transcript.open(path.join(dir, 'main.jsonl'), { onDiscarded: (r) => discarded.push(r) });
  const recovery = reconcileDeliveries(store, transcript);
  const owner = new OwnerRegistry([
    { plugin: 'console', senderKey: '*' },
    { plugin: 'test', senderKey: 'test:owner' },
  ]);
  const tools = new ToolRegistry();
  const plugins = new InprocPluginHost({ store, bus, owner, kv, tools, log, clock: systemClock, dataDir: dir, timezone: 'UTC' });
  const provider = opts.provider ?? new ScriptedProvider(opts.steps ?? [() => textReply('ok')]);
  const pushInternal = (input: Parameters<InprocPluginHost['pushInternal']>[0]): void => {
    plugins.pushInternal(input);
  };
  const defaults = defaultConfig();
  const dispatcher = new ToolDispatcher(tools, log);
  const sessions = new SessionRepo(db);
  const forks = new ForkManager({
    dir: path.join(dir, 'forks'),
    dataDir: dir,
    sessions,
    usage,
    bus,
    provider,
    tools,
    dispatcher,
    log,
    clock: systemClock,
    settings: { ...defaults.scheduler.forks, ...opts.forks },
    backoffMs: opts.backoffMs ?? [5, 5],
    effortFor: () => 'high',
    system: () => [{ id: 'runtime', text: 'You are a test fork.' }],
    pushInternal,
  });
  const budget = new BudgetTracker({
    usage,
    settings: { ...defaults.budget, ...opts.budget },
    bus,
    log,
    clock: systemClock,
    pushInternal,
  });

  const outputs: string[] = [];
  const say: ToolSpec<{ text: string }> = {
    name: 'say',
    description: 'Say something.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
    flags: { barrierAfter: true },
    handler: (i) => {
      outputs.push(i.text);
      return 'said';
    },
  };
  const idle: ToolSpec<Record<string, never>> = {
    name: 'idle',
    description: 'End the turn.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    flags: { endsTurn: true },
    handler: () => 'ok',
  };
  tools.register('core', idle);
  const kernel = kernelTools({ store, status: () => { throw new Error('self_status is not available in tests'); } });
  for (const t of kernel.filter((k) => k.name.startsWith('events_'))) tools.register('core', t);
  for (const t of forkTools(forks, { maxTurns: defaults.scheduler.forks.maxTurns })) tools.register('core', t);
  tools.register('test', say);
  for (const t of opts.extraTools ?? []) tools.register('test', t);

  const assembler = new ContextAssembler({ segments: () => [{ id: 'identity', text: 'You are a test assistant.' }] }, tools);
  const main: MainSession = new MainSession({
    transcript,
    store,
    batches,
    usage,
    bus,
    provider,
    assembler,
    dispatcher,
    log,
    clock: systemClock,
    rounds: opts.rounds ?? { soft: 12, hard: 30 },
    backoffMs: opts.backoffMs ?? [5, 5],
    effortFor: (l) => (l <= 1 ? 'medium' : 'high'),
    status: () => ({ now: '2026-11-03T00:00:00Z', phase: main.phase, pending: store.pendingCounts() }),
    pushInternal,
    ...(opts.outputTap ? { outputTap: opts.outputTap } : {}),
  });
  const scheduler = new Scheduler({
    store,
    bus,
    main,
    batches,
    levels: opts.levels ?? FAST_LEVELS,
    preemptStorm: opts.preemptStorm ?? defaults.scheduler.preemptStorm,
    log,
    clock: systemClock,
    pushInternal,
  });
  if (opts.start !== false) {
    scheduler.start();
    forks.recover();
    forks.start();
  }

  let seq = 0;
  const push = (input: Partial<EventInput> & { text: string }, source = 'test', maxLevel: Level = 1) =>
    plugins.push(
      { source, maxLevel },
      {
        type: 'test.message',
        ts: new Date().toISOString(),
        level: 1,
        trigger: 'flush',
        senderKey: 'test:owner',
        dedupeKey: `k${Date.now()}-${++seq}`,
        ...input,
      },
    );

  const idleNow = (): boolean => !main.busy && !scheduler.isDue;
  return {
    dir,
    db,
    bus,
    store,
    batches,
    usage,
    transcript,
    report,
    recovery,
    discarded,
    tools,
    plugins,
    provider,
    main,
    scheduler,
    forks,
    budget,
    sessions,
    outputs,
    listenerErrors,
    push,
    idle: (timeoutMs = 5000) => waitFor(idleNow, timeoutMs, 'idle'),
    close: async (drainMs = 1000) => {
      scheduler.drain();
      await Promise.all([main.drain(drainMs), forks.stop(drainMs)]);
      transcript.close();
      db.close();
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;

export function defaultLevels(): Record<Level, LevelSettings> {
  return defaultConfig().scheduler.levels;
}
