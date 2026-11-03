/** Control API request/response shapes (docs/30-specs/05-control-api.md). */
import type { EventEnvelope, Level, TerminalOutcome, Trigger } from './events.js';
import type { PluginState } from './plugin.js';
import type { BatchEndReason, BatchReason, CancelKind, ForkState, ModelRole, RunPhase } from './session.js';

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
  usage24h: UsageTotals;
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
}

export interface BudgetStatus {
  /** Budgets are tracked but not enforced until M6. */
  enforced: boolean;
  dailyUsd: number | null;
  levels: Record<Level, LevelBudget>;
}

/** Scheduling interventions, all of which are also recorded as internal events. */
export type SchedulerAction =
  | { kind: CancelKind; cursor: number; source: string; level: Level; batchId: string; batchLevel: Level; phase: RunPhase }
  | { kind: 'aged'; cursors: number[] }
  | { kind: 'storm_cooldown'; source: string; untilMs: number }
  | { kind: 'fork_yield'; forkIds: string[]; batchId: string }
  | { kind: 'fork_resume'; forkIds: string[] };

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
  | { topic: 'plugin'; data: PluginStatus }
  | { topic: 'approval'; data: ApprovalInfo };

export type StreamTopic = StreamMessage['topic'];
