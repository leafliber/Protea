import {
  isToolUseBlock,
  type BatchEndReason,
  type BatchReason,
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
}

const SESSION_ID = 'main';

/**
 * The single resident session that receives events (invariant I-1). Runs one
 * batch at a time: append events → model → tools → (boundary events) → model …
 * See docs/10-architecture/05-sessions-and-agent-loop.md.
 */
export class MainSession {
  private _phase: RunPhase = 'idle';
  private current: { batch: Batch; abort: AbortController; done: Promise<void> } | null = null;
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
    const abort = new AbortController();
    const done = this.runBatch(batch, abort.signal)
      .catch((err: unknown) => {
        this.o.log.error({ err: errorMessage(err), batch: batch.id }, 'batch crashed');
      })
      .finally(() => {
        this.current = null;
        this.setPhase('idle');
        this.feed?.onIdle();
      });
    this.current = { batch, abort, done };
    return done;
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

  private async runBatch(batch: Batch, signal: AbortSignal): Promise<void> {
    const o = this.o;
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
        const response = await this.callModel(batch, signal);
        if (!response) {
          endReason = 'model_error';
          break;
        }
        rounds++;
        o.batches.addRound(batch.id);
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
          sessionId: SESSION_ID,
          batchId: batch.id,
          batchLevel: batch.level,
        });

        if (rounds === o.rounds.soft) {
          o.pushInternal({
            type: 'session.round_limit',
            level: 2,
            trigger: 'flush',
            text: `This batch has used ${rounds} of ${o.rounds.hard} model rounds.`,
          });
        }
        // Turn boundary: due events join the tool results in the same user message.
        const extra = this.feed?.takeBoundaryEvents() ?? [];
        if (extra.length > 0) this.raiseLevel(batch, extra);
        o.transcript.appendMessage({
          role: 'user',
          content: [...dispatched.results, ...this.eventBlocks(batch, extra)],
          batch: batch.id,
          ...(extra.length > 0 ? { cursors: extra.map((e) => e.cursor) } : {}),
        });
        if (extra.length > 0) {
          this.settleDelivered(batch, extra);
          o.bus.emit('batch.extended', { batchId: batch.id, cursors: extra.map((e) => e.cursor) });
        }
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

  /** One model call with backoff on retryable errors. Returns null when the batch should end. */
  private async callModel(batch: Batch, signal: AbortSignal): Promise<ProviderResponse | null> {
    const o = this.o;
    for (let attempt = 0; ; attempt++) {
      const req = o.assembler.build(o.transcript.messages, { role: 'main', effort: o.effortFor(batch.level) });
      try {
        return await o.provider.generate(req, { signal });
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        const kind = err instanceof ProviderError ? err.kind : 'fatal';
        const delay = o.backoffMs[attempt];
        if (kind === 'retryable' && delay !== undefined) {
          o.log.warn({ batch: batch.id, attempt: attempt + 1, delayMs: delay, err: errorMessage(err) }, 'model call failed; backing off');
          this.setPhase('backoff', { batchId: batch.id });
          await sleep(delay, signal);
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
        return null;
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
