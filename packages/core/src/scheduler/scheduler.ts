import type { EventEnvelope, Level } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { LevelSettings } from '../config/types.js';
import type { BatchRepo } from '../db/repos.js';
import type { EventStore } from '../events/store.js';
import type { Logger } from '../observability/logger.js';
import { newBatchId, type Batch, type BatchFeed, type MainSession } from '../session/main-session.js';
import type { Clock } from '../util/time.js';

export interface SchedulerOptions {
  store: EventStore;
  bus: Bus;
  main: MainSession;
  batches: BatchRepo;
  levels: Record<Level, LevelSettings>;
  log: Logger;
  clock: Clock;
}

/**
 * Decides when pending events become a batch (docs/10-architecture/04-scheduling-and-preemption.md).
 * M0 scope: per-level debounce windows, flush, piggyback, store, and delivery at idle
 * and at turn boundaries. Preempt/interrupt currently behave like flush; aging,
 * budgets and fork scheduling arrive in M1.
 */
export class Scheduler implements BatchFeed {
  private readonly windows = new Map<Level, ReturnType<typeof setTimeout>>();
  private due = false;
  private draining = false;
  private started = false;
  private warnedPreempt = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly o: SchedulerOptions) {
    o.main.attachFeed(this);
  }

  /** Begin scheduling. Resumes an interrupted batch first, then re-arms windows for pending events. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.o.bus.on('event.stored', (e) => this.onStored(e));
    if (this.o.main.needsResume()) {
      this.deliverResume();
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
    this.unsubscribe?.();
  }

  get isDue(): boolean {
    return this.due;
  }

  private onStored(e: EventEnvelope): void {
    if (e.state !== 'pending' || this.draining) return;
    switch (e.effTrigger) {
      case 'piggyback':
      case 'store':
        return;
      case 'debounce': {
        const ms = this.o.levels[e.effLevel].debounceMs;
        if (ms !== null) this.openWindow(e.effLevel, ms);
        return;
      }
      case 'preempt':
      case 'interrupt':
        if (!this.warnedPreempt) {
          this.warnedPreempt = true;
          this.o.log.info({ trigger: e.effTrigger }, 'preemption is not implemented yet (M1); treating as flush');
        }
        this.requestDelivery();
        return;
      case 'flush':
        this.requestDelivery();
        return;
    }
  }

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
    if (!this.due || this.draining || this.o.main.busy) return;
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
    if (!this.due || this.draining) return [];
    const batchId = this.o.main.currentBatchId ?? newBatchId();
    return this.takeDue(batchId);
  }

  onIdle(): void {
    this.tryDeliver();
  }
}
