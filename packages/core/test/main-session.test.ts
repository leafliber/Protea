import { afterEach, describe, expect, it } from 'vitest';
import { isTextBlock, isToolResultBlock, type ContentBlock } from '@protea/protocol';
import {
  ProviderError,
  ScriptedProvider,
  reply,
  sleep,
  textReply,
  toolCall,
  type ProviderRequest,
  type ToolSpec,
} from '../src/index.js';
import { makeHarness, waitFor, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const lastUserTexts = (req: ProviderRequest): string[] =>
  (req.messages.at(-1)?.content ?? []).filter(isTextBlock).map((b) => b.text);
const eventsIn = (req: ProviderRequest): number => lastUserTexts(req).join('\n').match(/<event /g)?.length ?? 0;

describe('MainSession + Scheduler', () => {
  it('delivers a flush event, runs a tool round and settles the event', async () => {
    const provider = new ScriptedProvider([() => reply([toolCall('say', { text: 'hello' })]), () => textReply('done')]);
    h = makeHarness({ provider });
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    const r = h.push({ text: 'hi there' });
    await waitFor(() => ended.length === 1);
    expect(h.outputs).toEqual(['hello']);
    expect(ended).toEqual(['end_turn']);
    expect(provider.calls).toHaveLength(2);
    expect(eventsIn(provider.calls[0] as ProviderRequest)).toBe(1);
    expect(lastUserTexts(provider.calls[0] as ProviderRequest)[0]).toContain('sender="owner"');
    expect(provider.calls[0]?.effort).toBe('medium');
    expect(h.store.get(r.cursor as number)?.state).toBe('delivered');
    const roles = h.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    // All tool results of one assistant message go back in one user message.
    expect(h.transcript.messages[2]?.content.every(isToolResultBlock)).toBe(true);
  });

  it('collects a debounce window into one batch', async () => {
    const provider = new ScriptedProvider([() => textReply('ok')]);
    h = makeHarness({ provider });
    for (const t of ['a', 'b', 'c']) h.push({ text: t, trigger: 'debounce' });
    await waitFor(() => provider.calls.length === 1);
    await h.idle();
    expect(eventsIn(provider.calls[0] as ProviderRequest)).toBe(3);
    expect(provider.calls).toHaveLength(1);
  });

  it('lets piggyback events ride along and never delivers stored ones', async () => {
    const provider = new ScriptedProvider([() => textReply('ok')]);
    h = makeHarness({ provider });
    const rss = h.push({ text: 'feed item', level: 4, trigger: 'piggyback', type: 'rss.item' }, 'rss', 4);
    const log = h.push({ text: 'log line', level: 4, trigger: 'store', type: 'log.line' }, 'log', 4);
    await sleep(80);
    expect(provider.calls).toHaveLength(0);
    h.push({ text: 'now' });
    await waitFor(() => provider.calls.length === 1);
    await h.idle();
    expect(eventsIn(provider.calls[0] as ProviderRequest)).toBe(2);
    expect(h.store.get(rss.cursor as number)?.state).toBe('delivered');
    expect(h.store.get(log.cursor as number)?.state).toBe('archived');
  });

  it('appends events that arrive during tools at the turn boundary, after the tool results', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const wait: ToolSpec<Record<string, never>> = {
      name: 'wait_gate',
      description: 'wait',
      inputSchema: { type: 'object' },
      handler: async () => {
        await gate;
        return 'released';
      },
    };
    const provider = new ScriptedProvider([() => reply([toolCall('wait_gate', {})]), () => textReply('saw it')]);
    h = makeHarness({ provider, extraTools: [wait as unknown as ToolSpec<never>] });
    const extended: number[][] = [];
    h.bus.on('batch.extended', (b) => extended.push(b.cursors));
    h.push({ text: 'first' });
    await waitFor(() => h?.main.phase === 'tools');
    const second = h.push({ text: 'second' });
    release();
    await waitFor(() => provider.calls.length === 2);
    await h.idle();
    const content = provider.calls[1]?.messages.at(-1)?.content as ContentBlock[];
    expect(content[0]?.type).toBe('tool_result');
    expect(content.filter(isTextBlock)[0]?.text).toContain('second');
    expect(extended).toEqual([[second.cursor]]);
    expect(h.store.get(second.cursor as number)?.state).toBe('delivered');
  });

  it('refuses to deliver while a batch runs (I-1)', async () => {
    const provider = new ScriptedProvider([() => textReply('ok')], 50);
    h = makeHarness({ provider });
    h.push({ text: 'x' });
    await waitFor(() => h?.main.busy === true);
    expect(() => h?.main.deliver({ id: 'b_x', level: 1, reason: 'flush', events: [] })).toThrow(/busy/);
  });

  it('backs off on retryable errors and then succeeds', async () => {
    const provider = new ScriptedProvider([
      () => new ProviderError('retryable', 'overloaded', 529),
      () => textReply('ok'),
    ]);
    h = makeHarness({ provider });
    const phases: string[] = [];
    h.bus.on('session.phase', (p) => phases.push(p.phase));
    h.push({ text: 'x' });
    await waitFor(() => provider.calls.length === 2);
    await h.idle();
    expect(phases).toContain('backoff');
    expect(h.transcript.messages.at(-1)?.role).toBe('assistant');
  });

  it('ends the batch on a fatal error, records it, and does not resume it later', async () => {
    const provider = new ScriptedProvider([() => new ProviderError('fatal', 'bad request', 400)]);
    h = makeHarness({ provider });
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    h.push({ text: 'x' });
    await waitFor(() => ended.length === 1);
    expect(ended).toEqual(['model_error']);
    expect(h.store.query({ type: 'model.error' })[0]?.state).toBe('archived');
    expect(h.main.needsResume()).toBe(false);
  });

  it('answers tool calls cut off by max_tokens without running them', async () => {
    const provider = new ScriptedProvider([
      () => reply([toolCall('say', { text: 'partial' })], 'max_tokens'),
      () => textReply('retry later'),
    ]);
    h = makeHarness({ provider });
    h.push({ text: 'x' });
    await waitFor(() => provider.calls.length === 2);
    await h.idle();
    expect(h.outputs).toEqual([]);
    const results = h.transcript.messages[2]?.content.filter(isToolResultBlock);
    expect(results?.[0]).toMatchObject({ is_error: true });
  });

  it('stops on a refusal and keeps the history valid', async () => {
    const provider = new ScriptedProvider([() => ({ ...reply([toolCall('say', { text: 'x' })], 'refusal'), stopDetails: { category: 'cyber' } })]);
    h = makeHarness({ provider });
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    h.push({ text: 'x' });
    await waitFor(() => ended.length === 1);
    expect(ended).toEqual(['refusal']);
    expect(h.outputs).toEqual([]);
    expect(h.transcript.messages.at(-1)?.content.every(isToolResultBlock)).toBe(true);
    expect(h.store.query({ type: 'model.refused' })[0]?.text).toContain('category: cyber');
  });

  it('stops at the hard round limit and warns at the soft one', async () => {
    const provider = new ScriptedProvider([() => reply([toolCall('say', { text: 'again' })])]);
    h = makeHarness({ provider, rounds: { soft: 2, hard: 3 } });
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    h.push({ text: 'loop' });
    await waitFor(() => ended.length === 1);
    expect(ended).toEqual(['round_limit']);
    expect(provider.calls).toHaveLength(3);
    // The soft-limit notice is an internal event delivered at the boundary after round 2.
    expect(lastUserTexts(provider.calls[2] as ProviderRequest).join('')).toContain('session.round_limit');
  });

  it('ends the turn after an endsTurn tool', async () => {
    const provider = new ScriptedProvider([() => reply([toolCall('idle', {})])]);
    h = makeHarness({ provider });
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    h.push({ text: 'x' });
    await waitFor(() => ended.length === 1);
    expect(ended).toEqual(['ends_turn']);
    expect(provider.calls).toHaveLength(1);
    expect(h.transcript.messages.at(-1)?.content[0]?.type).toBe('tool_result');
  });

  it('aborts a batch on drain and resumes it after a restart', async () => {
    const slow = new ScriptedProvider([() => textReply('never')], 5_000);
    h = makeHarness({ provider: slow });
    h.push({ text: 'interrupted' });
    await waitFor(() => slow.calls.length === 1);
    const dir = h.dir;
    await h.close();
    h = null;

    const provider = new ScriptedProvider([() => textReply('resumed')]);
    h = makeHarness({ dir, provider });
    await waitFor(() => provider.calls.length === 1);
    await h.idle();
    expect(lastUserTexts(provider.calls[0] as ProviderRequest).join('')).toContain('interrupted');
    expect(h.transcript.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(h.main.needsResume()).toBe(false);
  });

  it('records usage per model call', async () => {
    h = makeHarness();
    h.push({ text: 'x' });
    await waitFor(() => h?.usage.totalsSince(0).calls === 1);
    expect(h.usage.totalsSince(0)).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 });
  });
});
