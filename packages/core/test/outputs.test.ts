import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BatchRepo, Bus, EventStore, OutputLog, openDatabase, type Clock, type GatedEvent } from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup() {
  const { db } = openDatabase(path.join(tmpDir(), 'p.db'));
  let now = Date.parse('2026-11-05T08:00:00.000Z');
  const clock: Clock = { now: () => now } as Clock;
  const store = new EventStore(db, new Bus(), { runId: 'r1', clock });
  const outputs = new OutputLog(db);
  const batches = new BatchRepo(db);
  const at = () => new Date(now).toISOString();
  const tick = (ms = 1000) => (now += ms);
  const say = (text: string, over: Partial<GatedEvent> = {}) =>
    store.append({
      type: 'console.message',
      ts: at(),
      level: 1,
      trigger: 'flush',
      text,
      source: 'console',
      origin: 'external',
      effLevel: 1,
      effTrigger: 'flush',
      senderKey: 'console:owner',
      ...over,
    }).envelope;
  return { db, store, outputs, batches, at, tick, say };
}

describe('OutputLog chat history', () => {
  it('merges console messages and replies by time, pages backwards, and leaves other sources out', () => {
    const { store, outputs, batches, at, tick, say } = setup();
    const m1 = say('first');
    batches.start({ id: 'b1', level: 1, reason: 'flush', sessionId: 'main', startedAt: at() });
    store.markDelivering([m1.cursor], 'b1');
    // Same millisecond as the message: the reply still sorts after it.
    outputs.record({ at: at(), plugin: 'console', channel: 'console', text: 'reply one', batchId: 'b1', sessionId: 'main' });
    store.settle([m1.cursor], 'delivered', { batchId: 'b1', sessionId: 'main' });
    batches.end('b1', 'end_turn', at());
    tick();
    say('from telegram', { source: 'telegram', type: 'telegram.message' });
    outputs.record({ at: at(), plugin: 'telegram', text: 'not console' });
    outputs.record({ at: at(), plugin: 'console', channel: 'approvals', text: 'Approval a1 requested' });
    tick();
    const m2 = say('second');

    const all = outputs.chat();
    expect(all.items.map((i) => [i.kind, i.text])).toEqual([
      ['owner', 'first'],
      ['reply', 'reply one'],
      ['notice', 'Approval a1 requested'],
      ['owner', 'second'],
    ]);
    expect(all.items[0]).toMatchObject({ key: `e${m1.cursor}`, cursor: m1.cursor, state: 'delivered', sender: 'console:owner', batchId: 'b1' });
    expect(all.items[3]).toMatchObject({ key: `e${m2.cursor}`, state: 'pending' });
    expect(all.before).toBeNull();
    expect(all.batches).toEqual([{ id: 'b1', endReason: 'end_turn', endedAt: expect.any(String), sources: ['console'], replied: true }]);

    const p1 = outputs.chat({ limit: 2 });
    expect(p1.items.map((i) => i.text)).toEqual(['Approval a1 requested', 'second']);
    expect(p1.before).not.toBeNull();
    const p2 = outputs.chat({ limit: 2, before: p1.before as string });
    expect(p2.items.map((i) => i.text)).toEqual(['first', 'reply one']);
    expect(p2.before).toBeNull();
    expect(outputs.chat({ before: 'garbage' }).items).toHaveLength(4);
  });

  it('explains a batch that failed and one that never replied', () => {
    const { store, outputs, batches, at, tick, say } = setup();
    const m = say('hello?');
    batches.start({ id: 'b9', level: 1, reason: 'flush', sessionId: 'main', startedAt: at() });
    store.markDelivering([m.cursor], 'b9');
    store.settle([m.cursor], 'delivered', { batchId: 'b9' });
    store.append({
      type: 'model.error',
      ts: at(),
      level: 4,
      trigger: 'store',
      text: 'Model call failed for batch b9 (config): secret PROVIDER_X_API_KEY is not set',
      source: 'core',
      origin: 'internal',
      effLevel: 4,
      effTrigger: 'store',
      meta: { batchId: 'b9', kind: 'config' },
    });
    batches.end('b9', 'model_error', at());
    tick();
    const n = say('still there?');
    batches.start({ id: 'b10', level: 1, reason: 'flush', sessionId: 'main', startedAt: at() });
    store.markDelivering([n.cursor], 'b10');
    store.settle([n.cursor], 'delivered', { batchId: 'b10' });
    batches.end('b10', 'end_turn', at());

    const { batches: info } = outputs.chat();
    expect(info).toEqual([
      { id: 'b9', endReason: 'model_error', endedAt: expect.any(String), sources: ['console'], replied: false, error: 'secret PROVIDER_X_API_KEY is not set' },
      { id: 'b10', endReason: 'end_turn', endedAt: expect.any(String), sources: ['console'], replied: false },
    ]);
    expect(outputs.batches(['nope'])).toEqual([]);
  });

  it('recovers replies sent before the outputs table existed, once', () => {
    const { outputs } = setup();
    const dir = tmpDir();
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const toolUse = (id: string, text: string) => ({ type: 'tool_use', id, name: 'con_send', input: { text } });
    fs.writeFileSync(
      path.join(dir, 'main.0001.jsonl'),
      line({ t: 'msg', role: 'assistant', at: '2026-11-01T10:00:00.000Z', batch: 'b_old', content: [toolUse('t1', 'earlier reply'), toolUse('t2', 'blocked reply')] }) +
        line({ t: 'msg', role: 'user', at: '2026-11-01T10:00:01.000Z', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }, { type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }] }) +
        'not json\n' +
        line({ t: 'msg', role: 'assistant', at: '2999-01-01T00:00:00.000Z', batch: 'b_new', content: [toolUse('t3', 'already stored')] }),
    );
    fs.writeFileSync(path.join(dir, 'main.0002.jsonl'), line({ t: 'msg', role: 'assistant', at: '2026-11-02T09:00:00.000Z', content: [toolUse('t4', 'after a handoff')] }));
    fs.writeFileSync(path.join(dir, 'fork-x.jsonl'), line({ t: 'msg', role: 'assistant', at: '2026-11-02T09:00:00.000Z', content: [toolUse('t5', 'not main')] }));
    expect(outputs.backfillFromTranscripts(dir)).toBe(2);
    expect(outputs.chat().items.map((i) => [i.kind, i.text, i.batchId])).toEqual([
      ['reply', 'earlier reply', 'b_old'],
      ['reply', 'after a handoff', undefined],
    ]);
    expect(outputs.backfillFromTranscripts(dir)).toBe(0);
    expect(outputs.chat().items).toHaveLength(2);
  });
});
