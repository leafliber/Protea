import fs from 'node:fs';
import path from 'node:path';
import type { EventEnvelope, Level } from '@protea/protocol';
import {
  RecordedProvider,
  SecretStore,
  createLogger,
  latestRecording,
  loadConfig,
  newBatchId,
  offlineConfigYaml,
  readRecording,
  readReplayBatches,
  recordedToolResults,
  stableJson,
  type GuardDecision,
  type Provider,
  type ToolGuard,
} from '@protea/core';
import { startDaemon } from './daemon.js';

/**
 * Offline replay (docs/10-architecture/03-event-store-and-bus.md §7): a range of events goes
 * again, in the original order and batch boundaries, to a separate main session in its own
 * data directory. The production database is only read. No plugin, MCP server or side effect
 * runs: every tool call is answered from the recorded transcript (or a stub); read-only Core
 * tools run against the replay's own copy of memory and events.
 */
export interface ReplayOptions {
  dataDir: string;
  from?: number;
  to?: number;
  /** recorded: responses from a run's provider.jsonl (free, deterministic); echo; config: the configured model (costs money). */
  provider: 'recorded' | 'echo' | 'config';
  /** Run whose recording to play (default: the newest run that has one). */
  run?: string;
  /** Replay directory (default <data>/replays/<time>). */
  out?: string;
  env?: NodeJS.ProcessEnv;
  onBatch?: (info: { index: number; total: number; batchId: string; events: number }) => void;
}

export interface ReplayReport {
  out: string;
  transcript: string;
  batches: number;
  events: number;
  /** Events in the range that never reached the model (stored, discarded, …). */
  skipped: number;
  modelCalls: number;
  tools: { recorded: number; ran: number; stubbed: number };
  /** recorded provider: responses left over (the replay took a different path) per role. */
  remaining?: Record<string, number>;
  recording?: string;
}

export async function replay(o: ReplayOptions): Promise<ReplayReport> {
  const env = o.env ?? process.env;
  const dataDir = path.resolve(o.dataDir);
  const dbFile = path.join(dataDir, 'protea.db');
  if (!fs.existsSync(dbFile)) throw new Error(`${dataDir} has no protea.db`);
  const out = path.resolve(o.out ?? path.join(dataDir, 'replays', new Date().toISOString().replace(/[:.]/g, '-')));
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  const offline = path.join(out, 'data');
  fs.mkdirSync(offline, { recursive: true });

  // 1. Events and their original batches (the production database is only read).
  const { batches, skipped } = readReplayBatches(dbFile, o.from, o.to);

  // 2. The offline data directory: the same persona, memory and skills; nothing that reaches out.
  for (const item of ['persona', 'memory', 'skills', 'overrides']) {
    const src = path.join(dataDir, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(offline, item), { recursive: true });
  }
  const prodConfig = path.join(dataDir, 'config.yaml');
  fs.writeFileSync(path.join(offline, 'config.yaml'), offlineConfigYaml(fs.existsSync(prodConfig) ? fs.readFileSync(prodConfig, 'utf8') : null, { echo: o.provider === 'echo' }));
  // Production overrides (PROTEA_PLUGINS__…, PROTEA_CONTROL__…) do not apply to the replay.
  const replayEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('PROTEA_') || k === 'PROTEA_ASSETS_DIR' || k === 'PROTEA_WEB_DIR') replayEnv[k] = v;

  let provider: Provider | undefined;
  let recorded: RecordedProvider | undefined;
  let recording: string | undefined;
  if (o.provider === 'recorded') {
    recording = o.run ? path.join(dataDir, 'runs', o.run, 'provider.jsonl') : latestRecording(path.join(dataDir, 'runs'));
    if (!recording || !fs.existsSync(recording)) {
      throw new Error('no recording found: set observability.recordProvider to responses (or full), let the daemon run, then replay with --run <id>');
    }
    recorded = new RecordedProvider(readRecording(recording));
    provider = recorded;
  } else if (o.provider === 'config') {
    // The providers' keys are handed over in memory, never copied into the replay directory.
    const names = Object.values(loadConfig(dataDir, env).config.providers.profiles).flatMap((p) => (p.apiKeySecret ? [p.apiKeySecret] : []));
    for (const name of new Set(names)) {
      const key = new SecretStore(path.join(dataDir, 'secrets'), env).get(name);
      if (key) replayEnv[`PROTEA_SECRET_${name}`] = key;
    }
  }

  // 3. Tool calls are answered from the production transcripts.
  const { byId, byInput } = recordedToolResults(path.join(dataDir, 'sessions'));
  const tools = { recorded: 0, ran: 0, stubbed: 0 };
  const guard: ToolGuard = {
    check(def, use): GuardDecision {
      const rec = byId.get(use.id) ?? byInput.get(`${use.name}:${stableJson(use.input)}`)?.shift();
      if (rec) {
        tools.recorded++;
        return { action: 'block', policy: 'allow', rule: 'replay', text: rec.text, isError: rec.isError };
      }
      if (def.owner === 'core' && def.flags?.readOnly) {
        tools.ran++;
        return { action: 'run', policy: 'allow', rule: 'replay', audit: false };
      }
      tools.stubbed++;
      return { action: 'block', policy: 'allow', rule: 'replay', text: `[replay] ${use.name} was not run: this offline replay has no recorded result for the call.`, isError: true };
    },
    after() {},
  };

  // 4. Deliver the batches one by one with the scheduler paused.
  const d = await startDaemon({
    dataDir: offline,
    env: replayEnv,
    listen: '127.0.0.1:0',
    processMetrics: false,
    toolGuard: guard,
    logger: createLogger({ level: 'silent', file: path.join(out, 'replay.log.jsonl') }),
    ...(provider ? { provider } : {}),
  });
  let modelCalls = 0;
  const offUsage = d.bus.on('usage.recorded', () => {
    modelCalls++;
  });
  let transcript = d.transcript.file;
  try {
    d.scheduler.pause('replay', { record: false });
    for (const [i, b] of batches.entries()) {
      const envelopes: EventEnvelope[] = b.events.map(({ cursor: _c, ...ev }) => d.store.append(ev).envelope);
      const id = newBatchId();
      d.store.markDelivering(
        envelopes.map((e) => e.cursor),
        id,
      );
      o.onBatch?.({ index: i + 1, total: batches.length, batchId: b.id, events: envelopes.length });
      const level = b.level ?? (Math.min(...envelopes.map((e) => e.effLevel)) as Level);
      await d.main.deliver({ id, level, reason: 'window', events: envelopes.map((e) => ({ ...e, state: 'delivering', batchId: id })) });
      // A handoff may follow a batch; the next one waits for it.
      while (d.main.busy) await new Promise((r) => setTimeout(r, 20));
    }
    transcript = d.transcript.file;
  } finally {
    offUsage();
    await d.stop('replay finished');
  }
  return {
    out,
    transcript,
    batches: batches.length,
    events: batches.reduce((n, b) => n + b.events.length, 0),
    skipped,
    modelCalls,
    tools,
    ...(recorded ? { remaining: recorded.remaining() } : {}),
    ...(recording ? { recording } : {}),
  };
}
