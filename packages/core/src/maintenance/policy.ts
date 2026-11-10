import type { IdleCompactionSettings } from './settings.js';

export interface CompactionState {
  nowMs: number;
  idleSinceMs: number;
  busy: boolean;
  /** Delivery is paused by the operator. */
  paused: boolean;
  needsResume: boolean;
  /** Pending events that a batch will pick up soon (levels 0–2). */
  urgentPending: number;
  budgetRefused: boolean;
  /** Tokens of the conversation, without the system prefix. */
  conversationTokens: number;
  /** Tokens a compaction would actually remove. */
  droppableTokens: number;
  lastAttemptMs: number | null;
  /** How long the provider keeps its cache, when it says. */
  cacheHorizonMs: number | undefined;
}

export type CompactionTrigger = 'cache-cold' | 'early';

/**
 * Whether to compact now. The usual moment is when the provider's cache has gone cold: the
 * next request would be a cache miss anyway, so compacting costs only the notes request. A
 * conversation that is already long does not wait that long.
 */
export function compactionTrigger(s: CompactionState, cfg: IdleCompactionSettings): CompactionTrigger | null {
  if (s.busy || s.paused || s.needsResume || s.budgetRefused || s.urgentPending > 0) return null;
  if (s.droppableTokens < cfg.minDroppableTokens) return null;
  if (s.lastAttemptMs !== null && s.nowMs - s.lastAttemptMs < cfg.minIntervalMs) return null;
  const idleMs = s.nowMs - s.idleSinceMs;
  if (s.conversationTokens >= cfg.minTokens && idleMs >= (s.cacheHorizonMs ?? cfg.coldAfterMs)) return 'cache-cold';
  if (s.conversationTokens >= cfg.earlyTokens && idleMs >= cfg.earlyAfterMs) return 'early';
  return null;
}
