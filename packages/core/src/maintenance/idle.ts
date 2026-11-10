import type { HandoffKind } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { Logger } from '../observability/logger.js';
import type { MainSession } from '../session/main-session.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import type { DreamRunner } from './dream.js';
import { compactionTrigger } from './policy.js';
import type { IdleCompactionSettings } from './settings.js';

const TICK_MS = 60_000;

export interface IdleMaintenanceOptions {
  main: Pick<MainSession, 'busy' | 'idleSince' | 'needsResume' | 'compactionStats' | 'compactWhileIdle' | 'abortIdleWork'>;
  bus: Bus;
  /** Pending events at levels 0–2. */
  urgentPending: () => number;
  paused: () => boolean;
  /** Why background work may not spend budget now; null when it may. */
  budgetRefusal: () => string | null;
  settings: () => IdleCompactionSettings;
  cacheHorizonMs: () => number | undefined;
  clock: Clock;
  log: Logger;
  /** First thing on every tick: work that was waiting for the session to go idle. */
  onTick?: () => void;
  dream?: Pick<DreamRunner, 'due' | 'run'>;
}

/** What the main session does when nothing is happening: compact the conversation and consolidate memory. */
export class IdleMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private off: (() => void) | null = null;
  private lastAttemptMs: number | null = null;
  private compacting = false;
  private ticking = false;
  private last: { at: string; kind: HandoffKind; dropped: number; kept: number } | null = null;

  constructor(private readonly o: IdleMaintenanceOptions) {}

  start(): void {
    if (this.timer) return;
    const offStored = this.o.bus.on('event.stored', (e) => {
      if (this.compacting && e.effLevel <= 1 && e.effTrigger !== 'store') this.o.main.abortIdleWork();
    });
    const offHandoff = this.o.bus.on('session.handoff', (h) => {
      this.last = { at: new Date(this.o.clock.now()).toISOString(), kind: h.kind, dropped: h.dropped, kept: h.kept };
    });
    this.off = () => {
      offStored();
      offHandoff();
    };
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  get lastCompaction(): { at: string; kind: HandoffKind; dropped: number; kept: number } | null {
    return this.last;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.o.onTick?.();
      await this.maybeCompact();
      this.maybeDream();
    } catch (err) {
      this.o.log.warn({ err: errorMessage(err) }, 'idle maintenance failed');
    } finally {
      this.ticking = false;
    }
  }

  private async maybeCompact(): Promise<void> {
    const o = this.o;
    const cfg = o.settings();
    const nowMs = o.clock.now();
    // Worked out from the whole transcript, so only when it could matter.
    if (!cfg.enabled || o.main.busy || nowMs - o.main.idleSince < cfg.earlyAfterMs) return;
    const stats = o.main.compactionStats(cfg.keepTokens);
    const trigger = compactionTrigger(
      {
        nowMs,
        idleSinceMs: o.main.idleSince,
        busy: o.main.busy,
        paused: o.paused(),
        needsResume: o.main.needsResume(),
        urgentPending: o.urgentPending(),
        budgetRefused: o.budgetRefusal() !== null,
        conversationTokens: stats.conversationTokens,
        droppableTokens: stats.droppableTokens,
        lastAttemptMs: this.lastAttemptMs,
        cacheHorizonMs: o.cacheHorizonMs(),
      },
      cfg,
    );
    if (!trigger) return;
    this.lastAttemptMs = nowMs;
    this.compacting = true;
    try {
      const idleMin = Math.round((nowMs - o.main.idleSince) / 60_000);
      const r = await o.main.compactWhileIdle(`idle for ${idleMin} min with about ${stats.conversationTokens} conversation tokens`, cfg.keepTokens);
      o.log.info({ trigger, compacted: r !== null, conversationTokens: stats.conversationTokens, droppableTokens: stats.droppableTokens }, 'idle compaction');
    } finally {
      this.compacting = false;
    }
  }

  private maybeDream(): void {
    const { dream, main, clock } = this.o;
    if (!dream || main.busy || !dream.due(clock.now(), main.idleSince)) return;
    dream.run();
  }
}
