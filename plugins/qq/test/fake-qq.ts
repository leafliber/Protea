import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface RecordedCall {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface SentMessage {
  scope: 'c2c' | 'group';
  target: string;
  content: string;
  msgId: string | undefined;
  msgType: number;
  /** The upload a media message refers to. */
  fileInfo?: string;
  keyboard?: { content: { rows: Array<{ buttons: Array<{ id: string; render_data: { label: string }; action: { data: string } }> }> } };
}

/** One answer of poll_bind_result: a status, or a finished bind whose secret the fake seals to the task's key. */
export type BindStep = { status: number } | { complete: { appId: string; appSecret: string; userOpenid?: string } } | { raw: Record<string, unknown> };

/** How poll_bind_result seals the AppSecret: AES-256-GCM, base64 of IV + ciphertext + tag. */
export function sealSecret(plain: string, keyBase64: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

/**
 * Just enough of the QQ bot platform for tests: the q.qq.com bind service (create_bind_task,
 * poll_bind_result), the access-token service, the REST API (gateway URL, C2C and group
 * messages), the WebSocket gateway (HELLO, IDENTIFY/RESUME, READY, heartbeats, dispatch) and a
 * picture host.
 */
export class FakeQq {
  readonly calls: RecordedCall[] = [];
  readonly sent: SentMessage[] = [];
  /** Answers of poll_bind_result, consumed in order; then PENDING. */
  readonly bindScript: BindStep[] = [];
  /** appId → the AppSecret the token service accepts. */
  readonly apps = new Map<string, string>();
  /** Answers of the message endpoints, consumed in order; then success. */
  readonly sendResults: Array<{ status: number; body: Record<string, unknown> }> = [];
  /** What the picture host serves, by path. */
  readonly images = new Map<string, Buffer>();
  /** Pictures uploaded for messages: who for, and the bytes. */
  readonly uploads: Array<{ target: string; fileType: number; data: Buffer; fileInfo: string }> = [];
  /** Frames of C2C stream messages, in order. */
  readonly streamFrames: Array<Record<string, unknown>> = [];
  /** Answers of the stream endpoint, consumed in order; then success. */
  readonly streamResults: Array<{ status: number; body: Record<string, unknown> }> = [];
  /** Answers of the message endpoint for messages with buttons, consumed in order; then success. */
  readonly keyboardResults: Array<{ status: number; body: Record<string, unknown> }> = [];
  /** Acknowledged button presses. */
  readonly acks: Array<{ id: string; code: number }> = [];
  /** IDENTIFY and RESUME frames, in order. */
  readonly handshakes: Array<{ op: number; d: Record<string, unknown> }> = [];
  /** Answer IDENTIFY and RESUME by closing with this code, as QQ does for a bot it will not serve. */
  refuseWith: number | null = null;
  private readonly tasks = new Map<string, string>();
  private readonly sockets = new Set<WebSocket>();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private seq = 0;
  private nextId = 1;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (ws) => this.accept(ws));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    return this.url;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((c) => c.path.split('?')[0] === path);
  }

  /** Sessions that completed IDENTIFY or RESUME and are still open. */
  get online(): number {
    return [...this.sockets].filter((ws) => (ws as WebSocket & { ready?: boolean }).ready).length;
  }

  /** The owner (or anyone) writes to the bot in private. Returns the message id. */
  c2c(m: { from: string; text?: string; id?: string; attachments?: Array<Record<string, unknown>>; quoted?: string }): string {
    const id = m.id ?? `c2c-${this.nextId++}`;
    this.dispatch('C2C_MESSAGE_CREATE', {
      id,
      author: { id: m.from, user_openid: m.from },
      content: m.text ?? '',
      timestamp: new Date().toISOString(),
      ...(m.attachments ? { attachments: m.attachments } : {}),
      ...(m.quoted !== undefined ? { message_type: 103, msg_elements: [{ msg_idx: 'REFIDX_1', content: m.quoted }] } : {}),
    });
    return id;
  }

  /** A group message; `at` (default true) means it mentions the bot. Returns the message id. */
  group(m: { group: string; from: string; text: string; at?: boolean; id?: string }): string {
    const id = m.id ?? `grp-${this.nextId++}`;
    this.dispatch(m.at === false ? 'GROUP_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE', {
      id,
      author: { id: m.from, member_openid: m.from },
      content: ` ${m.text}`,
      timestamp: new Date().toISOString(),
      group_id: m.group,
      group_openid: m.group,
    });
    return id;
  }

  /** Someone presses a button under a message. Returns the interaction id. */
  press(m: { from: string; data: string; messageId?: string; group?: string }): string {
    const id = `int-${this.nextId++}`;
    this.dispatch('INTERACTION_CREATE', {
      id,
      type: 11,
      chat_type: m.group ? 1 : 2,
      timestamp: new Date().toISOString(),
      version: 1,
      ...(m.group ? { group_openid: m.group, group_member_openid: m.from } : { user_openid: m.from }),
      data: { type: 11, resolved: { button_data: m.data, button_id: 'b', ...(m.messageId ? { message_id: m.messageId } : {}) } },
    });
    return id;
  }

  /** Close every gateway connection, e.g. with 4914 (the bot is offline or sandbox-only). */
  closeAll(code: number, reason = ''): void {
    for (const ws of this.sockets) ws.close(code, reason);
  }

  private dispatch(t: string, d: Record<string, unknown>): void {
    const frame = JSON.stringify({ op: 0, s: ++this.seq, t, id: `evt-${this.seq}`, d });
    for (const ws of this.sockets) if ((ws as WebSocket & { ready?: boolean }).ready) ws.send(frame);
  }

  private accept(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('message', (raw) => {
      const p = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (p.op === 1) return ws.send(JSON.stringify({ op: 11 }));
      if (p.op !== 2 && p.op !== 6) return;
      this.handshakes.push(p);
      if (this.refuseWith !== null) return ws.close(this.refuseWith, 'refused');
      (ws as WebSocket & { ready?: boolean }).ready = true;
      ws.send(JSON.stringify(p.op === 2
        ? { op: 0, s: ++this.seq, t: 'READY', d: { version: 1, session_id: `session-${this.handshakes.length}`, user: { id: 'bot-1', username: 'bot', bot: true }, shard: [0, 1] } }
        : { op: 0, s: ++this.seq, t: 'RESUMED', d: '' }));
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    this.calls.push({ method: req.method ?? 'GET', path: url, headers: req.headers, body });
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/lite/create_bind_task') {
      const taskId = `task-${this.tasks.size + 1}`;
      this.tasks.set(taskId, String(body['key']));
      return json(200, { retcode: 0, msg: 'success', data: { task_id: taskId } });
    }
    if (path === '/lite/poll_bind_result') {
      const key = this.tasks.get(String(body['task_id']));
      const empty = { bot_appid: '0', bot_encrypt_secret: '', user_openid: '' };
      if (key === undefined) return json(200, { retcode: 0, msg: 'success', data: { status: 3, ...empty } });
      const step = this.bindScript.shift() ?? { status: 1 };
      if ('status' in step) return json(200, { retcode: 0, msg: 'success', data: { status: step.status, ...empty } });
      if ('raw' in step) return json(200, { retcode: 0, msg: 'success', data: step.raw });
      const { appId, appSecret, userOpenid } = step.complete;
      return json(200, { retcode: 0, msg: 'success', data: { status: 2, bot_appid: appId, bot_encrypt_secret: sealSecret(appSecret, key), user_openid: userOpenid ?? '' } });
    }
    if (path === '/app/getAppAccessToken') {
      const appId = String(body['appId']);
      if (this.apps.get(appId) !== body['clientSecret']) return json(401, { code: 100016, message: 'invalid appid or secret' });
      return json(200, { access_token: `access-${appId}`, expires_in: '7200' });
    }
    if (path.startsWith('/img/')) {
      const img = this.images.get(path);
      if (!img) return json(404, { message: 'not found' });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(img);
      return;
    }
    if (!String(req.headers['authorization'] ?? '').startsWith('QQBot access-')) return json(401, { code: 11244, message: 'token not exist or expire' });
    if (path === '/gateway') return json(200, { url: `${this.url.replace('http', 'ws')}/ws` });
    const files = /^\/v2\/(users|groups)\/([^/]+)\/files$/.exec(path);
    if (files && req.method === 'POST') {
      const fileInfo = `fi-${this.uploads.length + 1}`;
      this.uploads.push({ target: decodeURIComponent(files[2] as string), fileType: Number(body['file_type']), data: Buffer.from(String(body['file_data'] ?? ''), 'base64'), fileInfo });
      return json(200, { file_uuid: `fu-${this.uploads.length}`, file_info: fileInfo, ttl: 3600 });
    }
    const stream = /^\/v2\/users\/([^/]+)\/stream_messages$/.exec(path);
    if (stream && req.method === 'POST') {
      const result = this.streamResults.shift();
      if (result && result.status !== 200) return json(result.status, result.body);
      this.streamFrames.push(body);
      const id = typeof body['stream_msg_id'] === 'string' ? body['stream_msg_id'] : `stm-${this.streamFrames.filter((f) => f['index'] === 0).length}`;
      return json(200, { id, timestamp: Math.floor(Date.now() / 1000) });
    }
    const press = /^\/interactions\/([^/]+)$/.exec(path);
    if (press && req.method === 'PUT') {
      this.acks.push({ id: decodeURIComponent(press[1] as string), code: Number(body['code']) });
      return json(200, {});
    }
    const m = /^\/v2\/(users|groups)\/([^/]+)\/messages$/.exec(path);
    if (m && req.method === 'POST') {
      const result = body['keyboard'] ? (this.keyboardResults.shift() ?? this.sendResults.shift()) : this.sendResults.shift();
      if (result && result.status !== 200) return json(result.status, result.body);
      this.sent.push({
        scope: m[1] === 'users' ? 'c2c' : 'group',
        target: decodeURIComponent(m[2] as string),
        content: String(body['content'] ?? ''),
        msgId: typeof body['msg_id'] === 'string' ? body['msg_id'] : undefined,
        msgType: Number(body['msg_type'] ?? 0),
        ...(body['media'] ? { fileInfo: String((body['media'] as { file_info: string }).file_info) } : {}),
        ...(body['keyboard'] ? { keyboard: body['keyboard'] as NonNullable<SentMessage['keyboard']> } : {}),
      });
      return json(200, { id: `out-${this.sent.length}`, timestamp: Math.floor(Date.now() / 1000) });
    }
    json(404, { message: `no route ${req.method} ${path}` });
  }
}
