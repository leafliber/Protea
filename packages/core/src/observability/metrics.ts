import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  FORK_STATES,
  LEVELS,
  MODEL_ROLES,
  PLUGIN_STATES,
  isForkTerminal,
  type BudgetStatus,
  type ForkInfo,
  type Level,
  type McpServerStatus,
  type ModelRole,
  type PluginStatus,
} from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { EventStore } from '../events/store.js';
import type { Clock } from '../util/time.js';

export interface MetricsOptions {
  bus: Bus;
  store: EventStore;
  clock: Clock;
  version: string;
  runId: string;
  plugins: () => PluginStatus[];
  mcp: () => McpServerStatus[];
  forks: () => ForkInfo[];
  budget: () => BudgetStatus;
  /** Rolling 24 h cache hit ratio for a model role (null without calls). */
  cacheHitRatio: (role: ModelRole) => number | null;
  /** Estimated tokens of the main conversation. */
  contextTokens: () => number;
  /** Node.js process metrics (memory, CPU, event loop); off in tests that create many registries. */
  processMetrics?: boolean;
}

export interface Metrics {
  registry: Registry;
  /** Feed from ToolDispatcher.observe. */
  toolCall(name: string, ms: number, failed: boolean): void;
  /** Prometheus text exposition. */
  render(): Promise<string>;
  contentType: string;
  close(): void;
}

/**
 * The metrics of docs/10-architecture/15-observability.md §3. Counters follow bus records;
 * gauges are read when Prometheus scrapes. The registry is private to the daemon.
 */
