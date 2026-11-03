import { describe, expect, it } from 'vitest';
import { isTextBlock, isToolResultBlock, type Level, type RunPhase, type SchedulerAction, type Trigger } from '@protea/protocol';
import {
  decidePreemption,
  reply,
  sleep,
  textReply,
  toolCall,
  type ProviderRequest,
  type ToolSpec,
} from '../src/index.js';
import { makeHarness, waitFor, type Harness } from './helpers.js';

/** Text of the last user message of a request (where new events land). */
function lastUserText(req: ProviderRequest): string {
  const last = req.messages.at(-1);
  if (!last || last.role !== 'user') return '';
  return last.content
    .map((b) => (isTextBlock(b) ? b.text : isToolResultBlock(b) ? String(b.content) : ''))
    .join('\n');
}

function hasEvent(req: ProviderRequest, text: string): boolean {
  return req.messages.some((m) => m.content.some((b) => isTextBlock(b) && b.text.includes(text)));
}

/** A tool that takes `ms`; when interruptible it returns a partial receipt on abort. */
function slowTool(name: string, ms: number, interruptible = false, log?: string[]): ToolSpec<never> {
  const spec: ToolSpec<Record<string, unknown>> = {
    name,
    description: `slow ${name}`,
    inputSchema: { type: 'object' },
    ...(interruptible ? { flags: { interruptible: true } } : {}),
    handler: (_i, ctx) =>
      new Promise((resolve) => {
        log?.push(`${name}:start`);
        const t = setTimeout(() => {
          log?.push(`${name}:done`);
          resolve(`${name} done`);
        }, ms);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            log?.push(`${name}:partial`);
            resolve({ text: `${name}: partial (2 of 5 feeds)`, partial: true });
          },
          { once: true },
        );
      }),
  };
  return spec as unknown as ToolSpec<never>;
}

function actions(h: Harness): SchedulerAction[] {
  const out: SchedulerAction[] = [];
  h.bus.on('scheduler.action', (a) => out.push(a));
  return out;
}

const pushBrief = (h: Harness) => h.push({ text: 'schedule "morning-brief" fired', level: 3, trigger: 'flush', type: 'cron.tick' }, 'cron', 3);

describe('preemption matrix', () => {
  const turn = (batchLevel: Level, phase: RunPhase, externalOutput = false) => ({ batchLevel, phase, externalOutput });

  it('follows docs/10-architecture/04-scheduling-and-preemption.md §4', () => {
    // N < C
    expect(decidePreemption(1, 'preempt', turn(3, 'model'))).toBe('preempt');
    expect(decidePreemption(1, 'preempt', turn(3, 'backoff'))).toBe('preempt');
    expect(decidePreemption(1, 'preempt', turn(3, 'model', true))).toBe('wait');
    expect(decidePreemption(1, 'preempt', turn(3, 'tools'))).toBe('wait');
    expect(decidePreemption(1, 'interrupt', turn(3, 'model'))).toBe('interrupt');
    expect(decidePreemption(1, 'interrupt', turn(3, 'model', true))).toBe('interrupt');
    expect(decidePreemption(1, 'interrupt', turn(3, 'tools'))).toBe('interrupt');
    // N = C
    expect(decidePreemption(1, 'preempt', turn(1, 'model'))).toBe('wait');
    expect(decidePreemption(1, 'interrupt', turn(1, 'model'))).toBe('interrupt');
    expect(decidePreemption(1, 'interrupt', turn(1, 'tools'))).toBe('interrupt');
    // N > C
    for (const t of ['preempt', 'interrupt'] as Trigger[]) {
      expect(decidePreemption(2, t, turn(1, 'model'))).toBe('wait');
      expect(decidePreemption(4, t, turn(3, 'tools'))).toBe('wait');
    }
    // Non-cancelling triggers and non-cancellable phases.
    for (const t of ['store', 'piggyback', 'debounce', 'flush'] as Trigger[]) expect(decidePreemption(0, t, turn(4, 'model'))).toBe('wait');
    for (const p of ['idle', 'delivering', 'handoff'] as RunPhase[]) expect(decidePreemption(0, 'interrupt', turn(4, p))).toBe('wait');
  });
});

