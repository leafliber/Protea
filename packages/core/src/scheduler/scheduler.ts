import type { EventEnvelope, EventInput, Level } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { LevelSettings, PreemptStormSettings } from '../config/types.js';
import type { BatchRepo } from '../db/repos.js';
import type { EventStore } from '../events/store.js';
import type { Logger } from '../observability/logger.js';
import { newBatchId, type BatchFeed, type MainSession } from '../session/main-session.js';
import type { Clock } from '../util/time.js';
import { decidePreemption } from './preemption.js';

export interface SchedulerOptions {
  store: EventStore;
  bus: Bus;
  main: MainSession;
  batches: BatchRepo;
  levels: Record<Level, LevelSettings>;
  preemptStorm: PreemptStormSettings;
  log: Logger;
  clock: Clock;
  /** Push an internal (Core) event; every scheduling intervention is recorded as one. */
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
}

/** Core's own events are never throttled. */
const CORE_SOURCE = 'core';

function fmtWait(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * Decides when pending events become a batch and whether a running turn is cut short
 * (docs/10-architecture/04-scheduling-and-preemption.md): per-level debounce windows,
 * flush/piggyback/store, delivery at idle and at turn boundaries, the preemption
 * matrix with storm protection, and aging. Fork scheduling lives in ForkManager.
 */
export class Scheduler implements BatchFeed {
  private readonly windows = new Map<Level, ReturnType<typeof setTimeout>>();
  private due = false;
  private draining = false;
  private started = false;
  private unsubscribe: Array<() => void> = [];
  private agingTimer: ReturnType<typeof setTimeout> | null = null;
  private agingAt = Number.POSITIVE_INFINITY;
  private readonly stormHits = new Map<string, number[]>();
  private readonly cooldownUntil = new Map<string, number>();
  private pausedBy: string | null = null;
  private resumePending = false;

  constructor(private readonly o: SchedulerOptions) {
    o.main.attachFeed(this);
  }

  /** Begin scheduling. Resumes an interrupted batch first, then re-arms windows for pending events. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe.push(
      this.o.bus.on('event.stored', (e) => this.onStored(e)),
      this.o.bus.on('event.promoted', (e) => {
        // The envelope is a snapshot; skip events a batch took in the meantime.
        if (this.o.store.get(e.cursor)?.state === 'pending') this.onStored(e);
      }),
    );
    this.armAging();
    if (this.o.main.needsResume()) {
      if (this.pausedBy !== null) this.resumePending = true;
      else this.deliverResume();
      return;
    }
    const pending = this.o.store.pending();
    if (pending.some((e) => e.effTrigger !== 'debounce' && e.effTrigger !== 'piggyback')) {
      this.requestDelivery();
      return;
    }
    const now = this.o.clock.now();
    for (const e of pending) {
      if (e.effTrigger !== 'debounce') continue;
      const ms = this.o.levels[e.effLevel].debounceMs;
      if (ms === null) continue;
      const remaining = Math.max(0, Date.parse(e.receivedAt) + ms - now);
      this.openWindow(e.effLevel, remaining);
    }
  }

  /** Stop opening batches (shutdown). Pending events stay in the store. */
  drain(): void {
    this.draining = true;
    this.clearWindows();
    if (this.agingTimer) clearTimeout(this.agingTimer);
    this.agingTimer = null;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  get isDue(): boolean {
    return this.due;
  }

  /** Who paused delivery (control API), or null while delivering. */
  get paused(): string | null {
    return this.pausedBy;
  }

  /**
   * Stop opening and extending batches; events keep arriving and stay pending, and the
   * running batch finishes. Preempt/interrupt events wait too. Recorded as an internal event.
   */
  pause(by: string, opts: { record?: boolean } = {}): boolean {
    if (this.pausedBy !== null) return false;
    this.pausedBy = by;
    this.o.bus.emit('scheduler.action', { kind: 'paused', by });
    if (opts.record !== false) {
      this.o.pushInternal({ type: 'scheduler.paused', level: 4, trigger: 'store', text: `Event delivery paused by ${by}; events are stored and wait until it resumes.` });
    }
    this.o.log.warn({ by }, 'event delivery paused');
    return true;
  }

  resume(by: string): boolean {
    if (this.pausedBy === null) return false;
    this.pausedBy = null;
    this.o.bus.emit('scheduler.action', { kind: 'resumed', by });
    const waiting = Object.values(this.o.store.pendingCounts()).reduce((a, b) => a + b, 0);
    this.o.pushInternal({ type: 'scheduler.resumed', level: 4, trigger: 'piggyback', text: `Event delivery resumed by ${by}; ${waiting} event(s) were waiting.` });
    this.o.log.info({ by, waiting }, 'event delivery resumed');
    if (!this.started || this.draining) return true;
    if (this.resumePending) {
      this.resumePending = false;
      this.deliverResume();
      return true;
    }
    // Windows that closed during the pause left `due` set; pending flush events count too.
    if (this.o.store.pending().some((e) => e.effTrigger === 'flush' || e.effTrigger === 'preempt' || e.effTrigger === 'interrupt')) this.due = true;
    this.tryDeliver();
    return true;
  }

  /**
   * Settle every pending event at these levels as `discarded` (control API). Returns the
   * cursors; recorded as one internal event.
   */
  discard(levels: readonly Level[], by: string): number[] {
    const set = new Set(levels);
    const cursors = this.o.store
      .pending()
      .filter((e) => set.has(e.effLevel) && e.source !== CORE_SOURCE)
      .map((e) => e.cursor);
    const done = this.o.store.settle(cursors, 'discarded');
    if (done.length > 0) {
      this.o.bus.emit('scheduler.action', { kind: 'discarded', cursors: done, levels: [...set].sort(), by });
      this.o.pushInternal({
        type: 'scheduler.discarded',
        level: 4,
        trigger: 'store',
        text: `${by} discarded ${done.length} pending event(s) at level(s) ${[...set].sort().join(', ')}.`,
      });
      this.o.log.warn({ by, levels: [...set], count: done.length }, 'pending events discarded');
    }
    return done;
  }

  /** Sources whose preempt/interrupt requests are currently scheduled as flush. */
  cooldowns(): Array<{ source: string; untilMs: number }> {
    const now = this.o.clock.now();
    return [...this.cooldownUntil].filter(([, until]) => until > now).map(([source, untilMs]) => ({ source, untilMs }));
  }

  private onStored(e: EventEnvelope): void {
    if (e.state !== 'pending' || this.draining) return;
    this.scheduleAging(e);
    switch (e.effTrigger) {
      case 'piggyback':
      case 'store':
        return;
      case 'debounce': {
        const ms = this.o.levels[e.effLevel].debounceMs;
        if (ms !== null) this.openWindow(e.effLevel, ms);
        return;
      }
      case 'flush':
        this.requestDelivery();
        return;
      case 'preempt':
      case 'interrupt': {
        // When idle the event simply starts a batch; only a running batch can be cut short.
        const wasBusy = this.o.main.busy;
        this.requestDelivery();
        if (wasBusy && this.pausedBy === null) this.considerCancel(e);
        return;
      }
    }
  }

  /** Apply the preemption matrix to a preempt/interrupt event that arrived during a batch. */
  private considerCancel(e: EventEnvelope): void {
    const turn = this.o.main.runningTurn();
    if (!turn) return;
    if (e.source !== CORE_SOURCE && this.inCooldown(e.source)) {
      this.o.log.debug({ cursor: e.cursor, source: e.source }, 'source in preemption cooldown; scheduling as flush');
      return;
    }
    const decision = decidePreemption(e.effLevel, e.effTrigger, turn);
    if (decision === 'wait') return;
    if (!this.o.main.cancel({ kind: decision, cursor: e.cursor, source: e.source, level: e.effLevel })) return;
    this.o.bus.emit('scheduler.action', {
      kind: decision,
      cursor: e.cursor,
      source: e.source,
      level: e.effLevel,
      batchId: turn.batchId,
      batchLevel: turn.batchLevel,
      phase: turn.phase,
    });
    this.o.log.info({ decision, cursor: e.cursor, source: e.source, batch: turn.batchId, phase: turn.phase }, 'preemption');
    if (e.source !== CORE_SOURCE) this.countStorm(e.source);
  }

  private inCooldown(source: string): boolean {
    const until = this.cooldownUntil.get(source);
    if (until === undefined) return false;
    if (this.o.clock.now() < until) return true;
    this.cooldownUntil.delete(source);
    return false;
  }

  private countStorm(source: string): void {
    const { count, windowMs, cooldownMs } = this.o.preemptStorm;
    const now = this.o.clock.now();
    const hits = (this.stormHits.get(source) ?? []).filter((t) => now - t < windowMs);
    hits.push(now);
    if (hits.length < count) {
      this.stormHits.set(source, hits);
      return;
    }
    this.stormHits.delete(source);
    if (cooldownMs === 0) return;
    const untilMs = now + cooldownMs;
    this.cooldownUntil.set(source, untilMs);
    this.o.bus.emit('scheduler.action', { kind: 'storm_cooldown', source, untilMs });
    this.o.log.warn({ source, hits: hits.length, cooldownMs }, 'preemption storm; cooling down the source');
    this.o.pushInternal({
      type: 'scheduler.storm_cooldown',
      level: 4,
      trigger: 'piggyback',
      text: `Source ${source} cut turns short ${hits.length} times within ${fmtWait(windowMs)}; for the next ${fmtWait(cooldownMs)} its urgent events wait for the next turn boundary instead.`,
    });
  }

  // —— Aging ——

  /** When a pending event should be promoted to flush, or null if it never ages. */
  private agingDeadline(e: EventEnvelope): number | null {
    if (e.effTrigger !== 'debounce' && e.effTrigger !== 'piggyback') return null;
    const wait = this.o.levels[e.effLevel].maxWaitMs;
    if (!wait) return null;
    return Date.parse(e.receivedAt) + wait;
  }

  private scheduleAging(e: EventEnvelope): void {
    const at = this.agingDeadline(e);
    if (at !== null && at < this.agingAt) this.armAgingAt(at);
  }

  /** Re-arm the aging timer for the earliest deadline among pending events. */
  private armAging(): void {
    let min = Number.POSITIVE_INFINITY;
    for (const e of this.o.store.pending()) {
      const at = this.agingDeadline(e);
      if (at !== null && at < min) min = at;
    }
    if (this.agingTimer) clearTimeout(this.agingTimer);
    this.agingTimer = null;
    this.agingAt = Number.POSITIVE_INFINITY;
    if (min < Number.POSITIVE_INFINITY) this.armAgingAt(min);
  }

  private armAgingAt(at: number): void {
    if (this.draining) return;
    if (this.agingTimer) clearTimeout(this.agingTimer);
    this.agingAt = at;
    // setTimeout caps at 2^31-1 ms; a later deadline simply re-arms when this fires.
    const delay = Math.min(Math.max(0, at - this.o.clock.now()), 2 ** 31 - 1);
    this.agingTimer = setTimeout(() => this.runAging(), delay);
  }

  /** Promote every event that waited longer than its level's maxWaitMs to flush (level unchanged). */
  private runAging(): void {
    this.agingTimer = null;
    this.agingAt = Number.POSITIVE_INFINITY;
    if (this.draining) return;
    const now = this.o.clock.now();
    const aged = this.o.store.pending().filter((e) => {
      const at = this.agingDeadline(e);
      return at !== null && at <= now;
    });
    if (aged.length > 0) {
      this.o.bus.emit('scheduler.action', { kind: 'aged', cursors: aged.map((e) => e.cursor) });
      this.o.log.info({ cursors: aged.map((e) => e.cursor) }, 'aged events promoted to flush');
      this.o.pushInternal({
        type: 'scheduler.aged',
        level: 4,
        trigger: 'store',
        text: `Promoted to flush after waiting too long: ${aged
          .map((e) => `#${e.cursor} (L${e.effLevel} ${e.type}, waited ${fmtWait(now - Date.parse(e.receivedAt))})`)
          .join(', ')}.`,
      });
      // Promotion re-announces each event; the first one triggers delivery of all of them.
      for (const e of aged) this.o.store.promote(e.cursor, 'flush');
    }
    this.armAging();
  }

  // —— Batching ——

  private openWindow(level: Level, ms: number): void {
    if (this.windows.has(level)) return;
    this.windows.set(
      level,
      setTimeout(() => {
        this.windows.delete(level);
        this.requestDelivery();
      }, ms),
    );
  }

  private clearWindows(): void {
    for (const t of this.windows.values()) clearTimeout(t);
    this.windows.clear();
  }

  /** A window closed or a flush arrived: everything pending goes out at the next opportunity. */
  private requestDelivery(): void {
    this.clearWindows();
    this.due = true;
    this.tryDeliver();
  }

  private tryDeliver(): void {
    if (!this.due || this.draining || this.pausedBy !== null || this.o.main.busy) return;
    const batchId = newBatchId();
    const events = this.takeDue(batchId);
    if (events.length === 0) return;
    const level = Math.min(...events.map((e) => e.effLevel)) as Level;
    void this.o.main.deliver({ id: batchId, level, reason: 'window', events });
  }

  private deliverResume(): void {
    const batchId = newBatchId();
    const events = this.takeAll(batchId);
    this.due = false;
    const level = Math.min(this.o.main.resumeLevel(), ...events.map((e) => e.effLevel)) as Level;
    this.o.log.info({ batch: batchId, events: events.length }, 'resuming the interrupted batch');
    void this.o.main.deliver({ id: batchId, level, reason: 'resume', events });
  }

  /** Take every pending event (expired ones are settled instead). */
  private takeAll(batchId: string): EventEnvelope[] {
    const now = this.o.clock.now();
    const pending = this.o.store.pending();
    const expired = pending.filter((e) => e.expiresAt !== undefined && Date.parse(e.expiresAt) <= now);
    if (expired.length > 0) this.o.store.settle(expired.map((e) => e.cursor), 'expired');
    const live = pending.filter((e) => !expired.includes(e));
    this.o.store.markDelivering(
      live.map((e) => e.cursor),
      batchId,
    );
    return live;
  }

  private takeDue(batchId: string): EventEnvelope[] {
    this.due = false;
    return this.takeAll(batchId);
  }

  // —— BatchFeed ——

  takeBoundaryEvents(): EventEnvelope[] {
    if (!this.due || this.draining || this.pausedBy !== null) return [];
    const batchId = this.o.main.currentBatchId ?? newBatchId();
    return this.takeDue(batchId);
  }

  onIdle(): void {
    this.tryDeliver();
  }
}
