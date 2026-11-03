import type { Level, RunPhase, Trigger } from '@protea/protocol';

export type PreemptDecision = 'wait' | 'preempt' | 'interrupt';

/** What the matrix needs to know about the batch the main session is running. */
export interface RunningTurn {
  batchLevel: Level;
  phase: RunPhase;
  /** The current model call has already reached the outside world (output tap). */
  externalOutput: boolean;
}

/**
 * The preemption matrix (docs/10-architecture/04-scheduling-and-preemption.md §4).
 * A cancel only ever goes from a more urgent event to a less urgent batch, or to a
 * batch of the same level with `interrupt` (invariant I-5). The gate already limits
 * preempt to L1/L2 and interrupt to L0/L1, so L3/L4 events can never cancel anything.
 */
export function decidePreemption(level: Level, trigger: Trigger, turn: RunningTurn): PreemptDecision {
  if (trigger !== 'preempt' && trigger !== 'interrupt') return 'wait';
  // Only a model call (or the backoff before one) and running tools can be cut short.
  const cancellable = turn.phase === 'model' || turn.phase === 'backoff' || turn.phase === 'tools';
  if (!cancellable) return 'wait';
  if (trigger === 'interrupt') return level <= turn.batchLevel ? 'interrupt' : 'wait';
  if (level >= turn.batchLevel || turn.phase === 'tools' || turn.externalOutput) return 'wait';
  return 'preempt';
}
