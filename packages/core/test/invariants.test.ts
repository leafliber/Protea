import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TRIGGERS, type Level, type Trigger } from '@protea/protocol';
import {
  ScriptedProvider,
  reply,
  sleep,
  textReply,
  toolCall,
  type Provider,
  type ProviderRequest,
  type ScriptStep,
  type ToolSpec,
} from '../src/index.js';
import { makeHarness, waitFor } from './helpers.js';

function transcriptCursorCounts(file: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const rec = JSON.parse(line) as { cursors?: number[] };
    for (const c of rec.cursors ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

/** Wraps a scripted provider to count model calls in flight. */
function countingProvider(steps: ScriptStep[]): { provider: Provider; inner: ScriptedProvider; inFlight: () => number } {
  const inner = new ScriptedProvider(steps);
  let n = 0;
  const provider: Provider = {
    id: 'counting',
    modelFor: (r) => inner.modelFor(r),
    health: () => inner.health(),
    generate: async (req, opts) => {
      n++;
      try {
        return await inner.generate(req, opts);
      } finally {
        n--;
      }
    },
  };
  return { provider, inner, inFlight: () => n };
}

/** Tools that count how many handlers are running; `iwork` is interruptible. */
function countedTools(): { tools: ToolSpec<never>[]; running: () => number } {
  let n = 0;
  const make = (name: string, ms: number, interruptible: boolean): ToolSpec<never> => {
    const spec: ToolSpec<Record<string, unknown>> = {
      name,
      description: name,
      inputSchema: { type: 'object' },
      ...(interruptible ? { flags: { interruptible: true } } : {}),
      handler: (_i, ctx) =>
        new Promise((resolve) => {
          n++;
          const done = (text: string): void => {
            n--;
            resolve({ text, ...(text.endsWith('partial') ? { partial: true } : {}) });
          };
          const t = setTimeout(() => done(`${name} done`), ms);
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              done(`${name} partial`);
            },
            { once: true },
          );
        }),
    };
    return spec as unknown as ToolSpec<never>;
  };
  return { tools: [make('work', 8, false), make('iwork', 30, true)], running: () => n };
}

const SOURCES = [
  { source: 'test', maxLevel: 1 as Level },
  { source: 'hook', maxLevel: 2 as Level },
  { source: 'cron', maxLevel: 3 as Level },
  { source: 'rss', maxLevel: 4 as Level },
];

const mixedSteps = (mode: number): ScriptStep[] => [
  async (_req, i, { signal }) => {
    await sleep(i === 0 ? 40 : 3 + (i % 3) * 5, signal);
    switch ((i + mode) % 4) {
      case 0:
        return reply([toolCall('work', {}), toolCall('iwork', {}), toolCall('say', { text: 'x' })]);
      case 1:
        return reply([toolCall('iwork', {})]);
      case 2:
        return textReply('ok');
      default:
        return reply([toolCall('idle', {})]);
    }
  },
];

/** Every run starts with a busy L3 batch and an owner event that preempts it, then the random events follow. */
async function seedPreemption(h: ReturnType<typeof makeHarness>): Promise<void> {
  h.push({ text: 'seed brief', level: 3, trigger: 'flush' }, 'cron', 3);
  await waitFor(() => h.main.phase === 'model');
  h.push({ text: 'seed owner', level: 1, trigger: 'preempt' });
}

