import {
  CHAT_DRAFT_INTERVAL_MS,
  CHAT_DRAFT_MIN_INTERVAL_MS,
  CHAT_MESSAGE_EVENT,
  type BlobImageRef,
  type ChatChoices,
  type ChatDraftParams,
  type ChatDraftUpdate,
  type ChatMarkdown,
  type ChatPending,
  type ChatPlatformDecl,
  type ChatPlatformInfo,
  type ChatReplyParts,
  type ChatSendParams,
  type ChatSendResult,
  type ChatWidgetRef,
} from '@protea/protocol';
import { isBlobHandle, sniffImageMime, type BlobStore } from '../blobs/store.js';
import { readWorkspaceFile } from '../blobs/tools.js';
import type { Bus } from '../bus.js';
import type { OutputLog } from '../events/outputs.js';
import type { Logger } from '../observability/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolOutcome, ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import { checkWidget, type WidgetStore } from './widgets.js';

export const CHAT_SEND = 'chat_send';
/** Owner of `chat_send` in the tool registry. */
export const CHAT_TOOL_OWNER = 'chat';
/** Channel of a chat reply in the outputs table. */
export const CHAT_CHANNEL = 'chat';

/** A running platform, as a plugin hands it to the hub. */
export interface ChatPlatform extends ChatPlatformDecl {
  id: string;
  send(req: ChatSendParams): Promise<ChatSendResult> | ChatSendResult;
  /**
   * Takes the reply as it is written (a platform that declares `drafts`). Absent on a platform
   * whose client reads the `chat.draft` bus records itself (the web chat).
   */
  draft?(d: ChatDraftParams): void;
}

/** Limits that follow the configuration. */
export interface ChatLimits {
  maxImages: number;
  maxImageBytes: number;
  widgets: boolean;
  widgetMaxBytes: number;
}

export interface ChatHubOptions {
  tools: ToolRegistry;
  bus: Bus;
  outputs?: OutputLog;
  log: Logger;
  clock: Clock;
  /** Needed for `images`. */
  blobs?: BlobStore;
  /** The workspace `images` paths are read from. */
  workspace?: string;
  /** Needed for `widget`. */
  widgets?: WidgetStore;
  limits?: () => ChatLimits;
  /** Where a browser reaches the console (`control.publicUrl`), for a widget's page. */
  publicUrl?: () => string | null;
}

interface ChatSendInput {
  platform: string;
  text: string;
  reply_to?: string;
  images?: string[];
  choices?: ChatChoices;
  widget?: { title: string; code: string };
  /** The turn ends once this message is sent. */
  final?: boolean;
}

/** A reply being written, as far as a platform that takes drafts has been told. */
interface Relay {
  platform: string;
  batchId: string;
  text: string;
  pending: ChatPending[] | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the platform last got an update. */
  last: number;
  shown: boolean;
}

const DEFAULT_MARKDOWN: ChatMarkdown = 'none';
const DEFAULT_LIMITS: ChatLimits = { maxImages: 4, maxImageBytes: 1536 * 1024, widgets: true, widgetMaxBytes: 64 * 1024 };
const MARKDOWN_WORDS: Record<ChatMarkdown, string> = { none: 'plain text', basic: 'basic Markdown', full: 'full Markdown' };

/**
 * The owner's conversation across chat platforms (docs/10-architecture/17-chat-and-console.md).
 * Owns the one `chat_send` tool, routes it to the platform it names, and records what was
 * sent, so every platform shows up the same way in the console. A platform is a connector
 * that declares itself one; its inbound side is ordinary `chat.message` events. What a reply
 * may carry besides text (images, choices, a widget, drafts) is what the platform declares.
 */
export class ChatHub {
  private readonly platforms = new Map<string, ChatPlatform>();
  private readonly relays = new Map<string, Relay>();
  private last: string | null;

  constructor(private readonly o: ChatHubOptions) {
    this.last = o.outputs?.lastChatPlatform() ?? null;
    o.bus.on('event.stored', (e) => {
      if (e.type === CHAT_MESSAGE_EVENT && e.senderRole === 'owner') this.last = e.source;
    });
    o.bus.on('chat.draft', (d) => this.relay(d));
  }

  register(p: ChatPlatform): void {
    this.platforms.set(p.id, p);
    this.publish(`platform ${p.id} started`);
  }

  unregister(id: string, reason: string): void {
    if (!this.platforms.delete(id)) return;
    for (const [callId, r] of this.relays) if (r.platform === id) this.dropRelay(callId);
    this.publish(reason);
  }

  /** Publish the tool again after a setting that shapes it changed (`chat.widgets`). */
  refresh(reason: string): void {
    this.publish(reason);
  }

