/** Control API request/response shapes (docs/30-specs/05-control-api.md). */
import type { EventEnvelope, Level, TerminalOutcome, Trigger } from './events.js';
import type { PluginState } from './plugin.js';
import type { BatchEndReason, BatchReason, CancelKind, ForkState, ModelRole, RunPhase } from './session.js';

/** M5: who a control API request acts as. `readonly` may only read (and never memory, persona or secrets). */
export type ControlRole = 'admin' | 'readonly';

export interface PushEventRequest {
  text: string;
  level?: Level;
  trigger?: Trigger;
  tags?: string[];
}

export interface PushEventResponse {
  cursor: number;
  effectiveLevel: Level;
  effectiveTrigger: Trigger;
  deduped: boolean;
  warnings: string[];
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** cache_read / (input + cache_read + cache_write); null when no calls. */
  cacheHitRatio: number | null;
}

export interface PluginStatus {
  id: string;
  kind: string;
  state: PluginState;
  /** Operator intent (`plugins.<id>.enabled`); a failed start does not change it. */
  enabled: boolean;
  /** `inproc` (built into the daemon), `builtin` (shipped out-of-process) or `data` (installed into the data volume). */
  origin: 'inproc' | 'builtin' | 'data';
  version?: string;
  tools: string[];
  pid?: number;
  /** Resident memory of the plugin process and its children at the last sample (out-of-process plugins). */
  memoryBytes?: number;
  restarts?: number;
  error?: string;
}

export type McpServerState = PluginState | 'auth_required';

export interface McpToolInfo {
  /** Name the model sees: `mcp__<server>__<tool>`. */
  name: string;
  /** The server's own name for the tool. */
  mcpName: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  /** Excluded by `tools.allow` / `tools.deny`. */
  filtered?: boolean;
}

