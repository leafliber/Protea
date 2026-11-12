import { ApprovalInbox, DEFAULT_STOP_WORDS, approvalOutcome, definePlugin, parseApprovalButton, isModeCommand, isStopWord, modeCommand, splitMessage as splitAt, type Host, type PluginDefinition } from '@protea/plugin-sdk';
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
interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}
interface TgDocument {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
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

/** The longest edge worth sending to a model: larger photos are scaled down by the provider anyway. */
const MAX_PHOTO_EDGE = 1568;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** The largest size of a photo that fits, or the smallest there is. */
export function pickPhotoSize(sizes: readonly TgPhotoSize[]): TgPhotoSize | undefined {
  const byEdge = [...sizes].sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  return byEdge.filter((s) => Math.max(s.width, s.height) <= MAX_PHOTO_EDGE).at(-1) ?? byEdge[0];
}

/** Minimal Bot API client (https://core.telegram.org/bots/api). */
export class TelegramClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  /** The bytes of a file the Bot API knows by id. */
  async download(fileId: string): Promise<Buffer> {
    const { file_path: filePath, file_size: size } = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!filePath) throw new TelegramError('Telegram did not give a file path');
    if (size !== undefined && size > MAX_DOWNLOAD_BYTES) throw new TelegramError(`the file is too large (${size} bytes)`);
    const res = await fetch(`${this.base.replace(/\/$/, '')}/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new TelegramError(`download failed: HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

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

export { DEFAULT_STOP_WORDS };
const CHUNK = 3500;
const MAX_TEXT = 4000;

export const splitMessage = (text: string, limit = CHUNK): string[] => splitAt(text, limit);

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
  /** The approval requests shown here, and what the owner's words and presses mean. */
  let inbox: ApprovalInbox<TelegramConfig> | null = null;
  const inboxOf = (host: Host<TelegramConfig>): ApprovalInbox<TelegramConfig> => (inbox ??= new ApprovalInbox(host));
  /** What each request message said, to rewrite it once the request is settled. */
  const shownText = new Map<string, string>();

  /** A button under an approval request: only the owner's press counts, and the host checks again. */
  async function pressed(host: Host<TelegramConfig>, q: TgCallbackQuery): Promise<void> {
    const answer = (text: string): Promise<unknown> =>
      needClient()
        .call('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190) })
        .catch((err: Error) => host.log.warn('could not answer a Telegram button', { err: err.message }));
    const zh = host.language.toLowerCase().startsWith('zh');
    const senderKey = `telegram:${q.from.id}`;
    if (!parseApprovalButton(q.data ?? '')) return void (await answer(zh ? '这个按钮已经失效' : 'This button no longer works'));
    if ((await host.owner.resolve(senderKey)) !== 'owner' || q.message?.chat.type !== 'private') return void (await answer(zh ? '只有主人可以决定' : 'Only the owner can decide'));
    const r = await inboxOf(host).press(senderKey, q.data as string);
    await answer(r?.text ?? '');
    // Decided elsewhere or expired while this message kept its buttons: take them off now.
    if (!r?.ok && q.message) await needClient().call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => undefined);
  }

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

  /** The owner's picture, stored for the model. A failure leaves the message as text: it should still arrive. */
  async function ownerImages(host: Host<TelegramConfig>, m: TgMessage): Promise<NonNullable<EventInput['blobs']>> {
    const doc = m['document'] as TgDocument | undefined;
    const fileId = pickPhotoSize((m['photo'] as TgPhotoSize[] | undefined) ?? [])?.file_id ?? (doc?.mime_type?.startsWith('image/') ? doc.file_id : undefined);
    if (!fileId) return [];
    try {
      const put = await host.blobs.put(await needClient().download(fileId));
      return [{ handle: put.handle, mime: put.mime, size: put.size }];
    } catch (err) {
      host.log.warn('could not fetch the image of a message', { messageId: m.message_id, err: (err as Error).message });
      return [];
    }
  }

  async function handle(host: Host<TelegramConfig>, u: TgUpdate): Promise<void> {
    if (u.callback_query) return pressed(host, u.callback_query);
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
        if (!edited) {
          const answer = typeof m.text === 'string' ? await inboxOf(host).reply(senderKey, text, m.reply_to_message ? { quoted: String(m.reply_to_message.message_id) } : {}) : null;
          if (answer !== null) {
            inbox?.sentOther();
            await send(m.chat.id, answer, m.message_id);
            return;
          }
          if (isModeCommand(text)) {
            await send(m.chat.id, await modeCommand(host, senderKey, text), m.message_id);
            return;
          }
        }
        const isStop = isStopWord(text, host.config.stopWords ?? DEFAULT_STOP_WORDS);
        const blobs = await ownerImages(host, m);
        await host.events.push({ ...base, ...(blobs.length > 0 ? { blobs } : {}), type: ownerType, level: 1, trigger: isStop && !edited ? 'interrupt' : 'flush', text: `Message from owner in private chat (${ref}):\n${text}` });
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
          { offset, timeout, allowed_updates: ['message', 'edited_message', 'callback_query'] },
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
        inbox?.sentOther();
        const ids = await send(ownerChatId, req.text, replyTo);
        return { ok: true, messageIds: ids.map(String) };
      },
    },
    tools: [
      {
        name: 'tg_send_chat',
        description: 'Send a message to another Telegram chat (a group or another user). Needs the owner’s approval.',
        approval: { title: { zh: '发 Telegram 消息给别人', en: 'Send a Telegram message to someone else' }, target: 'text', fields: { chat_id: { zh: '发给', en: 'To chat' }, reply_to: { zh: '回复的消息', en: 'Replying to' } } },
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
    async onApprovalRequest(host, req) {
      if (ownerChatId === null || !client) return { delivered: false };
      const box = inboxOf(host);
      const msg = box.message(req);
      const text = msg.text.slice(0, MAX_TEXT);
      // Approve and deny side by side, the longer "stop asking for a while" on its own row. Plain text: no parse_mode, so nothing in a tool's input is read as markup.
      const button = (b: (typeof msg.buttons)[number]) => ({ text: b.label, callback_data: b.data });
      const rows = [msg.buttons.filter((b) => b.choice !== 'grant').map(button), msg.buttons.filter((b) => b.choice === 'grant').map(button)].filter((r) => r.length > 0);
      try {
        const sent = await client.call<TgMessage>('sendMessage', { chat_id: ownerChatId, text, reply_markup: { inline_keyboard: rows } });
        shownText.set(req.id, text);
        box.shown(req.id, String(sent.message_id));
        return { delivered: true };
      } catch (err) {
        box.dropped(req.id);
        host.log.warn('could not send an approval request', { err: (err as Error).message });
        return { delivered: false };
      }
    },
    async onApprovalResolved(host, p) {
      const shown = inboxOf(host).resolved(p.id);
      const text = shownText.get(p.id);
      shownText.delete(p.id);
      if (!shown?.messageId || ownerChatId === null || !client) return;
      // The request stays readable; its buttons give way to the outcome.
      const outcome = approvalOutcome(p, { language: host.language, timezone: host.timezone });
      await client
        .call('editMessageText', { chat_id: ownerChatId, message_id: Number(shown.messageId), text: `${text ?? shown.req.summary}\n\n${outcome}`.slice(0, MAX_TEXT + 60) })
        .catch((err: Error) => host.log.warn('could not update a settled approval request', { err: err.message }));
    },
    health(host) {
      if (!started) return { ok: true };
      const limitMs = ((host.config.pollTimeoutSec ?? 30) + 60) * 1000;
      const age = Date.now() - lastPollAt;
      return lastPollAt > 0 && age < limitMs ? { ok: true } : { ok: false, detail: lastPollAt === 0 ? 'no successful poll yet' : `last successful poll ${Math.round(age / 1000)}s ago` };
    },
  });
}