  private limits(): ChatLimits {
    return this.o.limits?.() ?? DEFAULT_LIMITS;
  }

  private widgetsOn(p: ChatPlatformDecl): boolean {
    return p.widgets === true && this.o.widgets !== undefined && this.limits().widgets;
  }

  private imagesOn(p: ChatPlatformDecl): boolean {
    return p.images === true && this.o.blobs !== undefined;
  }

  list(): ChatPlatformInfo[] {
    return [...this.platforms.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((p) => ({
        id: p.id,
        displayName: p.displayName ?? p.id,
        markdown: p.markdown ?? DEFAULT_MARKDOWN,
        ...(p.maxChars !== undefined ? { maxChars: p.maxChars } : {}),
        images: this.imagesOn(p),
        choices: p.choices === true,
        widgets: this.widgetsOn(p),
        drafts: p.drafts !== undefined,
      }));
  }

  showsDrafts(id: string): boolean {
    return this.platforms.get(id)?.drafts !== undefined;
  }

  /** Where the owner last wrote, when that platform is running. */
  get lastPlatform(): string | undefined {
    return this.last !== null && this.platforms.has(this.last) ? this.last : undefined;
  }

  /** The tool's schema names the running platforms; with none there is nothing to call. */
  private publish(reason: string): void {
    const ids = [...this.platforms.keys()].sort();
    this.o.tools.replaceOwner(CHAT_TOOL_OWNER, ids.length > 0 ? [this.spec(ids) as unknown as ToolSpec<never>] : [], reason);
  }

  /** What each running platform shows, from what it declared: the model reads this instead of guessing. */
  private features(): string {
    return this.list()
      .map((p) => {
        const parts = [MARKDOWN_WORDS[p.markdown]];
        if (p.maxChars !== undefined) parts.push(`up to ${p.maxChars} characters a message`);
        if (p.images) parts.push('images');
        if (p.choices) parts.push('choices');
        if (p.widgets) parts.push('widget');
        return `${p.id}: ${parts.join(', ')}`;
      })
      .join('; ');
  }

  private spec(ids: string[]): ToolSpec<ChatSendInput> {
    const info = this.list();
    const limits = this.limits();
    const extra: Record<string, unknown> = {};
    if (info.some((p) => p.images)) {
      extra['images'] = {
        type: 'array',
        minItems: 1,
        maxItems: Math.max(1, limits.maxImages),
        items: { type: 'string', minLength: 1, maxLength: 4096 },
        description: 'Pictures shown under the message: workspace paths (as view_image takes them) or stored image handles (blob:…).',
      };
    }
    if (info.some((p) => p.choices)) {
      extra['choices'] = {
        type: 'object',
        additionalProperties: false,
        required: ['options'],
        description:
          'Options the owner can tap instead of typing; the text is the question. The answer arrives later as an ordinary chat.message whose text is the chosen label. The owner can always type something else.',
        properties: {
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label'],
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[^/\\s]', description: 'Short plain text; sent as the answer.' },
                detail: { type: 'string', maxLength: 120, description: 'One line under the label.' },
              },
            },
          },
          multiple: { type: 'boolean', description: 'The owner may choose several.' },
        },
      };
    }
    if (info.some((p) => p.widgets)) {
      extra['widget'] = {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'code'],
        description:
          'An interactive HTML or SVG fragment shown under the message, for what Markdown, a mermaid diagram or an image cannot show. It runs in a sandbox: inline <style> and <script> only, no network, no external scripts, styles, fonts or images (data: URLs work), no storage, no links or forms. sendPrompt(text) puts text into the owner\'s input box for them to send.',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 60 },
          code: { type: 'string', minLength: 1, maxLength: Math.max(1, limits.widgetMaxBytes), description: 'The fragment, without <html>, <head> or <body>.' },
        },
      };
    }
    return {
      name: CHAT_SEND,
      description: `Send a message to the owner on a chat platform. The platform is required. What each platform shows: ${this.features()}.${Object.keys(extra).length > 0 ? ` ${Object.keys(extra).join(', ')} only work on a platform that lists them.` : ''}`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'text'],
        properties: {
          platform: { type: 'string', enum: ids, description: 'Which chat platform to use.' },
          text: { type: 'string', minLength: 1, maxLength: 20_000 },
          reply_to: { type: 'string', maxLength: 256, description: 'Platform message id to reply to (the correlation of the event).' },
          ...extra,
          final: { type: 'boolean', description: 'true when this message is the last thing you do in this turn: the turn ends as soon as it is sent, with no further model call. Leave it out when you will keep working after it.' },
        },
      },
      flags: { sideEffect: true, barrierAfter: true },
      outboundKey: (input) => input.platform,
      handler: (input, call) => this.send(input, call),
    };
  }

  /** The images a reply names, stored. A workspace file is stored first, like `view_image` does. */
  private resolveImages(id: string, requested: string[]): { images: BlobImageRef[] } | { error: string } {
    const blobs = this.o.blobs as BlobStore;
    const limits = this.limits();
    if (requested.length > limits.maxImages) return { error: `a message carries at most ${limits.maxImages} images (${requested.length} given)` };
    const images: BlobImageRef[] = [];
    for (const ref of requested) {
      if (isBlobHandle(ref)) {
        const info = blobs.info(ref);
        if (!info) return { error: `${ref} is no longer stored` };
        images.push({ handle: info.handle, mime: info.mime });
        continue;
      }
      if (this.o.workspace === undefined) return { error: `${ref}: there is no workspace to read images from; use a stored image handle (blob:…)` };
      let bytes: Buffer;
      try {
        bytes = readWorkspaceFile(this.o.workspace, ref, limits.maxImageBytes);
      } catch (err) {
        return { error: errorMessage(err) };
      }
      if (!sniffImageMime(bytes)) return { error: `${ref} is not a PNG, JPEG, WebP or GIF image` };
      const put = blobs.putImage(bytes, `chat:${id}`);
      if (!put.ok) return { error: `${ref}: ${put.reason}` };
      images.push({ handle: put.blob.handle, mime: put.blob.mime });
    }
    return { images };
  }

  private async send(input: ChatSendInput, call: ToolContext): Promise<ToolOutcome> {
    const { platform: id, text } = input;
    const platform = this.platforms.get(id);
    const fail = (why: string): ToolOutcome => {
      this.endRelay(call.callId, false);
      return { text: why, failed: true };
    };
    if (!platform) return fail(`chat platform ${id} is not running; running: ${this.list().map((p) => p.id).join(', ') || 'none'}`);
    // A platform shows what it declared. Nothing is rewritten for one that does not: the model is told and decides.
    if (input.images !== undefined && !this.imagesOn(platform)) return fail(`${id} does not show images sent this way; describe the picture in the text, or use a platform that lists images`);
    if (input.choices !== undefined && platform.choices !== true) return fail(`${id} does not show choices; put the options in the text`);
    if (input.widget !== undefined && !this.widgetsOn(platform)) {
      return fail(platform.widgets === true ? 'widgets are turned off (chat.widgets); say it in the text' : `${id} does not show widgets; say it in the text, or use a platform that lists widget`);
    }
    const parts: ChatReplyParts = { callId: call.callId };
    if (input.choices !== undefined) {
      const labels = input.choices.options.map((o) => o.label.trim());
      if (new Set(labels).size !== labels.length) return fail('two choices have the same label');
      parts.choices = { options: input.choices.options.map((o) => ({ label: o.label.trim(), ...(o.detail ? { detail: o.detail } : {}) })), ...(input.choices.multiple ? { multiple: true } : {}) };
    }
    if (input.images !== undefined) {
      const r = this.resolveImages(id, input.images);
      if ('error' in r) return fail(r.error);
      parts.images = r.images;
    }
    let widget: ChatWidgetRef | undefined;
    if (input.widget !== undefined) {
      const why = checkWidget(input.widget.code, this.limits().widgetMaxBytes);
      if (why) return fail(why);
      const at = new Date(this.o.clock.now()).toISOString();
      const stored = (this.o.widgets as WidgetStore).put({ title: input.widget.title, code: input.widget.code, sessionId: call.sessionId, batchId: call.batchId }, at);
      parts.widget = stored;
      const base = this.o.publicUrl?.();
      widget = { ...stored, ...(base ? { url: `${base.replace(/\/+$/, '')}/#/widget/${stored.id}` } : {}) };
    }
    this.holdRelay(call.callId);
    let result: ChatSendResult;
    try {
      result = await platform.send({
        text,
        sessionId: call.sessionId,
        batchId: call.batchId,
        callId: call.callId,
        ...(input.reply_to !== undefined ? { replyTo: input.reply_to } : {}),
        ...(parts.images ? { images: parts.images } : {}),
        ...(parts.choices ? { choices: parts.choices } : {}),
        ...(widget ? { widget } : {}),
      });
    } catch (err) {
      return fail(`${id} could not send the message: ${errorMessage(err)}`);
    }
    if (!result.ok) return fail(result.error ?? `${id} could not send the message`);
    this.endRelay(call.callId, true);
    this.record(id, text, { sessionId: call.sessionId, batchId: call.batchId }, parts);
    const ids = result.messageIds ?? [];
    const extras = [parts.images ? `${parts.images.length} image${parts.images.length === 1 ? '' : 's'}` : '', parts.choices ? `${parts.choices.options.length} choices` : '', parts.widget ? 'a widget' : ''].filter(Boolean);
    return {
      text: `sent to ${id}${ids.length > 0 ? ` as message ${ids.join(', ')}` : ''} (${text.length} characters${extras.length > 0 ? `, ${extras.join(', ')}` : ''})${parts.choices ? '; the answer will arrive as a chat.message' : ''}`,
      ...(input.final === true ? { endsTurn: true } : {}),
    };
  }

  /**
   * A message from Protea itself: to where the owner last wrote, then to the other running
   * platforms until one takes it (some can only answer within a time window). False when none did.
   */
  async notifyOwner(text: string): Promise<boolean> {
    const last = this.lastPlatform;
    const others = [...this.platforms.keys()].filter((id) => id !== last).sort();
    for (const id of last !== undefined ? [last, ...others] : others) {
      try {
        const result = await this.platforms.get(id)?.send({ text });
        if (!result?.ok) throw new Error(result?.error ?? 'the platform did not send it');
        this.record(id, text, {}, {});
        return true;
      } catch (err) {
        this.o.log.warn({ platform: id, err: errorMessage(err) }, 'could not send a notice to the owner');
      }
    }
    return false;
  }

  private record(plugin: string, text: string, call: Partial<Pick<ToolContext, 'sessionId' | 'batchId'>>, parts: ChatReplyParts): void {
    const at = new Date(this.o.clock.now()).toISOString();
    let id: number | undefined;
    try {
      id = this.o.outputs?.record({ at, plugin, channel: CHAT_CHANNEL, text, ...call, meta: parts }).id;
    } catch (err) {
      this.o.log.warn({ plugin, err: errorMessage(err) }, 'could not store a chat message');
    }
    this.o.bus.emit('plugin.output', { plugin, channel: CHAT_CHANNEL, text, at, ...(call.batchId !== undefined ? { batchId: call.batchId } : {}), ...(id !== undefined ? { id } : {}), ...parts });
  }

  // Drafts for platforms that take them over the plugin protocol. The bus carries fragments every
  // 50 ms; a platform gets the whole text so far, no more often than it asked for.

  private relay(d: ChatDraftUpdate): void {
    const p = this.platforms.get(d.platform);
    if (!p?.draft) return;
    if (d.state === 'discarded') {
      this.endRelay(d.callId, false);
      return;
    }
    let r = this.relays.get(d.callId);
    if (!r) {
      r = { platform: d.platform, batchId: d.batchId, text: '', pending: undefined, timer: null, last: 0, shown: false };
      this.relays.set(d.callId, r);
    }
    // A fragment that does not line up came after a gap: wait for the reply itself.
    if (d.offset !== r.text.length) return;
    r.text += d.text;
    r.pending = d.pending;
    if (r.timer) return;
    const every = Math.max(CHAT_DRAFT_MIN_INTERVAL_MS, p.drafts?.minIntervalMs ?? CHAT_DRAFT_INTERVAL_MS);
    const callId = d.callId;
    r.timer = setTimeout(() => this.flushRelay(callId), Math.max(0, r.last + every - this.o.clock.now()));
    r.timer.unref?.();
  }

  private flushRelay(callId: string): void {
    const r = this.relays.get(callId);
    if (!r) return;
    r.timer = null;
    const p = this.platforms.get(r.platform);
    if (!p?.draft || (r.text === '' && !r.pending)) return;
    r.last = this.o.clock.now();
    r.shown = true;
    try {
      p.draft({ callId, batchId: r.batchId, state: 'writing', text: r.text, ...(r.pending ? { pending: r.pending } : {}) });
    } catch (err) {
      this.o.log.warn({ platform: r.platform, err: errorMessage(err) }, 'could not pass a draft to the platform');
    }
  }

  /** The reply itself is being sent: no more previews of it. */
  private holdRelay(callId: string): void {
    const r = this.relays.get(callId);
    if (r?.timer) clearTimeout(r.timer);
    if (r) r.timer = null;
  }

  /** The reply replaced its preview (`sent`), or the preview is withdrawn. */
  private endRelay(callId: string, sent: boolean): void {
    const r = this.relays.get(callId);
    if (!r) return;
    this.dropRelay(callId);
    if (sent || !r.shown) return;
    try {
      this.platforms.get(r.platform)?.draft?.({ callId, batchId: r.batchId, state: 'discarded' });
    } catch (err) {
      this.o.log.warn({ platform: r.platform, err: errorMessage(err) }, 'could not withdraw a draft from the platform');
    }
  }

  private dropRelay(callId: string): void {
    const r = this.relays.get(callId);
    if (r?.timer) clearTimeout(r.timer);
    this.relays.delete(callId);
  }
}
