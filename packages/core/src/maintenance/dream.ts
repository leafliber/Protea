import { isForkTerminal, type DreamStatus, type ForkInfo, type Level } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { KvNamespace } from '../db/repos.js';
import type { EventGateway } from '../events/gateway.js';
import type { ForkManager } from '../forks/fork-manager.js';
import type { MemoryStore } from '../memory/store.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import { isoInZone, type Clock } from '../util/time.js';
import type { DreamSettings } from './settings.js';

const STATE_KEY = 'dream';
const DREAM_LEVEL: Level = 4;
/** Reads the record and edits notes, nothing else: it cannot reach anyone. */
const DREAM_TOOLS = ['memory', 'memory_search', 'memory_recent', 'board', 'skill_load'];
const DREAM_SKILL = 'memory-dream';
/** Consecutive failures after which the daily run stops until someone starts it by hand. */
const MAX_FAILURES = 3;

interface DreamState {
  date?: string;
  forkId?: string;
  startedAt?: string;
  endedAt?: string;
  endedAtMs?: number;
  result?: 'completed' | 'failed' | 'cancelled';
  summary?: string;
  failures: number;
  disabled: boolean;
}

export interface DreamRunnerOptions {
  forks: Pick<ForkManager, 'spawn' | 'get'>;
  kv: KvNamespace;
  memory: Pick<MemoryStore, 'listFiles'>;
  bus: Bus;
  clock: Clock;
  timezone: string;
  settings: () => DreamSettings;
  /** Why this level may not spend budget now; null when it may. */
  budgetRefusal: () => string | null;
  /** The notes and index may have changed. */
  onCompleted: () => void;
  notify: Pick<EventGateway, 'pushInternal'>;
  log: Logger;
}

/**
 * The daily consolidation of the memory directory ("dream"): a fork that follows the
 * memory-dream skill. This class decides only when it runs and records how it went; what
 * it does is up to the skill. The fork id is stored at spawn, so a restart can tell how a
 * run ended even if the fork's final event was missed.
 */
export class DreamRunner {
  private off: (() => void) | null = null;

  constructor(private readonly o: DreamRunnerOptions) {}

  private load(): DreamState {
    return this.o.kv.get<DreamState>(STATE_KEY) ?? { failures: 0, disabled: false };
  }

  private save(state: DreamState): void {
    this.o.kv.set(STATE_KEY, state);
  }

  start(): void {
    if (this.off) return;
    this.off = this.o.bus.on('fork.changed', (f) => this.onFork(f));
    const state = this.load();
    if (state.forkId && !state.endedAt) {
      const fork = this.o.forks.get(state.forkId);
      if (!fork) this.finish(state, 'cancelled', 'the fork no longer exists');
      else if (isForkTerminal(fork.state)) this.onFork(fork);
    }
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  status(): DreamStatus {
    const s = this.load();
    const cfg = this.o.settings();
    return {
      enabled: cfg.enabled,
      disabled: s.disabled,
      running: Boolean(s.forkId && !s.endedAt),
      at: cfg.at,
      failures: s.failures,
      ...(s.date ? { date: s.date } : {}),
      ...(s.forkId ? { forkId: s.forkId } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      ...(s.result ? { result: s.result } : {}),
      ...(s.summary ? { summary: s.summary } : {}),
    };
  }

  /** Whether today's run should start now. */
  due(nowMs: number, idleSinceMs: number): boolean {
    const cfg = this.o.settings();
    const s = this.load();
    if (!cfg.enabled || s.disabled || (s.forkId && !s.endedAt)) return false;
    const local = isoInZone(nowMs, this.o.timezone);
    if (s.date === local.slice(0, 10) || local.slice(11, 16) < cfg.at) return false;
    if (nowMs - idleSinceMs < cfg.minIdleMs) return false;
    if (this.o.budgetRefusal() !== null) return false;
    // The run's own writes end before endedAtMs, so they do not count as something new.
    const since = s.endedAtMs ?? 0;
    return this.o.memory.listFiles().some((f) => f.mtimeMs > since);
  }

  /** Start a run now. A manual run also clears the stop after repeated failures. */
  run(opts: { manual?: boolean } = {}): { started: true; forkId: string } | { started: false; reason: string } {
    const state = this.load();
    if (state.forkId && !state.endedAt) return { started: false, reason: 'a consolidation is already running' };
    const refusal = this.o.budgetRefusal();
    if (refusal !== null) return { started: false, reason: refusal };
    const nowMs = this.o.clock.now();
    try {
      const fork = this.o.forks.spawn({
        goal: `Consolidate the memory directory: call skill_load with the name "${DREAM_SKILL}" and follow it. Finish with a two-line summary of what changed.`,
        ...(state.date ? { context: `The previous consolidation ran on ${state.date}.` } : {}),
        tools: DREAM_TOOLS,
        model: this.o.settings().model,
        level: DREAM_LEVEL,
        reportTo: 'none',
      });
      this.save({
        date: isoInZone(nowMs, this.o.timezone).slice(0, 10),
        forkId: fork.id,
        startedAt: new Date(nowMs).toISOString(),
        failures: opts.manual ? 0 : state.failures,
        disabled: false,
        ...(state.endedAtMs !== undefined ? { endedAtMs: state.endedAtMs } : {}),
      });
      this.o.log.info({ fork: fork.id, manual: opts.manual === true }, 'memory consolidation started');
      return { started: true, forkId: fork.id };
    } catch (err) {
      const reason = errorMessage(err);
      this.o.log.warn({ err: reason }, 'memory consolidation could not start');
      return { started: false, reason };
    }
  }

  private onFork(f: ForkInfo): void {
    if (!isForkTerminal(f.state)) return;
    const state = this.load();
    if (state.forkId !== f.id || state.endedAt) return;
    this.finish(state, f.state === 'completed' ? 'completed' : f.state === 'cancelled' ? 'cancelled' : 'failed', f.summary ?? f.error);
  }

  private finish(state: DreamState, result: NonNullable<DreamState['result']>, summary: string | undefined): void {
    const nowMs = this.o.clock.now();
    const failures = result === 'failed' ? state.failures + 1 : result === 'completed' ? 0 : state.failures;
    const disabled = failures >= MAX_FAILURES;
    const { summary: _previous, endedAtMs: _before, ...rest } = state;
    this.save({
      ...rest,
      endedAt: new Date(nowMs).toISOString(),
      endedAtMs: nowMs,
      result,
      ...(summary ? { summary } : {}),
      failures,
      disabled,
    });
    this.o.log.info({ fork: state.forkId, result }, 'memory consolidation ended');
    if (result === 'completed') {
      this.o.onCompleted();
    } else if (disabled && !state.disabled) {
      this.o.log.error({ failures }, 'memory consolidation stopped after repeated failures');
      this.o.notify.pushInternal({
        type: 'memory.dream_stopped',
        level: 2,
        trigger: 'flush',
        text: `The daily memory consolidation failed ${failures} times in a row and has stopped. A manual run from the console starts it again.`,
      });
    }
  }
}
