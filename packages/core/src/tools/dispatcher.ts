import type { ToolResultBlock, ToolUseBlock } from '@protea/protocol';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolOutcome } from './types.js';

export const MAX_RESULT_CHARS = 100_000;
export const INTERRUPT_GRACE_MS = 5_000;

export interface DispatchResult {
  results: ToolResultBlock[];
  endsTurn: boolean;
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
  constructor(
    private readonly registry: ToolRegistry,
    private readonly log: Logger,
    private readonly defaultTimeoutMs = 60_000,
  ) {}

  async runAll(uses: readonly ToolUseBlock[], ctx: Omit<ToolContext, 'callId'>): Promise<DispatchResult> {
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

  private async runOne(use: ToolUseBlock, ctx: Omit<ToolContext, 'callId'>): Promise<OneResult> {
    const fail = (text: string): OneResult => ({
      block: { type: 'tool_result', tool_use_id: use.id, content: text, is_error: true },
      endsTurn: false,
    });
    const def = this.registry.get(use.name);
    if (!def) return fail(`tool ${use.name} is not available`);
    const valid = this.registry.validate(use.name, use.input);
    if (!valid.ok) return fail(`invalid input for ${use.name}: ${valid.errors.join('; ')}`);
    if (ctx.signal.aborted) return fail('not run: the turn was cancelled');

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
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
      const block: ToolResultBlock = { type: 'tool_result', tool_use_id: use.id, content: truncate(outcome.text) };
      if (outcome.failed) block.is_error = true;
      return { block, endsTurn: !outcome.failed && (!!def.flags?.endsTurn || !!outcome.endsTurn) };
    } catch (err) {
      if (timedOut) return fail(`${use.name} timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (ctx.signal.aborted) return fail(`${use.name} was cancelled`);
      this.log.warn({ tool: use.name, callId: use.id, err: errorMessage(err) }, 'tool failed');
      return fail(`${use.name} failed: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParentAbort);
    }
  }
}
