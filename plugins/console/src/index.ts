import { fileURLToPath } from 'node:url';
import { isoInZone, type InprocPlugin, type PluginContext, type PushResult } from '@protea/core';
import type { Level, Trigger } from '@protea/protocol';

export interface ConsoleMessageOptions {
  senderKey: string;
  level?: Level;
  trigger?: Trigger;
  tags?: string[];
}

/**
 * Operator injection (POST /api/events, the run stream's input box, `protea events push`): an
 * event at any allowed level and trigger, for testing and operations. It is not a conversation:
 * nothing here reaches the chat, and the model's answer is its text, shown on the run stream.
 */
export class ConsolePlugin implements InprocPlugin {
  readonly id = 'console';
  readonly kind = 'source' as const;
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

  envPromptVars(): Record<string, unknown> {
    return {};
  }
}
