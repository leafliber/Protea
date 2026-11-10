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

  const eventsPromote: ToolSpec<{ cursor: number; trigger: 'flush' | 'piggyback' }> = {
    name: 'events_promote',
    description:
      'Bring an event that has not been delivered (pending, or archived by a "store" source) into the conversation: ' +
      '"flush" delivers it at the next turn boundary, "piggyback" with the next batch. The level never changes.',
    inputSchema: {
      type: 'object',
      required: ['cursor', 'trigger'],
      additionalProperties: false,
      properties: {
        cursor: { type: 'integer', minimum: 1 },
        trigger: { type: 'string', enum: ['flush', 'piggyback'] },
      },
    },
    handler: (input) => {
      const before = deps.store.get(input.cursor);
      if (!before) return { text: `no event #${input.cursor}`, failed: true };
      const after = deps.store.promote(input.cursor, input.trigger);
      if (!after) return { text: `event #${input.cursor} is already ${before.state}`, failed: true };
      return `event #${input.cursor} (${before.type}) is pending with trigger ${input.trigger}`;
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
      // A plugin that is only installed is in state "loaded", which reads as if it were in use.
      const off = s.plugins.filter((p) => !p.enabled);
      return [
        `run ${s.runId}, up ${s.uptimeSec}s, phase ${s.phase}`,
        `pending: ${Object.entries(s.pending).map(([l, n]) => `L${l}=${n}`).join(' ')}`,
        `model: ${s.provider.id}/${s.provider.mainModel}${s.provider.ready ? '' : ` (not ready: ${s.provider.problem ?? 'unknown'})`}`,
        `plugins: ${s.plugins.filter((p) => p.enabled).map((p) => `${p.id}(${p.state})`).join(', ') || 'none'}`,
        ...(off.length > 0 ? [`plugins installed but not enabled (no tools, no events): ${off.map((p) => p.id).join(', ')}`] : []),
        `usage 24h: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens, cache read ${u.cacheReadTokens}, ~$${u.costUsd.toFixed(4)}`,
        `budget 24h${s.budget.enforced ? '' : ' (tracked, not enforced)'}: ${Object.entries(s.budget.levels)
          .map(
            ([l, b]) =>
              `L${l} $${b.spentUsd.toFixed(4)}${b.limitUsd === null ? '' : ` of $${b.limitUsd.toFixed(2)}`}${b.held ? ` (${b.held} held)` : ''}${b.releasedUntil ? ` (released until ${b.releasedUntil})` : ''}`,
          )
          .join(', ')}${
          s.budget.hardDailyUsd === null
            ? ''
            : `; hard cap $${s.budget.hardDailyUsd}${s.budget.hardCapReached && !s.budget.hardCapReleasedUntil ? ' REACHED: only L0/L1 events are delivered' : ''}`
        }`,
        `forks: ${s.forks.filter((f) => !['completed', 'cancelled', 'failed'].includes(f.state)).map((f) => `${f.id}(${f.state}, L${f.level})`).join(', ') || 'none active'}`,
      ].join('\n');
    },
  };

  return [idle, eventsQuery, eventsPromote, selfStatus] as unknown as ToolSpec<never>[];
}
