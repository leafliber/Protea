import type { ForkInfo, Level, ModelRole } from '@protea/protocol';
import type { ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import type { ForkManager } from './fork-manager.js';

function describe(f: ForkInfo): string {
  const extra = [
    f.pauseReason ? `paused: ${f.pauseReason}` : '',
    f.endedAt ? `ended ${f.endedAt}` : '',
    f.error ? `error: ${f.error}` : '',
  ].filter(Boolean);
  return `${f.id} [${f.state}] L${f.level} ${f.model}, ${f.rounds} round(s)${extra.length ? ` (${extra.join('; ')})` : ''}: ${f.goal}${
    f.summary ? `\n  result: ${f.summary}` : ''
  }`;
}

/** fork_spawn / fork_status / fork_cancel (docs/10-architecture/05-sessions-and-agent-loop.md §9). */
export function forkTools(forks: ForkManager, opts: { maxTurns: number }): ToolSpec<never>[] {
  const spawn: ToolSpec<{
    goal: string;
    context?: string;
    tools?: string[];
    model?: ModelRole;
    level?: Level;
    max_turns?: number;
  }> = {
    name: 'fork_spawn',
    description:
      'Start a background fork: an independent tool loop that works on one goal while you stay responsive. ' +
      'It sees only the goal and context you give it (not this conversation, and no events) and by default ' +
      'gets every tool without side effects. Its final message comes back to you as a fork.completed event.',
    inputSchema: {
      type: 'object',
      required: ['goal'],
      additionalProperties: false,
      properties: {
        goal: { type: 'string', minLength: 1, description: 'What the fork should achieve and what its final message must contain.' },
        context: { type: 'string', description: 'Facts from this conversation the fork needs.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names the fork may call; omit for the default set.' },
        model: { type: 'string', enum: ['fork', 'cheap', 'main'], default: 'fork' },
        level: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Priority level; defaults to the current batch level and can only be less urgent.',
        },
        max_turns: { type: 'integer', minimum: 1, maximum: opts.maxTurns, description: 'Model rounds before it must stop.' },
      },
    },
    handler: (input, ctx) => {
      const floor = Math.max(1, ctx.batchLevel) as Level;
      const level = Math.max(floor, input.level ?? floor) as Level;
      const notes: string[] = [];
      if (input.level !== undefined && input.level < floor) {
        notes.push(`level raised to ${level}: a fork cannot be more urgent than the batch that spawned it`);
      }
      try {
        const f = forks.spawn({
          goal: input.goal,
          level,
          parentBatch: ctx.batchId,
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.max_turns !== undefined ? { maxTurns: input.max_turns } : {}),
        });
        return `Fork ${f.id} is ${f.state} at level ${f.level} (model role ${f.model}). Its result arrives as a fork.completed event.${
          notes.length ? ` Note: ${notes.join('; ')}.` : ''
        }`;
      } catch (err) {
        return { text: `fork not started: ${errorMessage(err)}`, failed: true };
      }
    },
  };

  const status: ToolSpec<{ id?: string }> = {
    name: 'fork_status',
    description: 'Show one fork, or list unfinished forks and the most recently ended ones.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
    flags: { readOnly: true },
    handler: (input) => {
      if (input.id !== undefined) {
        const f = forks.get(input.id);
        return f ? describe(f) : { text: `no fork ${input.id}`, failed: true };
      }
      const all = forks.list();
      return all.length === 0 ? 'no forks' : all.map(describe).join('\n');
    },
  };

  const cancel: ToolSpec<{ id: string }> = {
    name: 'fork_cancel',
    description: 'Cancel a fork. A running fork stops at once; its partial transcript is kept but nothing is reported.',
    inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
    handler: (input) => {
      try {
        const f = forks.cancel(input.id);
        return `fork ${f.id} is ${f.state === 'running' ? 'being cancelled' : f.state}`;
      } catch (err) {
        return { text: errorMessage(err), failed: true };
      }
    },
  };

  return [spawn, status, cancel] as unknown as ToolSpec<never>[];
}
