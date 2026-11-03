import {
  isToolUseBlock,
  type BatchEndReason,
  type BatchReason,
  type CancelKind,
  type ContentBlock,
  type Effort,
  type EventEnvelope,
  type EventInput,
  type Level,
  type RunPhase,
  type ToolResultBlock,
} from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { ContextAssembler } from '../context/assembler.js';
import type { BatchRepo, UsageRepo } from '../db/repos.js';
import { renderEventsBlock, renderStatusBlock, type StatusSnapshot } from '../events/render.js';
import type { EventStore } from '../events/store.js';
import type { Logger } from '../observability/logger.js';
import { ProviderError, type Provider, type ProviderResponse } from '../providers/types.js';
import type { RunningTurn } from '../scheduler/preemption.js';
import type { ToolDispatcher } from '../tools/dispatcher.js';
import { isAbortError, sleep } from '../util/abort.js';
import { errorMessage } from '../util/errors.js';
import { newId } from '../util/ids.js';
import type { Clock } from '../util/time.js';
import type { Transcript } from './transcript.js';

export interface Batch {
  id: string;
  level: Level;
  reason: BatchReason;
  events: EventEnvelope[];
}

/** The event that cut a turn short. */
export interface CancelCause {
  kind: CancelKind;
  cursor: number;
  source: string;
  level: Level;
}

/** What the session needs from the scheduler. */
export interface BatchFeed {
  /** Events that are due for delivery at a turn boundary inside a running batch. */
  takeBoundaryEvents(): EventEnvelope[];
  /** Called after the session returns to idle. */
  onIdle(): void;
}

export interface MainSessionOptions {
  transcript: Transcript;
  store: EventStore;
  batches: BatchRepo;
  usage: UsageRepo;
  bus: Bus;
  provider: Provider;
  assembler: ContextAssembler;
  dispatcher: ToolDispatcher;
  log: Logger;
  clock: Clock;
  rounds: { soft: number; hard: number };
  backoffMs: readonly number[];
  effortFor: (level: Level) => Effort;
  status: () => StatusSnapshot;
  /** Push an internal (Core) event. */
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
  /**
   * Optional streaming output tap (e.g. a typing indicator or live text to a channel).
   * Once it has received text, the model call counts as having external output and
   * can no longer be preempted (only interrupted).
   */
  outputTap?: (delta: string, ctx: { batchId: string }) => void;
}

interface Running {
  batch: Batch;
  /** Hard abort: shutdown. Everything stops; the batch resumes after restart. */
  abort: AbortController;
  /** Interrupt: cancels the model call and interruptible tools; the batch ends. */
  turn: AbortController;
  /** Preempt: cancels only the current model call, which is then re-issued with the new events. */
  call: AbortController | null;
  externalOutput: boolean;
  cancel: CancelCause | null;
  done: Promise<void>;
}

const SESSION_ID = 'main';

/**
 * The single resident session that receives events (invariant I-1). Runs one
 * batch at a time: append events → model → tools → (boundary events) → model …
 * See docs/10-architecture/05-sessions-and-agent-loop.md.
 */
export class MainSession {
  private _phase: RunPhase = 'idle';
  private current: Running | null = null;
  private feed: BatchFeed | null = null;

  constructor(private readonly o: MainSessionOptions) {}

  attachFeed(feed: BatchFeed): void {
    this.feed = feed;
  }

