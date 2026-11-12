import { fileURLToPath } from 'node:url';
import { isoInZone, type InprocPlugin, type PluginContext, type PushResult } from '@protea/core';
import { CHAT_MESSAGE_EVENT, type ApprovalRequestParams, type ApprovalResolvedParams, type ChatAnswer, type ChatPlatformDecl, type ChatSendResult } from '@protea/protocol';

export interface WebchatMessageOptions {
  senderKey: string;
  trigger?: 'flush' | 'interrupt';
  /** Images stored with POST /api/blobs. */
  blobs?: Array<{ handle: string; mime: string }>;
  /** The message answers the choices of a reply. */
  answer?: ChatAnswer;
}

/** The chat window shows everything a reply can carry; it reads drafts from the live stream itself. */
const PLATFORM: ChatPlatformDecl = { displayName: 'Web chat', markdown: 'full', maxChars: 20_000, images: true, choices: true, widgets: true, drafts: {} };

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
  /** What each open request is about, for the line that records its outcome. */
  private readonly asked = new Map<string, string>();

  readonly chat = {
    ...PLATFORM,
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
      ...(opts.answer ? { meta: { answer: opts.answer } } : {}),
    });
  }

  envPromptVars(): Record<string, unknown> {
    return {};
  }

  /**
   * The chat window shows open requests as cards with buttons (it reads them from the API);
   * what goes into the conversation here is the record: what was asked, and how it ended.
   * `protea chat` prints the same lines; `protea approvals` decides from a terminal.
   */
  onApprovalRequest(req: ApprovalRequestParams): { delivered: boolean } {
    const ctx = this.ctx;
    if (!ctx) return { delivered: false };
    const zh = ctx.language.toLowerCase().startsWith('zh');
    const what = req.view ? `${req.view.title}${req.view.target ? `${zh ? '：' : ': '}${req.view.target}` : ''}` : req.summary;
    this.asked.set(req.id, req.view?.title ?? req.tool);
    if (this.asked.size > 200) this.asked.delete(this.asked.keys().next().value as string);
    ctx.emitOutput({ channel: 'approvals', text: `${zh ? '请你确认：' : 'Asked for your OK: '}${what}${req.view?.reason ? (zh ? `（${req.view.reason}）` : ` (${req.view.reason})`) : ''}` });
    return { delivered: true };
  }

  onApprovalResolved(p: ApprovalResolvedParams): void {
    const ctx = this.ctx;
    const title = this.asked.get(p.id);
    this.asked.delete(p.id);
    if (!ctx || title === undefined) return;
    const zh = ctx.language.toLowerCase().startsWith('zh');
    const word = p.state === 'approved' ? (zh ? '已同意' : 'Approved') : p.state === 'denied' ? (zh ? '已拒绝' : 'Denied') : zh ? '没有等到答复，已过期' : 'Expired without an answer';
    ctx.emitOutput({ channel: 'approvals', text: `${word}${zh ? '：' : ': '}${title}` });
  }
}
