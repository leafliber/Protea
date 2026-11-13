import crypto from 'node:crypto';
import { ApprovalInbox, DEFAULT_STOP_WORDS, definePlugin, isModeCommand, isStopWord, modeCommand, splitMessage, type Host, type PluginDefinition } from '@protea/plugin-sdk';
import { CHAT_MESSAGE_EVENT, type ChatSendResult, type EventInput } from '@protea/protocol';
import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
  MessageItemType,
  MessageType,
  STALE_TOKEN_ERRCODE,
  StreamingMarkdownFilter,
  downloadMediaFromItem,
  getRemainingPauseMs,
  getUpdates,
  getWeixinMessageId,
  isSessionPaused,
  notifyStart,
  notifyStop,
  pauseSession,
  prepareOfficialClient,
  sendMessageWeixin,
  weixinMessageToMsgContext,
  type MessageItem,
  type WeixinMessage,
} from './ilink.js';
import { QrLogin } from './login.js';

export interface WechatConfig {
  apiBase?: string;
  cdnBase?: string;
  stopWords?: string[];
}

export interface WechatPluginOptions {
  /** Pause between sign-in status requests (default 1 s, as in the official client). */
  loginPollMs?: number;
  /** Pause after a failed poll (default 2 s, as in the official client). */
  retryMs?: number;
}