  get phase(): RunPhase {
    return this._phase;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  get currentBatchId(): string | null {
    return this.current?.batch.id ?? null;
  }

  /** The running batch as the preemption matrix sees it; null when idle. */
  runningTurn(): (RunningTurn & { batchId: string }) | null {
    const cur = this.current;
    if (!cur) return null;
    return { batchId: cur.batch.id, batchLevel: cur.batch.level, phase: this._phase, externalOutput: cur.externalOutput };
  }

  /**
   * Cut the running turn short on behalf of a more urgent event. `preempt` cancels the
   * model call (or its backoff) and re-issues it with the new events merged in;
   * `interrupt` also cancels interruptible tools and ends the batch, so the interrupting
   * events start the next one. Returns false if there is nothing to cancel.
   */
  cancel(cause: CancelCause): boolean {
    const cur = this.current;
    if (!cur || cur.abort.signal.aborted) return false;
    if (cause.kind === 'preempt') {
      if (cur.cancel || !cur.call || (this._phase !== 'model' && this._phase !== 'backoff')) return false;
      cur.cancel = cause;
      cur.call.abort(cause);
      return true;
    }
    if (cur.cancel?.kind === 'interrupt') return false;
    cur.cancel = cause; // an interrupt supersedes a preempt that has not been handled yet
    cur.turn.abort(cause);
    return true;
  }

  needsResume(): boolean {
    return this.o.transcript.needsResume();
  }

  /** Level of the batch that was interrupted (for effort selection when resuming). */
  resumeLevel(): Level {
    const id = this.o.transcript.lastBatchId();
    return (id ? this.o.batches.get(id)?.level : undefined) ?? 2;
  }

  /** Start a batch. Throws if one is running: the scheduler must only deliver when idle. */
  deliver(batch: Batch): Promise<void> {
    if (this.current) throw new Error(`main session is busy with ${this.current.batch.id}; cannot deliver ${batch.id}`);
    const cur: Running = {
      batch,
      abort: new AbortController(),
      turn: new AbortController(),
      call: null,
      externalOutput: false,
      cancel: null,
      done: Promise.resolve(),
    };
    this.current = cur;
    cur.done = this.runBatch(cur)
      .catch((err: unknown) => {
        this.o.log.error({ err: errorMessage(err), batch: batch.id }, 'batch crashed');
      })
      .finally(() => {
        this.current = null;
        this.setPhase('idle');
        this.feed?.onIdle();
      });
    return cur.done;
  }

  /** Wait for the running batch; abort it if it does not finish in time. Returns true if it finished on its own. */
  async drain(timeoutMs: number): Promise<boolean> {
    const cur = this.current;
    if (!cur) return true;
    const finished = await Promise.race([cur.done.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!finished) {
      cur.abort.abort('shutdown');
      await cur.done;
    }
    return finished;
  }

  private setPhase(phase: RunPhase, extra: { batchId?: string; round?: number } = {}): void {
    this._phase = phase;
    this.o.bus.emit('session.phase', { sessionId: SESSION_ID, phase, ...extra });
  }

  private nowIso(): string {
    return new Date(this.o.clock.now()).toISOString();
  }

  /** Append events (and the status snapshot) to the transcript, then mark them delivered. */
  private eventBlocks(batch: Batch, events: EventEnvelope[]): ContentBlock[] {
    if (events.length === 0) return [];
    return [renderEventsBlock(events, batch.id), renderStatusBlock(this.o.status())];
  }

  private settleDelivered(batch: Batch, events: EventEnvelope[]): void {
    if (events.length === 0) return;
    this.o.store.settle(
      events.map((e) => e.cursor),
      'delivered',
      { batchId: batch.id, sessionId: SESSION_ID },
    );
  }

  private raiseLevel(batch: Batch, events: EventEnvelope[]): void {
    const min = Math.min(batch.level, ...events.map((e) => e.effLevel)) as Level;
    if (min < batch.level) {
      batch.level = min;
      this.o.batches.setLevel(batch.id, min);
    }
  }

  /** Events that became due at a boundary join the conversation in the given user message content. */
  private appendWithBoundaryEvents(batch: Batch, head: ContentBlock[]): void {
    const extra = this.feed?.takeBoundaryEvents() ?? [];
    if (head.length === 0 && extra.length === 0) return;
    if (extra.length > 0) this.raiseLevel(batch, extra);
    this.o.transcript.appendMessage({
      role: 'user',
      content: [...head, ...this.eventBlocks(batch, extra)],
      batch: batch.id,
      ...(extra.length > 0 ? { cursors: extra.map((e) => e.cursor) } : {}),
    });
    if (extra.length > 0) {
      this.settleDelivered(batch, extra);
      this.o.bus.emit('batch.extended', { batchId: batch.id, cursors: extra.map((e) => e.cursor), level: batch.level });
    }
  }

  private noteInterrupted(batch: Batch, cause: CancelCause, during: 'model' | 'tools'): void {
    this.o.transcript.appendMark('turn_cancelled', { batch: batch.id, reason: 'interrupt', by: cause.cursor, during });
    this.o.pushInternal({
      type: 'session.turn_cancelled',
      level: 4,
      trigger: 'piggyback',
      text: `Turn cancelled: batch ${batch.id} was interrupted by L${cause.level} event #${cause.cursor} during ${during === 'model' ? 'the model call' : 'tool calls'}. Tool results above show what had finished.`,
      correlation: String(cause.cursor),
    });
    this.o.log.info({ batch: batch.id, by: cause.cursor, during }, 'turn interrupted');
  }

  private notePreempted(batch: Batch, cause: CancelCause): void {
    this.o.transcript.appendMark('model_call_cancelled', { batch: batch.id, reason: 'preempt', by: cause.cursor });
    this.o.pushInternal({
      type: 'session.preempted',
      level: 4,
      trigger: 'store',
      text: `A model call in batch ${batch.id} was cancelled and re-issued to take in L${cause.level} event #${cause.cursor}.`,
      correlation: String(cause.cursor),
    });
    this.o.log.info({ batch: batch.id, by: cause.cursor }, 'model call preempted');
  }

  private async runBatch(cur: Running): Promise<void> {
    const o = this.o;
    const { batch } = cur;
    const signal = cur.abort.signal;
    o.batches.start({ id: batch.id, level: batch.level, reason: batch.reason, sessionId: SESSION_ID, startedAt: this.nowIso() });
    o.bus.emit('batch.started', { batchId: batch.id, level: batch.level, reason: batch.reason, cursors: batch.events.map((e) => e.cursor) });
    this.setPhase('delivering', { batchId: batch.id });

    if (batch.events.length > 0) {
      o.transcript.appendMessage({
        role: 'user',
        content: this.eventBlocks(batch, batch.events),
        batch: batch.id,
        cursors: batch.events.map((e) => e.cursor),
      });
      this.settleDelivered(batch, batch.events);
    }

    let rounds = 0;
    let endReason: BatchEndReason = 'end_turn';
    try {
      for (;;) {
        if (rounds >= o.rounds.hard) {
          endReason = 'round_limit';
          o.pushInternal({
            type: 'session.round_limit',
            level: 4,
            trigger: 'piggyback',
            text: `Batch ${batch.id} stopped after the hard limit of ${o.rounds.hard} model rounds.`,
          });
          break;
        }
        this.setPhase('model', { batchId: batch.id, round: rounds + 1 });
        const response = await this.callModel(cur);
        if (response === 'error') {
          endReason = 'model_error';
          break;
        }
        rounds++;
        o.batches.addRound(batch.id);
        if (response === 'cancelled') {
          // A cancelled call counts as a round; nothing of it reaches the transcript.
          const cause = cur.cancel as CancelCause;
          if (cause.kind === 'interrupt') {
            this.noteInterrupted(batch, cause, 'model');
            endReason = 'interrupted';
            break;
          }
          cur.cancel = null;
          this.notePreempted(batch, cause);
          this.appendWithBoundaryEvents(batch, []);
          continue;
        }
        // A preempt that lost the race with the response is moot; its event joins at the next boundary.
        if (cur.cancel?.kind === 'preempt') cur.cancel = null;
        o.transcript.appendMessage({
          role: 'assistant',
          content: response.content,
          batch: batch.id,
          usage: response.usage,
          stop: response.stopReason,
          model: response.model,
        });
        this.recordUsage(batch, response);

        if (response.stopReason === 'refusal') {
          endReason = 'refusal';
          o.pushInternal({
            type: 'model.refused',
            level: 4,
            trigger: 'piggyback',
            text: `The model declined to continue batch ${batch.id}${detailCategory(response.stopDetails)}.`,
          });
          // A refusal can cut a tool_use off mid-input; answer any so the history stays valid.
          this.answerUnrun(batch, response.content, 'not run: the response was declined');
          break;
        }

        const uses = response.content.filter(isToolUseBlock);
        if (uses.length === 0) {
          endReason = response.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
          break;
        }
        if (response.stopReason === 'max_tokens') {
          // Tool input may be truncated: never run it.
          this.answerUnrun(batch, response.content, 'not run: the tool input was cut off at max_tokens');
          continue;
        }

        this.setPhase('tools', { batchId: batch.id, round: rounds });
        const dispatched = await o.dispatcher.runAll(uses, {
          signal,
          interrupt: cur.turn.signal,
          sessionId: SESSION_ID,
          batchId: batch.id,
          batchLevel: batch.level,
        });
        if (cur.cancel?.kind === 'interrupt' && !signal.aborted) {
          // Every call has its (possibly partial) result; the interrupting events start the next batch.
          o.transcript.appendMessage({ role: 'user', content: dispatched.results, batch: batch.id });
          this.noteInterrupted(batch, cur.cancel, 'tools');
          endReason = 'interrupted';
          break;
        }

        if (rounds === o.rounds.soft) {
          o.pushInternal({
            type: 'session.round_limit',
            level: 2,
            trigger: 'flush',
            text: `This batch has used ${rounds} of ${o.rounds.hard} model rounds.`,
          });
        }
        // Turn boundary: due events join the tool results in the same user message.
        this.appendWithBoundaryEvents(batch, dispatched.results);
        if (dispatched.endsTurn) {
          endReason = 'ends_turn';
          break;
        }
        if (signal.aborted) {
          endReason = 'aborted';
          break;
        }
      }
    } catch (err) {
      if (!isAbortError(err)) throw err;
      endReason = 'aborted';
    } finally {
      o.transcript.appendMark('batch_ended', { batch: batch.id, reason: endReason, rounds, resumable: endReason === 'aborted' });
      o.batches.end(batch.id, endReason, this.nowIso());
      o.bus.emit('batch.ended', { batchId: batch.id, endReason, rounds });
      o.log.info({ batch: batch.id, endReason, rounds, batchLevel: batch.level }, 'batch ended');
    }
  }

  private answerUnrun(batch: Batch, content: ContentBlock[], text: string): void {
    const results: ToolResultBlock[] = content
      .filter(isToolUseBlock)
      .map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: text, is_error: true }));
    if (results.length > 0) this.o.transcript.appendMessage({ role: 'user', content: results, batch: batch.id });
  }

  /**
   * One model call with backoff on retryable errors. Returns 'error' when the batch should
   * end, 'cancelled' when a preempt or interrupt cut the call (or its backoff) short.
   */
  private async callModel(cur: Running): Promise<ProviderResponse | 'error' | 'cancelled'> {
    const o = this.o;
    const { batch } = cur;
    const hard = cur.abort.signal;
    for (let attempt = 0; ; attempt++) {
      const req = o.assembler.build(o.transcript.messages, { role: 'main', effort: o.effortFor(batch.level) });
      const call = new AbortController();
      cur.call = call;
      cur.externalOutput = false;
      const signal = AbortSignal.any([hard, cur.turn.signal, call.signal]);
      const tap = o.outputTap;
      try {
        return await o.provider.generate(req, {
          signal,
          ...(tap
            ? {
                onText: (delta: string) => {
                  if (delta.length === 0) return;
                  cur.externalOutput = true;
                  tap(delta, { batchId: batch.id });
                },
              }
            : {}),
        });
      } catch (err) {
        if (hard.aborted) throw err;
        if (cur.cancel && signal.aborted) return 'cancelled';
        if (isAbortError(err)) throw err;
        const kind = err instanceof ProviderError ? err.kind : 'fatal';
        const delay = o.backoffMs[attempt];
        if (kind === 'retryable' && delay !== undefined) {
          o.log.warn({ batch: batch.id, attempt: attempt + 1, delayMs: delay, err: errorMessage(err) }, 'model call failed; backing off');
          this.setPhase('backoff', { batchId: batch.id });
          try {
            await sleep(delay, signal);
          } catch (sleepErr) {
            if (hard.aborted) throw sleepErr;
            if (cur.cancel) return 'cancelled';
            throw sleepErr;
          }
          this.setPhase('model', { batchId: batch.id });
          continue;
        }
        o.log.error({ batch: batch.id, kind, err: errorMessage(err) }, 'model call failed; ending batch');
        o.pushInternal({
          type: 'model.error',
          level: 4,
          trigger: 'store',
          text: `Model call failed for batch ${batch.id} (${kind}): ${errorMessage(err)}`,
        });
        return 'error';
      } finally {
        cur.call = null;
      }
    }
  }

  private recordUsage(batch: Batch, r: ProviderResponse): void {
    const now = this.o.clock.now();
    const rec = {
      at: new Date(now).toISOString(),
      atMs: now,
      provider: this.o.provider.id,
      model: r.model,
      role: 'main' as const,
      sessionId: SESSION_ID,
      batchId: batch.id,
      level: batch.level,
      ...r.usage,
      stopReason: r.stopReason,
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r.model !== r.requestedModel ? { fallbackModel: r.model } : {}),
    };
    this.o.usage.record(rec);
    this.o.bus.emit('usage.recorded', rec);
  }
}

function detailCategory(details: unknown): string {
  if (details && typeof details === 'object' && 'category' in details) {
    const c = (details as { category: unknown }).category;
    if (typeof c === 'string') return ` (category: ${c})`;
  }
  return '';
}

export function newBatchId(): string {
  return newId('b');
}
