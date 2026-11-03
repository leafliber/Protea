import { LEVELS, type BudgetStatus, type EventInput, type Level, type LevelBudget } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { BudgetSettings } from '../config/types.js';
import type { UsageRepo } from '../db/repos.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../util/time.js';

const DAY_MS = 86_400_000;

export interface BudgetTrackerOptions {
  usage: UsageRepo;
  settings: BudgetSettings;
  bus: Bus;
  log: Logger;
  clock: Clock;
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
}

/**
 * Per-level budget pools over a rolling 24 h window (docs/10-architecture/04-scheduling-and-preemption.md §6).
 * M1 tracks and reports only: crossing warnAt or 100 % records an internal notice, but
 * scheduling is not affected until enforcement lands (M6).
 */
export class BudgetTracker {
  /** Last notice per level, so each threshold is reported once until usage drops below it again. */
  private readonly noticed = new Map<Level, 'warn' | 'over'>();

  constructor(private readonly o: BudgetTrackerOptions) {
    o.bus.on('usage.recorded', (u) => {
      if (u.level !== undefined) this.check(u.level);
    });
  }

  limitFor(level: Level): number | null {
    const { dailyUsd, shares } = this.o.settings;
    const share = shares[level];
    return dailyUsd === null || share === null ? null : dailyUsd * share;
  }

  status(): BudgetStatus {
    const used = this.o.usage.byLevelSince(this.o.clock.now() - DAY_MS);
    const levels = {} as Record<Level, LevelBudget>;
    for (const l of LEVELS) {
      const u = used.get(l) ?? { costUsd: 0, tokens: 0 };
      const limitUsd = this.limitFor(l);
      levels[l] = {
        spentUsd: Math.round(u.costUsd * 1e6) / 1e6,
        tokens: u.tokens,
        limitUsd,
        usedRatio: limitUsd === null ? null : limitUsd === 0 ? 1 : u.costUsd / limitUsd,
      };
    }
    return { enforced: false, dailyUsd: this.o.settings.dailyUsd, levels };
  }

  /** Remaining share per limited level, in whole percent (for the status block). */
  remainingPercent(): Partial<Record<Level, number>> {
    const out: Partial<Record<Level, number>> = {};
    for (const [l, b] of Object.entries(this.status().levels)) {
      if (b.usedRatio !== null) out[Number(l) as Level] = Math.max(0, Math.round((1 - b.usedRatio) * 100));
    }
    return out;
  }

  private check(level: Level): void {
    const b = this.status().levels[level];
    if (b.usedRatio === null || b.limitUsd === null) return;
    const state = b.usedRatio >= 1 ? 'over' : b.usedRatio >= this.o.settings.warnAt ? 'warn' : null;
    const prev = this.noticed.get(level);
    if (state === null) {
      this.noticed.delete(level);
      return;
    }
    if (prev === state || (prev === 'over' && state === 'warn')) return;
    this.noticed.set(level, state);
    const pct = Math.round(b.usedRatio * 100);
    this.o.log.warn({ level, spentUsd: b.spentUsd, limitUsd: b.limitUsd, pct }, 'budget threshold crossed');
    this.o.pushInternal({
      type: 'budget.threshold',
      level: 4,
      trigger: 'piggyback',
      text: `The L${level} budget is at ${pct}% ($${b.spentUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)} over the last 24 h). Budgets are tracked but not enforced yet.`,
    });
  }
}
