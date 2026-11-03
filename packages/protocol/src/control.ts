/** Control API request/response shapes (docs/30-specs/05-control-api.md). */
import type { EventEnvelope, Level, TerminalOutcome, Trigger } from './events.js';
import type { BatchEndReason, BatchReason, RunPhase } from './session.js';

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
}

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
  | { topic: 'batch.extended'; data: { batchId: string; cursors: number[] } }
  | { topic: 'batch.ended'; data: { batchId: string; endReason: BatchEndReason; rounds: number } }
  | { topic: 'output'; data: { plugin: string; channel?: string; text: string; at: string } };

export type StreamTopic = StreamMessage['topic'];
