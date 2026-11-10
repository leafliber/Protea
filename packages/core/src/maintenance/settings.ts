import type { ModelRole } from '@protea/protocol';

export interface IdleCompactionSettings {
  enabled: boolean;
  /** Conversation tokens (without the system prefix) above which an idle session is compacted once the provider's cache has gone cold. */
  minTokens: number;
  /** Conversation tokens above which it is compacted after only `earlyAfterMs` of idleness. */
  earlyTokens: number;
  earlyAfterMs: number;
  /** Idle time after which the cache of a provider that does not state its lifetime counts as cold. */
  coldAfterMs: number;
  /** Most recent tokens carried over verbatim. */
  keepTokens: number;
  /** A compaction has to drop at least this many tokens; below that it would only rotate the transcript. */
  minDroppableTokens: number;
  /** Least time between two attempts, failed ones included. */
  minIntervalMs: number;
}

export const DEFAULT_IDLE_COMPACTION: IdleCompactionSettings = {
  enabled: true,
  minTokens: 32_000,
  earlyTokens: 48_000,
  earlyAfterMs: 900_000,
  coldAfterMs: 1_800_000,
  keepTokens: 8_000,
  minDroppableTokens: 16_000,
  minIntervalMs: 600_000,
};

export interface DreamSettings {
  enabled: boolean;
  /** Local time (HH:MM, daemon time zone) after which each day's run may start. */
  at: string;
  /** The main session must have been idle this long. */
  minIdleMs: number;
  /** Model role of the consolidation fork. */
  model: ModelRole;
}

export const DEFAULT_DREAM: DreamSettings = { enabled: true, at: '03:30', minIdleMs: 1_800_000, model: 'fork' };
