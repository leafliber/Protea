import crypto from 'node:crypto';
import {
  DEFAULT_STOP_WORDS,
  ApprovalInbox,
  parseApprovalButton,
  type ApprovalMessage,
  chatAnswer,
  definePlugin,
  isModeCommand,
  isStopWord,
  modeCommand,
  splitMessage,
  type Host,
  type PluginDefinition,
  type PluginTool,
} from '@protea/plugin-sdk';
import { CHAT_MESSAGE_EVENT, type ChatChoices, type ChatDraftParams, type ChatSendParams, type ChatSendResult, type EventInput } from '@protea/protocol';
import {
  ApiError,
  GatewayError,
  GatewayErrorCode,
  QQBot,
  contentSanitizer,
  type InlineKeyboard,
  type InteractionEvent,
  type QQBotInboundMessage,
  type ReplyTarget,
  type StreamSession,
} from '@tencent-connect/qqbot-nodejs';
import { QrBind } from './login.js';

export interface QqConfig {
  appId?: string;
  groups?: boolean;
  stopWords?: string[];
  apiBase?: string;
  tokenBase?: string;
  bindBase?: string;
}

export interface QqPluginOptions {
  /** Pause between sign-in status requests (default 2 s, as in the official client). */
  bindPollMs?: number;
  /** First pause after a failed connection; doubles up to 5 min (default 5 s). */
  retryMs?: number;
}

export const SECRET = 'QQ_APP_SECRET';
const CHUNK = 5000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Group messages the assistant may still answer, newest last. */
const MAX_GROUP_MESSAGES = 500;
const DEFAULT_BIND_BASE = 'https://q.qq.com';
/** Everything that belongs to one bot and one owner; forgotten on sign-out and on a new sign-in. */
const STATE_KEYS = ['signIn', 'ownerOpenid', 'lastMsgId', 'session', 'refusedAt', 'choices'];
/** QQ streams a reply only within 5 minutes of the owner's message; stay inside that. */
const STREAM_WINDOW_MS = 4.5 * 60_000;
/** What a preview becomes when its reply is withdrawn: a stream message can be rewritten, not deleted. */
const WITHDRAWN = '（这条回复没有写完，已撤回）';
/** QQ answers a button press within 5 s; these are its codes. */
const ACK_OK = 0;
const ACK_FAILED = 1;
const ACK_NO_PERMISSION = 4;

const NOT_SIGNED_IN = 'QQ is not signed in: the operator has to scan the QR code (console: Plugins, qq, Sign-in; or "protea plugins login qq").';
const NO_APP_ID = 'QQ_APP_SECRET is set but the AppID is unknown: sign in with the QR code, or set plugins.qq.config.appId to the bot the secret belongs to.';
const NO_CONVERSATION = 'QQ bots cannot start a conversation: the owner has to write to the bot on QQ first. Reach the owner on another platform.';

interface SignIn {
  appId: string;
  /** Which secret this AppID came with: a secret replaced by hand falls back to config.appId. */
  secretSha256: string;
}

/** The newest options sent to the owner: the only ones that can still be answered. */
interface OpenChoices {
  callId: string;
  labels: string[];
  multiple: boolean;
  /** The message that carries the buttons, when there are buttons. */
  messageId?: string;
}

/** A reply that QQ shows while it is written (a C2C stream message). */
interface Preview {
  session: StreamSession;
  /** Something may be on the owner's screen. */
  shown: boolean;
  /** QQ refused a frame: nothing more goes through this stream. */
  broken: boolean;
  /** Frames go one after another. */
  work: Promise<void>;
}

interface PersistedSession {
  sessionId: string;
  lastSeq: number | null;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The service's own words when it answered; a network failure is not a refusal. */
const refused = (err: unknown): err is ApiError => err instanceof ApiError && err.httpStatus > 0;

function detailOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.bizMessage ?? err.message}${err.bizCode !== undefined ? ` (code ${err.bizCode})` : ''}`;
  return errorText(err);
}

function isoOf(ts: string | undefined): string {
  const t = ts ? Date.parse(ts) : NaN;
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString();
}

type Attachment = NonNullable<QQBotInboundMessage['attachments']>[number];
const isImage = (a: Attachment): boolean => (a.content_type ?? '').startsWith('image');
const urlOf = (a: Attachment): string => (a.url.startsWith('//') ? `https:${a.url}` : /^https?:\/\//i.test(a.url) ? a.url : `https://${a.url}`);