export interface McpServerStatus {
  id: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  state: McpServerState;
  enabled: boolean;
  trust: 'low' | 'normal' | 'high';
  /** `config` (mcp.servers) or `plugin` (a `kind: mcp` plugin directory). */
  origin: 'config' | 'plugin';
  server?: { name: string; version: string };
  tools: string[];
  prompts: number;
  resources: boolean;
  pid?: number;
  /** Resident memory of the server process and its children at the last sample (stdio servers). */
  memoryBytes?: number;
  restarts?: number;
  error?: string;
  /** Pending OAuth authorization: open this URL to grant access. */
  authorizeUrl?: string;
  /** Mean latency of the recent tool calls (ms). */
  avgLatencyMs?: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** builtin (shipped), user (data/skills), plugin (a plugin's skills/), mcp (an MCP prompt, read-only). */
  origin: 'builtin' | 'user' | 'plugin' | 'mcp';
  owner?: string;
  version?: string;
  enabled: boolean;
  /** Valid and shown in the catalog (enabled, and its required tools exist). */
  listed: boolean;
  errors: string[];
  warnings: string[];
  allowedTools: string[];
  requiresTools: string[];
  level?: Level;
  loads: number;
  lastLoadedAt?: string;
}

export interface ApprovalInfo {
  id: string;
  tool: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'used';
  summary: string;
  reason?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface StatusResponse {
  runId: string;
  version: string;
  startedAt: string;
  uptimeSec: number;
  phase: RunPhase;
  batchId: string | null;
  pending: Record<Level, number>;
  provider: { id: string; mainModel: string; ready: boolean; problem?: string };
  plugins: PluginStatus[];
  mcp: McpServerStatus[];
  skills: { listed: number; rejected: number };
  /** Tools sent to the model, and how many of them sit behind tool search. */
  tools: { total: number; deferred: number };
  /**
   * M4: the main conversation's size. `estimatedTokens` is the last response's usage plus an
   * estimate of what came after; a handoff starts when it passes `softTokens` at a batch start or `hardTokens` anytime.
   */
  context: { transcript: string; handoffs: number; estimatedTokens: number; softTokens: number; hardTokens: number };
  /** M4: files in the memory directory, and whether persona hooks are loaded (or why not). */
  memory: { files: number };
  persona: { hooks: boolean; problem?: string };
  usage24h: UsageTotals;
  /** M5: delivery paused by the operator (who), and sources in preemption cooldown. */
  scheduler: { paused: string | null; cooldowns: Array<{ source: string; untilMs: number }> };
  /** Non-terminal forks first, then the most recently ended ones. */
  forks: ForkInfo[];
  budget: BudgetStatus;
}

export interface ForkInfo {
  id: string;
  state: ForkState;
  level: Level;
  model: ModelRole;
  goal: string;
  rounds: number;
  createdAt: string;
  endedAt?: string;
  pauseReason?: string;
  summary?: string;
  error?: string;
}

export interface LevelBudget {
  /** Rolling 24 h spend attributed to this level. */
  spentUsd: number;
  tokens: number;
  /** null when the pool is unlimited. */
  limitUsd: number | null;
  usedRatio: number | null;
  /** Events whose delivery the budget changed (L2 → piggyback, L3/L4 → store) and that are still waiting. */
  held?: number;
  /** The owner lifted enforcement for this level until then. */
  releasedUntil?: string;
}

export interface BudgetStatus {
  /** `budget.enforce`: exhausted pools change how new events are scheduled. */
  enforced: boolean;
  dailyUsd: number | null;
  /** Global cap over the rolling 24 h (only L0/L1 are delivered past it); null: none. */
  hardDailyUsd: number | null;
  /** Total spend over the rolling 24 h. */
  spentUsd: number;
  hardCapReached: boolean;
  hardCapReleasedUntil?: string;
  levels: Record<Level, LevelBudget>;
}

/** Scheduling interventions, all of which are also recorded as internal events. */
export type SchedulerAction =
  | { kind: CancelKind; cursor: number; source: string; level: Level; batchId: string; batchLevel: Level; phase: RunPhase }
  | { kind: 'aged'; cursors: number[] }
  | { kind: 'storm_cooldown'; source: string; untilMs: number }
  | { kind: 'fork_yield'; forkIds: string[]; batchId: string }
  | { kind: 'fork_resume'; forkIds: string[] }
  /** M5: operator interventions through the control API. */
  | { kind: 'paused' | 'resumed'; by: string }
  | { kind: 'discarded'; cursors: number[]; levels: Level[]; by: string };

export interface BatchStartedData {
  batchId: string;
  level: Level;
  reason: BatchReason;
  cursors: number[];
}

export type StreamMessage =
  | { topic: 'event'; data: EventEnvelope }
  | { topic: 'settled'; data: { cursors: number[]; outcome: TerminalOutcome; batchId?: string } }
  | { topic: 'phase'; data: { phase: RunPhase; batchId?: string; round?: number } }
  | { topic: 'batch.started'; data: BatchStartedData }
  | { topic: 'batch.extended'; data: { batchId: string; cursors: number[]; level: Level } }
  | { topic: 'batch.ended'; data: { batchId: string; endReason: BatchEndReason; rounds: number } }
  | { topic: 'output'; data: { plugin: string; channel?: string; text: string; at: string } }
  | { topic: 'scheduler'; data: SchedulerAction }
  | { topic: 'fork'; data: ForkInfo }
  | { topic: 'mcp'; data: McpServerStatus }
  | { topic: 'skills'; data: { names: string[] } }
  /** M4: the main session handed off to a new transcript. */
  | { topic: 'handoff'; data: { from: string; to: string; notes: string; dropped: number; kept: number } }
  | { topic: 'plugin'; data: PluginStatus }
  | { topic: 'approval'; data: ApprovalInfo };

export type StreamTopic = StreamMessage['topic'];

/** M5: one model call, as recorded (the WebSocket `usage` topic). */
export interface UsageInfo {
  at: string;
  model: string;
  role: ModelRole;
  sessionId: string;
  batchId?: string;
  level?: Level;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  stopReason?: string;
}

/** M5: a log line (pino JSON): time is epoch ms, level 10–60. */
export type LogRecord = Record<string, unknown> & { time: number; level: number; msg: string };

/** WebSocket-only messages beside the stream projection. */
export type WsExtraMessage =
  | { topic: 'hello'; data: { runId: string; role: ControlRole } }
  | { topic: 'subscribed'; data: { topics: WsTopic[] } }
  | { topic: 'promoted'; data: EventEnvelope }
  | { topic: 'persona'; data: { files: string[] } }
  | { topic: 'usage'; data: UsageInfo }
  | { topic: 'log'; data: LogRecord }
  | { topic: 'error'; data: { message: string } };

export type WsServerMessage = StreamMessage | WsExtraMessage;

/**
 * WebSocket `/ws` subscription groups (docs/30-specs/05-control-api.md): each covers some
 * server message topics.
 */
export const WS_TOPICS = {
  events: ['event', 'settled', 'promoted'],
  phase: ['phase', 'batch.started', 'batch.extended', 'batch.ended'],
  scheduler: ['scheduler'],
  output: ['output'],
  changes: ['fork', 'plugin', 'approval', 'mcp', 'skills', 'handoff', 'persona'],
  usage: ['usage'],
  logs: ['log'],
} as const satisfies Record<string, ReadonlyArray<WsServerMessage['topic']>>;
export type WsTopic = keyof typeof WS_TOPICS;

/** Client → server. Each message replaces the subscription; `since` replays stored events first. */
export interface WsClientMessage {
  subscribe: WsTopic[];
  since?: number;
  logFilter?: { level?: string | number; component?: string; plugin?: string; q?: string };
}

/** M5: `GET /api/batches` rows. */
export interface BatchInfo {
  id: string;
  level: Level;
  reason: BatchReason;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  rounds: number;
  endReason: BatchEndReason | null;
}

/** M5: `GET /api/config`. */
export interface ConfigResponse {
  /** Effective configuration; secret values that appear in it are replaced with [REDACTED:<NAME>]. */
  config: Record<string, unknown>;
  /** Layers, lowest first. */
  layers: string[];
  /** Where each leaf comes from (dotted path → defaults | file | environment). */
  sources: Record<string, 'defaults' | 'file' | 'environment'>;
  /** Top-level sections applied without a restart. */
  hot: string[];
}

export interface SecretInfo {
  name: string;
  source: 'env' | 'file';
  /** A file exists but the environment value wins. */
  shadowedFile: boolean;
}
