import {
  isToolUseBlock,
  type BatchEndReason,
  type BatchReason,
  type CancelKind,
  type ContentBlock,
  type Effort,
  type EventEnvelope,
  type EventInput,
  type HandoffKind,
  type Level,
  type RunPhase,
  type TextBlock,
  type ToolResultBlock,
} from '@protea/protocol';
import type { Bus } from '../bus.js';
import { mergeConsecutive, type ContextAssembler } from '../context/assembler.js';
import { prefixFingerprint } from '../context/prefix.js';
import type { BatchRepo, UsageRepo } from '../db/repos.js';
import { renderEventsBlock, renderStatusBlock, type StatusSnapshot } from '../events/render.js';
import type { Board } from '../memory/board.js';
import { MEMORY_ROOT } from '../memory/store.js';
import type { EventStore } from '../events/store.js';
import type { Logger } from '../observability/logger.js';
import { estimateRequestTokens } from '../providers/tokens.js';
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from '../providers/types.js';
import type { RunningTurn } from '../scheduler/preemption.js';
import type { ToolDispatcher } from '../tools/dispatcher.js';
import { isAbortError, sleep } from '../util/abort.js';
import { errorMessage } from '../util/errors.js';
import { escapeStructural } from '../util/escape.js';
import { newId } from '../util/ids.js';
import type { Clock } from '../util/time.js';
import { estimateMessagesTokens } from '../util/tokens.js';
import { selectTailStart, type ContextLimits, type Handoff, type HandoffResult } from './handoff.js';
import { DeltaStream, responseTrace, summarizeRequest } from './trace.js';
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
  /** Push an internal (Core) event; returns its cursor when it was stored. */
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => { cursor?: number } | void;
  /** Capacity handoff (M4); without it the conversation grows until the provider refuses it. */
  handoff?: Handoff;
  /** The whiteboard: shown again when someone other than this session changed it. */
  board?: Board;
  /** Context thresholds for the main model. */
  limits?: () => ContextLimits;
  /** A transcript was retired by a handoff. */
  onHandoff?: (r: HandoffResult & { from: string }) => void;
  /** Extra input to the thinking-prefix fingerprint (e.g. the redacted secret set). */
  prefixSalt?: () => string;
  /** After each batch (persona hook). */
  onBatchEnd?: (stats: { batchId: string; level: Level; endReason: BatchEndReason; rounds: number }) => void;
  /**
   * Optional streaming output tap (e.g. a typing indicator or live text to a channel).
   * Once it has received text, the model call counts as having external output and
   * can no longer be preempted (only interrupted). The console's run stream is not such an
   * output: it reads the `model.delta` bus records, which never affect preemption.
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
  handoffs: number;
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
  private transcript: Transcript;
  private handoffRequested: string | null = null;
  private idleWork: Promise<unknown> | null = null;
  /** Cancels the idle work in progress (shutdown, or an urgent event during an idle compaction). */
  private idleAbort: AbortController | null = null;
  private idleSinceMs: number;
  /** The context did not fit even after a handoff; cleared by the next successful model call. */
  private overflowed = false;
  /** The cached prefix changed since the last request went out (reported on the run stream). */
  private prefixChanged = false;

  constructor(private readonly o: MainSessionOptions) {
    this.transcript = o.transcript;
    this.idleSinceMs = o.clock.now();
  }

  /** The current main transcript (handoffs replace it). */
  get currentTranscript(): Transcript {
    return this.transcript;
  }

  attachFeed(feed: BatchFeed): void {
    this.feed = feed;
  }

  get phase(): RunPhase {
    return this._phase;
  }

  get busy(): boolean {
    return this.current !== null || this.idleWork !== null;
  }

  /** When the last batch ended (the start of the process before any batch). */
  get idleSince(): number {
    return this.idleSinceMs;
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
    return this.transcript.needsResume();
  }

  /** Level of the batch that was interrupted (for effort selection when resuming). */
  resumeLevel(): Level {
    const id = this.transcript.lastBatchId();
    return (id ? this.o.batches.get(id)?.level : undefined) ?? 2;
  }

  /** Start a batch. Throws if one is running: the scheduler must only deliver when idle. */
  deliver(batch: Batch): Promise<void> {
    if (this.current) throw new Error(`main session is busy with ${this.current.batch.id}; cannot deliver ${batch.id}`);
    if (this.idleWork) throw new Error(`main session is handing off; cannot deliver ${batch.id}`);
    const cur: Running = {
      batch,
      abort: new AbortController(),
      turn: new AbortController(),
      call: null,
      externalOutput: false,
      cancel: null,
      done: Promise.resolve(),
      handoffs: 0,
    };
    this.current = cur;
    cur.done = this.runBatch(cur)
      .catch((err: unknown) => {
        this.o.log.error({ err: errorMessage(err), batch: batch.id }, 'batch crashed');
      })
      .finally(() => {
        this.current = null;
        this.idleSinceMs = this.o.clock.now();
        this.setPhase('idle');
        this.feed?.onIdle();
      });
    return cur.done;
  }

  /** Wait for the running batch; abort it if it does not finish in time. Returns true if it finished on its own. */
  async drain(timeoutMs: number): Promise<boolean> {
    const cur = this.current;
    if (!cur) {
      if (this.idleWork) {
        this.idleAbort?.abort('shutdown');
        await this.idleWork.catch(() => undefined);
      }
      return true;
    }
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
  private eventBlocks(batch: Batch, events: EventEnvelope[], extra?: TextBlock): ContentBlock[] {
    if (events.length === 0) return [];
    return [renderEventsBlock(events, batch.id), ...(extra ? [extra] : []), renderStatusBlock(this.o.status())];
  }

  /** The whiteboard, when someone other than this session changed it since this conversation last saw it. */
  private boardUpdate(): { block: TextBlock; rev: number } | null {
    const board = this.o.board;
    if (!board) return null;
    const rev = board.externalRev;
    // Not "greater than": restoring a backup can move the revision back.
    if (rev === this.transcript.boardRev) return null;
    return { block: { type: 'text', text: board.render() }, rev };
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
    this.transcript.appendMessage({
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
    this.transcript.appendMark('turn_cancelled', { batch: batch.id, reason: 'interrupt', by: cause.cursor, during });
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
    this.transcript.appendMark('model_call_cancelled', { batch: batch.id, reason: 'preempt', by: cause.cursor });
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
      const board = this.boardUpdate();
      this.transcript.appendMessage({
        role: 'user',
        content: this.eventBlocks(batch, batch.events, board?.block),
        batch: batch.id,
        cursors: batch.events.map((e) => e.cursor),
        ...(board ? { boardRev: board.rev } : {}),
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
        if (!(await this.ensureCapacity(cur, rounds === 0 ? 'batch' : 'round'))) {
          endReason = 'context_overflow';
          break;
        }
        this.setPhase('model', { batchId: batch.id, round: rounds + 1 });
        const response = await this.callModel(cur, rounds + 1);
        if (response === 'overflow') {
          // The provider counted more than we estimated: hand off now, once.
          if (cur.handoffs === 0 && (await this.ensureCapacity(cur, 'overflow'))) continue;
          endReason = 'context_overflow';
          break;
        }
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
        this.overflowed = false;
        this.transcript.appendMessage({
          role: 'assistant',
          content: response.content,
          batch: batch.id,
          usage: response.usage,
          stop: response.stopReason,
          model: response.model,
        });
        o.bus.emit('model.response', responseTrace(response, { sessionId: SESSION_ID, batchId: batch.id, round: rounds, at: this.nowIso() }));
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
          this.transcript.appendMessage({ role: 'user', content: dispatched.results, batch: batch.id });
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
        if (dispatched.endsTurn) {
          // The model ended its turn (idle, sleep): due events stay pending and start the next
          // batch at once. Joining them here would put them in the transcript with no model call
          // left to answer them.
          this.transcript.appendMessage({ role: 'user', content: dispatched.results, batch: batch.id });
          endReason = 'ends_turn';
          break;
        }
        // Turn boundary: due events join the tool results in the same user message.
        this.appendWithBoundaryEvents(batch, dispatched.results);
        if (signal.aborted) {
          endReason = 'aborted';
          break;
        }
      }
    } catch (err) {
      if (!isAbortError(err)) throw err;
      endReason = 'aborted';
    } finally {
      this.transcript.appendMark('batch_ended', { batch: batch.id, reason: endReason, rounds, resumable: endReason === 'aborted' });
      o.batches.end(batch.id, endReason, this.nowIso());
      o.bus.emit('batch.ended', { batchId: batch.id, endReason, rounds });
      o.log.info({ batch: batch.id, endReason, rounds, batchLevel: batch.level }, 'batch ended');
      try {
        o.onBatchEnd?.({ batchId: batch.id, level: batch.level, endReason, rounds });
      } catch (err) {
        o.log.warn({ err: errorMessage(err) }, 'onBatchEnd failed');
      }
    }
  }

  /** The next request: messages from the transcript, with the thinking floor moved first if the prefix changed. */
  private buildRequest(level: Level): ProviderRequest {
    const o = this.o;
    const req = o.assembler.build(this.transcript.messages, { role: 'main', effort: o.effortFor(level) });
    if (this.transcript.notePrefix(prefixFingerprint(req, o.prefixSalt?.() ?? ''))) {
      this.prefixChanged = true;
      return { ...req, messages: mergeConsecutive(this.transcript.messages) };
    }
    return req;
  }

  /** What the next model request would carry. Reads only: the thinking floor and everything else stay as they are. */
  previewRequest(level: Level = 2): ProviderRequest {
    return this.o.assembler.build(this.transcript.messages, { role: 'main', effort: this.o.effortFor(level) });
  }

  /** Input tokens of the next request: the last response's usage plus a local estimate of what came after; exact near the threshold. */
  private async estimate(level: Level, threshold: number, signal: AbortSignal): Promise<number> {
    const o = this.o;
    const req = this.buildRequest(level);
    const base = this.transcript.sinceLastUsage();
    let est = base ? base.tokens + estimateMessagesTokens(base.after) : estimateRequestTokens(req);
    if (o.provider.countTokens && est >= threshold * 0.9) {
      try {
        const exact = await o.provider.countTokens(req, { signal });
        if (exact !== undefined) est = exact;
      } catch (err) {
        if (signal.aborted) throw err;
        o.log.debug({ err: errorMessage(err) }, 'token count failed; using the estimate');
      }
    }
    return est;
  }

  /**
   * Hand off when the next request is too large (docs/10-architecture/05-sessions-and-agent-loop.md §8):
   * over softTokens at the start of a batch, over hardTokens before any request, or after the provider
   * refused the input. Returns false when the conversation cannot be made to fit (loop protection).
   */
  private async ensureCapacity(cur: Running, at: 'batch' | 'round' | 'overflow'): Promise<boolean> {
    const o = this.o;
    if (!o.handoff || !o.limits) return true;
    const limits = o.limits();
    const signal = cur.abort.signal;
    const est = await this.estimate(cur.batch.level, at === 'batch' ? limits.soft : limits.hard, signal);
    const requested = this.handoffRequested;
    // Still too large since the last failed attempt: no new handoff (it would only churn transcripts).
    if (this.overflowed && est > limits.hard && requested === null) return false;
    const over = at === 'overflow' || est > limits.hard || (at === 'batch' && est > limits.soft);
    if (!over && requested === null) return true;
    if (!over && at !== 'batch' && requested !== null) {
      // A requested handoff waits for a clean point: the start of the next batch.
      return true;
    }
    this.handoffRequested = null;
    const reason =
      requested ??
      (at === 'overflow'
        ? 'the provider refused the input as too long'
        : est > limits.hard
          ? `about ${est} input tokens, over the limit of ${limits.hard}`
          : `about ${est} input tokens at the start of a batch, over ${limits.soft}`);
    this.setPhase('handoff', { batchId: cur.batch.id });
    // A requested handoff, or one after the provider refused the input (our estimate was too low),
    // carries over as little as possible: the running batch.
    const minimal = requested !== null || at === 'overflow';
    const kind: HandoffKind = requested !== null ? 'requested' : at === 'overflow' ? 'overflow' : 'capacity';
    const r = await this.handOff(reason, est, minimal ? { ...limits, keep: 0 } : limits, this.transcript.batchStart(cur.batch.id), cur.batch.id, signal, { kind, level: cur.batch.level });
    if (r) cur.handoffs++;
    const after = r ? await this.estimate(cur.batch.level, limits.hard, signal) : est;
    if (after > limits.hard || (at === 'overflow' && !r)) return this.overflow(after, limits);
    return true;
  }

  private overflow(est: number, limits: ContextLimits): false {
    if (!this.overflowed) {
      this.overflowed = true;
      this.o.log.error({ estimatedTokens: est, hardTokens: limits.hard }, 'context still too large after a handoff');
      this.o.pushInternal({
        type: 'context.overflow',
        level: 0,
        trigger: 'flush',
        text: `The conversation does not fit the model's context even after a handoff (about ${est} input tokens, limit ${limits.hard}). The system prompt, tools or the running batch take too much room: shorten the Skills catalog, the MCP tool set or ${MEMORY_ROOT}/INDEX.md. Batches end without a model call until this is fixed.`,
      });
    }
    return false;
  }

  private async handOff(
    reason: string,
    est: number,
    limits: ContextLimits,
    mustKeepFrom: number,
    batchId: string | null,
    signal: AbortSignal,
    how: { kind: HandoffKind; level: Level; strict?: boolean; seal?: boolean },
  ): Promise<HandoffResult | null> {
    const o = this.o;
    const h = o.handoff as Handoff;
    const r = await h.run(this.transcript, {
      mustKeepFrom,
      limits,
      estimatedTokens: est,
      reason,
      signal,
      kind: how.kind,
      level: how.level,
      ...(how.strict ? { strict: true } : {}),
      ...(how.seal ? { seal: true } : {}),
      notice: (info) => this.handoffNotice(info, reason, batchId, how.kind),
    });
    if (!r) return null;
    const old = this.transcript;
    this.transcript = r.transcript;
    old.close();
    o.bus.emit('session.handoff', { sessionId: SESSION_ID, from: old.file, to: r.transcript.file, notes: r.notesPath, dropped: r.dropped, kept: r.kept, kind: r.kind });
    o.onHandoff?.({ ...r, from: old.file });
    return r;
  }

  /**
   * The first message of the new conversation: a session.handoff event with the facts, then
   * the whiteboard and the notes. The notes are a model's summary and may quote outside
   * content, so they stay out of the internal event.
   */
  private handoffNotice(
    info: { notesPath: string; notes: string | null; dropped: number; kept: number },
    reason: string,
    batchId: string | null,
    kind: HandoffKind,
  ): { content: ContentBlock[]; cursors?: number[]; batch?: string; boardRev?: number } {
    const text = `The conversation was compacted (${reason}). ${info.dropped} earlier message(s) are summarised in ${MEMORY_ROOT}/${info.notesPath}; the ${info.kept} most recent message(s) follow unchanged.${info.notes === null ? ' Read the notes before relying on anything from before this point.' : ''}`;
    const pushed = this.o.pushInternal({ type: 'session.handoff', level: 4, trigger: 'store', text, correlation: info.notesPath, meta: { kind } });
    const cursor = pushed && typeof pushed.cursor === 'number' ? pushed.cursor : undefined;
    const env = cursor !== undefined ? this.o.store.get(cursor) : undefined;
    const block = env ? renderEventsBlock([env], batchId ?? 'handoff') : { type: 'text', text };
    const content: ContentBlock[] = [block];
    const board = this.o.board;
    if (board && board.open().length > 0) content.push({ type: 'text', text: board.render() });
    if (info.notes !== null) content.push({ type: 'text', text: `<handoff_notes path="${MEMORY_ROOT}/${info.notesPath}">\n${escapeStructural(info.notes)}\n</handoff_notes>` });
    return {
      content,
      ...(cursor !== undefined && env ? { cursors: [cursor] } : {}),
      ...(batchId ? { batch: batchId } : {}),
      ...(board ? { boardRev: board.externalRev } : {}),
    };
  }

  /** How much of the conversation an idle compaction would act on. Local estimate only: this must not touch the transcript. */
  compactionStats(keepTokens: number): { conversationTokens: number; droppableTokens: number } {
    const messages = this.transcript.messages;
    const start = selectTailStart(messages, messages.length, keepTokens);
    return {
      conversationTokens: estimateMessagesTokens(messages),
      droppableTokens: start === 0 ? 0 : estimateMessagesTokens(messages.slice(0, start)),
    };
  }

  /**
   * Compact while nothing is running. Nothing is written until the notes exist, so
   * `abortIdleWork` or a failed notes request leaves the conversation as it was. Returns the
   * result, or null when it did not happen.
   */
  async compactWhileIdle(reason: string, keepTokens: number): Promise<HandoffResult | null> {
    const o = this.o;
    if (!o.handoff || !o.limits || this.current || this.idleWork) return null;
    const limits = o.limits();
    const ac = new AbortController();
    const work = (async (): Promise<HandoffResult | null> => {
      this.setPhase('handoff');
      const est = estimateMessagesTokens(this.transcript.messages);
      return this.handOff(reason, est, { ...limits, keep: keepTokens }, this.transcript.length, null, ac.signal, { kind: 'idle', level: 4, strict: true, seal: true });
    })();
    this.idleWork = work;
    this.idleAbort = ac;
    try {
      return await work;
    } catch (err) {
      if (ac.signal.aborted || isAbortError(err)) return null;
      throw err;
    } finally {
      this.idleWork = null;
      this.idleAbort = null;
      this.setPhase('idle');
      this.feed?.onIdle();
    }
  }

  /** Give up the idle work in progress, if any. */
  abortIdleWork(): void {
    this.idleAbort?.abort('preempted');
  }

  /**
   * Hand off on request (control API): now when idle, otherwise at the start of the next batch.
   */
  async requestHandoff(reason = 'requested through the control API'): Promise<{ scheduled: true } | { result: HandoffResult | null }> {
    const o = this.o;
    if (!o.handoff || !o.limits) throw new Error('handoff is not configured');
    if (this.current || this.idleWork) {
      this.handoffRequested = reason;
      return { scheduled: true };
    }
    const limits = o.limits();
    const ac = new AbortController();
    const work = (async (): Promise<HandoffResult | null> => {
      this.setPhase('handoff');
      const est = await this.estimate(2, limits.hard, ac.signal);
      return this.handOff(reason, est, { ...limits, keep: 0 }, this.transcript.length, null, ac.signal, { kind: 'requested', level: 2, seal: true });
    })();
    this.idleWork = work;
    this.idleAbort = ac;
    try {
      return { result: await work };
    } finally {
      this.idleWork = null;
      this.idleAbort = null;
      this.setPhase('idle');
      this.feed?.onIdle();
    }
  }

  private answerUnrun(batch: Batch, content: ContentBlock[], text: string): void {
    const results: ToolResultBlock[] = content
      .filter(isToolUseBlock)
      .map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: text, is_error: true }));
    if (results.length > 0) this.transcript.appendMessage({ role: 'user', content: results, batch: batch.id });
  }

  /**
   * One model call with backoff on retryable errors. Returns 'error' when the batch should
   * end, 'cancelled' when a preempt or interrupt cut the call (or its backoff) short.
   */
  private async callModel(cur: Running, round: number): Promise<ProviderResponse | 'error' | 'cancelled' | 'overflow'> {
    const o = this.o;
    const { batch } = cur;
    const hard = cur.abort.signal;
    for (let attempt = 0; ; attempt++) {
      const req = this.buildRequest(batch.level);
      const call = new AbortController();
      cur.call = call;
      cur.externalOutput = false;
      const signal = AbortSignal.any([hard, cur.turn.signal, call.signal]);
      const tap = o.outputTap;
      o.bus.emit('model.request', {
        batchId: batch.id,
        sessionId: SESSION_ID,
        attempt,
        round,
        role: 'main',
        model: o.provider.modelFor('main'),
        context: summarizeRequest(req, this.prefixChanged),
      });
      this.prefixChanged = false;
      const deltas = new DeltaStream((kind, text) => o.bus.emit('model.delta', { sessionId: SESSION_ID, batchId: batch.id, round, kind, text }));
      try {
        return await o.provider.generate(req, {
          signal,
          onText: (delta: string) => {
            deltas.push('text', delta);
            if (!tap || delta.length === 0) return;
            cur.externalOutput = true;
            tap(delta, { batchId: batch.id });
          },
          onThinking: (delta: string) => deltas.push('thinking', delta),
        });
      } catch (err) {
        if (hard.aborted) throw err;
        if (cur.cancel && signal.aborted) return 'cancelled';
        if (isAbortError(err)) throw err;
        const kind = err instanceof ProviderError ? err.kind : 'fatal';
        if (kind === 'overflow' && o.handoff) {
          o.log.warn({ batch: batch.id, err: errorMessage(err) }, 'the provider refused the input as too long');
          return 'overflow';
        }
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
          meta: { batchId: batch.id, kind },
        });
        return 'error';
      } finally {
        deltas.flush();
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
