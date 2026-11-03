import type { ToolResultBlock, ToolUseBlock } from '@protea/protocol';
import type { Logger } from '../observability/logger.js';
import type { GuardDecision, ToolGuard } from '../permissions/guard.js';
import { errorMessage } from '../util/errors.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolOutcome } from './types.js';

export const MAX_RESULT_CHARS = 100_000;
export const INTERRUPT_GRACE_MS = 5_000;

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
export class ToolDispatcher {
  private guard: ToolGuard | null = null;
  private observer: ToolCallObserver | null = null;

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

  async runAll(uses: readonly ToolUseBlock[], ctx: DispatchContext): Promise<DispatchResult> {
    const results: OneResult[] = new Array(uses.length);
    const inflight: Promise<void>[] = [];
    for (const [i, use] of uses.entries()) {
      inflight.push(
        this.runOne(use, ctx).then((r) => {
          results[i] = r;
        }),
      );
      if (this.registry.get(use.name)?.flags?.barrierAfter) await Promise.all(inflight);
    }
    await Promise.all(inflight);
    return { results: results.map((r) => r.block), endsTurn: results.some((r) => r.endsTurn) };
  }

  private async runOne(use: ToolUseBlock, dctx: DispatchContext): Promise<OneResult> {
    const fail = (text: string): OneResult => ({
      block: { type: 'tool_result', tool_use_id: use.id, content: text, is_error: true },
      endsTurn: false,
    });
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

    let decision: GuardDecision | null = null;
    if (this.guard) {
      const gctx = { sessionId: ctx.sessionId, batchId: ctx.batchId };
      try {
        decision = await this.guard.check(def, use, gctx);
      } catch (err) {
        this.log.error({ tool: use.name, err: errorMessage(err) }, 'permission check failed');
        return fail(`not run: the permission check failed (${errorMessage(err)})`);
      }
      if (decision.action === 'block') {
        const block: ToolResultBlock = { type: 'tool_result', tool_use_id: use.id, content: decision.text };
        if (decision.isError) block.is_error = true;
        return { block, endsTurn: false };
      }
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
      this.log.debug({ tool: use.name, callId: use.id, ms: Date.now() - started, failed: !!outcome.failed }, 'tool done');
      this.notify(use.name, Date.now() - started, !!outcome.failed);
      const block: ToolResultBlock = { type: 'tool_result', tool_use_id: use.id, content: truncate(outcome.text) };
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