describe('invariants', () => {
  it('I-3: the conversation only changes at turn boundaries, across preempts and interrupts', async () => {
    const op = fc.record({
      src: fc.integer({ min: 0, max: 3 }),
      level: fc.constantFrom<Level>(1, 2, 3, 4),
      trigger: fc.constantFrom<Trigger>(...TRIGGERS),
      gapMs: fc.integer({ min: 0, max: 15 }),
    });
    let cancels = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), fc.integer({ min: 0, max: 3 }), async (ops, mode) => {
        const { provider, inner, inFlight } = countingProvider(mixedSteps(mode));
        const counted = countedTools();
        const h = makeHarness({ provider, extraTools: counted.tools });
        const violations: string[] = [];
        const append = h.transcript.appendMessage.bind(h.transcript);
        h.transcript.appendMessage = (m) => {
          if (inFlight() > 0 || counted.running() > 0) {
            violations.push(`append of a ${m.role} message with ${inFlight()} model call(s) and ${counted.running()} tool(s) running`);
          }
          append(m);
        };
        h.bus.on('scheduler.action', (a) => {
          if (a.kind === 'preempt' || a.kind === 'interrupt') cancels++;
        });
        try {
          await seedPreemption(h);
          for (const o of ops) {
            const s = SOURCES[o.src] as (typeof SOURCES)[number];
            h.push({ text: `e ${o.level} ${o.trigger}`, level: o.level, trigger: o.trigger }, s.source, s.maxLevel);
            if (o.gapMs) await sleep(o.gapMs);
          }
          await h.idle(10_000);
          expect(violations).toEqual([]);
          // Every request extends the one before it: nothing in the context was ever rewritten.
          const flat = (req: ProviderRequest): string[] => req.messages.flatMap((m) => m.content.map((b) => `${m.role}:${JSON.stringify(b)}`));
          for (let i = 1; i < inner.calls.length; i++) {
            const a = flat(inner.calls[i - 1] as ProviderRequest);
            expect(flat(inner.calls[i] as ProviderRequest).slice(0, a.length)).toEqual(a);
          }
        } finally {
          await h.close();
        }
      }),
      { numRuns: 25 },
    );
    expect(cancels).toBeGreaterThan(0); // the runs did exercise preemption
  }, 120_000);

  it('I-5: a turn is only cut short by a more urgent event, or by an interrupt of the same level', async () => {
    const op = fc.record({
      src: fc.integer({ min: 0, max: 3 }),
      level: fc.constantFrom<Level>(0, 1, 2, 3, 4),
      trigger: fc.constantFrom<Trigger>(...TRIGGERS),
      gapMs: fc.integer({ min: 0, max: 12 }),
    });
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 2, maxLength: 12 }), fc.integer({ min: 0, max: 3 }), async (ops, mode) => {
        const counted = countedTools();
        const h = makeHarness({ steps: mixedSteps(mode), extraTools: counted.tools });
        // The batch level as observed from outside the scheduler.
        let current: Level | null = null;
        h.bus.on('batch.started', (b) => {
          current = b.level;
        });
        h.bus.on('batch.extended', (b) => {
          current = b.level;
        });
        h.bus.on('batch.ended', () => {
          current = null;
        });
        const bad: string[] = [];
        h.bus.on('scheduler.action', (a) => {
          if (a.kind !== 'preempt' && a.kind !== 'interrupt') return;
          checked++;
          const ev = h.store.get(a.cursor);
          const lvl = ev?.effLevel;
          const ok =
            current !== null &&
            lvl !== undefined &&
            lvl <= 2 &&
            (a.kind === 'preempt' ? lvl < current : lvl <= 1 && lvl <= current) &&
            a.batchLevel === current;
          if (!ok) bad.push(`${a.kind} by L${lvl} event #${a.cursor} of a L${current} batch`);
        });
        try {
          await seedPreemption(h);
          for (const o of ops) {
            const s = SOURCES[o.src] as (typeof SOURCES)[number];
            h.push({ text: `e ${o.level} ${o.trigger}`, level: o.level, trigger: o.trigger }, s.source, s.maxLevel);
            if (o.gapMs) await sleep(o.gapMs);
          }
          await h.idle(10_000);
          expect(bad).toEqual([]);
        } finally {
          await h.close();
        }
      }),
      { numRuns: 30 },
    );
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it('I-1/I-2: batches never overlap and every event ends with exactly one terminal record, across aborts and restarts', async () => {
    const op = fc.record({
      level: fc.constantFrom<Level>(1, 2, 3, 4),
      trigger: fc.constantFrom<Trigger>(...TRIGGERS),
      gapMs: fc.integer({ min: 0, max: 12 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 40 }), fc.boolean(), async (ops, abortAfter, tools) => {
        const timeline: string[] = [];
        const provider1 = new ScriptedProvider(
          [(_req, i) => (tools && i % 2 === 0 ? reply([toolCall('say', { text: 'x' })]) : textReply('ok'))],
          4,
        );
        const h1 = makeHarness({ provider: provider1 });
        h1.bus.on('batch.started', (b) => timeline.push(`start:${b.batchId}`));
        h1.bus.on('batch.ended', (b) => timeline.push(`end:${b.batchId}`));
        const cursors: number[] = [];
        for (const o of ops) {
          const r = h1.push({ text: `e${cursors.length}`, level: o.level, trigger: o.trigger });
          if (r.cursor !== undefined) cursors.push(r.cursor);
          if (o.gapMs) await sleep(o.gapMs);
        }
        await sleep(abortAfter);
        await h1.close(0); // abort whatever is running: the next start must recover

        const h2 = makeHarness({ dir: h1.dir, provider: new ScriptedProvider([() => textReply('ok')]), start: false });
        h2.bus.on('batch.started', (b) => timeline.push(`start:${b.batchId}`));
        h2.bus.on('batch.ended', (b) => timeline.push(`end:${b.batchId}`));
        h2.scheduler.start();
        const final = h2.push({ text: 'final', level: 1, trigger: 'flush' });
        cursors.push(final.cursor as number);
        await waitFor(() => h2.store.get(final.cursor as number)?.state === 'delivered');
        await h2.idle();

        try {
          // I-1: started/ended strictly alternate.
          for (let i = 0; i < timeline.length; i++) expect(timeline[i]?.startsWith(i % 2 === 0 ? 'start:' : 'end:')).toBe(true);
          // I-2: every event is terminal (delivered) or archived (store); terminal events have one delivery row.
          const seen = transcriptCursorCounts(path.join(h1.dir, 'main.jsonl'));
          for (const c of cursors) {
            const e = h2.store.get(c);
            expect(['delivered', 'archived']).toContain(e?.state);
            const d = h2.store.deliveryOf(c);
            if (e?.state === 'delivered') {
              expect(d?.outcome).toBe('delivered');
              expect(seen.get(c)).toBe(1); // rendered into the transcript exactly once
            } else {
              expect(d).toBeUndefined();
              expect(seen.has(c)).toBe(false);
            }
          }
          const rows = h2.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number };
          const delivered = h2.db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'delivered'").get() as { n: number };
          expect(rows.n).toBe(delivered.n);
        } finally {
          await h2.close();
        }
      }),
      { numRuns: 25 },
    );
  }, 120_000);

  it('keeps every request an append-only extension of the previous one over 100 pushes (prompt-cache stability)', async () => {
    const provider = new ScriptedProvider([
      (_req, i) => {
        switch (i % 5) {
          case 0:
            return reply([{ type: 'thinking', thinking: '', signature: `s${i}` }, toolCall('say', { text: `r${i}` })]);
          case 1:
            return textReply(`done ${i}`);
          case 2:
            return reply([toolCall('idle', {})]);
          default:
            return textReply(`ok ${i}`);
        }
      },
    ]);
    const h = makeHarness({ provider });
    try {
      for (let i = 0; i < 100; i++) {
        const r = h.push({ text: `message ${i}`, trigger: i % 3 === 0 ? 'debounce' : 'flush' });
        await waitFor(() => h.store.get(r.cursor as number)?.state === 'delivered');
        await h.idle();
      }
      const calls = provider.calls;
      expect(calls.length).toBeGreaterThan(100);
      const flat = (req: ProviderRequest): string[] => req.messages.flatMap((m) => m.content.map((b) => `${m.role}:${JSON.stringify(b)}`));
      const head = (req: ProviderRequest): string => JSON.stringify([req.system, req.tools]);
      let shared = 0;
      let total = 0;
      for (let i = 1; i < calls.length; i++) {
        const prev = calls[i - 1] as ProviderRequest;
        const cur = calls[i] as ProviderRequest;
        expect(head(cur)).toBe(head(prev));
        const a = flat(prev);
        const b = flat(cur);
        expect(b.slice(0, a.length)).toEqual(a);
        const prefixChars = head(prev).length + a.join('').length;
        shared += prefixChars;
        total += head(cur).length + b.join('').length;
      }
      // Byte-level proxy for the cache hit ratio: share of each request already sent in the previous one.
      expect(shared / total).toBeGreaterThan(0.8);
    } finally {
      await h.close();
    }
  }, 60_000);
});
