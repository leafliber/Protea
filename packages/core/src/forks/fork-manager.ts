import fs from 'node:fs';
import path from 'node:path';
import {
  isForkTerminal,
  isTextBlock,
  isToolUseBlock,
  type ContentBlock,
  type Effort,
  type EventInput,
  type ForkInfo,
  type ForkState,
  type Level,
  type ModelRole,
  type ToolResultBlock,
  type TranscriptMessage,
} from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { ForkSchedulerSettings } from '../config/types.js';
import { mergeConsecutive } from '../context/assembler.js';
import type { ToolExposure } from '../context/tool-search.js';
import type { SessionRepo, UsageRepo } from '../db/repos.js';
import type { Logger } from '../observability/logger.js';
import { ProviderError, type Provider, type ProviderResponse, type SystemSegment } from '../providers/types.js';
import { FORK_MISSING_RESULT_TEXT, Transcript, readTranscript } from '../session/transcript.js';
import type { ToolDispatcher } from '../tools/dispatcher.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { sleep } from '../util/abort.js';
import { errorMessage } from '../util/errors.js';
import { newId } from '../util/ids.js';
import type { Clock } from '../util/time.js';

export interface ForkRequest {
  goal: string;
  context?: string;
  /** Tool names the fork may call; defaults to every tool without side effects. */
  tools?: string[];
  model?: ModelRole;
  level: Level;
  maxTurns?: number;
  parentBatch?: string;
  reportTo?: 'main' | 'none';
}

/** Everything needed to continue a fork after a pause or restart (`<id>.checkpoint.json`). */
interface Checkpoint {
  id: string;
  goal: string;
  context?: string;
  tools: string[];
  model: ModelRole;
  level: Level;
  maxTurns: number;
  parentBatch?: string;
  reportTo: 'main' | 'none';
  state: ForkState;
  rounds: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  pauseReason?: string;
  summary?: string;
  error?: string;
}

type RunOutcome =
  | { kind: 'completed'; summary: string }
  | { kind: 'failed'; error: string }
  | { kind: 'paused' }
  | { kind: 'cancelled' };

interface Fork {
  cp: Checkpoint;
  transcript: Transcript | null;
  /** Cancel or shutdown: the reason ('cancel' | 'shutdown') decides the outcome. */
  hard: AbortController | null;
  /** The model call in flight; aborted when a yield times out. */
  call: AbortController | null;
  pauseRequested: string | null;
  yieldTimer: ReturnType<typeof setTimeout> | null;
  run: Promise<void> | null;
}

export interface ForkManagerOptions {
  /** Directory for fork transcripts and checkpoints (`<data>/sessions/forks`). */
  dir: string;
  /** Paths stored in the sessions table are relative to this. */
  dataDir: string;
  sessions: SessionRepo;
  usage: UsageRepo;
  bus: Bus;
  provider: Provider;
  tools: ToolRegistry;
  /** Tool search for fork requests (deferred MCP tools); without it every allowed tool loads. */
  exposure?: ToolExposure;
  dispatcher: ToolDispatcher;
  log: Logger;
  clock: Clock;
  settings: ForkSchedulerSettings;
  backoffMs: readonly number[];
  effortFor: (role: ModelRole) => Effort;
  /** System prompt segments for forks (stable across forks, so it caches). */
  system: () => SystemSegment[];
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
}

const WRAP_UP_TEXT =
  '[fork] One model round is left. Finish now: reply with your final summary of the outcome instead of calling more tools.';
const MAX_REPORT_CHARS = 4000;
const RECENT_ENDED = 10;

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Tools a fork never gets: session control and fork management stay with the main session. */
export function forkExcluded(d: ToolDef): boolean {
  return !!d.flags?.endsTurn || d.name.startsWith('fork_');
}

/**
 * Background tool loops (docs/10-architecture/05-sessions-and-agent-loop.md §5) and their
 * scheduling (04-scheduling-and-preemption.md §7): a concurrency cap with a FIFO queue,
 * cooperative pause while the main session runs an urgent batch, resume afterwards,
 * checkpoints, and recovery after a restart. Forks never receive events (I-1); they
 * report back through an internal `fork.completed` / `fork.failed` event.
 */
