import crypto from 'node:crypto';
import {
  DEFAULT_STOP_WORDS,
  approvalCommand,
  definePlugin,
  isModeCommand,
  isStopWord,
  modeCommand,
  splitMessage,
  type Host,
  type PluginDefinition,
  type PluginTool,
} from '@protea/plugin-sdk';
import { CHAT_MESSAGE_EVENT, type ChatSendResult, type EventInput } from '@protea/protocol';
import { ApiError, GatewayError, GatewayErrorCode, QQBot, contentSanitizer, type QQBotInboundMessage, type ReplyTarget } from '@tencent-connect/qqbot-nodejs';
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
const STATE_KEYS = ['signIn', 'ownerOpenid', 'lastMsgId', 'session', 'refusedAt'];

const NOT_SIGNED_IN = 'QQ is not signed in: the operator has to scan the QR code (console: Plugins, qq, Sign-in; or "protea plugins login qq").';
const NO_APP_ID = 'QQ_APP_SECRET is set but the AppID is unknown: sign in with the QR code, or set plugins.qq.config.appId to the bot the secret belongs to.';
const NO_CONVERSATION = 'QQ bots cannot start a conversation: the owner has to write to the bot on QQ first. Reach the owner on another platform.';

interface SignIn {
  appId: string;
  /** Which secret this AppID came with: a secret replaced by hand falls back to config.appId. */
  secretSha256: string;
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
    passiveRefused = null;
    await host.kv.set('lastMsgId', id);
    if (ownerOpenid !== sender) {
      ownerOpenid = sender;
      await host.kv.set('ownerOpenid', sender);
    }
    const command = m.content.trim();
    const answer = await approvalCommand(host, senderKey, command);
    if (answer !== null) return tell(host, answer);
    if (isModeCommand(command)) return tell(host, await modeCommand(host, senderKey, command));
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

  /** One part to the owner: a reply to their newest message while QQ takes it, else a message of its own. */
  async function sendToOwner(b: QQBot, owner: string, text: string): Promise<string> {
    const target: ReplyTarget = { scope: 'c2c', targetId: owner };
    const replyTo = lastMsgId;
    if (replyTo && passiveRefused !== replyTo) {
      try {
        return (await b.sendText({ ...target, msgId: replyTo }, text)).id;
      } catch (err) {
        if (!refused(err)) throw err; // it may have arrived; do not send it twice
        passiveRefused = replyTo;
      }
    }
    return (await b.sendText(target, text)).id;
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

  /** Short notices to the owner (answers to commands). A closed window only costs the notice. */
  async function tell(host: Host<QqConfig>, text: string): Promise<void> {
    const r = await deliver(text);
    if (!r.ok) host.log.warn('could not answer the owner on QQ', { err: r.error });
  }

  const groupReply: PluginTool<{ message_id: string; text: string }, QqConfig> = {
    name: 'qq_group_reply',
    description: 'Answer a QQ group message that mentioned the bot, in that group. message_id is the "msg" id of the qq.message event. Everyone in the group reads the answer.',
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
      bot = b;
      loop = run(host, b);
    },
    async stop() {
      await disconnect();
    },
    chat: {
      send: (_host, req) => deliver(req.text),
    },
    tools: (host) => (host.config.groups === true ? [groupReply] : []),
    envPromptVars: (host) => ({ signedIn: bot !== null, groups: host.config.groups === true, groupsStored: host.config.groups !== true }),
    async onApprovalRequest(_host, req) {
      const text = `Approval ${req.id} requested: ${req.summary}${req.reason ? `\nReason: ${req.reason}` : ''}\nReply /approve ${req.id} or /deny ${req.id} (expires ${req.expiresAt}). /approve ${req.id} 1h also allows these tools for an hour.`;
      return { delivered: (await deliver(text.slice(0, CHUNK))).ok };
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