/** What the model reads: the quote, the text, and a note per attachment that is not a delivered image. */
function textOf(m: QQBotInboundMessage, imagesDelivered: boolean): string {
  const lines: string[] = [];
  const quoted = m.refMsgIdx ? m.msgElements?.[0]?.content?.trim() : undefined;
  if (quoted) lines.push(`[quoted: ${quoted}]`);
  if (m.content) lines.push(m.content);
  for (const a of m.attachments ?? []) {
    const type = a.content_type ?? '';
    if (isImage(a)) {
      if (!imagesDelivered) lines.push('[image]');
    } else if (type === 'voice' || type.startsWith('audio')) lines.push(a.asr_refer_text ? `[voice] ${a.asr_refer_text}` : '[voice]');
    else if (type.startsWith('video')) lines.push('[video]');
    else lines.push(`[file${a.filename ? ` ${a.filename}` : ''}]`);
  }
  return lines.join('\n') || '[unsupported message]';
}

/** Buttons for single-choice options, two to a row. */
function keyboardOf(c: ChatChoices): InlineKeyboard {
  const buttons = c.options.map((o, i) => ({
    id: `c${i}`,
    render_data: { label: o.label, visited_label: o.label, style: i === 0 ? 1 : 0 },
    action: { type: 1, permission: { type: 2 }, data: `choice:${i}`, click_limit: 1 },
  }));
  const rows: InlineKeyboard['content']['rows'] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push({ buttons: buttons.slice(i, i + 2) });
  return { content: { rows } };
}

/** Approve and deny side by side, the longer "stop asking for a while" on its own row. A pressed button shows the outcome. */
function approvalKeyboard(m: ApprovalMessage): InlineKeyboard {
  const button = (b: ApprovalMessage['buttons'][number]) => ({
    id: b.data,
    render_data: { label: b.label, visited_label: b.done, style: b.choice === 'approve' ? 1 : 0 },
    action: { type: 1, permission: { type: 2 }, data: b.data, click_limit: 1 },
  });
  const short = m.buttons.filter((b) => b.choice !== 'grant').map(button);
  const long = m.buttons.filter((b) => b.choice === 'grant').map(button);
  return { content: { rows: [{ buttons: short }, ...(long.length > 0 ? [{ buttons: long }] : [])] } };
}

/** The options as text, for when there are no buttons: the owner answers with numbers. */
function numbered(c: ChatChoices): string {
  const lines = c.options.map((o, i) => `${i + 1}. ${o.label}${o.detail ? `（${o.detail}）` : ''}`);
  return `${c.multiple ? '可以选多个，回复编号，用空格隔开：' : '回复编号选择：'}\n${lines.join('\n')}`;
}

/** What the owner chose, when their message is nothing but option numbers or labels; null otherwise. */
export function answerOf(text: string, open: { labels: string[]; multiple: boolean }): string[] | null {
  const t = text.trim();
  if (t === '') return null;
  const exact = open.labels.find((l) => l === t);
  if (exact) return [exact];
  const parts = t.split(/[\s,，、;；]+/).filter(Boolean);
  if (!parts.every((p) => /^\d{1,2}$/.test(p))) return null;
  const picked = [...new Set(parts.map((p) => Number(p) - 1))];
  if (picked.some((i) => i < 0 || i >= open.labels.length)) return null;
  if (!open.multiple && picked.length !== 1) return null;
  return picked.sort((a, b) => a - b).map((i) => open.labels[i] as string);
}

/**
 * The QQ connector, built on Tencent's official @tencent-connect/qqbot-nodejs client: connects to
 * the QQ bot gateway over WebSocket, turns the owner's private messages into `chat.message` events
 * and is the `qq` chat platform. Group messages that mention the bot are delivered only when
 * `groups` is on. See docs/10-architecture/08-event-source-plugins.md.
 */