export class ForkManager {
  private readonly forks = new Map<string, Fork>();
  private started = false;
  private stopping = false;
  private yielding = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private mainBatch: { id: string; level: Level } | null = null;

  constructor(private readonly o: ForkManagerOptions) {
    fs.mkdirSync(o.dir, { recursive: true });
    o.bus.on('batch.started', (b) => this.onMainLevel(b.batchId, b.level));
    o.bus.on('batch.extended', (b) => this.onMainLevel(b.batchId, b.level));
    o.bus.on('session.phase', (p) => {
      if (p.sessionId === 'main' && p.phase === 'idle') this.onMainIdle();
    });
  }

  private file(id: string, ext: 'jsonl' | 'checkpoint.json'): string {
    return path.join(this.o.dir, `${id}.${ext}`);
  }

  private nowIso(): string {
    return new Date(this.o.clock.now()).toISOString();
  }

  /** Queue the forks that had not finished when the daemon last stopped. Call before start(). */
  recover(): number {
    let n = 0;
    for (const row of this.o.sessions.list('fork', ['queued', 'running', 'paused'])) {
      const cp = this.readCheckpoint(row.id);
      if (!cp) {
        this.o.sessions.setState(row.id, 'failed', { endedAt: this.nowIso(), summary: 'checkpoint missing' });
        this.o.log.warn({ fork: row.id }, 'fork checkpoint missing; marked failed');
        continue;
      }
      cp.state = 'queued';
      delete cp.pauseReason;
      const f = this.track(cp);
      this.persist(f);
      n++;
    }
    if (n > 0) this.o.log.info({ forks: n }, 'recovered unfinished forks');
    return n;
  }

  start(): void {
    this.started = true;
    this.pump();
  }

