import type { HandoffKind, ModelRole } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { EventGateway } from '../events/gateway.js';
import type { Logger } from '../observability/logger.js';
import type { MainSession } from '../session/main-session.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import type { DreamRunner } from './dream.js';
import { compactionTrigger } from './policy.js';
import type { IdleCompactionSettings } from './settings.js';

const TICK_MS = 60_000;
/** Who writes the notes, in turn, when a model keeps failing at it. */
export const NOTES_ROLES: readonly ModelRole[] = ['cheap', 'fork', 'main'];
/** Failed attempts before the next role takes over. */
export const FAILURES_PER_ROLE = 3;

/** Where repeated failures of idle compaction stand. */
export interface CompactionFailures {
  /** Consecutive failed attempts. */
  count: number;
  /** Every role failed; nothing is tried until the conversation grows past this size. */
  exhaustedAt: number | null;
}

/** The wait before the next attempt after `failures` failures: the base interval, doubled up to four times it. */
export function retryIntervalMs(baseMs: number, failures: number): number {
  return baseMs * 2 ** Math.min(failures, 2);
}

/** The role that writes the notes after `failures` failures; null once every role failed. */
export function notesRoleAfter(failures: number): ModelRole | null {
  return NOTES_ROLES[Math.floor(failures / FAILURES_PER_ROLE)] ?? null;
}

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
  /** Told when every model failed to write the notes. */
  notify?: Pick<EventGateway, 'pushInternal'>;
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
  private preempted = false;
  private ticking = false;
  private failures: CompactionFailures = { count: 0, exhaustedAt: null };
  private last: { at: string; kind: HandoffKind; dropped: number; kept: number } | null = null;

  constructor(private readonly o: IdleMaintenanceOptions) {}

  start(): void {
    if (this.timer) return;
    const offStored = this.o.bus.on('event.stored', (e) => {
      if (this.compacting && e.effLevel <= 1 && e.effTrigger !== 'store') {
        this.preempted = true;
        this.o.main.abortIdleWork();
      }
    });
    const offHandoff = this.o.bus.on('session.handoff', (h) => {
      this.last = { at: new Date(this.o.clock.now()).toISOString(), kind: h.kind, dropped: h.dropped, kept: h.kept };
      // Any handoff (a capacity one too) starts the count over.
      this.failures = { count: 0, exhaustedAt: null };
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

  get compactionFailures(): CompactionFailures {
    return { ...this.failures };
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
    if (this.failures.exhaustedAt !== null) {
      // Every model failed on this conversation; try again once it has grown.
      if (stats.conversationTokens <= this.failures.exhaustedAt) return;
      this.failures = { count: 0, exhaustedAt: null };
    }
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
      { ...cfg, minIntervalMs: retryIntervalMs(cfg.minIntervalMs, this.failures.count) },
    );
    if (!trigger) return;
    const role = notesRoleAfter(this.failures.count) ?? 'cheap';
    this.lastAttemptMs = nowMs;
    this.compacting = true;
    this.preempted = false;
    let compacted = false;
    try {
      const idleMin = Math.round((nowMs - o.main.idleSince) / 60_000);
      const r = await o.main.compactWhileIdle(`idle for ${idleMin} min with about ${stats.conversationTokens} conversation tokens`, cfg.keepTokens, role === 'cheap' ? {} : { notesRole: role });
      compacted = r !== null;
      o.log.info({ trigger, compacted, notesRole: role, conversationTokens: stats.conversationTokens, droppableTokens: stats.droppableTokens }, 'idle compaction');
    } finally {
      this.compacting = false;
    }
    if (compacted || this.preempted) return;
    this.failed(stats.conversationTokens);
  }

  private failed(conversationTokens: number): void {
    const count = this.failures.count + 1;
    if (notesRoleAfter(count) !== null) {
      this.failures = { count, exhaustedAt: null };
      return;
    }
    this.failures = { count, exhaustedAt: conversationTokens };
    this.o.log.error({ attempts: count, roles: NOTES_ROLES }, 'idle compaction failed with every model; waiting for the conversation to grow');
    this.o.notify?.pushInternal({
      type: 'memory.compaction_failed',
      level: 3,
      trigger: 'piggyback',
      text: `Idle compaction failed ${count} times in a row (notes models: ${NOTES_ROLES.join(', ')}); the conversation stays as it is and is tried again once it grows. A capacity handoff still happens when it gets too long.`,
    });
  }

  private maybeDream(): void {
    const { dream, main, clock } = this.o;
    if (!dream || main.busy || !dream.due(clock.now(), main.idleSince)) return;
    dream.run();
  }
}
