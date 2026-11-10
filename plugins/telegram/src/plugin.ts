import { definePlugin, type Host, type PluginDefinition } from '@protea/plugin-sdk';
import { CHAT_MESSAGE_EVENT, type EventInput } from '@protea/protocol';

export interface TelegramConfig {
  apiBase?: string;
  pollTimeoutSec?: number;
  ownerChatId?: number | string;
  stopWords?: string[];
  groupMentionsOnly?: boolean;
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}
interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  [k: string]: unknown;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Minimal Bot API client (https://core.telegram.org/bots/api). */
export class TelegramClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base.replace(/\/$/, '')}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (!body.ok) throw new TelegramError(body.description ?? `${method} failed`, body.error_code ?? res.status, body.parameters?.retry_after);
    return body.result as T;
  }
}

export const DEFAULT_STOP_WORDS = ['stop', 'wait', '停', '停下', '等一下', '别说了'];
const CHUNK = 3500;
const MAX_TEXT = 4000;

/** Split at paragraph or line breaks near the limit, so long replies stay readable. */
export function splitMessage(text: string, limit = CHUNK): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}

function displayName(u: TgUser | undefined): string {
  if (!u) return 'unknown';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return `${u.username ? `@${u.username}` : name || 'user'}${u.username && name ? ` (${name})` : ''}`;
}

