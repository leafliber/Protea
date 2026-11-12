import { isForkTerminal, type DreamStatus, type ForkInfo, type Level, type MemoryCheck, type MemoryRecall } from '@protea/protocol';
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
export const DREAM_TOOLS = ['memory', 'memory_search', 'board', 'skill_load'];
const DREAM_SKILL = 'memory-dream';
/** Consecutive failures after which the daily run stops until someone starts it by hand. */
const MAX_FAILURES = 3;
/** Files listed as changed in the first message; past this the list says how many more. */
const MAX_CHANGED = 60;
/** Days of memory use the first message reports. */
const RECALL_DAYS = 30;

interface DreamState {
  date?: string;
  forkId?: string;
  startedAt?: string;
  /** When the run started, for counting its writes. */
  startedAtMs?: number;
  endedAt?: string;
  result?: 'completed' | 'failed' | 'cancelled';
  /** Why a completed run was not accepted. */
  rejected?: string;
  summary?: string;
  failures: number;
  disabled: boolean;
  /** End of the latest accepted run: what changed after it is new. */
  acceptedAt?: string;
  acceptedAtMs?: number;
}

/** What the consolidation is told about the memory directory before it starts. */
export interface DreamInputs {
  usage: () => Array<{ path: string; chars: number; limit: number }>;
  checks: () => MemoryCheck[];
  recall: (days: number) => MemoryRecall;
  /** Writes a session made since a moment. */
  writesBy: (session: string, sinceMs: number) => number;
}

export interface DreamRunnerOptions {
  forks: Pick<ForkManager, 'spawn' | 'get'>;
  kv: KvNamespace;
  memory: Pick<MemoryStore, 'listFiles'>;
  inputs: DreamInputs;
  bus: Bus;
  clock: Clock;
  timezone: string;
  settings: () => DreamSettings;
  /** Why this level may not spend budget now; null when it may. */
  budgetRefusal: () => string | null;
  /** An accepted run: the notes and resident files may have changed. */
  onCompleted: () => void;
  notify: Pick<EventGateway, 'pushInternal'>;
  log: Logger;
}

