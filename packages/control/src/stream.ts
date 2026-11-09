import type { UsageInfo, WsServerMessage } from '@protea/protocol';
import type { Bus, BusTopic, BusTopics } from '@protea/core';

const base = (file: string): string => file.split('/').pop() ?? file;

type Projector<K extends BusTopic> = (data: BusTopics[K], extended: boolean) => WsServerMessage | null;

/**
 * How each bus topic appears on `/api/stream` (SSE) and `/ws`. It has an entry for every
 * topic, so a new bus topic does not compile until it is decided here; null keeps a record
 * off the stream. The WebSocket-only topics (`promoted`, `persona`, `usage`) need `extended`.
 */
const PROJECTORS: { [K in BusTopic]: Projector<K> } = {
  'event.stored': (data) => ({ topic: 'event', data }),
  'event.promoted': (data, extended) => (extended ? { topic: 'promoted', data } : null),
  'event.settled': (s) => ({ topic: 'settled', data: { cursors: s.cursors, outcome: s.outcome, ...(s.batchId !== undefined ? { batchId: s.batchId } : {}) } }),
  'session.phase': (p) => ({ topic: 'phase', data: { phase: p.phase, ...(p.batchId !== undefined ? { batchId: p.batchId } : {}), ...(p.round !== undefined ? { round: p.round } : {}) } }),
  'batch.started': (data) => ({ topic: 'batch.started', data }),
  'batch.extended': (data) => ({ topic: 'batch.extended', data }),
  'batch.ended': (data) => ({ topic: 'batch.ended', data }),
  'plugin.output': (data) => ({ topic: 'output', data }),
  'scheduler.action': (data) => ({ topic: 'scheduler', data }),
  'fork.changed': (data) => ({ topic: 'fork', data }),
  'plugin.changed': (data) => ({ topic: 'plugin', data }),
  'approval.changed': (data) => ({ topic: 'approval', data }),
  'mcp.changed': (data) => ({ topic: 'mcp', data }),
  'skills.changed': (data) => ({ topic: 'skills', data }),
  'session.handoff': (h) => ({ topic: 'handoff', data: { from: base(h.from), to: base(h.to), notes: h.notes, dropped: h.dropped, kept: h.kept } }),
  'persona.changed': (data, extended) => (extended ? { topic: 'persona', data } : null),
  'usage.recorded': (u, extended) => {
    if (!extended) return null;
    const data: UsageInfo = {
      at: u.at,
      model: u.model,
      role: u.role,
      sessionId: u.sessionId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      ...(u.batchId !== undefined ? { batchId: u.batchId } : {}),
      ...(u.level !== undefined ? { level: u.level } : {}),
      ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
      ...(u.stopReason !== undefined ? { stopReason: u.stopReason } : {}),
    };
    return { topic: 'usage', data };
  },
  // Only the latency metric reads this one.
  'model.request': () => null,
};

/**
 * Project bus records onto the stream messages of `/api/stream` (SSE) and `/ws`.
 *
 * It reads the bus through a tap, which sees each record before any listener reacts to it:
 * a stored event therefore goes out before the batch that a listener (the scheduler) starts
 * for it and before its settlement, i.e. in causal order.
 */
export function subscribeStream(bus: Bus, push: (m: WsServerMessage) => void, opts: { extended?: boolean } = {}): () => void {
  const extended = opts.extended === true;
  return bus.tap((topic, raw) => {
    // The tap carries the record untyped; the topic picks the projector written for its type.
    const project = PROJECTORS[topic] as (data: never, extended: boolean) => WsServerMessage | null;
    const m = project(raw as never, extended);
    if (m) push(m);
  });
}