export function createMetrics(o: MetricsOptions): Metrics {
  const registry = new Registry();
  if (o.processMetrics !== false) collectDefaultMetrics({ register: registry });
  const reg = { registers: [registry] };

  new Gauge({ name: 'protea_info', help: 'Protea build and run', labelNames: ['version', 'run'], ...reg }).set({ version: o.version, run: o.runId }, 1);

  const events = new Counter({ name: 'protea_events_total', help: 'Events settled, by source, level and outcome', labelNames: ['source', 'level', 'outcome'], ...reg });
  new Gauge({
    name: 'protea_events_pending',
    help: 'Pending events by effective level',
    labelNames: ['level'],
    ...reg,
    collect() {
      const counts = o.store.pendingCounts();
      for (const l of LEVELS) this.set({ level: String(l) }, counts[l]);
    },
  });
  const wait = new Histogram({
    name: 'protea_batch_wait_seconds',
    help: 'Time from an event being stored to its delivery in a batch',
    labelNames: ['level'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600, 14400],
    ...reg,
  });
  const preemptions = new Counter({ name: 'protea_preemptions_total', help: 'Preemptions and interrupts', labelNames: ['source', 'kind'], ...reg });
  const aging = new Counter({ name: 'protea_aging_promotions_total', help: 'Events promoted to flush by aging', labelNames: ['level'], ...reg });
  const turns = new Counter({ name: 'protea_turns_total', help: 'Finished batches (main) and forks', labelNames: ['session_kind', 'end_reason'], ...reg });
  const turnDuration = new Histogram({
    name: 'protea_turn_duration_seconds',
    help: 'Duration of a batch (main) or a fork',
    labelNames: ['session_kind'],
    buckets: [0.5, 1, 2.5, 5, 10, 20, 40, 80, 160, 320, 640, 1800],
    ...reg,
  });
  const tokens = new Counter({ name: 'protea_model_tokens_total', help: 'Model tokens by role and kind', labelNames: ['role', 'kind'], ...reg });
  const cost = new Counter({ name: 'protea_model_cost_usd_total', help: 'Model cost in USD by attributed level', labelNames: ['level'], ...reg });
  new Gauge({
    name: 'protea_cache_hit_ratio',
    help: 'Rolling 24 h prompt cache hit ratio by role',
    labelNames: ['role'],
    ...reg,
    collect() {
      this.reset();
      for (const role of MODEL_ROLES) {
        const r = o.cacheHitRatio(role);
        if (r !== null) this.set({ role }, r);
      }
    },
  });
  new Gauge({
    name: 'protea_budget_remaining_ratio',
    help: 'Remaining share of each level budget pool (pools with a limit only)',
    labelNames: ['level'],
    ...reg,
    collect() {
      this.reset();
      const b = o.budget();
      for (const l of LEVELS) {
        const used = b.levels[l].usedRatio;
        if (used !== null) this.set({ level: String(l) }, Math.max(0, 1 - used));
      }
    },
  });
  new Gauge({
    name: 'protea_plugin_state',
    help: 'Plugin state (1 for the current state)',
    labelNames: ['plugin', 'state'],
    ...reg,
    collect() {
      this.reset();
      for (const p of o.plugins()) for (const s of PLUGIN_STATES) this.set({ plugin: p.id, state: s }, p.state === s ? 1 : 0);
    },
  });
  const restarts = new Counter({ name: 'protea_plugin_restarts_total', help: 'Supervised plugin restarts', labelNames: ['plugin'], ...reg });
  const toolCalls = new Counter({ name: 'protea_tool_calls_total', help: 'Tool calls by outcome', labelNames: ['tool', 'outcome'], ...reg });
  const toolDuration = new Histogram({
    name: 'protea_tool_duration_seconds',
    help: 'Tool call duration',
    labelNames: ['tool'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120],
    ...reg,
  });
  new Gauge({
    name: 'protea_mcp_server_up',
    help: 'MCP server running (1) or not (0)',
    labelNames: ['server'],
    ...reg,
    collect() {
      this.reset();
      for (const m of o.mcp()) this.set({ server: m.id }, m.state === 'running' ? 1 : 0);
    },
  });
  new Gauge({
    name: 'protea_forks_active',
    help: 'Forks that have not ended, by state',
    labelNames: ['state'],
    ...reg,
    collect() {
      const counts = new Map<string, number>();
      for (const f of o.forks()) if (!isForkTerminal(f.state)) counts.set(f.state, (counts.get(f.state) ?? 0) + 1);
      for (const s of FORK_STATES) if (!isForkTerminal(s)) this.set({ state: s }, counts.get(s) ?? 0);
    },
  });
  new Gauge({
    name: 'protea_context_tokens',
    help: 'Estimated tokens in a conversation',
    labelNames: ['session'],
    ...reg,
    collect() {
      this.set({ session: 'main' }, o.contextTokens());
    },
  });

  // —— Counters that follow the bus ——
  const levelOf = new Map<number, Level>();
  const batchStart = new Map<string, number>();
  const restartsSeen = new Map<string, number>();
  const forkEnded = new Set<string>();
  const unsubs = [
    o.bus.on('event.stored', (e) => {
      levelOf.set(e.cursor, e.effLevel);
    }),
    o.bus.on('event.settled', (s) => {
      for (const ev of s.events) {
        const level = levelOf.get(ev.cursor) ?? o.store.get(ev.cursor)?.effLevel;
        levelOf.delete(ev.cursor);
        events.inc({ source: ev.source, level: level === undefined ? 'unknown' : String(level), outcome: s.outcome });
      }
    }),
    o.bus.on('batch.started', (b) => {
      const now = o.clock.now();
      batchStart.set(b.batchId, now);
      for (const c of b.cursors) {
        const e = o.store.get(c);
        if (e) wait.observe({ level: String(e.effLevel) }, Math.max(0, (now - Date.parse(e.receivedAt)) / 1000));
      }
    }),
    o.bus.on('batch.extended', (b) => {
      const now = o.clock.now();
      for (const c of b.cursors) {
        const e = o.store.get(c);
        if (e) wait.observe({ level: String(e.effLevel) }, Math.max(0, (now - Date.parse(e.receivedAt)) / 1000));
      }
    }),
    o.bus.on('batch.ended', (b) => {
      turns.inc({ session_kind: 'main', end_reason: b.endReason });
      const t0 = batchStart.get(b.batchId);
      batchStart.delete(b.batchId);
      if (t0 !== undefined) turnDuration.observe({ session_kind: 'main' }, (o.clock.now() - t0) / 1000);
    }),
    o.bus.on('fork.changed', (f) => {
      if (!isForkTerminal(f.state) || forkEnded.has(f.id)) return;
      forkEnded.add(f.id);
      turns.inc({ session_kind: 'fork', end_reason: f.state });
      if (f.endedAt) turnDuration.observe({ session_kind: 'fork' }, Math.max(0, (Date.parse(f.endedAt) - Date.parse(f.createdAt)) / 1000));
    }),
    o.bus.on('scheduler.action', (a) => {
      if (a.kind === 'preempt' || a.kind === 'interrupt') preemptions.inc({ source: a.source, kind: a.kind });
      else if (a.kind === 'aged') {
        for (const c of a.cursors) {
          const level = levelOf.get(c) ?? o.store.get(c)?.effLevel;
          aging.inc({ level: level === undefined ? 'unknown' : String(level) });
        }
      }
    }),
    o.bus.on('usage.recorded', (u) => {
      tokens.inc({ role: u.role, kind: 'input' }, u.inputTokens);
      tokens.inc({ role: u.role, kind: 'output' }, u.outputTokens);
      tokens.inc({ role: u.role, kind: 'cache_read' }, u.cacheReadTokens);
      tokens.inc({ role: u.role, kind: 'cache_write' }, u.cacheWriteTokens);
      if (u.costUsd !== undefined) cost.inc({ level: u.level === undefined ? 'none' : String(u.level) }, u.costUsd);
    }),
    o.bus.on('plugin.changed', (p) => {
      const prev = restartsSeen.get(p.id) ?? 0;
      const now = p.restarts ?? 0;
      if (now > prev) restarts.inc({ plugin: p.id }, now - prev);
      restartsSeen.set(p.id, now);
    }),
  ];
  for (const p of o.plugins()) restartsSeen.set(p.id, p.restarts ?? 0);

  return {
    registry,
    toolCall(name, ms, failed) {
      toolCalls.inc({ tool: name, outcome: failed ? 'error' : 'ok' });
      toolDuration.observe({ tool: name }, ms / 1000);
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
    close() {
      for (const u of unsubs) u();
      registry.clear();
    },
  };
}
