/** Control API request/response shapes (docs/30-specs/05-control-api.md). */
import type { EventEnvelope, Level, TerminalOutcome, Trigger } from './events.js';
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
  state: 'running' | 'stopped' | 'failed';
  error?: string;
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
  | { topic: 'fork'; data: ForkInfo };

export type StreamTopic = StreamMessage['topic'];