export const TOKEN_SECRET = 'WECHAT_BOT_TOKEN';
const CHUNK = 4000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MS = 30_000;
/** A healthy long poll answers within this. */
const STALE_POLL_MS = 95_000;
const NOT_SIGNED_IN = 'WeChat is not signed in: the operator has to scan the QR code (console: Plugins, wechat, Sign-in; or "protea plugins login wechat").';
const WINDOW_CLOSED = 'WeChat refused the message: its reply window is closed (the owner has not written recently, or too many messages were sent since their last one). It reopens when the owner writes on WeChat; reach the owner on another platform meanwhile.';

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Stable across re-reads of the same message, whatever the service still sends for it. */
function dedupeKeyOf(m: WeixinMessage, id: string | undefined, from: string): string {
  if (id) return `msg:${id}`;
  if (m.seq !== undefined) return `seq:${from}:${m.seq}`;
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify([from, m.create_time_ms, m.item_list])).digest('hex')}`;
}

/**
 * The WeChat connector, built on the official @tencent-weixin/openclaw-weixin client: long-polls
 * the iLink bot channel, turns the owner's private messages into `chat.message` events and is the
 * `wechat` chat platform. Everything else is stored, not delivered. See docs/10-architecture/08-event-source-plugins.md.
 */
export function createWechatPlugin(opts: WechatPluginOptions = {}): PluginDefinition<WechatConfig> {
  let token: string | null = null;
  let baseUrl = DEFAULT_BASE_URL;
  let cdnBase = CDN_BASE_URL;
  let botId = 'unbound';
  let account: string | null = null;
  let ownerUserId: string | null = null;
  let contextToken: string | null = null;
  let cursor = '';
  let expiredNotified = false;
  let stop = new AbortController();
  let loop: Promise<void> | null = null;
  let lastPollAt = 0;
  let login: QrLogin | null = null;
  const retryMs = opts.retryMs ?? 2000;

  /** Told once per expiry: the pause repeats every hour for as long as the session stays dead. */
  async function sessionExpired(host: Host<WechatConfig>): Promise<void> {
    pauseSession(botId);
    if (expiredNotified) return;
    expiredNotified = true;
    await host.kv.set('sessionExpiredAt', new Date().toISOString());
    await host.events.push({
      ts: new Date().toISOString(),
      type: 'wechat.session_expired',
      level: 2,
      trigger: 'flush',
      text: 'WeChat reports that the bot session expired (errcode -14). Sending and receiving on WeChat are paused for an hour, then retried. If it stays down, the owner has to scan the QR code again (console: Plugins, wechat, Sign-in). Tell the owner on another platform.',
    });
  }

  async function explainSendFailure(host: Host<WechatConfig>, err: unknown, sent: number, total: number): Promise<string> {
    const message = err instanceof Error ? err.message : String(err);
    const ret = Number(/\bret=(-?\d+)/.exec(message)?.[1]);
    let reason: string;
    if (ret === STALE_TOKEN_ERRCODE) {
      await sessionExpired(host);
      reason = 'WeChat reports that the bot session expired.';
    } else if (ret === -2) reason = WINDOW_CLOSED;
    else reason = `WeChat could not send the message: ${message}`;
    return sent > 0 ? `${reason} (${sent} of ${total} parts had already been delivered.)` : reason;
  }

  async function deliver(host: Host<WechatConfig>, text: string): Promise<ChatSendResult> {
    if (!token) return { ok: false, error: NOT_SIGNED_IN };
    if (isSessionPaused(botId)) return { ok: false, error: `The WeChat session expired; retrying in ${Math.ceil(getRemainingPauseMs(botId) / 60_000)} min. Reach the owner on another platform.` };
    if (!ownerUserId || !contextToken) return { ok: false, error: 'WeChat bots cannot start a conversation: the owner has to write to the bot first. Reach the owner on another platform.' };
    const filter = new StreamingMarkdownFilter();
    const parts = splitMessage(filter.feed(text) + filter.flush(), CHUNK);
    const ids: string[] = [];
    for (const part of parts) {
      try {
        const sent = await sendMessageWeixin({ to: ownerUserId, text: part, opts: { baseUrl, token, contextToken } });
        ids.push(sent.serverMessageId ?? sent.messageId);
      } catch (err) {
        return { ok: false, error: await explainSendFailure(host, err, ids.length, parts.length) };
      }
    }
    return { ok: true, messageIds: ids };
  }

  /** Short notices to the owner (answers to commands). A closed window only costs the notice. */
  /** The approval requests shown here, and what the owner's words mean. WeChat has no buttons: the owner answers in words. */
  let inbox: ApprovalInbox<WechatConfig> | null = null;
  const inboxOf = (host: Host<WechatConfig>): ApprovalInbox<WechatConfig> => (inbox ??= new ApprovalInbox(host));

  async function tell(host: Host<WechatConfig>, text: string): Promise<void> {
    inbox?.sentOther();
    const r = await deliver(host, text);
    if (!r.ok) host.log.warn('could not answer the owner on WeChat', { err: r.error });
  }

  /** The owner's pictures, stored for the model; a failure leaves the message as text. */
  async function ownerImages(host: Host<WechatConfig>, m: WeixinMessage, id: string | undefined): Promise<{ blobs: NonNullable<EventInput['blobs']>; failed: boolean }> {
    const blobs: NonNullable<EventInput['blobs']> = [];
    let failed = false;
    for (const item of m.item_list ?? []) {
      if (item.type !== MessageItemType.IMAGE) continue;
      const saved = await downloadMediaFromItem(item, {
        cdnBaseUrl: cdnBase,
        label: 'wechat',
        log: () => undefined,
        errLog: () => undefined,
        saveMedia: async (buffer) => {
          const put = await host.blobs.put(buffer);
          blobs.push({ handle: put.handle, mime: put.mime, size: put.size });
          return { path: put.handle };
        },
      });
      if (!saved.decryptedPicPath) {
        failed = true;
        // Not the official error text: it can carry the key or the CDN address.
        host.log.warn('could not fetch the image of a message', { messageId: id });
      }
    }
    return { blobs, failed };
  }

  /**
   * The owner's voice as text. With speech-to-text set up, the recording itself (SILK, which the
   * host decodes): WeChat's own transcript is often wrong for speech that is not Mandarin. Without
   * it, or when that fails, WeChat's transcript.
   */
  async function ownerVoice(host: Host<WechatConfig>, item: MessageItem, id: string | undefined): Promise<string | null> {
    const platform = item.voice_item?.text?.trim() || null;
    if (!item.voice_item?.media || !(await host.speech.ready())) return platform;
    let audio: { data: Buffer; mime: string } | null = null;
    await downloadMediaFromItem(item, {
      cdnBaseUrl: cdnBase,
      label: 'wechat',
      log: () => undefined,
      errLog: () => undefined,
      saveMedia: async (buffer, contentType) => {
        audio = { data: buffer, mime: contentType ?? 'audio/silk' };
        return { path: 'memory' };
      },
    });
    const got = audio as { data: Buffer; mime: string } | null;
    if (!got) {
      host.log.warn('could not fetch a voice message; using WeChat\'s own text', { messageId: id });
      return platform;
    }
    const r = await host.speech.transcribe(got.data, got.mime);
    if (r.ok && r.text) return r.text;
    if (!r.ok) host.log.warn('could not transcribe a voice message; using WeChat\'s own text', { messageId: id, code: r.code, err: r.error });
    return platform;
  }

  async function handle(host: Host<WechatConfig>, m: WeixinMessage): Promise<void> {
    const from = m.from_user_id?.trim();
    if (m.message_type !== MessageType.USER || !from) return;
    const id = getWeixinMessageId(m);
    const { Body: body, ReplyToBody: quoted } = weixinMessageToMsgContext(m, botId);
    const voice = (m.item_list ?? []).find((i) => i.type === MessageItemType.VOICE);
    const said = (t: string | null | undefined): string => `[voice] ${t?.trim() || '(could not be transcribed)'}`;
    const quote = quoted ? `[quoted: ${quoted}]\n` : '';
    const text = `${quote}${voice ? said(voice.voice_item?.text) : body || '[unsupported message]'}`;
    const senderKey = `wechat:${from}`;
    const role = await host.owner.resolve(senderKey);
    const ref = id ? `msg ${id}` : 'no message id';
    const base: Pick<EventInput, 'ts' | 'senderKey' | 'dedupeKey' | 'correlation' | 'meta'> = {
      ts: new Date(m.create_time_ms ?? Date.now()).toISOString(),
      senderKey,
      dedupeKey: dedupeKeyOf(m, id, from),
      ...(id ? { correlation: id } : {}),
      meta: { fromUserId: from, ...(id ? { messageId: id } : {}), ...(m.group_id ? { groupId: m.group_id } : {}) },
    };
    if (m.group_id) {
      const who = role === 'owner' ? 'owner' : `user ${from}`;
      await host.events.push({ ...base, type: 'wechat.message', level: 4, trigger: 'store', text: `Message from ${who} in WeChat group ${m.group_id} (${ref}):\n${text}` });
      return;
    }
    if (role !== 'owner') {
      await host.events.push({ ...base, type: 'wechat.message', level: 4, trigger: 'store', text: `Message from user ${from} (not the owner) in private chat (${ref}):\n${text}` });
      return;
    }
    // The newest token is what lets the bot answer; keep it before anything can fail.
    if (m.context_token && m.context_token !== contextToken) {
      contextToken = m.context_token;
      await host.kv.set('contextToken', contextToken);
    }
    if (ownerUserId !== from) {
      ownerUserId = from;
      await host.kv.set('ownerUserId', from);
    }
    // Spoken words never answer an approval or change a mode: a misheard "yes" must not approve anything.
    if (!voice) {
      const answer = await inboxOf(host).reply(senderKey, text);
      if (answer !== null) return tell(host, answer);
      if (isModeCommand(text)) return tell(host, await modeCommand(host, senderKey, text));
    }
    const shown = voice ? `${quote}${said(await ownerVoice(host, voice, id))}` : text;
    const isStop = !voice && isStopWord(text, host.config.stopWords ?? DEFAULT_STOP_WORDS);
    const { blobs, failed } = await ownerImages(host, m, id);
    await host.events.push({
      ...base,
      ...(blobs.length > 0 ? { blobs } : {}),
      type: CHAT_MESSAGE_EVENT,
      level: 1,
      trigger: isStop ? 'interrupt' : 'flush',
      text: `Message from owner in private chat (${ref}):\n${shown}${failed ? '\n[the image could not be downloaded]' : ''}`,
    });
  }

  async function poll(host: Host<WechatConfig>): Promise<void> {
    await notifyStart({ baseUrl, token: token as string }).catch((err: Error) => host.log.warn('notifystart failed; polling anyway', { err: err.message }));
    let failures = 0;
    let timeoutMs: number | undefined;
    const failed = async (detail: string): Promise<void> => {
      failures++;
      const pause = failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : retryMs;
      if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
      host.log.warn('wechat poll failed; retrying', { err: detail, retryInMs: pause });
      await sleep(pause, stop.signal);
    };
    while (!stop.signal.aborted) {
      if (isSessionPaused(botId)) {
        await sleep(getRemainingPauseMs(botId), stop.signal);
        continue;
      }
      try {
        const resp = await getUpdates({ baseUrl, token: token as string, get_updates_buf: cursor, ...(timeoutMs !== undefined ? { timeoutMs } : {}), abortSignal: stop.signal });
        if (stop.signal.aborted) break;
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
        if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
          failures = 0;
          await sessionExpired(host);
          continue;
        }
        if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
          await failed(`ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`);
          continue;
        }
        failures = 0;
        lastPollAt = Date.now();
        if (expiredNotified) {
          expiredNotified = false;
          await host.kv.delete('sessionExpiredAt');
        }
        for (const m of resp.msgs ?? []) await handle(host, m);
        // After the events are stored: a crash re-reads the batch (deduplicated), never loses it.
        if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
          cursor = resp.get_updates_buf;
          await host.kv.set('cursor', cursor);
        }
      } catch (err) {
        if (stop.signal.aborted) break;
        await failed((err as Error).message);
      }
    }
  }

  async function stopPolling(): Promise<void> {
    stop.abort();
    await loop;
    loop = null;
  }

  function loginOf(host: Host<WechatConfig>): QrLogin {
    login ??= new QrLogin({
      apiBase: host.config.apiBase ?? DEFAULT_BASE_URL,
      pollMs: opts.loginPollMs ?? 1000,
      currentToken: () => token,
      resting: () => (token && account ? { state: 'connected', account } : { state: 'idle' }),
      onConfirmed: async (r) => {
        // Nothing of the old session may be written after this point.
        await stopPolling();
        const label = r.userId ?? r.botId;
        await host.kv.set('baseUrl', r.baseUrl);
        await host.kv.set('botId', r.botId);
        await host.kv.set('account', label);
        await (r.userId ? host.kv.set('ownerUserId', r.userId) : host.kv.delete('ownerUserId'));
        for (const key of ['cursor', 'contextToken', 'sessionExpiredAt']) await host.kv.delete(key);
        await host.login.complete({ secrets: { [TOKEN_SECRET]: r.token }, ...(r.userId ? { ownerSenderKey: `wechat:${r.userId}` } : {}) });
        return label;
      },
    });
    return login;
  }

  return definePlugin<WechatConfig>({
    displayName: '微信',
    async start(host) {
      prepareOfficialClient(host.dataDir);
      cdnBase = host.config.cdnBase ?? CDN_BASE_URL;
      baseUrl = (await host.kv.get<string>('baseUrl')) ?? host.config.apiBase ?? DEFAULT_BASE_URL;
      token = host.secret(TOKEN_SECRET) ?? null;
      stop = new AbortController();
      if (!token) {
        // Signed out: nothing of the old account may be used by the next one.
        for (const key of ['cursor', 'contextToken', 'ownerUserId', 'botId', 'account', 'baseUrl', 'sessionExpiredAt']) await host.kv.delete(key);
        baseUrl = host.config.apiBase ?? DEFAULT_BASE_URL;
        host.log.info('not signed in; waiting for a QR sign-in from the console');
        return;
      }
      botId = (await host.kv.get<string>('botId')) ?? 'unbound';
      account = (await host.kv.get<string>('account')) ?? null;
      ownerUserId = (await host.kv.get<string>('ownerUserId')) ?? null;
      contextToken = (await host.kv.get<string>('contextToken')) ?? null;
      cursor = (await host.kv.get<string>('cursor')) ?? '';
      expiredNotified = (await host.kv.get<string>('sessionExpiredAt')) !== undefined;
      loop = poll(host);
    },
    async stop() {
      await stopPolling();
      if (token) await notifyStop({ baseUrl, token, timeoutMs: 3000 }).catch(() => undefined);
    },
    chat: {
      send: (host, req) => {
        inbox?.sentOther();
        return deliver(host, req.text);
      },
    },
    envPromptVars: () => ({ signedIn: token !== null }),
    async onApprovalRequest(host, req) {
      const box = inboxOf(host);
      const msg = box.message(req);
      const r = await deliver(host, `${msg.text.slice(0, CHUNK - 200)}\n${msg.hint}`);
      if (!r.ok) {
        box.dropped(req.id);
        return { delivered: false };
      }
      box.shown(req.id, r.messageIds?.[0]);
      return { delivered: true };
    },
    onApprovalResolved(host, p) {
      inboxOf(host).resolved(p.id);
    },
    health() {
      // Waiting for an operator is not a fault: no warning every 30 s while nobody has scanned yet.
      if (!token) return { ok: true, detail: 'not signed in' };
      if (isSessionPaused(botId)) return { ok: false, detail: 'the WeChat session expired; waiting before retrying (scan the QR code again if it stays down)' };
      const age = Date.now() - lastPollAt;
      return lastPollAt > 0 && age < STALE_POLL_MS ? { ok: true } : { ok: false, detail: lastPollAt === 0 ? 'no successful poll yet' : `last successful poll ${Math.round(age / 1000)}s ago` };
    },
    login: {
      start: (host) => loginOf(host).start(),
      status: (host) => loginOf(host).status(),
      submit: (host, code) => loginOf(host).submit(code),
      cancel: (host) => loginOf(host).cancel(),
    },
  });
}