export function createQqPlugin(opts: QqPluginOptions = {}): PluginDefinition<QqConfig> {
  let secret: string | null = null;
  let appId: string | null = null;
  let bot: QQBot | null = null;
  let ownerOpenid: string | null = null;
  /** The owner's newest private message: replies to it are passive, which QQ allows. */
  let lastMsgId: string | null = null;
  /** QQ refused a passive reply to this message; send without it until the owner writes again. */
  let passiveRefused: string | null = null;
  let session: PersistedSession | null = null;
  let connected = false;
  let lastError: string | null = null;
  /** The gateway closed for good (the bot is offline, banned or sandbox-only). */
  let gatewayRefusal: string | null = null;
  let stop = new AbortController();
  let loop: Promise<void> | null = null;
  /** Messages are handled one after another, in the order they arrived. */
  let queue: Promise<void> = Promise.resolve();
  let login: QrBind | null = null;
  /** When the owner's newest message arrived (ms): streaming is allowed only shortly after it. */
  let lastMsgAt = 0;
  let openChoices: OpenChoices | null = null;
  /** The approval requests shown here, and what the owner's words and presses mean. */
  let inbox: ApprovalInbox<QqConfig> | null = null;
  const inboxOf = (host: Host<QqConfig>): ApprovalInbox<QqConfig> => (inbox ??= new ApprovalInbox(host));
  const previews = new Map<string, Preview>();
  const groupMessages = new Map<string, string>();
  const retryMs = opts.retryMs ?? 5000;

  function rememberGroupMessage(id: string, group: string): void {
    groupMessages.delete(id);
    groupMessages.set(id, group);
    if (groupMessages.size > MAX_GROUP_MESSAGES) groupMessages.delete(groupMessages.keys().next().value as string);
  }

  async function gatewayRefused(host: Host<QqConfig>, err: GatewayError): Promise<void> {
    gatewayRefusal = `QQ closed the bot's connection for good (close code ${err.closeCode ?? 'unknown'}): the bot may be offline, banned or limited to its sandbox on q.qq.com.`;
    host.log.error('the QQ gateway refused the bot; not reconnecting', { closeCode: err.closeCode, err: err.message });
    // Told once: a restart finds the same answer until the operator fixes the bot.
    if ((await host.kv.get<string>('refusedAt')) !== undefined) return;
    await host.kv.set('refusedAt', new Date().toISOString());
    await host.events.push({
      ts: new Date().toISOString(),
      type: 'qq.connection_refused',
      level: 2,
      trigger: 'flush',
      text: `${gatewayRefusal} Messages on QQ are not received until the operator fixes the bot (q.qq.com) and restarts the qq plugin, or signs in again with a new QR code. Tell the owner on another platform.`,
    });
  }

  async function run(host: Host<QqConfig>, b: QQBot): Promise<void> {
    let backoff = retryMs;
    while (!stop.signal.aborted) {
      try {
        await b.start(stop.signal);
        return; // stopped
      } catch (err) {
        connected = false;
        if (stop.signal.aborted) return;
        if (err instanceof GatewayError && err.code === GatewayErrorCode.FATAL_CLOSE) return gatewayRefused(host, err);
        lastError = `could not connect: ${errorText(err)}`;
        host.log.warn('QQ connection failed; retrying', { err: errorText(err), retryInMs: backoff });
        await sleep(backoff, stop.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async function disconnect(): Promise<void> {
    for (const p of previews.values()) p.session.cancel();
    previews.clear();
    stop.abort();
    bot?.stop();
    await loop;
    await queue;
    loop = null;
    bot = null;
    connected = false;
  }

  /** The owner's pictures, stored for the model; a failure leaves the message as text. */
  async function ownerImages(host: Host<QqConfig>, m: QQBotInboundMessage): Promise<{ blobs: NonNullable<EventInput['blobs']>; failed: boolean }> {
    const blobs: NonNullable<EventInput['blobs']> = [];
    let failed = false;
    for (const a of m.attachments ?? []) {
      if (!isImage(a) || !a.url) continue;
      try {
        const res = await fetch(urlOf(a), { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > MAX_IMAGE_BYTES) throw new Error('too large');
        const put = await host.blobs.put(data);
        blobs.push({ handle: put.handle, mime: put.mime, size: put.size });
      } catch (err) {
        failed = true;
        // Not the address: it carries a download key.
        host.log.warn('could not fetch the image of a message', { messageId: m.messageId, err: errorText(err) });
      }
    }
    return { blobs, failed };
  }

  async function handle(host: Host<QqConfig>, m: QQBotInboundMessage): Promise<void> {
    const sender = m.senderId?.trim();
    if (!sender || m.senderIsBot) return;
    const id = m.messageId;
    const senderKey = `qq:${sender}`;
    const role = await host.owner.resolve(senderKey);
    const base: Pick<EventInput, 'ts' | 'senderKey' | 'dedupeKey' | 'correlation' | 'meta'> = {
      ts: isoOf(m.timestamp),
      senderKey,
      dedupeKey: `msg:${id}`,
      correlation: id,
      meta: { kind: m.kind, openid: sender, messageId: id, ...(m.groupOpenid ? { groupOpenid: m.groupOpenid } : {}) },
    };

    if (m.kind === 'group' && m.groupOpenid) {
      const who = role === 'owner' ? 'owner' : `member ${sender}${m.senderName ? ` (${m.senderName})` : ''}`;
      const where = `QQ group ${m.groupOpenid} (msg ${id})`;
      const text = textOf(m, false);
      if (host.config.groups === true && m.rawEventType === 'GROUP_AT_MESSAGE_CREATE') {
        rememberGroupMessage(id, m.groupOpenid);
        await host.events.push({ ...base, type: 'qq.message', level: 2, trigger: 'flush', text: `Message from ${who} in ${where}, mentioning the bot:\n${text}` });
      } else {
        await host.events.push({ ...base, type: 'qq.message', level: 4, trigger: 'store', text: `Message from ${who} in ${where}:\n${text}` });
      }
      return;
    }
    if (m.kind !== 'c2c') {
      await host.events.push({ ...base, type: 'qq.message', level: 4, trigger: 'store', text: `Message from ${sender} in a QQ channel (${m.kind}, msg ${id}):\n${textOf(m, false)}` });
      return;
    }
    if (role !== 'owner') {
      await host.events.push({ ...base, type: 'qq.message', level: 4, trigger: 'store', text: `Message from user ${sender} (not the owner) in private chat (msg ${id}):\n${textOf(m, false)}` });
      return;
    }

    // The newest message is what lets the bot answer; keep it before anything can fail.
    lastMsgId = id;
    lastMsgAt = Date.now();
    passiveRefused = null;
    await host.kv.set('lastMsgId', id);
    if (ownerOpenid !== sender) {
      ownerOpenid = sender;
      await host.kv.set('ownerOpenid', sender);
    }
    const command = m.content.trim();
    const answer = m.attachments?.length ? null : await inboxOf(host).reply(senderKey, command);
    if (answer !== null) return tell(host, answer);
    if (isModeCommand(command)) return tell(host, await modeCommand(host, senderKey, command));
    // Whatever the owner writes closes the options; numbers or a label answer them.
    const asked = openChoices;
    if (asked) await closeChoices(host);
    const picked = asked && !m.attachments?.length ? answerOf(command, asked) : null;
    if (asked && picked) {
      await host.events.push({ ...base, meta: { ...base.meta, ...chatAnswer(asked.callId, picked) }, type: CHAT_MESSAGE_EVENT, level: 1, trigger: 'flush', text: `Message from owner in private chat (msg ${id}), choosing from the options:\n${picked.join('、')}` });
      return;
    }
    const isStop = isStopWord(command, host.config.stopWords ?? DEFAULT_STOP_WORDS);
    const { blobs, failed } = await ownerImages(host, m);
    await host.events.push({
      ...base,
      ...(blobs.length > 0 ? { blobs } : {}),
      type: CHAT_MESSAGE_EVENT,
      level: 1,
      trigger: isStop ? 'interrupt' : 'flush',
      text: `Message from owner in private chat (msg ${id}):\n${textOf(m, true)}${failed ? '\n[the image could not be downloaded]' : ''}`,
    });
  }

  /** Send to the owner as a reply to their newest message while QQ takes it, else as a message of its own. */
  async function passive<T>(owner: string, send: (target: ReplyTarget) => Promise<T>): Promise<T> {
    const target: ReplyTarget = { scope: 'c2c', targetId: owner };
    const replyTo = lastMsgId;
    if (replyTo && passiveRefused !== replyTo) {
      try {
        return await send({ ...target, msgId: replyTo });
      } catch (err) {
        if (!refused(err)) throw err; // it may have arrived; do not send it twice
        passiveRefused = replyTo;
      }
    }
    return send(target);
  }

  /** One part to the owner. */
  async function sendToOwner(b: QQBot, owner: string, text: string): Promise<string> {
    return (await passive(owner, (t) => b.sendText(t, text))).id;
  }

  function explainSendFailure(err: unknown, sent: number, total: number): string {
    const reason = refused(err)
      ? `QQ refused the message: ${detailOf(err)}. QQ bots can answer only for a while after the owner's last message, and only a few times; that reopens when the owner writes on QQ. Reach the owner on another platform meanwhile.`
      : `QQ could not send the message: ${detailOf(err)}`;
    return sent > 0 ? `${reason} (${sent} of ${total} parts had already been delivered.)` : reason;
  }

  async function deliver(text: string): Promise<ChatSendResult> {
    if (!secret) return { ok: false, error: NOT_SIGNED_IN };
    if (!bot) return { ok: false, error: lastError ?? NOT_SIGNED_IN };
    if (gatewayRefusal) return { ok: false, error: `${gatewayRefusal} Reach the owner on another platform.` };
    if (!ownerOpenid) return { ok: false, error: NO_CONVERSATION };
    const parts = splitMessage(text, CHUNK);
    const ids: string[] = [];
    for (const part of parts) {
      try {
        ids.push(await sendToOwner(bot, ownerOpenid, part));
      } catch (err) {
        return { ok: false, error: explainSendFailure(err, ids.length, parts.length) };
      }
    }
    return { ok: true, messageIds: ids };
  }

  async function closeChoices(host: Host<QqConfig>): Promise<void> {
    openChoices = null;
    await host.kv.delete('choices');
  }

  /** Whether a reply may be shown while it is written: QQ streams only a reply to a recent private message. */
  function canPreview(): boolean {
    return bot !== null && !gatewayRefusal && ownerOpenid !== null && lastMsgId !== null && passiveRefused !== lastMsgId && Date.now() - lastMsgAt < STREAM_WINDOW_MS;
  }

  function draft(host: Host<QqConfig>, d: ChatDraftParams): void {
    let p = previews.get(d.callId);
    if (d.state === 'discarded') {
      if (!p) return;
      previews.delete(d.callId);
      const gone = p;
      // A stream message cannot be deleted: rewrite it, and close it.
      gone.work = gone.work.then(async () => {
        if (!gone.shown || gone.broken) return gone.session.cancel();
        try {
          await gone.session.update(WITHDRAWN);
          await gone.session.complete();
        } catch (err) {
          host.log.warn('could not withdraw a QQ preview', { err: detailOf(err) });
        }
      });
      return;
    }
    if (!p) {
      if (!canPreview() || !bot || !ownerOpenid || !lastMsgId) return;
      p = { session: bot.openStream({ target: { scope: 'c2c', targetId: ownerOpenid, msgId: lastMsgId }, throttleMs: 500 }), shown: false, broken: false, work: Promise.resolve() };
      previews.set(d.callId, p);
    }
    const live = p;
    const text = d.text.slice(0, CHUNK);
    if (live.broken || text.trim() === '') return;
    live.work = live.work.then(async () => {
      if (live.broken) return;
      try {
        live.shown = true;
        await live.session.update(text);
      } catch (err) {
        // QQ would not stream this (no permission, window closed): the reply comes whole instead.
        live.broken = true;
        live.session.cancel();
        host.log.warn('QQ refused a streamed preview; the reply will be sent whole', { err: detailOf(err) });
      }
    });
  }

  /** The options after the text: buttons for one choice when QQ takes them, a numbered list otherwise. */
  async function sendChoices(b: QQBot, owner: string, c: ChatChoices, lead: string | null): Promise<{ id: string; buttons: boolean }> {
    if (!c.multiple) {
      // One try only: a refusal here may be about the buttons, not the reply, so it must not count against replying.
      const replyTo = lastMsgId && passiveRefused !== lastMsgId ? lastMsgId : undefined;
      try {
        const id = (await b.sendTextWithKeyboard({ scope: 'c2c', targetId: owner, ...(replyTo ? { msgId: replyTo } : {}) }, lead ?? '请选择：', keyboardOf(c))).id;
        return { id, buttons: true };
      } catch (err) {
        if (!refused(err)) throw err;
        // Buttons need a permission many bots do not have: the list works everywhere.
      }
    }
    const id = await sendToOwner(b, owner, lead ? `${lead}\n\n${numbered(c)}` : numbered(c));
    return { id, buttons: false };
  }

  /** A `chat_send`: the text (finishing its preview when there is one), then the pictures, then the options. */
  async function reply(host: Host<QqConfig>, req: ChatSendParams): Promise<ChatSendResult> {
    inbox?.sentOther();
    const p = req.callId ? previews.get(req.callId) : undefined;
    if (req.callId) previews.delete(req.callId);
    if (p) await p.work;
    if (!req.images?.length && !req.choices) {
      if (!p || !p.shown || p.broken) {
        p?.session.cancel();
        return deliver(req.text);
      }
    }
    if (!secret) return { ok: false, error: NOT_SIGNED_IN };
    if (!bot) return { ok: false, error: lastError ?? NOT_SIGNED_IN };
    if (gatewayRefusal) return { ok: false, error: `${gatewayRefusal} Reach the owner on another platform.` };
    if (!ownerOpenid) return { ok: false, error: NO_CONVERSATION };
    const b = bot;
    const owner = ownerOpenid;
    const parts = splitMessage(req.text, CHUNK);
    const total = parts.length + (req.images?.length ?? 0) + (req.choices ? 1 : 0);
    const ids: string[] = [];
    try {
      let i = 0;
      if (p && p.shown && !p.broken) {
        try {
          await p.session.update(parts[0] as string);
          const done = await p.session.complete();
          ids.push(done?.id ?? `stream:${req.callId}`);
          i = 1;
        } catch (err) {
          // The preview may stay as it was: the reply still goes out whole.
          host.log.warn('could not finish a QQ preview; sending the reply as a message', { err: detailOf(err) });
        }
      } else p?.session.cancel();
      // With options and no pictures, the last part of the text carries them.
      const carry = req.choices && !req.images?.length && i < parts.length ? (parts.pop() as string) : null;
      for (; i < parts.length; i++) ids.push(await sendToOwner(b, owner, parts[i] as string));
      for (const img of req.images ?? []) {
        const { data } = await host.blobs.get(img.handle);
        const sent = await passive(owner, (t) => b.sendImage(t, { buffer: data }));
        ids.push(sent.message?.id ?? sent.upload.file_uuid);
      }
      if (req.choices) {
        const r = await sendChoices(b, owner, req.choices, carry);
        ids.push(r.id);
        openChoices = { callId: req.callId ?? r.id, labels: req.choices.options.map((o) => o.label), multiple: req.choices.multiple === true, ...(r.buttons ? { messageId: r.id } : {}) };
        await host.kv.set('choices', openChoices);
      }
    } catch (err) {
      return { ok: false, error: explainSendFailure(err, ids.length, total) };
    }
    return { ok: true, messageIds: ids };
  }

  /** A button pressed under options: from the owner and on the newest options, it answers them. */
  async function pressed(host: Host<QqConfig>, b: QQBot, e: InteractionEvent): Promise<void> {
    const ack = (code: number): Promise<void> => b.acknowledgeInteraction(e.id, code).catch((err: unknown) => host.log.warn('could not acknowledge a QQ button', { err: detailOf(err) }));
    const data = e.data?.resolved?.button_data ?? '';
    const m = /^choice:(\d+)$/.exec(data);
    const approval = parseApprovalButton(data);
    if (!m && !approval) return ack(ACK_FAILED);
    const user = e.user_openid ?? e.group_member_openid;
    if (e.group_openid || !user || (await host.owner.resolve(`qq:${user}`)) !== 'owner') return ack(ACK_NO_PERMISSION);
    if (approval) {
      // The host checks the owner again and that the request is still open; a stale press just fails.
      const r = await inboxOf(host).press(`qq:${user}`, data);
      if (!r?.ok) host.log.info('dropped a press on an approval request that is no longer open', { approval: approval.id });
      return ack(r?.ok ? ACK_OK : ACK_FAILED);
    }
    if (!m) return ack(ACK_FAILED);
    const asked = openChoices;
    const index = Number(m[1]);
    const label = asked?.labels[index];
    const message = e.data.resolved.message_id;
    // Only the buttons of the newest options: a numbered list has none, and an older message's buttons are stale.
    if (!asked?.messageId || label === undefined || (message && message !== asked.messageId)) {
      host.log.info('dropped a press on options that are no longer open', { index });
      return ack(ACK_FAILED);
    }
    await ack(ACK_OK);
    await closeChoices(host);
    await host.events.push({
      ts: isoOf(e.timestamp),
      senderKey: `qq:${user}`,
      dedupeKey: `press:${e.id}`,
      meta: { kind: 'c2c', openid: user, interaction: e.id, ...chatAnswer(asked.callId, [label]) },
      type: CHAT_MESSAGE_EVENT,
      level: 1,
      trigger: 'flush',
      text: `Message from owner in private chat (pressed a button), choosing from the options:\n${label}`,
    });
  }

  /** Short notices to the owner (answers to commands). A closed window only costs the notice. */
  async function tell(host: Host<QqConfig>, text: string): Promise<void> {
    inbox?.sentOther();
    const r = await deliver(text);
    if (!r.ok) host.log.warn('could not answer the owner on QQ', { err: r.error });
  }

  const groupReply: PluginTool<{ message_id: string; text: string }, QqConfig> = {
    name: 'qq_group_reply',
    description: 'Answer a QQ group message that mentioned the bot, in that group. message_id is the "msg" id of the qq.message event. Everyone in the group reads the answer.',
    approval: { title: { zh: '在 QQ 群里回复', en: 'Reply in a QQ group' }, target: 'text', fields: { message_id: { zh: '回复的消息', en: 'Answering message' } } },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message_id', 'text'],
      properties: {
        message_id: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1, maxLength: 20_000 },
      },
    },
    flags: { sideEffect: true },
    handler: async (i) => {
      const group = groupMessages.get(i.message_id);
      if (!group) return { text: `There is no group message ${i.message_id} to answer: only group messages that mentioned the bot since the qq plugin last started can be answered.`, failed: true };
      if (!bot || gatewayRefusal) return { text: gatewayRefusal ?? lastError ?? NOT_SIGNED_IN, failed: true };
      const parts = splitMessage(i.text, CHUNK);
      let sent = 0;
      for (const part of parts) {
        try {
          await bot.sendText({ scope: 'group', targetId: group, msgId: i.message_id }, part);
          sent++;
        } catch (err) {
          const why = refused(err)
            ? `QQ refused the group message: ${detailOf(err)}. A group message can be answered only for a few minutes and a few times.`
            : `QQ could not send the group message: ${detailOf(err)}`;
          return { text: sent > 0 ? `${why} (${sent} of ${parts.length} parts had already been delivered.)` : why, failed: true };
        }
      }
      return `answered message ${i.message_id} in QQ group ${group}`;
    },
  };

  function loginOf(host: Host<QqConfig>): QrBind {
    login ??= new QrBind({
      bindBase: host.config.bindBase ?? DEFAULT_BIND_BASE,
      pollMs: opts.bindPollMs ?? 2000,
      resting: () => (secret && appId ? { state: 'connected', account: appId } : { state: 'idle' }),
      onConfirmed: async (r) => {
        // Nothing of the old bot may be handled after this point.
        await disconnect();
        for (const key of STATE_KEYS) await host.kv.delete(key);
        await host.kv.set('signIn', { appId: r.appId, secretSha256: sha256(r.appSecret) } satisfies SignIn);
        if (r.userOpenid) await host.kv.set('ownerOpenid', r.userOpenid);
        await host.login.complete({ secrets: { [SECRET]: r.appSecret }, ...(r.userOpenid ? { ownerSenderKey: `qq:${r.userOpenid}` } : {}) });
        return r.appId;
      },
    });
    return login;
  }

  return definePlugin<QqConfig>({
    displayName: 'QQ',
    async start(host) {
      stop = new AbortController();
      queue = Promise.resolve();
      connected = false;
      lastError = null;
      gatewayRefusal = null;
      passiveRefused = null;
      groupMessages.clear();
      appId = null;
      ownerOpenid = null;
      lastMsgId = null;
      lastMsgAt = 0;
      openChoices = null;
      previews.clear();
      session = null;
      const sdkLog = (msg: string): void => host.log.warn(msg);
      secret = host.secret(SECRET) ?? null;
      if (!secret) {
        // Signed out: nothing of the old bot may be used by the next one.
        for (const key of STATE_KEYS) await host.kv.delete(key);
        host.log.info('not signed in; waiting for a QR sign-in from the console');
        return;
      }
      const signIn = await host.kv.get<SignIn>('signIn');
      if (signIn?.secretSha256 === sha256(secret)) appId = signIn.appId;
      else {
        // Set up by hand, or the secret was replaced by hand: the openids of another bot mean nothing here.
        if (signIn) for (const key of STATE_KEYS) await host.kv.delete(key);
        appId = host.config.appId?.trim() || null;
      }
      if (!appId) {
        lastError = NO_APP_ID;
        host.log.warn(NO_APP_ID);
        return;
      }
      ownerOpenid = (await host.kv.get<string>('ownerOpenid')) ?? null;
      lastMsgId = (await host.kv.get<string>('lastMsgId')) ?? null;
      openChoices = (await host.kv.get<OpenChoices>('choices')) ?? null;
      session = (await host.kv.get<PersistedSession>('session')) ?? null;
      const b = new QQBot({
        appId,
        appSecret: secret,
        ...(host.config.apiBase ? { baseUrl: host.config.apiBase } : {}),
        ...(host.config.tokenBase ? { tokenBaseUrl: host.config.tokenBase } : {}),
        // Its info and debug lines carry message bodies; its errors include every reconnect, so they are warnings here.
        logger: { info: () => undefined, debug: () => undefined, warn: sdkLog, error: sdkLog },
        // A restart resumes the session, so QQ replays what arrived meanwhile.
        sessionPersistence: {
          load: () => session,
          save: (s) => {
            session = s;
            void host.kv.set('session', s).catch(() => undefined);
          },
          clear: () => {
            session = null;
            void host.kv.delete('session').catch(() => undefined);
          },
        },
      });
      b.use(contentSanitizer({ parseFaceTags: true }));
      const up = (): void => {
        connected = true;
        lastError = null;
        void host.kv.delete('refusedAt').catch(() => undefined);
      };
      b.on('ready', up);
      b.on('resumed', up);
      b.on('disconnected', (e) => {
        connected = false;
        lastError = `disconnected (close code ${e.code}${e.reason ? `: ${e.reason}` : ''}); reconnecting`;
      });
      b.on('message', (_ctx, m) => {
        queue = queue.then(() => handle(host, m)).catch((err: unknown) => host.log.error('could not handle a QQ message', { messageId: m.messageId, err: errorText(err) }));
        return queue;
      });
      b.on('interaction', (_ctx, e) => {
        queue = queue.then(() => pressed(host, b, e)).catch((err: unknown) => host.log.error('could not handle a QQ button press', { err: errorText(err) }));
        return queue;
      });
      bot = b;
      loop = run(host, b);
    },
    async stop() {
      await disconnect();
    },
    chat: {
      send: (host, req) => reply(host, req),
      draft: (host, d) => draft(host, d),
    },
    tools: (host) => (host.config.groups === true ? [groupReply] : []),
    envPromptVars: (host) => ({ signedIn: bot !== null, groups: host.config.groups === true, groupsStored: host.config.groups !== true }),
    async onApprovalRequest(host, req) {
      const box = inboxOf(host);
      const msg = box.message(req);
      const b = bot;
      const owner = ownerOpenid;
      if (b && secret && !gatewayRefusal && owner) {
        // Buttons first. One try only: a refusal may be about the buttons (many bots may not send them), not the message.
        const replyTo = lastMsgId && passiveRefused !== lastMsgId ? lastMsgId : undefined;
        try {
          const id = (await b.sendTextWithKeyboard({ scope: 'c2c', targetId: owner, ...(replyTo ? { msgId: replyTo } : {}) }, msg.text.slice(0, CHUNK), approvalKeyboard(msg))).id;
          box.shown(req.id, id);
          return { delivered: true };
        } catch (err) {
          if (!refused(err)) host.log.warn('could not send an approval request with buttons', { err: detailOf(err) });
        }
      }
      // Words work everywhere.
      const r = await deliver(`${msg.text.slice(0, CHUNK - 200)}\n${msg.hint}`);
      if (!r.ok) {
        box.dropped(req.id);
        return { delivered: false };
      }
      box.shown(req.id, r.messageIds?.[0]);
      return { delivered: true };
    },
    onApprovalResolved(host, p) {
      // QQ cannot edit a message: a pressed button already shows the outcome, and a late press is refused.
      inboxOf(host).resolved(p.id);
    },
    health() {
      // Waiting for an operator is not a fault: no warning every 30 s while nobody has scanned yet.
      if (!secret) return { ok: true, detail: 'not signed in' };
      if (gatewayRefusal) return { ok: false, detail: gatewayRefusal };
      if (!bot) return { ok: false, detail: lastError ?? NO_APP_ID };
      return connected ? { ok: true } : { ok: false, detail: lastError ?? 'connecting to the QQ gateway' };
    },
    login: {
      start: (host) => loginOf(host).start(),
      status: (host) => loginOf(host).status(),
      submit: (host) => loginOf(host).submit(),
      cancel: (host) => loginOf(host).cancel(),
    },
  });
}
