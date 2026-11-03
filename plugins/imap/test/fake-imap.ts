import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FakeMessage {
  uid: number;
  raw: string;
  seen?: boolean;
}

/**
 * Just enough IMAP4rev1 for imapflow: LOGIN, LIST, SELECT/EXAMINE, UID SEARCH, UID FETCH
 * (UID, FLAGS, ENVELOPE, BODY[]), NOOP, IDLE with EXISTS pushes, LOGOUT. Plain TCP.
 */
export class FakeImap {
  readonly messages: FakeMessage[] = [];
  readonly commands: string[] = [];
  uidValidity = 1001;
  private uidNext = 1;
  private server: net.Server | null = null;
  private readonly sockets = new Set<{ socket: net.Socket; idleTag: string | null; known: number }>();

  constructor(
    readonly user = 'me@example.com',
    readonly pass = 'secret-pw',
  ) {}

  add(raw: string, seen = false): number {
    const uid = this.uidNext++;
    this.messages.push({ uid, raw: raw.replace(/\r?\n/g, '\r\n'), seen });
    for (const s of this.sockets) {
      if (s.idleTag) {
        s.socket.write(`* ${this.messages.length} EXISTS\r\n`);
        s.known = this.messages.length;
      }
    }
    return uid;
  }

  /** Drop every connection (the client should reconnect). */
  kick(): void {
    for (const s of this.sockets) s.socket.destroy();
  }

