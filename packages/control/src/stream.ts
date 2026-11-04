import type { UsageInfo, WsServerMessage } from '@protea/protocol';
import type { Bus, BusTopic, BusTopics } from '@protea/core';

const base = (file: string): string => file.split('/').pop() ?? file;

/**
 * Project bus records onto the stream messages of `/api/stream` (SSE) and `/ws`. The
 * WebSocket-only topics (`promoted`, `persona`, `usage`) are included when `extended` is set.
 *
 * It reads the bus through a tap, which sees each record before any listener reacts to it:
 * a stored event therefore goes out before the batch that a listener (the scheduler) starts
 * for it and before its settlement, i.e. in causal order.
 */
export function subscribeStream(bus: Bus, push: (m: WsServerMessage) => void, opts: { extended?: boolean } = {}): () => void {
  return bus.tap((topic, raw) => {
    const m = project(topic, raw, opts.extended === true);
    if (m) push(m);
  });
}

function project(topic: BusTopic, raw: unknown, extended: boolean): WsServerMessage | null {
  switch (topic) {
    case 'event.stored':
      return { topic: 'event', data: raw as BusTopics['event.stored'] };
    case 'event.settled': {
      const s = raw as BusTopics['event.settled'];
      return { topic: 'settled', data: { cursors: s.cursors, outcome: s.outcome, ...(s.batchId !== undefined ? { batchId: s.batchId } : {}) } };
    }
    case 'session.phase': {
      const p = raw as BusTopics['session.phase'];
      return { topic: 'phase', data: { phase: p.phase, ...(p.batchId !== undefined ? { batchId: p.batchId } : {}), ...(p.round !== undefined ? { round: p.round } : {}) } };
    }
    case 'batch.started':
      return { topic: 'batch.started', data: raw as BusTopics['batch.started'] };
    case 'batch.extended':
      return { topic: 'batch.extended', data: raw as BusTopics['batch.extended'] };
    case 'batch.ended':
      return { topic: 'batch.ended', data: raw as BusTopics['batch.ended'] };
    case 'plugin.output':
      return { topic: 'output', data: raw as BusTopics['plugin.output'] };
    case 'scheduler.action':
      return { topic: 'scheduler', data: raw as BusTopics['scheduler.action'] };
    case 'fork.changed':
      return { topic: 'fork', data: raw as BusTopics['fork.changed'] };
    case 'plugin.changed':
      return { topic: 'plugin', data: raw as BusTopics['plugin.changed'] };
    case 'approval.changed':
      return { topic: 'approval', data: raw as BusTopics['approval.changed'] };
    case 'mcp.changed':
      return { topic: 'mcp', data: raw as BusTopics['mcp.changed'] };
    case 'skills.changed':
      return { topic: 'skills', data: raw as BusTopics['skills.changed'] };
    case 'session.handoff': {
      const h = raw as BusTopics['session.handoff'];
      return { topic: 'handoff', data: { from: base(h.from), to: base(h.to), notes: h.notes, dropped: h.dropped, kept: h.kept } };
    }
    case 'event.promoted':
      return extended ? { topic: 'promoted', data: raw as BusTopics['event.promoted'] } : null;
    case 'persona.changed':
      return extended ? { topic: 'persona', data: raw as BusTopics['persona.changed'] } : null;
    case 'usage.recorded': {
      if (!extended) return null;
      const u = raw as BusTopics['usage.recorded'];
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
    }
  }
  return null;
}
