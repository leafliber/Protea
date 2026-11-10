import { PERMISSION_MODES, type PermissionMode, type PermissionModeInfo } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { KvNamespace } from '../db/repos.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../util/time.js';
import type { AuditLog } from './audit.js';
import type { BaselineMode, PermissionSettings } from './policy.js';

const STATE_KEY = 'mode';
const HOUR_MS = 3_600_000;
/** A temporary mode lasts at most this long; bypass is limited by `permissions.grantMaxMs` instead. */
const MAX_OVERRIDE_MS = 30 * 24 * HOUR_MS;

export interface JudgeStatus {
  model: string;
  ready: boolean;
  problem?: string;
}

export interface PermissionModesOptions {
  kv: KvNamespace;
  audit: AuditLog;
  bus: Bus;
  clock: Clock;
  log: Logger;
  settings: () => PermissionSettings;
  /** Write `permissions.mode` to config.yaml and apply it. */
  persistBaseline: (mode: BaselineMode) => Promise<void> | void;
  judgeStatus: () => JudgeStatus;
  /** Tell the owner something once (auto mode paused). */
  notifyOwner: (text: string) => void;
}

interface ModeState {
  override?: { mode: PermissionMode; untilMs: number; by: string; setAtMs: number };
  /** Auto mode stopped itself; the effective mode is `ask` until the owner sets a mode again. */
  paused?: { atMs: number; reason: string };
  sinceMs: number;
  allowed: number;
  held: number;
  consecutiveHolds: number;
  recentHolds: number[];
}

/** A request the mode service refuses; the message is meant for the owner. */
export class PermissionModeError extends Error {
  override readonly name = 'PermissionModeError';
}

/**
 * Who clears a call whose policy is `ask` (docs/20-decisions/ADR-0015-permission-modes-and-auto-review.md).
 * The baseline lives in config.yaml; a temporary mode and the auto-mode counters live in the
 * database, so a bypass that was given a time limit keeps it across a restart.
 */
export class PermissionModes {
  private state: ModeState;

  constructor(private readonly o: PermissionModesOptions) {
    this.state = o.kv.get<ModeState>(STATE_KEY) ?? this.fresh();
  }

  private fresh(): ModeState {
    return { sinceMs: this.o.clock.now(), allowed: 0, held: 0, consecutiveHolds: 0, recentHolds: [] };
  }

  private save(): void {
    this.o.kv.set(STATE_KEY, this.state);
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** The mode set by the owner, ending a temporary one whose time is up. */
  private chosen(): PermissionMode {
    const o = this.state.override;
    if (o && o.untilMs <= this.o.clock.now()) {
      delete this.state.override;
      delete this.state.paused;
      this.save();
      this.o.audit.record({ kind: 'permission_mode', owner: 'system', summary: `${o.mode} -> ${this.o.settings().mode}`, outcome: 'expired', detail: `set by ${o.by}` });
      this.o.log.info({ mode: o.mode, baseline: this.o.settings().mode }, 'temporary permission mode ended');
      this.o.bus.emit('permission.mode', this.info());
    }
    return this.state.override?.mode ?? this.o.settings().mode;
  }

  /** The mode in effect now. */
  current(): PermissionMode {
    const mode = this.chosen();
    return mode === 'auto' && this.state.paused ? 'ask' : mode;
  }

  info(): PermissionModeInfo {
    const mode = this.current();
    const { override: o, paused } = this.state;
    return {
      mode,
      baseline: this.o.settings().mode,
      ...(o ? { override: { mode: o.mode, until: this.iso(o.untilMs), by: o.by, setAt: this.iso(o.setAtMs) } } : {}),
      ...(paused && this.chosen() === 'auto' ? { paused: { at: this.iso(paused.atMs), reason: paused.reason } } : {}),
      auto: { since: this.iso(this.state.sinceMs), allowed: this.state.allowed, held: this.state.held, judge: this.o.judgeStatus() },
      bypassMaxMs: this.o.settings().grantMaxMs,
    };
  }

  /**
   * Switch modes. Without `forMs` the mode becomes the baseline (config.yaml); with it, a
   * temporary mode that ends by itself. Either way a paused auto mode and its counters start over.
   */
  async set(mode: PermissionMode, opts: { forMs?: number; by: string }): Promise<PermissionModeInfo> {
    if (!PERMISSION_MODES.includes(mode)) throw new PermissionModeError(`mode must be one of ${PERMISSION_MODES.join(', ')}`);
    if (opts.forMs !== undefined && !(Number.isFinite(opts.forMs) && opts.forMs > 0)) throw new PermissionModeError('the duration must be positive');
    const grantMax = this.o.settings().grantMaxMs;
    if (mode === 'bypass') {
      if (opts.forMs === undefined) throw new PermissionModeError('bypass needs a time limit, for example 30m');
      if (!(grantMax > 0)) throw new PermissionModeError('time-limited permissions are off (permissions.grantMaxMs is 0)');
    }
    const before = this.current();
    const now = this.o.clock.now();
    const ms = opts.forMs === undefined ? undefined : Math.min(opts.forMs, mode === 'bypass' ? grantMax : MAX_OVERRIDE_MS);
    if (ms === undefined) await this.o.persistBaseline(mode as BaselineMode);
    this.state = { ...this.fresh(), ...(ms !== undefined ? { override: { mode, untilMs: now + ms, by: opts.by, setAtMs: now } } : {}) };
    this.save();
    this.o.audit.record({ kind: 'permission_mode', owner: opts.by, summary: `${before} -> ${mode}`, outcome: ms !== undefined ? 'temporary' : 'baseline', ...(ms !== undefined ? { detail: `until ${this.iso(now + ms)}` } : {}) });
    this.o.log.info({ from: before, to: mode, by: opts.by, ...(ms !== undefined ? { forMs: ms } : {}) }, 'permission mode changed');
    const info = this.info();
    this.o.bus.emit('permission.mode', info);
    return info;
  }

  /** Count one review. Too many holds pause auto mode: the judge or the task has gone wrong. */
  noteReview(allowed: boolean): void {
    const s = this.state;
    if (allowed) {
      s.allowed++;
      s.consecutiveHolds = 0;
      this.save();
      return;
    }
    const now = this.o.clock.now();
    s.held++;
    s.consecutiveHolds++;
    s.recentHolds = [...s.recentHolds.filter((t) => now - t < HOUR_MS), now];
    const { pauseAfterConsecutive, pauseAfterPerHour } = this.o.settings().auto;
    const reason =
      s.consecutiveHolds >= pauseAfterConsecutive
        ? `${s.consecutiveHolds} calls in a row were not allowed`
        : s.recentHolds.length >= pauseAfterPerHour
          ? `${s.recentHolds.length} calls in the last hour were not allowed`
          : null;
    if (reason === null || s.paused || this.chosen() !== 'auto') {
      this.save();
      return;
    }
    s.paused = { atMs: now, reason };
    this.save();
    this.o.audit.record({ kind: 'permission_mode', owner: 'system', summary: 'auto -> ask', outcome: 'paused', detail: reason });
    this.o.log.warn({ reason }, 'auto permission mode paused');
    this.o.notifyOwner(`Auto permission mode is paused: ${reason}. Calls that need approval now come to you. Send /mode auto to resume.`);
    this.o.bus.emit('permission.mode', this.info());
  }
}