/**
 * The daily consolidation of the memory directory ("dream"): a fork that follows the
 * memory-dream skill. This class decides when it runs, tells it what changed, and checks the
 * result mechanically (a final summary, at least one write, resident files within their
 * limits); what it does is up to the skill. The fork id is stored at spawn, so a restart can
 * tell how a run ended even if the fork's final event was missed.
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

  /** The fork of the run in progress, if one is. */
  get runningForkId(): string | null {
    const s = this.load();
    return s.forkId && !s.endedAt ? s.forkId : null;
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
      ...(s.rejected ? { rejected: s.rejected } : {}),
      ...(s.summary ? { summary: s.summary } : {}),
      ...(s.acceptedAt ? { acceptedAt: s.acceptedAt } : {}),
    };
  }

  /** Files changed after the latest accepted run, newest first. */
  private changedSince(sinceMs: number): Array<{ path: string; size: number; mtimeMs: number }> {
    return this.o.memory
      .listFiles()
      .filter((f) => f.mtimeMs > sinceMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
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
    // An accepted run's own writes end before acceptedAtMs, so they do not count as something new.
    return this.changedSince(s.acceptedAtMs ?? 0).length > 0;
  }

  /** The first message's context: what changed, how full the resident files are, what needs care, how memory was used. */
  private context(state: DreamState): string {
    const since = state.acceptedAtMs ?? 0;
    const changed = this.changedSince(since);
    const lines = [state.acceptedAt ? `The previous accepted consolidation ended at ${state.acceptedAt}.` : 'This is the first consolidation.', '', '<memory_state>'];
    lines.push(`<changed since="${state.acceptedAt ?? 'the beginning'}" files="${changed.length}">`);
    for (const f of changed.slice(0, MAX_CHANGED)) lines.push(`${f.path} (${f.size} bytes)`);
    if (changed.length > MAX_CHANGED) lines.push(`… ${changed.length - MAX_CHANGED} more`);
    lines.push('</changed>', '<core>');
    for (const u of this.o.inputs.usage()) lines.push(`${u.path} ${u.chars}/${u.limit} characters`);
    lines.push('</core>');
    const checks = this.o.inputs.checks();
    if (checks.length > 0) {
      lines.push('<checks>');
      for (const c of checks) lines.push(`${c.path}: ${c.problem}${c.detail ? ` (${c.detail})` : ''}`);
      lines.push('</checks>');
    }
    const r = this.o.inputs.recall(RECALL_DAYS);
    lines.push(`<recall days="${r.days}" searches="${r.searches}">`);
    if (r.used.length > 0) lines.push(`read or found: ${r.used.slice(0, 20).map((u) => `${u.path} (${u.reads} reads, ${u.hits} hits)`).join('; ')}`);
    if (r.unused.length > 0) lines.push(`notes never read or found: ${r.unused.join(', ')}`);
    if (r.misses.length > 0) lines.push(`searches that found nothing: ${r.misses.map((m) => `${JSON.stringify(m.query)} ×${m.times}`).join('; ')}`);
    lines.push('</recall>', '</memory_state>');
    return lines.join('\n');
  }

  /** Start a run now. A manual run also clears the stop after repeated failures. */
  run(opts: { manual?: boolean } = {}): { started: true; forkId: string } | { started: false; reason: string } {
    const state = this.load();
    if (state.forkId && !state.endedAt) return { started: false, reason: 'a consolidation is already running' };
    const refusal = this.o.budgetRefusal();
    if (refusal !== null) return { started: false, reason: refusal };
    const nowMs = this.o.clock.now();
    const cfg = this.o.settings();
    try {
      const fork = this.o.forks.spawn({
        goal: `Consolidate the memory directory: call skill_load with the name "${DREAM_SKILL}" and follow it. Finish with a two-line summary of what changed.`,
        context: this.context(state),
        tools: DREAM_TOOLS,
        model: cfg.model,
        maxTurns: cfg.maxTurns,
        uncapped: true,
        level: DREAM_LEVEL,
        reportTo: 'none',
      });
      this.save({
        date: isoInZone(nowMs, this.o.timezone).slice(0, 10),
        forkId: fork.id,
        startedAt: new Date(nowMs).toISOString(),
        startedAtMs: nowMs,
        failures: opts.manual ? 0 : state.failures,
        disabled: false,
        ...(state.acceptedAt ? { acceptedAt: state.acceptedAt } : {}),
        ...(state.acceptedAtMs !== undefined ? { acceptedAtMs: state.acceptedAtMs } : {}),
      });
      this.o.log.info({ fork: fork.id, manual: opts.manual === true }, 'memory consolidation started');
      return { started: true, forkId: fork.id };
    } catch (err) {
      const reason = errorMessage(err);
      this.o.log.warn({ err: reason }, 'memory consolidation could not start');
      return { started: false, reason };
    }
  }

  /** Why a completed run cannot be accepted, or null. */
  private rejection(state: DreamState, f: ForkInfo): string | null {
    if (f.unfinished === 'round_limit') return 'it ran out of rounds before finishing';
    if (f.unfinished === 'no_final_text' || !f.summary?.trim()) return 'it gave no final summary';
    if (this.o.inputs.writesBy(f.id, state.startedAtMs ?? 0) === 0) return 'it wrote nothing';
    const over = this.o.inputs.checks().filter((c) => c.problem === 'over_limit');
    if (over.length > 0) return `${over.map((c) => c.path).join(', ')} over the limit`;
    return null;
  }

  private onFork(f: ForkInfo): void {
    if (!isForkTerminal(f.state)) return;
    const state = this.load();
    if (state.forkId !== f.id || state.endedAt) return;
    if (f.state === 'completed') {
      const why = this.rejection(state, f);
      this.finish(state, why ? 'failed' : 'completed', f.summary, why ?? undefined);
    } else {
      this.finish(state, f.state === 'cancelled' ? 'cancelled' : 'failed', f.summary ?? f.error);
    }
  }

  private finish(state: DreamState, result: NonNullable<DreamState['result']>, summary: string | undefined, rejected?: string): void {
    const nowMs = this.o.clock.now();
    const failures = result === 'failed' ? state.failures + 1 : result === 'completed' ? 0 : state.failures;
    const disabled = failures >= MAX_FAILURES;
    const { summary: _summary, rejected: _rejected, ...rest } = state;
    const accepted = result === 'completed';
    this.save({
      ...rest,
      endedAt: new Date(nowMs).toISOString(),
      result,
      ...(summary ? { summary } : {}),
      ...(rejected ? { rejected } : {}),
      failures,
      disabled,
      ...(accepted ? { acceptedAt: new Date(nowMs).toISOString(), acceptedAtMs: nowMs } : {}),
    });
    this.o.log.info({ fork: state.forkId, result, ...(rejected ? { rejected } : {}) }, 'memory consolidation ended');
    if (accepted) {
      this.o.onCompleted();
    } else if (disabled && !state.disabled) {
      this.o.log.error({ failures }, 'memory consolidation stopped after repeated failures');
      this.o.notify.pushInternal({
        type: 'memory.dream_stopped',
        level: 2,
        trigger: 'flush',
        text: `The daily memory consolidation failed ${failures} times in a row and has stopped${rejected ? ` (last time: ${rejected})` : ''}. A manual run from the console starts it again.`,
      });
    }
  }
}