function contentOf(m: TgMessage): string {
  if (typeof m.text === 'string') return m.text;
  const kind = ['photo', 'document', 'voice', 'audio', 'video', 'sticker', 'location', 'contact'].find((k) => k in m) ?? 'message';
  return `${m.caption ? `${m.caption}\n` : ''}[${kind}]`;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * The Telegram connector: long-polls getUpdates, turns messages into events (owner
 * private messages at L1, strangers at L2, groups at L2 when mentioned, otherwise
 * stored), and is the `telegram` chat platform (`chat_send`), and offers tg_send_chat / tg_react. See docs/10-architecture/08-event-source-plugins.md.
 */
export function createTelegramPlugin(): PluginDefinition<TelegramConfig> {
  let client: TelegramClient | null = null;
  let me: TgUser | null = null;
  let ownerChatId: number | string | null = null;
  let offset = 0;
  let stop = new AbortController();
  let loop: Promise<void> | null = null;
  let lastPollAt = 0;
  let started = false;

  const needClient = (): TelegramClient => {
    if (!client) throw new Error('telegram is not started');
    return client;
  };

  async function send(chatId: number | string, text: string, replyTo?: number): Promise<number[]> {
    const ids: number[] = [];
    for (const [i, part] of splitMessage(text).entries()) {
      const msg = await needClient().call<TgMessage>('sendMessage', {
        chat_id: chatId,
        text: part,
        ...(i === 0 && replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
      ids.push(msg.message_id);
    }
    return ids;
  }

  async function handle(host: Host<TelegramConfig>, u: TgUpdate): Promise<void> {
    const m = u.message ?? u.edited_message;
    if (!m || !m.from || m.from.is_bot) return;
    const edited = !u.message;
    const text = contentOf(m);
    const senderKey = `telegram:${m.from.id}`;
    const role = await host.owner.resolve(senderKey);
    const ref = `msg ${m.message_id}${m.reply_to_message ? `, reply to ${m.reply_to_message.message_id}` : ''}${edited ? ', edited' : ''}`;
    const base: Pick<EventInput, 'ts' | 'senderKey' | 'dedupeKey' | 'correlation' | 'meta'> = {
      ts: new Date(m.date * 1000).toISOString(),
      senderKey,
      dedupeKey: `update:${u.update_id}`,
      correlation: String(m.message_id),
      meta: { chatId: m.chat.id, messageId: m.message_id, chatType: m.chat.type },
    };
    const type = edited ? 'telegram.edited' : 'telegram.message';
    // The owner's private messages are the conversation; an edit stays Telegram's own fact.
    const ownerType = edited ? 'telegram.edited' : CHAT_MESSAGE_EVENT;

    if (m.chat.type === 'private') {
      if (role === 'owner') {
        if (ownerChatId !== m.chat.id) {
          ownerChatId = m.chat.id;
          await host.kv.set('ownerChatId', m.chat.id);
        }
        const cmd = /^\/(approve|deny)\s+(a\d+)\b/i.exec(text.trim());
        if (cmd && !edited) {
          const decision = (cmd[1] as string).toLowerCase() === 'approve' ? 'approve' : 'deny';
          const r = await host.approvals.decide(cmd[2] as string, decision, senderKey).catch((err: Error) => ({ ok: false, message: err.message }));
          await send(m.chat.id, r.ok ? `${cmd[2]} ${decision === 'approve' ? 'approved' : 'denied'}.` : `Could not ${decision} ${cmd[2]}: ${r.message ?? 'unknown error'}`, m.message_id);
          return;
        }
        const stopWords = (host.config.stopWords ?? DEFAULT_STOP_WORDS).map((w) => w.toLowerCase());
        const isStop = stopWords.includes(text.trim().toLowerCase().replace(/[.!。！]+$/u, ''));
        await host.events.push({ ...base, type: ownerType, level: 1, trigger: isStop && !edited ? 'interrupt' : 'flush', text: `Message from owner in private chat (${ref}):\n${text}` });
        return;
      }
      await host.events.push({
        ...base,
        type,
        level: 2,
        trigger: 'flush',
        text: `Message from ${displayName(m.from)} (user ${m.from.id}, not the owner) in private chat (${ref}):\n${text}`,
      });
      return;
    }
    const mentioned =
      (me?.username !== undefined && text.includes(`@${me.username}`)) || (me !== null && m.reply_to_message?.from?.id === me.id);
    const who = role === 'owner' ? 'owner' : `${displayName(m.from)} (user ${m.from.id})`;
    const where = `group "${m.chat.title ?? m.chat.id}" (chat ${m.chat.id}, ${ref})`;
    if (mentioned || host.config.groupMentionsOnly === false) {
      await host.events.push({ ...base, type, level: 2, trigger: 'flush', text: `Message from ${who} in ${where}, mentioning the bot:\n${text}` });
    } else {
      await host.events.push({ ...base, type, level: 4, trigger: 'store', text: `Message from ${who} in ${where}:\n${text}` });
    }
  }

  async function poll(host: Host<TelegramConfig>): Promise<void> {
    let backoff = 1000;
    const timeout = host.config.pollTimeoutSec ?? 30;
    while (!stop.signal.aborted) {
      try {
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout((timeout + 15) * 1000)]);
        if (!me) me = await needClient().call<TgUser>('getMe', {}, signal);
        const updates = await needClient().call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout, allowed_updates: ['message', 'edited_message'] },
          signal,
        );
        lastPollAt = Date.now();
        backoff = 1000;
        for (const u of updates) {
          await handle(host, u);
          // The event is stored (or deduplicated) before the offset moves on: a crash re-reads, never loses.
          offset = u.update_id + 1;
          await host.kv.set('offset', offset);
        }
      } catch (err) {
        if (stop.signal.aborted) break;
        const retry = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : backoff;
        host.log.warn('telegram poll failed; retrying', { err: (err as Error).message, retryInMs: retry });
        await sleep(retry, stop.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  return definePlugin<TelegramConfig>({
    displayName: 'Telegram',
    async start(host) {
      const token = host.secret('TELEGRAM_BOT_TOKEN');
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
      client = new TelegramClient(host.config.apiBase ?? 'https://api.telegram.org', token);
      ownerChatId = host.config.ownerChatId ?? (await host.kv.get<number>('ownerChatId')) ?? null;
      offset = (await host.kv.get<number>('offset')) ?? 0;
      stop = new AbortController();
      started = true;
      loop = poll(host);
    },
    async stop() {
      stop.abort();
      await loop;
    },
    async onConfigChanged(host, patch) {
      if ('ownerChatId' in patch) ownerChatId = host.config.ownerChatId ?? (await host.kv.get<number>('ownerChatId')) ?? null;
    },
    chat: {
      async send(_host, req) {
        if (ownerChatId === null) {
          return { ok: false, error: "the owner's Telegram chat is not known yet: the owner has to message the bot first (or set plugins.telegram.config.ownerChatId)" };
        }
        const replyTo = req.replyTo === undefined ? undefined : Number(req.replyTo);
        if (replyTo !== undefined && !Number.isInteger(replyTo)) return { ok: false, error: `reply_to must be a Telegram message id, not "${req.replyTo}"` };
        const ids = await send(ownerChatId, req.text, replyTo);
        return { ok: true, messageIds: ids.map(String) };
      },
    },
    tools: [
      {
        name: 'tg_send_chat',
        description: 'Send a message to another Telegram chat (a group or another user). Needs the owner’s approval.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['chat_id', 'text'],
          properties: {
            chat_id: { type: ['integer', 'string'] },
            text: { type: 'string', minLength: 1, maxLength: 20_000 },
            reply_to: { type: 'integer' },
          },
        },
        flags: { sideEffect: true, barrierAfter: true },
        handler: async (i: { chat_id: number | string; text: string; reply_to?: number }) => {
          const ids = await send(i.chat_id, i.text, i.reply_to);
          return `sent message ${ids.join(', ')} to chat ${i.chat_id}`;
        },
      },
      {
        name: 'tg_react',
        description: 'React to a message with an emoji (default chat: the owner’s).',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['message_id', 'emoji'],
          properties: {
            message_id: { type: 'integer' },
            emoji: { type: 'string', minLength: 1, maxLength: 8 },
            chat_id: { type: ['integer', 'string'] },
          },
        },
        flags: { sideEffect: true },
        handler: async (i: { message_id: number; emoji: string; chat_id?: number | string }) => {
          const chat = i.chat_id ?? ownerChatId;
          if (chat === null) return { text: "no chat given and the owner's chat is not known", failed: true };
          await needClient().call('setMessageReaction', { chat_id: chat, message_id: i.message_id, reaction: [{ type: 'emoji', emoji: i.emoji }] });
          return `reacted ${i.emoji} to message ${i.message_id}`;
        },
      },
    ],
    envPromptVars: () => ({ ownerChatKnown: ownerChatId !== null, botUsername: me?.username ?? '' }),
    async onApprovalRequest(_host, req) {
      if (ownerChatId === null || !client) return { delivered: false };
      const text = `Approval ${req.id} requested: ${req.summary}${req.reason ? `\nReason: ${req.reason}` : ''}\nReply /approve ${req.id} or /deny ${req.id} (expires ${req.expiresAt}).`;
      await send(ownerChatId, text.slice(0, MAX_TEXT));
      return { delivered: true };
    },
    health(host) {
      if (!started) return { ok: true };
      const limitMs = ((host.config.pollTimeoutSec ?? 30) + 60) * 1000;
      const age = Date.now() - lastPollAt;
      return lastPollAt > 0 && age < limitMs ? { ok: true } : { ok: false, detail: lastPollAt === 0 ? 'no successful poll yet' : `last successful poll ${Math.round(age / 1000)}s ago` };
    },
  });
}
