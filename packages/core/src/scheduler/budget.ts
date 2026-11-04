import { LEVELS, type BudgetStatus, type EventEnvelope, type EventInput, type Level, type LevelBudget, type Trigger } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { BudgetSettings } from '../config/types.js';
import type { KvNamespace, UsageRepo } from '../db/repos.js';
import type { EventStore } from '../events/store.js';
import type { GatedEvent } from '../events/gate.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../util/time.js';

const DAY_MS = 86_400_000;
/** Usage totals are re-read at most this often (and after every model call). */
const CACHE_MS = 30_000;
/** Pools refill as the rolling window moves; recovery is noticed this often. */
const RECHECK_MS = 300_000;
const MAX_HELD = 2000;

export interface BudgetTrackerOptions {
  usage: UsageRepo;
  settings: BudgetSettings;
  bus: Bus;
  log: Logger;
  clock: Clock;
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
  /** Releases and held events survive restarts. */
  kv?: KvNamespace;
  /** Promotes held events on release. */
  store?: EventStore;
}

/** An event whose delivery mode the budget changed. */
interface Held {
  cursor: number;
  level: Level;
  /** The mode it would have had (restored on release). */
  trigger: Trigger;
}

export interface AdmissionDecision {
  trigger: Trigger;
  reason: string;
  onStored(e: EventEnvelope): void;
}

export interface ReleaseResult {
  levels: Level[];
  hardCap: boolean;
  untilMs: number;
  promoted: number[];
}

/**
 * Per-level budget pools over a rolling 24 h window and the global hard cap
 * (docs/10-architecture/04-scheduling-and-preemption.md §6, 14-security-and-permissions.md §7).
 *
 * Enforcement only changes how *new* events are scheduled; running turns are never cut short:
 * - L1 keeps going (a notice at warnAt and at 100 %);
 * - an exhausted L2 pool turns new L2 events into piggyback (they ride along, they do not age);
 * - an exhausted L3/L4 pool stores new events without delivery;
 * - past `hardDailyUsd` only L0/L1 are delivered: L2–L4 are stored.
 * Exhaustion and the hard cap are L0 internal events, so the model can tell the owner. The
 * owner releases a level (or the cap) for a while from the console; held events then return
 * to their original mode.
 */
