import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SentMessage {
  chat_id: number | string;
  text: string;
  message_id: number;
  reply_parameters?: { message_id: number };
}

/**
 * Just enough of the Telegram Bot API for tests: getMe, long-polling getUpdates,
 * sendMessage and setMessageReaction, with a way to inject incoming messages.
 */
export class FakeTelegram {
  readonly sent: SentMessage[] = [];
  readonly reactions: Array<Record<string, unknown>> = [];
  readonly calls: string[] = [];
  private updates: Array<{ update_id: number; message: Record<string, unknown> }> = [];
  private waiters: Array<() => void> = [];
  private nextUpdate = 100;
  private nextMessage = 5000;
  private server: http.Server | null = null;
  /** Fail this many getUpdates calls with HTTP 502 (outage simulation). */
  failPolls = 0;

  constructor(readonly token = 'test-token') {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters.splice(0)) w();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Queue an incoming text message. Returns its update id. */
  inject(m: { fromId: number; chatId?: number; chatType?: string; title?: string; text: string; username?: string; replyToFrom?: number }): number {
    const id = this.nextUpdate++;
    this.updates.push({
      update_id: id,
      message: {
        message_id: this.nextMessage++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: m.chatId ?? m.fromId, type: m.chatType ?? 'private', ...(m.title ? { title: m.title } : {}) },
        from: { id: m.fromId, is_bot: false, first_name: 'User', ...(m.username ? { username: m.username } : {}) },
        text: m.text,
        ...(m.replyToFrom ? { reply_to_message: { message_id: 1, date: 0, chat: { id: m.chatId }, from: { id: m.replyToFrom, is_bot: true } } } : {}),
      },
    });
    for (const w of this.waiters.splice(0)) w();
    return id;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const params = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const reply = (status: number, body: unknown): void => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!match || match[1] !== this.token) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = match[2] as string;
    this.calls.push(method);
    switch (method) {
      case 'getMe':
        return reply(200, { ok: true, result: { id: 999, is_bot: true, first_name: 'Protea', username: 'protea_bot' } });
      case 'getUpdates': {
        if (this.failPolls > 0) {
          this.failPolls--;
          return reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' });
        }
        const offset = Number(params['offset'] ?? 0);
        const timeout = Number(params['timeout'] ?? 0);
        const ready = () => this.updates.filter((u) => u.update_id >= offset);
        if (ready().length === 0 && timeout > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Math.min(timeout, 2) * 1000);
            this.waiters.push(() => (clearTimeout(t), resolve()));
            req.on('close', () => (clearTimeout(t), resolve()));
          });
        }
        return reply(200, { ok: true, result: ready() });
      }
      case 'sendMessage': {
        const m: SentMessage = {
          chat_id: params['chat_id'] as number,
          text: String(params['text']),
          message_id: this.nextMessage++,
          ...(params['reply_parameters'] ? { reply_parameters: params['reply_parameters'] as { message_id: number } } : {}),
        };
        this.sent.push(m);
        return reply(200, { ok: true, result: { message_id: m.message_id, date: 0, chat: { id: m.chat_id, type: 'private' } } });
      }
      case 'setMessageReaction':
        this.reactions.push(params);
        return reply(200, { ok: true, result: true });
      default:
        return reply(404, { ok: false, error_code: 404, description: `unknown method ${method}` });
    }
  }
}