describe('morning brief interrupted by the owner (§10)', () => {
  it('preempt during tools waits for the boundary and joins the tool results', async () => {
    const log: string[] = [];
    const h = makeHarness({
      extraTools: [slowTool('rss_fetch', 300, false, log)],
      steps: [
        (req) => {
          const said = req.messages.some((m) => m.content.some((b) => b.type === 'tool_use' && b['name'] === 'say'));
          if (said) return reply([toolCall('idle', {})]);
          if (hasEvent(req, 'what is on today')) return reply([toolCall('say', { text: 'Two meetings today.' })]);
          return reply([1, 2, 3, 4, 5].map((i) => toolCall('rss_fetch', { feed: i })));
        },
      ],
    });
    const acts = actions(h);
    try {
      pushBrief(h);
      await waitFor(() => log.includes('rss_fetch:start'));
      const t0 = Date.now();
      const owner = h.push({ text: 'what is on today?', level: 1, trigger: 'preempt' });
      await waitFor(() => h.store.get(owner.cursor as number)?.state === 'delivered', 3000, 'owner event delivered');
      const latency = Date.now() - t0;
      await h.idle();

      expect(latency).toBeLessThan(1000);
      expect(acts.filter((a) => a.kind === 'preempt' || a.kind === 'interrupt')).toEqual([]); // matrix: wait
      expect(log.filter((l) => l === 'rss_fetch:done')).toHaveLength(5);
      // The owner's message entered at the boundary, in the same user message as the tool results.
      const msgs = h.transcript.messages;
      const withOwner = msgs.find((m) => m.content.some((b) => isTextBlock(b) && b.text.includes('what is on today')));
      expect(withOwner?.content.filter(isToolResultBlock)).toHaveLength(5);
      expect(h.outputs).toEqual(['Two meetings today.']);
      // One batch, raised to L1 by the owner's event.
      const batch = h.batches.get(h.store.get(owner.cursor as number)?.batchId as string);
      expect(batch?.level).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('interrupt cancels interruptible tools, keeps partial receipts and starts the next batch', async () => {
    const log: string[] = [];
    const h = makeHarness({
      extraTools: [slowTool('rss_fetch', 5000, true, log), slowTool('archive', 200, false, log), slowTool('pin', 10, false, log)],
      steps: [
        (req) => {
          if (hasEvent(req, 'stop')) return textReply('Stopped.');
          return reply([
            toolCall('rss_fetch', {}),
            toolCall('rss_fetch', {}),
            toolCall('archive', {}),
            toolCall('say', { text: 'fetching' }), // barrierAfter: later calls wait for the ones above
            toolCall('pin', {}),
          ]);
        },
      ],
    });
    const acts = actions(h);
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    try {
      const brief = pushBrief(h);
      await waitFor(() => log.includes('rss_fetch:start') && log.includes('archive:start'));
      const t0 = Date.now();
      const stop = h.push({ text: 'stop', level: 1, trigger: 'interrupt' });
      await waitFor(() => h.store.get(stop.cursor as number)?.state === 'delivered', 3000, 'stop delivered');
      const latency = Date.now() - t0;
      await h.idle();

      expect(latency).toBeLessThan(1000);
      expect(acts).toMatchObject([{ kind: 'interrupt', cursor: stop.cursor, level: 1, batchLevel: 3, phase: 'tools' }]);
      expect(ended).toEqual(['interrupted', 'end_turn']);
      // Interruptible tools returned partial receipts; the plain tool ran to completion; nothing new started.
      expect(log.filter((l) => l === 'rss_fetch:partial')).toHaveLength(2);
      expect(log).toContain('archive:done');
      expect(log).not.toContain('pin:start');
      const results = h.transcript.messages.flatMap((m) => m.content.filter(isToolResultBlock));
      expect(results.map((r) => r.content)).toEqual([
        'rss_fetch: partial (2 of 5 feeds)',
        'rss_fetch: partial (2 of 5 feeds)',
        'archive done',
        'said',
        'not run: the turn was interrupted',
      ]);
      // The next batch carries the interrupting event and the runtime's notice.
      const second = h.batches.get(h.store.get(stop.cursor as number)?.batchId as string);
      expect(second?.level).toBe(1);
      expect(second?.id).not.toBe(h.store.get(brief.cursor as number)?.batchId);
      const notice = h.store.query({ type: 'session.turn_cancelled' })[0];
      expect(notice?.state).toBe('delivered');
      expect(notice?.batchId).toBe(second?.id);
      expect(notice?.text).toContain(`#${stop.cursor}`);
      expect(h.transcript.needsResume()).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('preempt during the model call cancels it and re-requests with the merged events', async () => {
    const h = makeHarness({
      steps: [
        async (req, _i, { signal }) => {
          if (hasEvent(req, 'quick question')) return reply([toolCall('say', { text: 'answer' }), toolCall('idle', {})]);
          await sleep(5000, signal); // the long morning-brief call
          return textReply('brief');
        },
      ],
    });
    const acts = actions(h);
    const provider = h.provider as unknown as { calls: ProviderRequest[] };
    try {
      pushBrief(h);
      await waitFor(() => provider.calls.length === 1 && h.main.phase === 'model');
      const t0 = Date.now();
      const q = h.push({ text: 'quick question', level: 1, trigger: 'preempt' });
      await waitFor(() => provider.calls.length === 2, 3000, 'second request');
      const latency = Date.now() - t0;
      await h.idle();

      expect(latency).toBeLessThan(1000);
      expect(acts).toMatchObject([{ kind: 'preempt', cursor: q.cursor, batchLevel: 3, phase: 'model' }]);
      // Same batch, now at level 1; the second request extends the first with the new event.
      const first = provider.calls[0] as ProviderRequest;
      const second = provider.calls[1] as ProviderRequest;
      const before = first.messages[0]?.content ?? [];
      expect(second.messages).toHaveLength(1);
      expect(second.messages[0]?.content.slice(0, before.length)).toEqual(before);
      expect(lastUserText(second)).toContain('quick question');
      expect(second.effort).toBe('medium');
      const batchId = h.store.get(q.cursor as number)?.batchId as string;
      expect(h.batches.get(batchId)).toMatchObject({ level: 1, endReason: 'ends_turn', rounds: 2 });
      expect(h.outputs).toEqual(['answer']);
      // Nothing of the cancelled call reached the transcript; the cancel is recorded.
      expect(h.transcript.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
      expect(h.store.query({ type: 'session.preempted' })[0]?.state).toBe('archived');
    } finally {
      await h.close();
    }
  });

  it('does not preempt a call whose output already reached the outside world', async () => {
    const tapped: string[] = [];
    const h = makeHarness({
      outputTap: (d) => tapped.push(d),
      steps: [
        async (req, _i, { signal, onText }) => {
          if (hasEvent(req, 'quick question')) return reply([toolCall('idle', {})]);
          onText?.('Good morning');
          await sleep(300, signal);
          return textReply('Good morning, here is the brief.');
        },
      ],
    });
    const acts = actions(h);
    try {
      pushBrief(h);
      await waitFor(() => tapped.length > 0);
      const q = h.push({ text: 'quick question', level: 1, trigger: 'preempt' });
      await waitFor(() => h.store.get(q.cursor as number)?.state === 'delivered');
      await h.idle();
      expect(acts).toEqual([]);
      expect(h.transcript.messages.filter((m) => m.role === 'assistant').map((m) => m.content[0])).toContainEqual({
        type: 'text',
        text: 'Good morning, here is the brief.',
      });
    } finally {
      await h.close();
    }
  });

  it('interrupt during the model call ends the batch; same-level preempt waits', async () => {
    const h = makeHarness({
      steps: [
        async (req, _i, { signal }) => {
          if (hasEvent(req, 'never mind')) return reply([toolCall('idle', {})]);
          await sleep(5000, signal);
          return textReply('long answer');
        },
      ],
    });
    const acts = actions(h);
    const ended: string[] = [];
    h.bus.on('batch.ended', (b) => ended.push(b.endReason));
    try {
      h.push({ text: 'tell me a long story', level: 1, trigger: 'flush' });
      await waitFor(() => h.main.phase === 'model');
      h.push({ text: 'also this', level: 1, trigger: 'preempt' }); // N = C: waits
      await sleep(50);
      expect(acts).toEqual([]);
      const stop = h.push({ text: 'never mind', level: 1, trigger: 'interrupt' }); // N = C: interrupts
      await waitFor(() => h.store.get(stop.cursor as number)?.state === 'delivered');
      await h.idle();
      expect(acts).toMatchObject([{ kind: 'interrupt', level: 1, batchLevel: 1, phase: 'model' }]);
      expect(ended).toEqual(['interrupted', 'ends_turn']);
      expect(h.transcript.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('never lets an L3/L4 source cut a turn short: interrupt is downgraded and recorded', async () => {
    const h = makeHarness({
      steps: [
        async (req, _i, { signal }) => {
          if (req.messages.length > 1) return reply([toolCall('idle', {})]);
          await sleep(300, signal);
          return reply([toolCall('idle', {})]);
        },
      ],
    });
    const acts = actions(h);
    try {
      h.push({ text: 'owner asks', level: 1, trigger: 'flush' });
      await waitFor(() => h.main.phase === 'model');
      const feed = h.push({ text: 'rss item', level: 4, trigger: 'interrupt', type: 'rss.item' }, 'rss', 4);
      expect(feed.effectiveTrigger).toBe('piggyback');
      expect(feed.warnings.join(' ')).toContain('trigger interrupt is not allowed at level 4');
      await h.idle();
      expect(acts).toEqual([]);
      const note = h.store.query({ type: 'core.event_downgraded' })[0];
      expect(note?.text).toContain(`#${feed.cursor}`);
    } finally {
      await h.close();
    }
  });

  it('cools a source down after a preemption storm', async () => {
    const h = makeHarness({
      preemptStorm: { count: 3, windowMs: 10_000, cooldownMs: 60_000 },
      steps: [
        async (_req, _i, { signal }) => {
          await sleep(5000, signal);
          return reply([toolCall('idle', {})]);
        },
      ],
    });
    const acts = actions(h);
    try {
      h.push({ text: 'start', level: 1, trigger: 'flush' });
      for (let i = 1; i <= 3; i++) {
        await waitFor(() => h.main.phase === 'model');
        const r = h.push({ text: `stop ${i}`, level: 1, trigger: 'interrupt' });
        await waitFor(() => h.store.get(r.cursor as number)?.state === 'delivered', 3000, `stop ${i} delivered`);
      }
      await waitFor(() => h.main.phase === 'model');
      const late = [4, 5].map((i) => h.push({ text: `stop ${i}`, level: 1, trigger: 'interrupt' }));
      await sleep(50);

      expect(acts.filter((a) => a.kind === 'interrupt')).toHaveLength(3);
      expect(acts.filter((a) => a.kind === 'storm_cooldown')).toMatchObject([{ source: 'test' }]);
      expect(h.scheduler.cooldowns().map((c) => c.source)).toEqual(['test']);
      // During the cooldown the urgent events wait for the boundary like flush.
      for (const r of late) expect(h.store.get(r.cursor as number)?.state).toBe('pending');
      expect(h.store.query({ type: 'scheduler.storm_cooldown' })).toHaveLength(1);
    } finally {
      await h.close(0);
    }
  });
});
