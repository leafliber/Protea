import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TRIGGERS, type Level, type Trigger } from '@protea/protocol';
import { ScriptedProvider, reply, sleep, textReply, toolCall, type ProviderRequest } from '../src/index.js';
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

describe('invariants', () => {
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
