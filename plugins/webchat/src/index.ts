import { fileURLToPath } from 'node:url';
import { isoInZone, type InprocPlugin, type PluginContext, type PushResult } from '@protea/core';
import { CHAT_MESSAGE_EVENT, type ApprovalRequestParams, type ChatPlatformDecl, type ChatSendResult } from '@protea/protocol';

export interface WebchatMessageOptions {
  senderKey: string;
  trigger?: 'flush' | 'interrupt';
  /** Images stored with POST /api/blobs. */
  blobs?: Array<{ handle: string; mime: string }>;
}

const PLATFORM: ChatPlatformDecl = { displayName: 'Web chat', markdown: 'basic', maxChars: 20_000 };

/**
 * The built-in chat platform: the browser's chat window and `protea chat`. Input comes from
 * POST /api/chat/messages. Sending has nothing to do here beyond succeeding: the chat hub stores
 * what is sent and publishes it, and that is what the window shows, online or later.
 */
export class WebchatPlugin implements InprocPlugin {
  readonly id = 'webchat';
  readonly kind = 'connector' as const;
  readonly levelCap = 1 as const;
  readonly envPromptFile = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
  private ctx: PluginContext | null = null;

  readonly chat = {
    ...PLATFORM,
    drafts: true,
    send: (): ChatSendResult => (this.ctx ? { ok: true } : { ok: false, error: 'the web chat is not running' }),
  };

  start(ctx: PluginContext): void {
    this.ctx = ctx;
  }

  stop(): void {
    this.ctx = null;
  }

  receive(text: string, opts: WebchatMessageOptions): PushResult {
    const ctx = this.ctx;
    if (!ctx) return { ok: false, warnings: [], errors: ['the web chat is not running'] };
    return ctx.pushEvent({
      type: CHAT_MESSAGE_EVENT,
      ts: isoInZone(ctx.clock.now(), ctx.timezone),
      level: 1,
      trigger: opts.trigger ?? 'flush',
      text,
      senderKey: opts.senderKey,
      ...(opts.blobs?.length ? { blobs: opts.blobs } : {}),
    });
  }

  envPromptVars(): Record<string, unknown> {
    return {};
  }

  /** Approval requests appear in the chat window, which offers approve and deny; the CLI has `protea approvals`. */
  onApprovalRequest(req: ApprovalRequestParams): { delivered: boolean } {
    const ctx = this.ctx;
    if (!ctx) return { delivered: false };
    ctx.emitOutput({
      channel: 'approvals',
      text: `Approval ${req.id} requested: ${req.summary}${req.reason ? ` (${req.reason})` : ''}. Decide with: protea approvals approve ${req.id} | protea approvals deny ${req.id} (expires ${req.expiresAt}).`,
    });
    return { delivered: true };
  }
}
