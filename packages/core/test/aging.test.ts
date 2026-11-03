import { describe, expect, it } from 'vitest';
import { isTextBlock, type Level, type SchedulerAction } from '@protea/protocol';
import { reply, sleep, textReply, toolCall, type LevelSettings, type ProviderRequest } from '../src/index.js';
import { FAST_LEVELS, makeHarness, waitFor } from './helpers.js';

function levels(over: Partial<Record<Level, Partial<LevelSettings>>>): Record<Level, LevelSettings> {
  const out = structuredClone(FAST_LEVELS);
  for (const [l, v] of Object.entries(over)) Object.assign(out[Number(l) as Level], v);
  return out;
}

function hasEvent(req: ProviderRequest, text: string): boolean {
  return req.messages.some((m) => m.content.some((b) => isTextBlock(b) && b.text.includes(text)));
}

describe('aging', () => {
  it('promotes an L3 event that waited past maxWaitMs to flush, keeping its level', async () => {
    // A 10 s window would normally hold the event; aging delivers it after ~150 ms.
    const h = makeHarness({ levels: levels({ 3: { debounceMs: 10_000, maxWaitMs: 150 } }) });
    const acts: SchedulerAction[] = [];
    h.bus.on('scheduler.action', (a) => acts.push(a));
    try {
      const t0 = Date.now();
      const r = h.push({ text: 'hourly digest', level: 3, trigger: 'debounce', type: 'cron.tick' }, 'cron', 3);
      await waitFor(() => h.store.get(r.cursor as number)?.state === 'delivered', 3000, 'aged delivery');
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(140);
      expect(waited).toBeLessThan(2000);
      const e = h.store.get(r.cursor as number);
      expect(e).toMatchObject({ effLevel: 3, effTrigger: 'flush' });
      expect(acts).toEqual([{ kind: 'aged', cursors: [r.cursor] }]);
      const note = h.store.query({ type: 'scheduler.aged' })[0];
      expect(note?.state).toBe('archived');
      expect(note?.text).toContain(`#${r.cursor} (L3 cron.tick`);
      await h.idle();
    } finally {
      await h.close();
    }
  });

  it('ages piggyback events that nothing else would deliver', async () => {
    const h = makeHarness({ levels: levels({ 4: { maxWaitMs: 100 } }) });
    try {
      const r = h.push({ text: 'feed item', level: 4, trigger: 'piggyback', type: 'rss.item' }, 'rss', 4);
      await sleep(30);
      expect(h.store.get(r.cursor as number)?.state).toBe('pending');
      await waitFor(() => h.store.get(r.cursor as number)?.state === 'delivered', 3000);
      await h.idle();
    } finally {
      await h.close();
    }
  });

  it('never preempts: an aged event waits for the boundary of a more urgent batch', async () => {
    const h = makeHarness({
      levels: levels({ 3: { debounceMs: 10_000, maxWaitMs: 80 } }),
      steps: [
        async (req, _i, { signal }) => {
          if (req.messages.length === 1) {
            await sleep(400, signal); // the owner's long first call
            return reply([toolCall('say', { text: 'working' })]);
          }
          return reply([toolCall('idle', {})]);
        },
      ],
    });
    const acts: SchedulerAction[] = [];
    h.bus.on('scheduler.action', (a) => acts.push(a));
    try {
      h.push({ text: 'owner request', level: 1, trigger: 'flush' });
      await waitFor(() => h.main.phase === 'model');
      const r = h.push({ text: 'digest', level: 3, trigger: 'debounce' }, 'cron', 3);
      await waitFor(() => acts.some((a) => a.kind === 'aged'));
      expect(h.main.phase).toBe('model'); // still running: aging did not cancel anything
      await waitFor(() => h.store.get(r.cursor as number)?.state === 'delivered', 3000);
      await h.idle();
      // Delivered into the running batch at its boundary, after the tool result.
      const msg = h.transcript.messages.find((m) => m.content.some((b) => isTextBlock(b) && b.text.includes('digest')));
      expect(msg?.content[0]?.type).toBe('tool_result');
      expect(acts.filter((a) => a.kind === 'preempt' || a.kind === 'interrupt')).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('re-arms aging after a restart from the stored receive time', async () => {
    const lv = levels({ 3: { debounceMs: 60_000, maxWaitMs: 300 } });
    const h1 = makeHarness({ levels: lv });
    const r = h1.push({ text: 'digest', level: 3, trigger: 'debounce' }, 'cron', 3);
    await h1.close();
    const h2 = makeHarness({ dir: h1.dir, levels: lv });
    try {
      await waitFor(() => h2.store.get(r.cursor as number)?.state === 'delivered', 3000);
      expect(h2.store.get(r.cursor as number)?.effTrigger).toBe('flush');
      await h2.idle();
    } finally {
      await h2.close();
    }
  });
});

describe('events_promote', () => {
  it('brings an archived event into the running batch at the next boundary', async () => {
    let cursor = 0;
    const h = makeHarness({
      steps: [
        (req) => {
          if (hasEvent(req, 'disk usage 91%')) return textReply('noted');
          return reply([toolCall('events_promote', { cursor, trigger: 'flush' })]);
        },
      ],
    });
    try {
      const archived = h.push({ text: 'disk usage 91%', level: 4, trigger: 'store', type: 'log.line' }, 'logs', 4);
      cursor = archived.cursor as number;
      expect(h.store.get(cursor)?.state).toBe('archived');
      const ask = h.push({ text: 'anything in the logs?', level: 1, trigger: 'flush' });
      await waitFor(() => h.store.get(cursor)?.state === 'delivered', 3000);
      await h.idle();
      const e = h.store.get(cursor);
      expect(e).toMatchObject({ effLevel: 4, effTrigger: 'flush' });
      expect(e?.batchId).toBe(h.store.get(ask.cursor as number)?.batchId);
      const results = h.transcript.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
      expect(results[0]?.['content']).toContain('is pending with trigger flush');
    } finally {
      await h.close();
    }
  });

  it('refuses events that were already delivered', async () => {
    // The batch starts inside push(), so read the cursor of the delivered event from the request.
    const cursorIn = (req: ProviderRequest): number => {
      const b = req.messages[0]?.content[0];
      return Number(/cursor="(\d+)"/.exec(b && isTextBlock(b) ? b.text : '')?.[1]);
    };
    const h = makeHarness({
      steps: [
        (req) => (req.messages.length === 1 ? reply([toolCall('events_promote', { cursor: cursorIn(req), trigger: 'flush' })]) : textReply('ok')),
      ],
    });
    try {
      const r = h.push({ text: 'hello', level: 1, trigger: 'flush' });
      const cursor = r.cursor as number;
      await waitFor(() => h.store.get(cursor)?.state === 'delivered');
      await h.idle();
      const result = h.transcript.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'))[0];
      expect(result).toMatchObject({ is_error: true, content: `event #${cursor} is already delivered` });
    } finally {
      await h.close();
    }
  });
});
