import { CHAT_MESSAGE_EVENT, type ChatMarkdown, type ChatPlatformDecl, type ChatPlatformInfo, type ChatSendParams, type ChatSendResult } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { OutputLog } from '../events/outputs.js';
import type { Logger } from '../observability/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolOutcome, ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';

export const CHAT_SEND = 'chat_send';
/** Owner of `chat_send` in the tool registry. */
export const CHAT_TOOL_OWNER = 'chat';
/** Channel of a chat reply in the outputs table. */
export const CHAT_CHANNEL = 'chat';

/** A running platform, as a plugin hands it to the hub. */
export interface ChatPlatform extends ChatPlatformDecl {
  id: string;
  send(req: ChatSendParams): Promise<ChatSendResult> | ChatSendResult;
}

export interface ChatHubOptions {
  tools: ToolRegistry;
  bus: Bus;
  outputs?: OutputLog;
  log: Logger;
  clock: Clock;
}

interface ChatSendInput {
  platform: string;
  text: string;
  reply_to?: string;
}

const DEFAULT_MARKDOWN: ChatMarkdown = 'none';

/**
 * The owner's conversation across chat platforms (docs/10-architecture/17-chat-and-console.md).
 * Owns the one `chat_send` tool, routes it to the platform it names, and records what was
 * sent, so every platform shows up the same way in the console. A platform is a connector
 * that declares itself one; its inbound side is ordinary `chat.message` events.
 */
export class ChatHub {
  private readonly platforms = new Map<string, ChatPlatform>();
  private last: string | null;

  constructor(private readonly o: ChatHubOptions) {
    this.last = o.outputs?.lastChatPlatform() ?? null;
    o.bus.on('event.stored', (e) => {
      if (e.type === CHAT_MESSAGE_EVENT && e.senderRole === 'owner') this.last = e.source;
    });
  }

  register(p: ChatPlatform): void {
    this.platforms.set(p.id, p);
    this.publish(`platform ${p.id} started`);
  }

  unregister(id: string, reason: string): void {
    if (this.platforms.delete(id)) this.publish(reason);
  }

  list(): ChatPlatformInfo[] {
    return [...this.platforms.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((p) => ({
        id: p.id,
        displayName: p.displayName ?? p.id,
        markdown: p.markdown ?? DEFAULT_MARKDOWN,
        ...(p.maxChars !== undefined ? { maxChars: p.maxChars } : {}),
      }));
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

  private spec(ids: string[]): ToolSpec<ChatSendInput> {
    return {
      name: CHAT_SEND,
      description: 'Send a message to the owner on a chat platform. The platform is required.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'text'],
        properties: {
          platform: { type: 'string', enum: ids, description: 'Which chat platform to use.' },
          text: { type: 'string', minLength: 1, maxLength: 20_000 },
          reply_to: { type: 'string', maxLength: 256, description: 'Platform message id to reply to (the correlation of the event).' },
        },
      },
      flags: { sideEffect: true, barrierAfter: true },
      outboundKey: (input) => input.platform,
      handler: (input, call) => this.send(input, call),
    };
  }

  private async send(input: ChatSendInput, call: ToolContext): Promise<ToolOutcome> {
    const { platform: id, text } = input;
    const platform = this.platforms.get(id);
    if (!platform) return { text: `chat platform ${id} is not running; running: ${this.list().map((p) => p.id).join(', ') || 'none'}`, failed: true };
    let result: ChatSendResult;
    try {
      result = await platform.send({
        text,
        sessionId: call.sessionId,
        batchId: call.batchId,
        ...(input.reply_to !== undefined ? { replyTo: input.reply_to } : {}),
      });
    } catch (err) {
      return { text: `${id} could not send the message: ${errorMessage(err)}`, failed: true };
    }
    if (!result.ok) return { text: result.error ?? `${id} could not send the message`, failed: true };
    this.record(id, text, { sessionId: call.sessionId, batchId: call.batchId });
    const ids = result.messageIds ?? [];
    return { text: `sent to ${id}${ids.length > 0 ? ` as message ${ids.join(', ')}` : ''} (${text.length} characters)` };
  }

  /** A message from Protea itself, to where the owner last wrote; false when it could not be sent. */
  async notifyOwner(text: string): Promise<boolean> {
    const id = this.lastPlatform ?? [...this.platforms.keys()].sort()[0];
    const platform = id !== undefined ? this.platforms.get(id) : undefined;
    if (id === undefined || !platform) return false;
    try {
      const result = await platform.send({ text });
      if (!result.ok) throw new Error(result.error ?? 'the platform did not send it');
      this.record(id, text, {});
      return true;
    } catch (err) {
      this.o.log.warn({ platform: id, err: errorMessage(err) }, 'could not send a notice to the owner');
      return false;
    }
  }

  private record(plugin: string, text: string, call: Partial<Pick<ToolContext, 'sessionId' | 'batchId'>>): void {
    const at = new Date(this.o.clock.now()).toISOString();
    let id: number | undefined;
    try {
      id = this.o.outputs?.record({ at, plugin, channel: CHAT_CHANNEL, text, ...call }).id;
    } catch (err) {
      this.o.log.warn({ plugin, err: errorMessage(err) }, 'could not store a chat message');
    }
    this.o.bus.emit('plugin.output', { plugin, channel: CHAT_CHANNEL, text, at, ...(call.batchId !== undefined ? { batchId: call.batchId } : {}), ...(id !== undefined ? { id } : {}) });
  }
}
