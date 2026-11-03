import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetTracker, Bus, UsageRepo, openDatabase, silentLogger, type UsageRecord } from '../src/index.js';
import { tmpDir } from './helpers.js';

function setup(dailyUsd: number | null) {
  const { db } = openDatabase(path.join(tmpDir(), 'protea.db'));
  const bus = new Bus();
  const usage = new UsageRepo(db);
  const notices: string[] = [];
  let now = Date.parse('2026-11-03T08:00:00Z');
  const budget = new BudgetTracker({
    usage,
    settings: { dailyUsd, shares: { 0: null, 1: 0.6, 2: 0.2, 3: 0.15, 4: 0.05 }, warnAt: 0.9 },
    bus,
    log: silentLogger(),
    clock: { now: () => now },
    pushInternal: (e) => notices.push(e.text),
  });
  const spend = (level: 0 | 1 | 2 | 3 | 4, costUsd: number, atMs = now): void => {
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
  return { budget, spend, notices, advance: (ms: number) => (now += ms), close: () => db.close() };
}

describe('budget tracking', () => {
  it('attributes 24 h spend to level pools and reports each threshold once', () => {
    const t = setup(10);
    try {
      t.spend(3, 1.0); // L3 pool is $1.50
      expect(t.notices).toEqual([]);
      t.spend(3, 0.4); // 93 %
      t.spend(3, 0.01);
      expect(t.notices).toHaveLength(1);
      expect(t.notices[0]).toContain('L3 budget is at 93%'); // the first crossing; 94 % is not reported again
      t.spend(3, 0.2); // over 100 %
      expect(t.notices).toHaveLength(2);
      expect(t.notices[1]).toContain('not enforced');
      const s = t.budget.status();
      expect(s.enforced).toBe(false);
      expect(s.levels[3]).toMatchObject({ spentUsd: 1.61, limitUsd: 1.5, tokens: 440 });
      expect(s.levels[0]).toMatchObject({ limitUsd: null, usedRatio: null });
      expect(t.budget.remainingPercent()).toEqual({ 1: 100, 2: 100, 3: 0, 4: 100 });
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
    } finally {
      t.close();
    }
  });
});