export class BudgetTracker {
  /** Last notice per level, so each threshold is reported once until usage drops below it again. */
  private readonly noticed = new Map<Level, 'warn' | 'over'>();
  private hardNoticed = false;
  private cache: { at: number; byLevel: Map<number, { costUsd: number; tokens: number }>; total: number } | null = null;
  private released: Partial<Record<Level | 'hard', number>> = {};
  private held: Held[] = [];
  private readonly heldSet = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private o: BudgetTrackerOptions) {
    const saved = o.kv?.get<{ released?: BudgetTracker['released']; held?: Held[] }>('state');
    if (saved?.released) this.released = saved.released;
    if (Array.isArray(saved?.held)) for (const h of saved.held) this.addHeld(h, false);
    o.bus.on('usage.recorded', (u) => {
      this.cache = null;
      if (u.level !== undefined) this.check(u.level);
      this.checkHard();
    });
    o.bus.on('event.settled', (s) => {
      if (this.heldSet.size === 0) return;
      const done = new Set(s.cursors.filter((c) => this.heldSet.has(c)));
      if (done.size > 0) this.dropHeld(done);
    });
    this.timer = setInterval(() => this.recheck(), RECHECK_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Budget settings are hot: the next status or check uses them. */
  updateSettings(settings: BudgetSettings): void {
    this.o.settings = settings;
    this.noticed.clear();
    this.hardNoticed = false;
    this.cache = null;
  }

  limitFor(level: Level): number | null {
    const { dailyUsd, shares } = this.o.settings;
    const share = shares[level];
    return dailyUsd === null || share === null ? null : dailyUsd * share;
  }

  private totals(): NonNullable<BudgetTracker['cache']> {
    const now = this.o.clock.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache;
    const byLevel = this.o.usage.byLevelSince(now - DAY_MS);
    let total = 0;
    for (const u of byLevel.values()) total += u.costUsd;
    this.cache = { at: now, byLevel, total };
    return this.cache;
  }

  private releasedUntil(key: Level | 'hard'): number | undefined {
    const until = this.released[key];
    if (until === undefined) return undefined;
    if (until > this.o.clock.now()) return until;
    delete this.released[key];
    this.save();
    return undefined;
  }

  status(): BudgetStatus {
    const t = this.totals();
    const levels = {} as Record<Level, LevelBudget>;
    const heldBy = new Map<Level, number>();
    for (const h of this.held) heldBy.set(h.level, (heldBy.get(h.level) ?? 0) + 1);
    for (const l of LEVELS) {
      const u = t.byLevel.get(l) ?? { costUsd: 0, tokens: 0 };
      const limitUsd = this.limitFor(l);
      const until = this.releasedUntil(l);
      levels[l] = {
        spentUsd: Math.round(u.costUsd * 1e6) / 1e6,
        tokens: u.tokens,
        limitUsd,
        usedRatio: limitUsd === null ? null : limitUsd === 0 ? 1 : u.costUsd / limitUsd,
        ...(heldBy.get(l) ? { held: heldBy.get(l) as number } : {}),
        ...(until !== undefined ? { releasedUntil: new Date(until).toISOString() } : {}),
      };
    }
    const hard = this.o.settings.hardDailyUsd;
    const hardUntil = this.releasedUntil('hard');
    return {
      enforced: this.o.settings.enforce,
      dailyUsd: this.o.settings.dailyUsd,
      hardDailyUsd: hard,
      spentUsd: Math.round(t.total * 1e6) / 1e6,
      hardCapReached: hard !== null && t.total >= hard,
      ...(hardUntil !== undefined ? { hardCapReleasedUntil: new Date(hardUntil).toISOString() } : {}),
      levels,
    };
  }

  /** Remaining share per limited level, in whole percent (for the status block). */
  remainingPercent(): Partial<Record<Level, number>> {
    const out: Partial<Record<Level, number>> = {};
    for (const [l, b] of Object.entries(this.status().levels)) {
      if (b.usedRatio !== null) out[Number(l) as Level] = Math.max(0, Math.round((1 - b.usedRatio) * 100));
    }
    return out;
  }

  /** Is the pool of this level exhausted (and not released)? */
  private exhausted(level: Level): boolean {
    const limit = this.limitFor(level);
    if (limit === null) return false;
    const spent = this.totals().byLevel.get(level)?.costUsd ?? 0;
    return spent >= limit && this.releasedUntil(level) === undefined;
  }

  private hardCapActive(): boolean {
    const hard = this.o.settings.hardDailyUsd;
    return hard !== null && this.totals().total >= hard && this.releasedUntil('hard') === undefined;
  }

  /**
   * The scheduling change for a new event, or null to keep it (the plugin host calls this
   * between gating and storing). Core's own events are never held.
   */
  admit(ev: Pick<GatedEvent, 'source' | 'origin' | 'effLevel' | 'effTrigger'>): AdmissionDecision | null {
    if (!this.o.settings.enforce || ev.origin === 'internal' || ev.effLevel <= 1) return null;
    if (ev.effTrigger === 'store') return null;
    let trigger: Trigger | null = null;
    let reason = '';
    if (this.hardCapActive()) {
      trigger = 'store';
      reason = `the global budget cap ($${this.o.settings.hardDailyUsd}) is reached`;
    } else if (this.exhausted(ev.effLevel)) {
      if (ev.effLevel === 2) {
        if (ev.effTrigger !== 'piggyback') trigger = 'piggyback';
      } else {
        trigger = 'store';
      }
      reason = `the L${ev.effLevel} budget is exhausted`;
    }
    if (trigger === null || trigger === ev.effTrigger) return null;
    const original = ev.effTrigger;
    const level = ev.effLevel;
    return {
      trigger,
      reason,
      onStored: (e) => {
        this.addHeld({ cursor: e.cursor, level, trigger: original });
        this.o.log.info({ cursor: e.cursor, eventLevel: level, from: original, to: trigger, reason }, 'event held by the budget');
      },
    };
  }

  /** A fork at this level may not start while its pool (or the hard cap) holds new work. */
  forkRefusal(level: Level): string | null {
    if (!this.o.settings.enforce || level <= 1) return null;
    if (this.hardCapActive()) return `the global budget cap ($${this.o.settings.hardDailyUsd} per 24 h) is reached; only L0/L1 work runs until it is released`;
    if (level >= 3 && this.exhausted(level)) return `the L${level} budget is exhausted; ask the owner to release it, or spawn the fork at a level that has budget left`;
    return null;
  }

  /** Aging must not deliver a piggyback that the budget chose. */
  isHeld(cursor: number): boolean {
    return this.heldSet.has(cursor);
  }

  /**
   * Lift enforcement for these levels (and/or the hard cap) for `hours`, and return the events
   * held for them to their original mode.
   */
  release(opts: { levels?: readonly Level[]; hardCap?: boolean; hours?: number; by: string }): ReleaseResult {
    const hours = opts.hours ?? 24;
    if (!(hours > 0 && hours <= 24 * 7)) throw new Error('hours must be between 0 and 168');
    const levels = [...new Set(opts.levels ?? [2, 3, 4])].filter((l): l is Level => l >= 2 && l <= 4).sort();
    const hardCap = opts.hardCap ?? this.o.settings.hardDailyUsd !== null;
    const untilMs = this.o.clock.now() + hours * 3_600_000;
    for (const l of levels) this.released[l] = untilMs;
    if (hardCap) this.released.hard = untilMs;
    const promoted: number[] = [];
    const keep: Held[] = [];
    for (const h of this.held) {
      if (!levels.includes(h.level) && !hardCap) {
        keep.push(h);
        continue;
      }
      if (this.o.store?.promote(h.cursor, h.trigger)) promoted.push(h.cursor);
      this.heldSet.delete(h.cursor);
    }
    this.held = keep;
    this.save();
    this.noticed.clear();
    this.hardNoticed = false;
    const what = [...levels.map((l) => `L${l}`), ...(hardCap ? ['the hard cap'] : [])].join(', ');
    this.o.log.warn({ levels, hardCap, hours, by: opts.by, promoted: promoted.length }, 'budget released');
    this.o.pushInternal({
      type: 'budget.released',
      level: 4,
      trigger: 'piggyback',
      text: `${opts.by} released the budget for ${what || 'nothing'} for ${hours} h; ${promoted.length} held event(s) were returned to their normal delivery.`,
    });
    return { levels, hardCap, untilMs, promoted };
  }

  private addHeld(h: Held, persist = true): void {
    if (this.heldSet.has(h.cursor)) return;
    this.held.push(h);
    this.heldSet.add(h.cursor);
    while (this.held.length > MAX_HELD) {
      const old = this.held.shift() as Held;
      this.heldSet.delete(old.cursor);
    }
    if (persist) this.save();
  }

  private dropHeld(cursors: Set<number>): void {
    this.held = this.held.filter((h) => !cursors.has(h.cursor));
    for (const c of cursors) this.heldSet.delete(c);
    this.save();
  }

  private save(): void {
    this.o.kv?.set('state', { released: this.released, held: this.held });
  }

  private recheck(): void {
    this.cache = null;
    for (const l of LEVELS) this.check(l);
    this.checkHard();
  }

  private checkHard(): void {
    const hard = this.o.settings.hardDailyUsd;
    if (hard === null) return;
    const total = this.totals().total;
    if (total < hard) {
      this.hardNoticed = false;
      return;
    }
    if (this.hardNoticed || this.releasedUntil('hard') !== undefined) return;
    this.hardNoticed = true;
    this.o.log.warn({ spentUsd: total, hardDailyUsd: hard }, 'global budget cap reached');
    this.o.pushInternal({
      type: 'budget.hard_cap',
      level: 0,
      trigger: 'flush',
      text: `Spending over the last 24 h reached the global cap ($${total.toFixed(2)} of $${hard.toFixed(2)}). ${this.o.settings.enforce ? 'Until it drops or the owner releases it, only L0/L1 events are delivered and new L2–L4 forks are refused; other events are stored.' : 'Enforcement is off (budget.enforce: false), so nothing changes.'} Tell the owner briefly.`,
    });
  }

  private check(level: Level): void {
    const b = this.status().levels[level];
    const prev = this.noticed.get(level);
    if (b.usedRatio === null || b.limitUsd === null) {
      this.noticed.delete(level);
      return;
    }
    const state = b.usedRatio >= 1 ? 'over' : b.usedRatio >= this.o.settings.warnAt ? 'warn' : null;
    if (prev === 'over' && state !== 'over') this.recovered(level);
    if (state === null) {
      this.noticed.delete(level);
      return;
    }
    // Falling back from "over" to "warn" is not a new warning.
    const quiet = prev === state || (prev === 'over' && state === 'warn');
    this.noticed.set(level, state);
    if (quiet) return;
    const pct = Math.round(b.usedRatio * 100);
    const spent = `$${b.spentUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)} over the last 24 h`;
    this.o.log.warn({ budgetLevel: level, spentUsd: b.spentUsd, limitUsd: b.limitUsd, pct }, 'budget threshold crossed');
    const enforce = this.o.settings.enforce;
    if (state === 'warn' || level <= 1 || !enforce || b.releasedUntil !== undefined) {
      const effect =
        state === 'warn'
          ? ''
          : level <= 1
            ? ' Owner events keep being delivered.'
            : !enforce
              ? ' Enforcement is off (budget.enforce: false).'
              : ' The owner released this level, so delivery continues.';
      this.o.pushInternal({ type: 'budget.threshold', level: 4, trigger: 'piggyback', text: `The L${level} budget is at ${pct}% (${spent}).${effect}` });
      return;
    }
    const effect = level === 2 ? 'new L2 events now only ride along with other batches (piggyback)' : `new L${level} events are now stored without being delivered`;
    this.o.pushInternal({
      type: 'budget.exhausted',
      level: 0,
      trigger: 'flush',
      text: `The L${level} budget is exhausted (${spent}): ${effect} until usage drops or the owner releases it in the console. Tell the owner only if it matters to them.`,
    });
  }

  /**
   * The pool refilled. Held L2 events (still pending as piggyback) get their mode back; held
   * L3/L4 events stay stored and the model is told which, so it can promote what still matters.
   */
  private recovered(level: Level): void {
    const held = this.held.filter((h) => h.level === level);
    if (held.length === 0) return;
    this.dropHeld(new Set(held.map((h) => h.cursor)));
    if (level === 2) {
      for (const h of held) this.o.store?.promote(h.cursor, h.trigger);
      return;
    }
    this.o.pushInternal({
      type: 'budget.recovered',
      level: 4,
      trigger: 'piggyback',
      text: `The L${level} budget has room again. ${held.length} event(s) stored while it was exhausted stay stored (${held
        .slice(-20)
        .map((h) => `#${h.cursor}`)
        .join(', ')}${held.length > 20 ? ', …' : ''}); promote any that still matter with events_promote.`,
    });
  }
}
