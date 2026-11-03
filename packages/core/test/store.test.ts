import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Bus, EventStore, migrate, openDatabase, systemClock, type GatedEvent, type SettledData } from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup() {
  const { db } = openDatabase(path.join(tmpDir(), 'p.db'));
  const bus = new Bus();
  const stored: number[] = [];
  const settled: SettledData[] = [];
  bus.on('event.stored', (e) => stored.push(e.cursor));
  bus.on('event.settled', (s) => settled.push(s));
  return { db, bus, store: new EventStore(db, bus, { runId: 'r1', clock: systemClock }), stored, settled };
}

const ev = (over: Partial<GatedEvent> = {}): GatedEvent => ({
  type: 'x.y',
  ts: '2026-11-03T00:00:00Z',
  level: 2,
  trigger: 'flush',
  text: 'hello',
  source: 'x',
  origin: 'external',
  effLevel: 2,
  effTrigger: 'flush',
  ...over,
});

describe('EventStore', () => {
  it('assigns increasing cursors and an initial state from the trigger', () => {
    const { store, stored } = setup();
    const a = store.append(ev());
    const b = store.append(ev({ effTrigger: 'store', trigger: 'store', effLevel: 4, level: 4 }));
    expect(b.envelope.cursor).toBeGreaterThan(a.envelope.cursor);
    expect(a.envelope.state).toBe('pending');
    expect(b.envelope.state).toBe('archived');
    expect(stored).toEqual([a.envelope.cursor, b.envelope.cursor]);
  });

  it('deduplicates per source and dedupe key without re-announcing', () => {
    const { store, stored } = setup();
    const a = store.append(ev({ dedupeKey: 'k1' }));
    const b = store.append(ev({ dedupeKey: 'k1', text: 'different' }));
    const c = store.append(ev({ dedupeKey: 'k1', source: 'other' }));
    expect(b.deduped).toBe(true);
    expect(b.envelope.cursor).toBe(a.envelope.cursor);
    expect(c.deduped).toBe(false);
    expect(stored).toHaveLength(2);
  });

  it('round-trips optional fields', () => {
    const { store } = setup();
    const { envelope } = store.append(
      ev({ senderKey: 's:1', senderRole: 'owner', tags: ['a'], meta: { n: 1 }, correlation: 'c', ephemeral: true }),
    );
    expect(store.get(envelope.cursor)).toMatchObject({ senderKey: 's:1', senderRole: 'owner', tags: ['a'], meta: { n: 1 }, correlation: 'c', ephemeral: true });
  });

  it('settles each event exactly once and records the delivery', () => {
    const { store, settled } = setup();
    const { envelope } = store.append(ev());
    store.markDelivering([envelope.cursor], 'b1');
    expect(store.get(envelope.cursor)?.state).toBe('delivering');
    expect(store.settle([envelope.cursor], 'delivered', { batchId: 'b1', sessionId: 'main' })).toEqual([envelope.cursor]);
    expect(store.settle([envelope.cursor], 'discarded')).toEqual([]);
    expect(store.get(envelope.cursor)?.state).toBe('delivered');
    expect(store.deliveryOf(envelope.cursor)).toMatchObject({ outcome: 'delivered', batchId: 'b1' });
    expect(settled).toHaveLength(1);
    expect(settled[0]?.events).toEqual([{ cursor: envelope.cursor, source: 'x' }]);
  });

  it('reverts delivering events to pending', () => {
    const { store } = setup();
    const { envelope } = store.append(ev());
    store.markDelivering([envelope.cursor], 'b1');
    store.revertToPending([envelope.cursor]);
    expect(store.get(envelope.cursor)).toMatchObject({ state: 'pending' });
    expect(store.get(envelope.cursor)?.batchId).toBeUndefined();
  });

  it('filters queries and counts pending by level', () => {
    const { store } = setup();
    store.append(ev({ effLevel: 1, level: 1 }));
    store.append(ev({ effLevel: 3, level: 3, source: 'cron', type: 'cron.tick' }));
    store.append(ev({ effLevel: 3, level: 3, source: 'cron', type: 'cron.tick' }));
    expect(store.pendingCounts()).toMatchObject({ 1: 1, 3: 2, 0: 0 });
    expect(store.query({ source: 'cron' })).toHaveLength(2);
    expect(store.query({ maxLevel: 2 })).toHaveLength(1);
    expect(store.query({ order: 'desc', limit: 1 })[0]?.cursor).toBe(3);
  });
});

describe('migrations', () => {
  it('are idempotent and refuse a newer schema', () => {
    const db = new Database(':memory:');
    expect(migrate(db).applied).toEqual(['1_init']);
    expect(migrate(db).applied).toEqual([]);
    db.prepare("INSERT INTO schema_version VALUES (99, 'future', 'now')").run();
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });
});