  async start(): Promise<number> {
    this.server = net.createServer((socket) => this.serve(socket));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.kick();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private serve(socket: net.Socket): void {
    const conn = { socket, idleTag: null as string | null, known: this.messages.length };
    this.sockets.add(conn);
    socket.on('close', () => this.sockets.delete(conn));
    socket.on('error', () => {});
    const caps = 'IMAP4rev1 IDLE UIDPLUS';
    socket.write(`* OK [CAPABILITY ${caps}] fake IMAP ready\r\n`);
    let buf = '';
    let authed = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (conn.idleTag) {
          if (line.trim().toUpperCase() === 'DONE') {
            socket.write(`${conn.idleTag} OK IDLE terminated\r\n`);
            conn.idleTag = null;
          }
          continue;
        }
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        const [, tag, cmdRaw, rest = ''] = m as unknown as [string, string, string, string];
        let cmd = cmdRaw.toUpperCase();
        let args = rest;
        if (cmd === 'UID') {
          const sp = rest.indexOf(' ');
          cmd = `UID ${rest.slice(0, sp).toUpperCase()}`;
          args = rest.slice(sp + 1);
        }
        this.commands.push(cmd);
        const ok = (text = 'done') => socket.write(`${tag} OK ${text}\r\n`);
        switch (cmd) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY ${caps}\r\n`);
            ok();
            break;
          case 'LOGIN': {
            const [u, p] = [...args.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] ?? x[2] ?? '').replace(/\\(.)/g, '$1'));
            if (u === this.user && p === this.pass) {
              authed = true;
              ok(`[CAPABILITY ${caps}] logged in`);
            } else socket.write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
            break;
          }
          case 'LIST':
            if (/""\s*""\s*$/.test(args)) socket.write('* LIST (\\Noselect) "/" ""\r\n');
            else socket.write('* LIST (\\HasNoChildren) "/" INBOX\r\n');
            ok();
            break;
          case 'SELECT':
          case 'EXAMINE':
            if (!authed) {
              socket.write(`${tag} NO not logged in\r\n`);
              break;
            }
            conn.known = this.messages.length;
            socket.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
            socket.write('* OK [PERMANENTFLAGS ()] read-only\r\n');
            socket.write(`* ${this.messages.length} EXISTS\r\n* 0 RECENT\r\n`);
            socket.write(`* OK [UIDVALIDITY ${this.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${this.uidNext}] next uid\r\n`);
            ok(`[${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed`);
            break;
          case 'NOOP':
            if (this.messages.length > conn.known) {
              socket.write(`* ${this.messages.length} EXISTS\r\n`);
              conn.known = this.messages.length;
            }
            ok();
            break;
          case 'IDLE':
            conn.idleTag = tag;
            socket.write('+ idling\r\n');
            if (this.messages.length > conn.known) {
              socket.write(`* ${this.messages.length} EXISTS\r\n`);
              conn.known = this.messages.length;
            }
            break;
          case 'UID SEARCH':
            socket.write(`* SEARCH ${this.search(args).join(' ')}\r\n`.replace(' \r\n', '\r\n'));
            ok();
            break;
          case 'UID FETCH': {
            const sp = args.indexOf(' ');
            const set = this.uidSet(args.slice(0, sp));
            const items = args.slice(sp + 1).toUpperCase();
            for (const msg of this.messages.filter((x) => set(x.uid))) {
              const seq = this.messages.indexOf(msg) + 1;
              const parts = [`UID ${msg.uid}`];
              if (items.includes('FLAGS')) parts.push(`FLAGS (${msg.seen ? '\\Seen' : ''})`);
              if (items.includes('ENVELOPE')) parts.push(`ENVELOPE ${envelope(msg.raw)}`);
              let tail = '';
              if (items.includes('BODY.PEEK[]') || items.includes('BODY[]')) {
                const bytes = Buffer.byteLength(msg.raw);
                tail = ` BODY[] {${bytes}}\r\n${msg.raw}`;
              }
              socket.write(`* ${seq} FETCH (${parts.join(' ')}${tail})\r\n`);
            }
            ok();
            break;
          }
          case 'LOGOUT':
            socket.write('* BYE logging out\r\n');
            ok();
            socket.end();
            break;
          default:
            socket.write(`${tag} BAD unsupported command ${cmd}\r\n`);
        }
      }
    });
  }

  private uidSet(spec: string): (uid: number) => boolean {
    const max = this.messages.at(-1)?.uid ?? 0;
    const ranges = spec.split(',').map((r) => {
      const [a, b] = r.split(':');
      const lo = a === '*' ? max : Number(a);
      const hi = b === undefined ? lo : b === '*' ? max : Number(b);
      return [Math.min(lo, hi), Math.max(lo, hi)] as const;
    });
    return (uid) => ranges.some(([lo, hi]) => uid >= lo && uid <= hi);
  }

  private search(args: string): number[] {
    let list = [...this.messages];
    const uidM = /UID (\S+)/i.exec(args);
    if (uidM) {
      const inSet = this.uidSet(uidM[1] as string);
      list = list.filter((m) => inSet(m.uid));
    }
    const fromM = /FROM "?([^"\s]+)"?/i.exec(args);
    if (fromM) list = list.filter((m) => header(m.raw, 'from').toLowerCase().includes((fromM[1] as string).toLowerCase()));
    const subjM = /SUBJECT "([^"]*)"|SUBJECT (\S+)/i.exec(args);
    if (subjM) list = list.filter((m) => header(m.raw, 'subject').toLowerCase().includes((subjM[1] ?? subjM[2] ?? '').toLowerCase()));
    if (/\bUNSEEN\b/i.test(args)) list = list.filter((m) => !m.seen);
    return list.map((m) => m.uid);
  }
}

function header(raw: string, name: string): string {
  const head = raw.split('\r\n\r\n')[0] ?? '';
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head);
  return m?.[1]?.trim() ?? '';
}

function q(s: string): string {
  return s ? `"${s.replace(/(["\\])/g, '\\$1')}"` : 'NIL';
}

function addr(v: string): string {
  if (!v) return 'NIL';
  const m = /^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/.exec(v.trim()) ?? [null, '', v.trim()];
  const [mbox, host] = (m[2] ?? '').split('@');
  return `((${q((m[1] ?? '').trim())} NIL ${q(mbox ?? '')} ${q(host ?? '')}))`;
}

function envelope(raw: string): string {
  const from = addr(header(raw, 'from'));
  return `(${q(header(raw, 'date'))} ${q(header(raw, 'subject'))} ${from} ${from} ${from} ${addr(header(raw, 'to'))} NIL NIL NIL ${q(header(raw, 'message-id'))})`;
}

export function mail(o: { from: string; to?: string; subject: string; body: string; date?: string; headers?: Record<string, string>; id?: string }): string {
  const extra = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
  return [
    `From: ${o.from}`,
    `To: ${o.to ?? 'Me <me@example.com>'}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? 'Tue, 03 Nov 2026 09:00:00 +0000'}`,
    `Message-ID: <${o.id ?? Math.random().toString(36).slice(2)}@example.com>`,
    ...extra,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
  ].join('\r\n');
}
