import { EVENT_STATES, type EventState, type StatusResponse } from '@protea/protocol';
import type { EventStore } from '../events/store.js';
import type { ToolSpec } from './types.js';

export interface KernelToolDeps {
  store: EventStore;
  status: () => StatusResponse;
}

function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** Tools every session has (docs/10-architecture/05-sessions-and-agent-loop.md §9). */
export function kernelTools(deps: KernelToolDeps): ToolSpec<never>[] {
  const idle: ToolSpec<Record<string, never>> = {
    name: 'idle',
    description: 'End the current turn without taking any further action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    flags: { endsTurn: true, readOnly: true },
    handler: () => 'ok',
  };

  const eventsQuery: ToolSpec<{
    source?: string;
    type?: string;
    states?: EventState[];
    since_cursor?: number;
    limit?: number;
  }> = {
    name: 'events_query',
    description:
      'Look up events in the event log, newest first. Use it to find events that were stored without being delivered (state "archived") or to re-read earlier events.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Plugin id, e.g. "console" or "cron".' },
        type: { type: 'string', description: 'Exact event type, e.g. "cron.tick".' },
        states: { type: 'array', items: { type: 'string', enum: [...EVENT_STATES] } },
        since_cursor: { type: 'integer', minimum: 0, description: 'Only events with a larger cursor.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
    flags: { readOnly: true },
    handler: (input) => {
      const events = deps.store.query({
        order: 'desc',
        limit: input.limit ?? 20,
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.states !== undefined ? { states: input.states } : {}),
        ...(input.since_cursor !== undefined ? { sinceCursor: input.since_cursor } : {}),
      });
      if (events.length === 0) return 'no matching events';
      return events
        .map((e) => `#${e.cursor} [${e.state}] L${e.effLevel} ${e.type} from ${e.source} at ${e.ts}: ${clip(e.text, 300)}`)
        .join('\n');
    },
  };

  const selfStatus: ToolSpec<Record<string, never>> = {
    name: 'self_status',
    description: 'Report the runtime state: phase, pending events per level, plugins, model and the last 24h of model usage.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    flags: { readOnly: true },
    handler: () => {
      const s = deps.status();
      const u = s.usage24h;
      return [
        `run ${s.runId}, up ${s.uptimeSec}s, phase ${s.phase}`,
        `pending: ${Object.entries(s.pending).map(([l, n]) => `L${l}=${n}`).join(' ')}`,
        `model: ${s.provider.id}/${s.provider.mainModel}${s.provider.ready ? '' : ` (not ready: ${s.provider.problem ?? 'unknown'})`}`,
        `plugins: ${s.plugins.map((p) => `${p.id}(${p.state})`).join(', ') || 'none'}`,
        `usage 24h: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens, cache read ${u.cacheReadTokens}, ~$${u.costUsd.toFixed(4)}`,
      ].join('\n');
    },
  };

  return [idle, eventsQuery, selfStatus] as unknown as ToolSpec<never>[];
}
