import { blobImageBlock, blobImagesIn, type ContentBlock, type ToolCallTrace, type ToolResultBlock, type ToolUseBlock } from '@protea/protocol';
import type { Logger } from '../observability/logger.js';
import type { GuardDecision, ToolGuard } from '../permissions/guard.js';
import { errorMessage } from '../util/errors.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolOutcome } from './types.js';

export const MAX_RESULT_CHARS = 100_000;
export const INTERRUPT_GRACE_MS = 5_000;
/** What the run stream shows of an input or a result; the transcript keeps the whole. */
const TRACE_CHARS = 8_000;

/** Called after every executed call (not for calls that were blocked or never started). */
export type ToolCallObserver = (name: string, ms: number, failed: boolean) => void;

export interface DispatchResult {
  results: ToolResultBlock[];
  endsTurn: boolean;
}

export interface DispatchContext extends Omit<ToolContext, 'callId'> {
  /**
   * Soft cancel (an `interrupt` event). Calls that have not started are skipped,
   * interruptible tools are signalled and return a partial receipt, and the others
   * run to completion. `signal` stays the hard cancel (shutdown).
   */
  interrupt?: AbortSignal;
  /** Restrict the callable tools (forks); others answer "not available". */
  allowed?: ReadonlySet<string>;
}

