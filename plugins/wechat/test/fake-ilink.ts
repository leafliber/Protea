import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface SentText {
  to: string;
  text: string;
  contextToken: string | undefined;
}

export type QrScript = Record<string, unknown>;

/** Encrypt the way the WeChat CDN stores media: AES-128-ECB with PKCS7 padding. */
export function encryptMedia(plain: Buffer, key: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

/**
 * Just enough of the iLink bot API and its CDN for tests: QR sign-in, long-polled getupdates with
 * a cursor, sendmessage, notifystart/notifystop and media download.
 */
export class FakeIlink {
  readonly calls: RecordedCall[] = [];
  readonly sent: SentText[] = [];
  /** Answers of get_qrcode_status, consumed in order; then "wait". */
  readonly qrScript: QrScript[] = [];
  /** Answers of sendmessage, consumed in order; then success. */
  readonly sendResults: Array<Record<string, unknown>> = [];
  /** What the CDN serves, by encrypted_query_param. */
  readonly cdn = new Map<string, Buffer>();
  /** Answer getupdates with this instead of messages. */
  pollError: Record<string, unknown> | null = null;
  /** Fail this many getupdates calls with HTTP 502. */
  failPolls = 0;
  private readonly messages: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];
  private nextMessage = 7000;
  private nextQr = 1;
  private server: http.Server | null = null;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    return this.url;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters.splice(0)) w();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  callsTo(suffix: string): RecordedCall[] {
    return this.calls.filter((c) => c.path.split('?')[0]?.endsWith(suffix));
  }

  /** Queue an incoming message. Returns its message id. */
  inject(m: { from: string; text?: string; contextToken?: string; groupId?: string; items?: Array<Record<string, unknown>>; messageId?: string; messageType?: number }): string {
    const id = m.messageId ?? String(this.nextMessage++);
    this.messages.push({
      seq: this.messages.length + 1,
      message_id: id,
      from_user_id: m.from,
      to_user_id: 'bot@im.bot',
      create_time_ms: Date.now(),
      message_type: m.messageType ?? 1,
      message_state: 2,
      context_token: m.contextToken ?? `ctx-${id}`,
      item_list: m.items ?? [{ type: 1, text_item: { text: m.text ?? '' } }],
      ...(m.groupId ? { group_id: m.groupId } : {}),
    });
    for (const w of this.waiters.splice(0)) w();
    return id;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const url = new URL(req.url ?? '/', 'http://x');
    this.calls.push({ path: `${url.pathname}${url.search}`, headers: req.headers, body });
    const reply = (status: number, value: unknown): void => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    switch (url.pathname) {
      case '/ilink/bot/get_bot_qrcode': {
        const n = this.nextQr++;
        return reply(200, { qrcode: `qr-${n}`, qrcode_img_content: `https://liteapp.example/q/${n}` });
      }
      case '/ilink/bot/get_qrcode_status':
        return reply(200, this.qrScript.shift() ?? { status: 'wait' });
      case '/ilink/bot/msg/notifystart':
      case '/ilink/bot/msg/notifystop':
        return reply(200, { ret: 0 });
      case '/ilink/bot/getupdates':
        return this.getUpdates(req, body, reply);
      case '/ilink/bot/sendmessage': {
        const msg = body['msg'] as { to_user_id: string; context_token?: string; item_list: Array<{ text_item: { text: string } }> };
        const result = this.sendResults.shift();
        if (result && result['ret'] !== 0) return reply(200, result);
        this.sent.push({ to: msg.to_user_id, text: msg.item_list[0]?.text_item.text ?? '', contextToken: msg.context_token });
        return reply(200, { ret: 0, message_id: String(this.nextMessage++), ...result });
      }
      case '/c2c/download': {
        const data = this.cdn.get(url.searchParams.get('encrypted_query_param') ?? '');
        res.writeHead(data ? 200 : 404);
        res.end(data);
        return;
      }
      default:
        return reply(404, { ret: -1 });
    }
  }

  private async getUpdates(req: http.IncomingMessage, body: Record<string, unknown>, reply: (status: number, value: unknown) => void): Promise<void> {
    if (this.failPolls > 0) {
      this.failPolls--;
      return reply(502, { ret: -1 });
    }
    if (this.pollError) return reply(200, this.pollError);
    const from = Number(/^buf-(\d+)$/.exec(String(body['get_updates_buf'] ?? ''))?.[1] ?? 0);
    if (this.messages.length <= from) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 150);
        this.waiters.push(() => (clearTimeout(t), resolve()));
        req.on('close', () => (clearTimeout(t), resolve()));
      });
    }
    reply(200, { ret: 0, msgs: this.messages.slice(from), get_updates_buf: `buf-${this.messages.length}`, longpolling_timeout_ms: 2000 });
  }
}
