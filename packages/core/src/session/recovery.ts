import type { EventStore } from '../events/store.js';
import type { Transcript } from './transcript.js';

/**
 * Startup reconciliation between the event store and the transcript
 * (docs/10-architecture/03-event-store-and-bus.md §8). The transcript is the
 * record of what the model has seen: events whose cursor is in it are delivered;
 * events selected for a batch that never reached it go back to pending.
 */
export function reconcileDeliveries(store: EventStore, transcript: Transcript): { delivered: number; reverted: number } {
  const seen = transcript.deliveredCursors();
  let delivered = 0;
  let reverted = 0;
  for (const e of [...store.inState('delivering'), ...store.pending()]) {
    if (seen.has(e.cursor)) {
      store.settle([e.cursor], 'delivered', { sessionId: 'main', ...(e.batchId !== undefined ? { batchId: e.batchId } : {}) });
      delivered++;
    } else if (e.state === 'delivering') {
      store.revertToPending([e.cursor]);
      reverted++;
    }
  }
  return { delivered, reverted };
}