  /** Create a fork. Throws with a model-readable message when it is refused. */
  spawn(req: ForkRequest): ForkInfo {
    if (this.stopping) throw new Error('the daemon is stopping; no new forks');
    const { settings } = this.o;
    const queued = [...this.forks.values()].filter((f) => f.cp.state === 'queued').length;
    const active = [...this.forks.values()].filter((f) => f.cp.state === 'running' || f.cp.state === 'paused').length;
    if (active >= settings.maxConcurrent && queued >= settings.maxQueued) {
      throw new Error(`too many forks: ${active} active and ${queued} queued (limit ${settings.maxQueued} queued)`);
    }
    const tools = this.resolveTools(req.tools);
    const id = newId('f');
    const now = this.nowIso();
    const cp: Checkpoint = {
      id,
      goal: req.goal,
      tools,
      model: req.model ?? 'fork',
      level: req.level,
      maxTurns: Math.min(Math.max(1, req.maxTurns ?? settings.maxTurns), settings.maxTurns),
      reportTo: req.reportTo ?? 'main',
      state: 'queued',
      rounds: 0,
      createdAt: now,
      updatedAt: now,
      ...(req.context !== undefined ? { context: req.context } : {}),
      ...(req.parentBatch !== undefined ? { parentBatch: req.parentBatch } : {}),
    };
    const { transcript } = Transcript.open(this.file(id, 'jsonl'), { missingResultText: FORK_MISSING_RESULT_TEXT });
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: this.firstMessage(cp) }] });
    const f = this.track(cp);
    f.transcript = transcript;
    this.o.sessions.upsert({
      id,
      kind: 'fork',
      state: 'queued',
      level: cp.level,
      transcriptPath: path.relative(this.o.dataDir, this.file(id, 'jsonl')),
      checkpointPath: path.relative(this.o.dataDir, this.file(id, 'checkpoint.json')),
      model: cp.model,
      createdAt: now,
      ...(cp.parentBatch !== undefined ? { parentId: cp.parentBatch } : {}),
    });
    this.persist(f);
    this.o.log.info({ fork: id, level: cp.level, model: cp.model, tools: tools.length }, 'fork spawned');
    this.pump();
    return this.info(f);
  }

  cancel(id: string): ForkInfo {
    const f = this.forks.get(id);
    if (!f) throw new Error(`no fork ${id}`);
    if (isForkTerminal(f.cp.state)) return this.info(f);
    if (f.cp.state === 'running' && f.hard) {
      f.hard.abort('cancel');
      return this.info(f);
    }
    this.finish(f, { kind: 'cancelled' });
    return this.info(f);
  }

  get(id: string): ForkInfo | undefined {
    const f = this.forks.get(id);
    if (f) return this.info(f);
    const cp = this.o.sessions.get(id)?.kind === 'fork' ? this.readCheckpoint(id) : undefined;
    return cp ? this.info({ cp }) : undefined;
  }

  /** Unfinished forks (oldest first), then the most recently ended ones. */
  list(): ForkInfo[] {
    const live = [...this.forks.values()].filter((f) => !isForkTerminal(f.cp.state)).map((f) => this.info(f));
    const ended = this.o.sessions
      .list('fork', ['completed', 'cancelled', 'failed'])
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
      .slice(0, RECENT_ENDED)
      .map((r) => this.get(r.id))
      .filter((i): i is ForkInfo => i !== undefined);
    return [...live, ...ended];
  }

  /** Number of forks that are queued, running or paused. */
  activeCount(): number {
    return [...this.forks.values()].filter((f) => !isForkTerminal(f.cp.state)).length;
  }

  transcript(id: string): TranscriptMessage[] | undefined {
    if (!this.forks.has(id) && this.o.sessions.get(id)?.kind !== 'fork') return undefined;
    return readTranscript(this.file(id, 'jsonl'), FORK_MISSING_RESULT_TEXT);
  }

  /** Shutdown: ask running forks to pause, then abort the ones that do not reach a boundary in time. */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    const running = [...this.forks.values()].filter((f) => f.run);
    for (const f of running) f.pauseRequested = 'shutdown';
    const all = Promise.all(running.map((f) => f.run));
    const inTime = await Promise.race([all.then(() => true), sleep(graceMs).then(() => false)]);
    if (!inTime) {
      for (const f of running) f.hard?.abort('shutdown');
      await all;
    }
    for (const f of this.forks.values()) {
      f.transcript?.close();
      f.transcript = null;
    }
  }

  // —— Scheduling ——

  private onMainLevel(batchId: string, level: Level): void {
    this.mainBatch = { id: batchId, level };
    const { yieldLevel } = this.o.settings;
    if (yieldLevel === null || level > yieldLevel || this.yielding) return;
    this.yielding = true;
    const ids: string[] = [];
    for (const f of this.forks.values()) {
      if (f.cp.state !== 'running') continue;
      this.requestYield(f);
      ids.push(f.cp.id);
    }
    if (ids.length > 0) {
      this.o.bus.emit('scheduler.action', { kind: 'fork_yield', forkIds: ids, batchId });
      this.o.log.info({ forks: ids, batch: batchId }, 'forks yield to the main session');
    }
  }

  private requestYield(f: Fork): void {
    f.pauseRequested = 'yield';
    // Low-priority forks that keep the model busy too long lose their call (it is re-issued on resume).
    if (f.cp.level >= 3 && !f.yieldTimer) {
      f.yieldTimer = setTimeout(() => {
        f.yieldTimer = null;
        if (f.pauseRequested === 'yield' && f.call) {
          this.o.log.info({ fork: f.cp.id }, 'fork did not reach a boundary in time; cancelling its model call');
          f.call.abort('yield');
        }
      }, this.o.settings.yieldTimeoutMs);
    }
  }

  private onMainIdle(): void {
    this.mainBatch = null;
    if (!this.yielding) return;
    // The scheduler may start another urgent batch right away; decide once it had the chance.
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      const { yieldLevel } = this.o.settings;
      if (this.stopping || (this.mainBatch && yieldLevel !== null && this.mainBatch.level <= yieldLevel)) return;
      this.yielding = false;
      const resumed: string[] = [];
      for (const f of this.forks.values()) {
        if (f.pauseRequested === 'yield') {
          // Still running toward its boundary: just withdraw the request.
          f.pauseRequested = null;
          if (f.yieldTimer) clearTimeout(f.yieldTimer);
          f.yieldTimer = null;
        }
        if (f.cp.state === 'paused' && f.cp.pauseReason === 'yield') {
          this.launch(f);
          resumed.push(f.cp.id);
        }
      }
      if (resumed.length > 0) {
        this.o.bus.emit('scheduler.action', { kind: 'fork_resume', forkIds: resumed });
        this.o.log.info({ forks: resumed }, 'forks resumed');
      }
      this.pump();
    }, 0);
  }

  private pump(): void {
    if (!this.started || this.stopping || this.yielding) return;
    const forks = [...this.forks.values()];
    let active = forks.filter((f) => f.cp.state === 'running' || f.cp.state === 'paused').length;
    for (const f of forks.sort((a, b) => a.cp.createdAt.localeCompare(b.cp.createdAt))) {
      if (active >= this.o.settings.maxConcurrent) break;
      if (f.cp.state !== 'queued') continue;
      this.launch(f);
      active++;
    }
  }

  private launch(f: Fork): void {
    f.cp.state = 'running';
    delete f.cp.pauseReason;
    f.pauseRequested = null;
    f.hard = new AbortController();
    this.persist(f);
    f.run = this.runFork(f)
      .catch((err: unknown): RunOutcome => ({ kind: 'failed', error: `fork crashed: ${errorMessage(err)}` }))
      .then((outcome) => this.finish(f, outcome));
  }

  private finish(f: Fork, outcome: RunOutcome): void {
    if (f.yieldTimer) clearTimeout(f.yieldTimer);
    f.yieldTimer = null;
    const pauseReason = f.pauseRequested ?? 'shutdown';
    f.run = null;
    f.hard = null;
    f.pauseRequested = null;
    const now = this.nowIso();
    if (outcome.kind === 'paused') {
      f.cp.state = 'paused';
      f.cp.pauseReason = pauseReason;
      this.persist(f);
      this.o.log.info({ fork: f.cp.id, reason: pauseReason, rounds: f.cp.rounds }, 'fork paused');
      return;
    }
    f.cp.state = outcome.kind;
    f.cp.endedAt = now;
    if (outcome.kind === 'completed') f.cp.summary = outcome.summary;
    if (outcome.kind === 'failed') f.cp.error = outcome.error;
    f.transcript?.appendMark('fork_ended', { state: outcome.kind, rounds: f.cp.rounds });
    f.transcript?.close();
    f.transcript = null;
    this.o.sessions.setState(f.cp.id, outcome.kind, {
      endedAt: now,
      ...(f.cp.summary !== undefined ? { summary: clip(f.cp.summary, 2000) } : {}),
      ...(f.cp.error !== undefined ? { summary: f.cp.error } : {}),
    });
    this.persist(f);
    this.o.log.info({ fork: f.cp.id, state: outcome.kind, rounds: f.cp.rounds }, 'fork ended');
    if (outcome.kind !== 'cancelled') this.report(f);
    this.pump();
  }

  private report(f: Fork): void {
    if (f.cp.reportTo === 'none') return;
    const level = Math.max(2, f.cp.level) as Level;
    const head = `Fork ${f.cp.id} ${f.cp.state} after ${f.cp.rounds} round(s). Goal: ${clip(f.cp.goal, 300)}`;
    const body =
      f.cp.state === 'completed'
        ? `Result:\n${clip(f.cp.summary ?? '', MAX_REPORT_CHARS)}`
        : `Error: ${f.cp.error ?? 'unknown'}`;
    this.o.pushInternal({
      type: `fork.${f.cp.state}`,
      level,
      trigger: level <= 3 ? 'flush' : 'piggyback',
      text: `${head}\n${body}`,
      correlation: f.cp.id,
    });
  }

  // —— The fork's own loop ——

  private async runFork(f: Fork): Promise<RunOutcome> {
    const o = this.o;
    const hard = (f.hard as AbortController).signal;
    if (!f.transcript) {
      const { transcript, report } = Transcript.open(this.file(f.cp.id, 'jsonl'), { missingResultText: FORK_MISSING_RESULT_TEXT });
      if (report.actions.length > 0 || report.placeholderResults.length > 0 || report.truncatedBytes > 0) {
        o.log.warn({ fork: f.cp.id, ...report }, 'fork transcript repaired');
      }
      f.transcript = transcript;
    }
    const t = f.transcript;
    const allowed = new Set(f.cp.tools);
    const stopped = (): RunOutcome | null => {
      if (hard.aborted) return hard.reason === 'cancel' ? { kind: 'cancelled' } : { kind: 'paused' };
      if (f.pauseRequested) return { kind: 'paused' };
      return null;
    };
    for (;;) {
      const stop = stopped();
      if (stop) return stop;
      const last = t.lastMessage();
      // Finished just before a restart: the final reply is already in the transcript.
      if (last?.role === 'assistant') return { kind: 'completed', summary: textOf(last.content) || '(no final text)' };
      if (f.cp.rounds >= f.cp.maxTurns) {
        return { kind: 'completed', summary: `Stopped at the limit of ${f.cp.maxTurns} rounds without a final summary.` };
      }
      const toolSet = o.exposure?.forRequest(t.messages, { role: f.cp.model, allowed });
      const res = await this.callModel(f, {
        role: f.cp.model,
        system: o.system(),
        messages: mergeConsecutive(t.messages),
        tools: toolSet ? toolSet.tools : o.tools.forProvider((d) => allowed.has(d.name)),
        ...(toolSet?.toolSearch ? { toolSearch: true } : {}),
        effort: o.effortFor(f.cp.model),
      });
      if ('kind' in res) return res;
      f.cp.rounds++;
      t.appendMessage({ role: 'assistant', content: res.content, usage: res.usage, stop: res.stopReason, model: res.model });
      this.recordUsage(f, res);

      if (res.stopReason === 'refusal') {
        this.answerUnrun(t, res.content, 'not run: the response was declined');
        return { kind: 'failed', error: 'the model declined to continue' };
      }
      const uses = res.content.filter(isToolUseBlock);
      if (uses.length === 0) return { kind: 'completed', summary: textOf(res.content) || '(no final text)' };
      if (res.stopReason === 'max_tokens') {
        this.answerUnrun(t, res.content, 'not run: the tool input was cut off at max_tokens');
        this.persist(f);
        continue;
      }
      const dispatched = await o.dispatcher.runAll(uses, {
        signal: hard,
        sessionId: f.cp.id,
        batchId: f.cp.id,
        batchLevel: f.cp.level,
        allowed,
      });
      const content: ContentBlock[] = [...dispatched.results];
      if (f.cp.rounds === f.cp.maxTurns - 1) content.push({ type: 'text', text: WRAP_UP_TEXT });
      t.appendMessage({ role: 'user', content });
      this.persist(f);
    }
  }

  private async callModel(
    f: Fork,
    req: Parameters<Provider['generate']>[0],
  ): Promise<ProviderResponse | RunOutcome> {
    const o = this.o;
    const hard = (f.hard as AbortController).signal;
    const interrupted = (): RunOutcome | null => {
      if (hard.aborted) return hard.reason === 'cancel' ? { kind: 'cancelled' } : { kind: 'paused' };
      return null;
    };
    for (let attempt = 0; ; attempt++) {
      const call = new AbortController();
      f.call = call;
      const signal = AbortSignal.any([hard, call.signal]);
      try {
        return await o.provider.generate(req, { signal });
      } catch (err) {
        const stop = interrupted() ?? (call.signal.aborted ? ({ kind: 'paused' } as const) : null);
        if (stop) return stop;
        const kind = err instanceof ProviderError ? err.kind : 'fatal';
        const delay = o.backoffMs[attempt];
        if (kind === 'retryable' && delay !== undefined) {
          o.log.warn({ fork: f.cp.id, attempt: attempt + 1, delayMs: delay, err: errorMessage(err) }, 'fork model call failed; backing off');
          try {
            await sleep(delay, signal);
          } catch {
            return interrupted() ?? { kind: 'paused' };
          }
          continue;
        }
        return { kind: 'failed', error: `model call failed (${kind}): ${errorMessage(err)}` };
      } finally {
        f.call = null;
      }
    }
  }

  private answerUnrun(t: Transcript, content: ContentBlock[], text: string): void {
    const results: ToolResultBlock[] = content
      .filter(isToolUseBlock)
      .map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: text, is_error: true }));
    if (results.length > 0) t.appendMessage({ role: 'user', content: results });
  }

  private recordUsage(f: Fork, r: ProviderResponse): void {
    const now = this.o.clock.now();
    const rec = {
      at: new Date(now).toISOString(),
      atMs: now,
      provider: this.o.provider.id,
      model: r.model,
      role: f.cp.model,
      sessionId: f.cp.id,
      level: f.cp.level,
      ...r.usage,
      stopReason: r.stopReason,
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r.model !== r.requestedModel ? { fallbackModel: r.model } : {}),
    };
    this.o.usage.record(rec);
    this.o.bus.emit('usage.recorded', rec);
  }

  // —— Bookkeeping ——

  private resolveTools(requested?: string[]): string[] {
    const candidates = this.o.tools.list().filter((d) => !forkExcluded(d));
    if (requested === undefined) return candidates.filter((d) => !d.flags?.sideEffect).map((d) => d.name);
    const names = new Set(candidates.map((d) => d.name));
    const unknown = requested.filter((n) => !names.has(n));
    if (unknown.length > 0) {
      throw new Error(`these tools are not available to forks: ${unknown.join(', ')}`);
    }
    return [...new Set(requested)].sort();
  }

  private firstMessage(cp: Checkpoint): string {
    return [
      `<fork id="${cp.id}" level="${cp.level}" max_rounds="${cp.maxTurns}">`,
      `Goal:\n${cp.goal}`,
      ...(cp.context ? [`Context from the main session:\n${cp.context}`] : []),
      '</fork>',
    ].join('\n\n');
  }

  private track(cp: Checkpoint): Fork {
    const f: Fork = { cp, transcript: null, hard: null, call: null, pauseRequested: null, yieldTimer: null, run: null };
    this.forks.set(cp.id, f);
    return f;
  }

  private persist(f: Fork): void {
    f.cp.updatedAt = this.nowIso();
    if (!isForkTerminal(f.cp.state)) this.o.sessions.setState(f.cp.id, f.cp.state);
    const file = this.file(f.cp.id, 'checkpoint.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(f.cp, null, 2)}\n`);
    fs.renameSync(tmp, file);
    this.o.bus.emit('fork.changed', this.info(f));
  }

  private readCheckpoint(id: string): Checkpoint | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(id, 'checkpoint.json'), 'utf8')) as Checkpoint;
    } catch {
      return undefined;
    }
  }

  private info(f: Pick<Fork, 'cp'>): ForkInfo {
    const cp = f.cp;
    return {
      id: cp.id,
      state: cp.state,
      level: cp.level,
      model: cp.model,
      goal: clip(cp.goal, 200),
      rounds: cp.rounds,
      createdAt: cp.createdAt,
      ...(cp.endedAt !== undefined ? { endedAt: cp.endedAt } : {}),
      ...(cp.pauseReason !== undefined ? { pauseReason: cp.pauseReason } : {}),
      ...(cp.summary !== undefined ? { summary: clip(cp.summary, 500) } : {}),
      ...(cp.error !== undefined ? { error: cp.error } : {}),
    };
  }
}
