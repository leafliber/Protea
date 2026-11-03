import { fileURLToPath } from 'node:url';
import { isoInZone, type InprocPlugin, type PluginContext, type PushResult, type ToolSpec } from '@protea/core';
import type { Level, Trigger } from '@protea/protocol';

export interface ConsoleMessageOptions {
  senderKey: string;
  level?: Level;
  trigger?: Trigger;
  tags?: string[];
}

/**
 * The operator's channel: input comes from the control API (POST /api/events),
 * output goes to stream subscribers (CLI, web console) via `con_send`.
 */
export class ConsolePlugin implements InprocPlugin {
  readonly id = 'console';
  readonly kind = 'connector' as const;
  readonly levelCap = 1 as const;
  readonly envPromptFile = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
  private ctx: PluginContext | null = null;

  start(ctx: PluginContext): void {
    this.ctx = ctx;
  }

  stop(): void {
    this.ctx = null;
  }

  receive(text: string, opts: ConsoleMessageOptions): PushResult {
    const ctx = this.ctx;
    if (!ctx) return { ok: false, warnings: [], errors: ['console plugin is not running'] };
    return ctx.pushEvent({
      type: 'console.message',
      ts: isoInZone(ctx.clock.now(), ctx.timezone),
      level: opts.level ?? 1,
      trigger: opts.trigger ?? 'flush',
      text,
      senderKey: opts.senderKey,
      ...(opts.tags ? { tags: opts.tags } : {}),
    });
  }

  tools(): ToolSpec<never>[] {
    const send: ToolSpec<{ text: string }> = {
      name: 'con_send',
      description: 'Send a message to the console, where the owner reads it.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 20_000 } },
      },
      flags: { sideEffect: true, barrierAfter: true },
      handler: (input) => {
        const ctx = this.ctx;
        if (!ctx) return { text: 'console is not running', failed: true };
        ctx.emitOutput({ channel: 'console', text: input.text });
        return `sent to the console (${input.text.length} characters)`;
      },
    };
    return [send as unknown as ToolSpec<never>];
  }

  envPromptVars(): Record<string, unknown> {
    return {};
  }
}
