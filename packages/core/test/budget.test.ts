import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventInput, Level, Trigger } from '@protea/protocol';
import {
  BudgetTracker,
  Bus,
  EventStore,
  KvRepo,
  UsageRepo,
  kvNamespace,
  openDatabase,
  silentLogger,
  type BudgetSettings,
  type GatedEvent,
  type UsageRecord,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

type Notice = Omit<EventInput, 'ts' | 'origin'>;

function setup(dailyUsd: number | null, extra: Partial<BudgetSettings> = {}, dir = tmpDir()) {
  const { db } = openDatabase(path.join(dir, 'protea.db'));
  const bus = new Bus();
  const usage = new UsageRepo(db);
  const kv = new KvRepo(db);
  let now = Date.parse('2026-11-03T08:00:00Z');
  const clock = { now: () => now };
  const store = new EventStore(db, bus, { runId: 'r', clock });
  const notices: Notice[] = [];
  const settings: BudgetSettings = { dailyUsd, shares: { 0: null, 1: 0.6, 2: 0.2, 3: 0.15, 4: 0.05 }, warnAt: 0.9, enforce: true, hardDailyUsd: null, ...extra };
  const make = () =>
    new BudgetTracker({ usage, settings, bus, log: silentLogger(), clock, pushInternal: (e) => notices.push(e), kv: kvNamespace(kv, 'budget'), store });
  const budget = make();
  const spend = (level: Level, costUsd: number, atMs = now): void => {
    const rec: UsageRecord = {
      at: new Date(atMs).toISOString(),
      atMs,
      provider: 'p',
      model: 'm',
      role: 'main',
      sessionId: 'main',
      level,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
    };
    usage.record(rec);
    bus.emit('usage.recorded', rec);
  };
  /** What the event gateway does: gate, admit, append. */
  const push = (b: BudgetTracker, level: Level, trigger: Trigger, origin: 'external' | 'internal' = 'external') => {
    const ev: GatedEvent = { ts: new Date(now).toISOString(), type: 't', source: 's', origin, level, trigger, text: 'x', effLevel: level, effTrigger: trigger };
    const d = b.admit(ev);
    if (d) ev.effTrigger = d.trigger;
    const { envelope } = store.append(ev);
    d?.onStored(envelope);
    return envelope;
  };
  return { budget, make, spend, push, store, notices, advance: (ms: number) => (now += ms), close: () => (budget.close(), db.close()) };
}

describe('budget tracking', () => {
  it('attributes 24 h spend to level pools and reports each threshold once (enforcement off)', () => {
    const t = setup(10, { enforce: false });
    try {
      t.spend(3, 1.0); // L3 pool is $1.50
      expect(t.notices).toEqual([]);
      t.spend(3, 0.4); // 93 %
      t.spend(3, 0.01);
      expect(t.notices).toHaveLength(1);
      expect(t.notices[0]?.text).toContain('L3 budget is at 93%'); // the first crossing; 94 % is not reported again
      t.spend(3, 0.2); // over 100 %
      expect(t.notices).toHaveLength(2);
      expect(t.notices[1]?.text).toContain('Enforcement is off');
      const s = t.budget.status();
      expect(s.enforced).toBe(false);
      expect(s.levels[3]).toMatchObject({ spentUsd: 1.61, limitUsd: 1.5, tokens: 440 });
      expect(s.levels[0]).toMatchObject({ limitUsd: null, usedRatio: null });
      expect(t.budget.remainingPercent()).toEqual({ 1: 100, 2: 100, 3: 0, 4: 100 });
      expect(t.push(t.budget, 3, 'flush').effTrigger).toBe('flush');
      // A day later the window has moved on.
      t.advance(86_400_001);
      expect(t.budget.status().levels[3].spentUsd).toBe(0);
    } finally {
      t.close();
    }
  });

  it('only reports spend when no daily budget is set', () => {
    const t = setup(null);
    try {
      t.spend(1, 50);
      expect(t.notices).toEqual([]);
      expect(t.budget.status().levels[1]).toMatchObject({ spentUsd: 50, limitUsd: null });
      expect(t.budget.remainingPercent()).toEqual({});
      expect(t.push(t.budget, 2, 'flush').effTrigger).toBe('flush');
    } finally {
      t.close();
    }
  });
});

describe('budget enforcement', () => {
  it('changes how new events of an exhausted level are scheduled, and says so at L0', () => {
    const t = setup(10);
    try {
      t.spend(2, 2.5); // L2 pool $2 → over
      t.spend(3, 1.6); // L3 pool $1.50 → over
      const exhausted = t.notices.filter((n) => n.type === 'budget.exhausted');
      expect(exhausted.map((n) => [n.level, n.trigger])).toEqual([
        [0, 'flush'],
        [0, 'flush'],
      ]);
      expect(exhausted[0]?.text).toContain('piggyback');
      expect(exhausted[1]?.text).toContain('stored without being delivered');

      const l2 = t.push(t.budget, 2, 'flush');
      expect(l2).toMatchObject({ effTrigger: 'piggyback', state: 'pending' });
      expect(t.budget.isHeld(l2.cursor)).toBe(true);
      const l3 = t.push(t.budget, 3, 'debounce');
      expect(l3).toMatchObject({ effTrigger: 'store', state: 'archived' });
      // L1 (owner) and Core's own events are never held; a pool with budget left is untouched.
      expect(t.push(t.budget, 1, 'flush').effTrigger).toBe('flush');
      expect(t.push(t.budget, 3, 'flush', 'internal').effTrigger).toBe('flush');
      expect(t.push(t.budget, 4, 'piggyback').effTrigger).toBe('piggyback');
      expect(t.budget.status().levels[2].held).toBe(1);
      expect(t.budget.forkRefusal(3)).toContain('L3 budget is exhausted');
      expect(t.budget.forkRefusal(2)).toBeNull();
      expect(t.budget.forkRefusal(1)).toBeNull();
    } finally {
      t.close();
    }
  });

  it('stores L2–L4 past the hard cap and refuses forks; L0/L1 still go', () => {
    const t = setup(null, { hardDailyUsd: 3 });
    try {
      t.spend(1, 3.2);
      const cap = t.notices.find((n) => n.type === 'budget.hard_cap');
      expect(cap).toMatchObject({ level: 0, trigger: 'flush' });
      expect(t.budget.status()).toMatchObject({ hardCapReached: true, spentUsd: 3.2 });
      expect(t.push(t.budget, 2, 'preempt').effTrigger).toBe('store');
      expect(t.push(t.budget, 1, 'interrupt').effTrigger).toBe('interrupt');
      expect(t.budget.forkRefusal(2)).toContain('global budget cap');
      expect(t.budget.forkRefusal(1)).toBeNull();
      t.spend(1, 0.1);
      expect(t.notices.filter((n) => n.type === 'budget.hard_cap')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('a release returns held events to their own mode, lasts for its hours, and survives a restart', () => {
    const dir = tmpDir();
    const t = setup(10, { hardDailyUsd: null }, dir);
    try {
      t.spend(3, 2);
      const a = t.push(t.budget, 3, 'flush');
      const b = t.push(t.budget, 3, 'debounce');
      expect([a.effTrigger, b.effTrigger]).toEqual(['store', 'store']);
      // A new tracker over the same database (a restart) still knows what it held.
      t.budget.close();
      const again = t.make();
      expect(again.status().levels[3].held).toBe(2);
      const r = again.release({ levels: [3], hours: 2, by: 'console:admin' });
      expect(r.promoted).toEqual([a.cursor, b.cursor]);
      expect(t.store.get(a.cursor)).toMatchObject({ state: 'pending', effTrigger: 'flush' });
      expect(t.store.get(b.cursor)).toMatchObject({ state: 'pending', effTrigger: 'debounce' });
      expect(t.notices.at(-1)).toMatchObject({ type: 'budget.released', level: 4 });
      expect(again.status().levels[3].releasedUntil).toBeDefined();
      expect(t.push(again, 3, 'flush').effTrigger).toBe('flush');
      t.advance(2 * 3_600_000 + 1);
      expect(t.push(again, 3, 'flush').effTrigger).toBe('store');
      expect(() => again.release({ hours: 0, by: 'x' })).toThrow(/hours/);
      again.close();
    } finally {
      t.close();
    }
  });

  it('when the pool refills, held L2 events get their mode back and held L3 events are listed', () => {
    const t = setup(10);
    try {
      t.spend(2, 2.5);
      t.spend(3, 2);
      const l2 = t.push(t.budget, 2, 'flush');
      const l3 = t.push(t.budget, 3, 'flush');
      t.advance(86_400_001);
      // The periodic re-check runs every 5 minutes; a model call re-checks its level at once.
      t.spend(2, 0.01);
      t.spend(3, 0.01);
      expect(t.store.get(l2.cursor)).toMatchObject({ effTrigger: 'flush', state: 'pending' });
      expect(t.budget.isHeld(l2.cursor)).toBe(false);
      const recovered = t.notices.find((n) => n.type === 'budget.recovered');
      expect(recovered?.text).toContain(`#${l3.cursor}`);
      expect(t.store.get(l3.cursor)?.state).toBe('archived');
    } finally {
      t.close();
    }
  });
});
