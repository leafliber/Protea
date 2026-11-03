import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@protea/protocol';
import { ToolDispatcher, ToolRegistry, silentLogger, sleep, type ToolSpec } from '../src/index.js';

const use = (name: string, input: unknown = {}, id = `id_${name}_${Math.random()}`): ToolUseBlock => ({ type: 'tool_use', id, name, input });
const ctx = (signal = new AbortController().signal) => ({ signal, sessionId: 'main', batchId: 'b', batchLevel: 1 as const });

function setup(specs: ToolSpec<never>[]) {
  const reg = new ToolRegistry();
  for (const s of specs) reg.register('t', s);
  return new ToolDispatcher(reg, silentLogger(), 200);
}

const spec = (name: string, handler: ToolSpec['handler'], extra: Partial<ToolSpec> = {}): ToolSpec<never> =>
  ({ name, description: name, inputSchema: { type: 'object' }, handler, ...extra }) as ToolSpec<never>;

describe('ToolDispatcher', () => {
  it('runs calls in parallel and returns results in call order', async () => {
    const log: string[] = [];
    const d = setup([
      spec('slow', async () => {
        log.push('slow:start');
        await sleep(40);
        log.push('slow:end');
        return 'S';
      }),
      spec('fast', async () => {
        log.push('fast:start');
        await sleep(5);
        log.push('fast:end');
        return 'F';
      }),
    ]);
    const r = await d.runAll([use('slow'), use('fast')], ctx());
    expect(r.results.map((b) => b.content)).toEqual(['S', 'F']);
    expect(log.indexOf('fast:start')).toBeLessThan(log.indexOf('slow:end'));
  });

  it('does not start later calls before a barrierAfter call returns', async () => {
    const log: string[] = [];
    const d = setup([
      spec(
        'send',
        async () => {
          await sleep(30);
          log.push('send');
          return 'sent';
        },
        { flags: { barrierAfter: true } },
      ),
      spec('next', () => {
        log.push('next');
        return 'n';
      }),
    ]);
    await d.runAll([use('send'), use('next')], ctx());
    expect(log).toEqual(['send', 'next']);
  });

  it('turns every failure into an error result instead of throwing', async () => {
    const d = setup([
      spec('boom', () => {
        throw new Error('kaput');
      }),
      spec('typed', () => 'ok', {
        inputSchema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } }, additionalProperties: false },
      }),
      spec('hang', () => new Promise(() => {})),
      spec('soft', () => ({ text: 'nope', failed: true })),
    ]);
    const r = await d.runAll([use('boom'), use('typed', { n: 'x' }), use('missing'), use('hang'), use('soft')], ctx());
    expect(r.results.every((b) => b.is_error)).toBe(true);
    expect(r.results.map((b) => b.content)).toEqual([
      'boom failed: kaput',
      expect.stringContaining('invalid input for typed'),
      'tool missing is not available',
      'hang timed out after 0s',
      'nope',
    ]);
  });

  it('ends the turn only when an endsTurn call succeeds', async () => {
    const d = setup([
      spec('idle', () => 'ok', { flags: { endsTurn: true } }),
      spec('bad_idle', () => ({ text: 'x', failed: true }), { flags: { endsTurn: true } }),
    ]);
    expect((await d.runAll([use('idle')], ctx())).endsTurn).toBe(true);
    expect((await d.runAll([use('bad_idle')], ctx())).endsTurn).toBe(false);
  });

  it('reports cancellation when the turn is aborted', async () => {
    const ac = new AbortController();
    const d = setup([spec('wait', (_i: never, c: { signal: AbortSignal }) => sleep(1000, c.signal).then(() => 'late'))]);
    const p = d.runAll([use('wait')], ctx(ac.signal));
    setTimeout(() => ac.abort('stop'), 10);
    const r = await p;
    expect(r.results[0]).toMatchObject({ is_error: true, content: 'wait was cancelled' });
  });
});