interface OneResult {
  block: ToolResultBlock;
  endsTurn: boolean;
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters]`;
}

/**
 * Runs the tool calls of one assistant message. Calls run in parallel except
 * across a `barrierAfter` tool; every call yields exactly one tool_result, in
 * the order of the calls, so they can go back in a single user message.
 */
/** A reason not to run this call now (outbound rate limit), or null. Checked before the permission guard. */
export type ToolLimiter = (def: NonNullable<ReturnType<ToolRegistry['get']>>, use: ToolUseBlock) => string | null;

export class ToolDispatcher {
  private guard: ToolGuard | null = null;
  private observer: ToolCallObserver | null = null;
  private limiter: ToolLimiter | null = null;
  private trace: ((t: ToolCallTrace) => void) | null = null;
  private maxImages: () => number = () => 4;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly log: Logger,
    private readonly defaultTimeoutMs = 60_000,
  ) {}

  /** Permission policy, approvals and audit (docs/10-architecture/14-security-and-permissions.md). */
  setGuard(guard: ToolGuard | null): void {
    this.guard = guard;
  }

  observe(observer: ToolCallObserver | null): void {
    this.observer = observer;
  }

  /** Report every call as it starts and ends, refused ones included (the console's run stream). */
  setTrace(trace: ((t: ToolCallTrace) => void) | null): void {
    this.trace = trace;
  }

  /** Outbound rate limits (docs/10-architecture/14-security-and-permissions.md §7). */
  setLimiter(limiter: ToolLimiter | null): void {
    this.limiter = limiter;
  }

  /** How many images one tool result may carry (vision.maxImagesPerMessage). */
  setImageLimit(limit: () => number): void {
    this.maxImages = limit;
  }

  /** The text and the images a call returned, as tool-result content. */
  private resultContent(outcome: ToolOutcome): string | ContentBlock[] {
    const text = truncate(outcome.text);
    // The Messages API accepts only text in a tool result marked as an error.
    const all = outcome.failed ? [] : (outcome.images ?? []);
    if (all.length === 0) return text;
    const max = this.maxImages();
    const dropped = all.length - max;
    const note = dropped > 0 ? `[${dropped} more image(s) not shown]` : '';
    const body = [text, note].filter(Boolean).join('\n');
    return [...(body ? [{ type: 'text', text: body }] : []), ...all.slice(0, max).map((i) => blobImageBlock(i.handle, i.mime))];
  }

  async runAll(uses: readonly ToolUseBlock[], ctx: DispatchContext): Promise<DispatchResult> {
    const results: OneResult[] = new Array(uses.length);
    const inflight: Promise<void>[] = [];
    for (const [i, use] of uses.entries()) {
      inflight.push(
        this.traced(use, ctx).then((r) => {
          results[i] = r;
        }),
      );
      if (this.registry.get(use.name)?.flags?.barrierAfter) await Promise.all(inflight);
    }
    await Promise.all(inflight);
    return { results: results.map((r) => r.block), endsTurn: results.some((r) => r.endsTurn) };
  }

  private emitTrace(t: ToolCallTrace): void {
    try {
      this.trace?.(t);
    } catch (err) {
      this.log.warn({ tool: t.name, err: errorMessage(err) }, 'tool trace failed');
    }
  }

  private async traced(use: ToolUseBlock, ctx: DispatchContext): Promise<OneResult> {
    if (!this.trace) return this.runOne(use, ctx);
    const head = { sessionId: ctx.sessionId, batchId: ctx.batchId, callId: use.id, name: use.name };
    const started = Date.now();
    const input = JSON.stringify(use.input ?? null);
    this.emitTrace({ ...head, at: new Date(started).toISOString(), phase: 'start', input: input.length > TRACE_CHARS ? { _truncated: input.slice(0, TRACE_CHARS) } : use.input });
    const r = await this.runOne(use, ctx);
    const text = typeof r.block.content === 'string' ? r.block.content : r.block.content.map((b) => (b.type === 'text' ? String(b['text'] ?? '') : `[${b.type}]`)).join('\n');
    const images = typeof r.block.content === 'string' ? [] : blobImagesIn(r.block.content);
    this.emitTrace({
      ...head,
      at: new Date().toISOString(),
      phase: 'end',
      ms: Date.now() - started,
      isError: r.block.is_error === true,
      result: text.slice(0, TRACE_CHARS),
      truncated: text.length > TRACE_CHARS,
      ...(images.length > 0 ? { images } : {}),
    });
    return r;
  }

  private async runOne(use: ToolUseBlock, dctx: DispatchContext): Promise<OneResult> {
    const fail = (text: string): OneResult => {
      this.log.info({ tool: use.name, callId: use.id, reason: text.slice(0, 200) }, 'tool not run');
      return { block: { type: 'tool_result', tool_use_id: use.id, content: text, is_error: true }, endsTurn: false };
    };
    const { interrupt, allowed, ...ctx } = dctx;
    const def = this.registry.get(use.name);
    if (!def || (allowed && !allowed.has(use.name))) {
      const why = !def ? this.registry.unavailableReason(use.name) : undefined;
      return fail(`tool ${use.name} is not available${why ? ` (${why})` : ''}`);
    }
    const valid = this.registry.validate(use.name, use.input);
    if (!valid.ok) return fail(`invalid input for ${use.name}: ${valid.errors.join('; ')}`);
    if (ctx.signal.aborted) return fail('not run: the turn was cancelled');
    if (interrupt?.aborted) return fail('not run: the turn was interrupted');
    const limited = this.limiter?.(def, use);
    if (limited) return fail(`not run: ${limited}`);

    let decision: GuardDecision | null = null;
    if (this.guard) {
      const gctx = { sessionId: ctx.sessionId, batchId: ctx.batchId, level: ctx.batchLevel, signal: interrupt ? AbortSignal.any([ctx.signal, interrupt]) : ctx.signal };
      try {
        decision = await this.guard.check(def, use, gctx);
      } catch (err) {
        this.log.error({ tool: use.name, err: errorMessage(err) }, 'permission check failed');
        return fail(`not run: the permission check failed (${errorMessage(err)})`);
      }
      if (decision.action === 'block') {
        this.log.info({ tool: use.name, callId: use.id, reason: decision.text.slice(0, 200) }, 'tool held by the permission policy');
        const block: ToolResultBlock = { type: 'tool_result', tool_use_id: use.id, content: decision.text };
        if (decision.isError) block.is_error = true;
        return { block, endsTurn: false };
      }
      // An automatic review can take seconds.
      if (ctx.signal.aborted) return fail('not run: the turn was cancelled');
      if (interrupt?.aborted) return fail('not run: the turn was interrupted');
      const r = await this.execute(def, use, ctx, interrupt);
      try {
        this.guard.after(def, use, gctx, decision, r.block);
      } catch (err) {
        this.log.error({ tool: use.name, err: errorMessage(err) }, 'audit record failed');
      }
      return r;
    }
    return this.execute(def, use, ctx, interrupt);
  }

  private async execute(
    def: NonNullable<ReturnType<ToolRegistry['get']>>,
    use: ToolUseBlock,
    ctx: Omit<ToolContext, 'callId'>,
    interrupt: AbortSignal | undefined,
  ): Promise<OneResult> {
    const fail = (text: string): OneResult => ({
      block: { type: 'tool_result', tool_use_id: use.id, content: text, is_error: true },
      endsTurn: false,
    });

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    // Only tools that declare `interruptible` see an interrupt; the rest finish their work.
    const softAbort = def.flags?.interruptible ? interrupt : undefined;
    const onInterrupt = (): void => controller.abort(softAbort?.reason);
    softAbort?.addEventListener('abort', onInterrupt, { once: true });
    const timeoutMs = def.timeoutMs ?? this.defaultTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, timeoutMs);
    const started = Date.now();
    try {
      const raced = await Promise.race([
        Promise.resolve(def.handler(use.input, { ...ctx, callId: use.id, signal: controller.signal })),
        new Promise<never>((_, reject) => {
          // Interruptible tools get a short grace period to return a partial receipt.
          const grace = def.flags?.interruptible ? INTERRUPT_GRACE_MS : 0;
          controller.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), grace), {
            once: true,
          });
        }),
      ]);
      const outcome: ToolOutcome = typeof raced === 'string' ? { text: raced } : raced;
      this.log.info({ tool: use.name, callId: use.id, ms: Date.now() - started, failed: !!outcome.failed, resultChars: outcome.text.length }, 'tool done');
      this.notify(use.name, Date.now() - started, !!outcome.failed);
      const block: ToolResultBlock = { type: 'tool_result', tool_use_id: use.id, content: this.resultContent(outcome) };
      if (outcome.failed) block.is_error = true;
      return { block, endsTurn: !outcome.failed && (!!def.flags?.endsTurn || !!outcome.endsTurn) };
    } catch (err) {
      this.notify(use.name, Date.now() - started, true);
      if (timedOut) return fail(`${use.name} timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (ctx.signal.aborted) return fail(`${use.name} was cancelled`);
      if (softAbort?.aborted) return fail(`${use.name} was interrupted before it returned a partial result`);
      this.log.warn({ tool: use.name, callId: use.id, err: errorMessage(err) }, 'tool failed');
      return fail(`${use.name} failed: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParentAbort);
      softAbort?.removeEventListener('abort', onInterrupt);
    }
  }

  private notify(name: string, ms: number, failed: boolean): void {
    try {
      this.observer?.(name, ms, failed);
    } catch (err) {
      this.log.warn({ tool: name, err: errorMessage(err) }, 'tool call observer failed');
    }
  }
}
