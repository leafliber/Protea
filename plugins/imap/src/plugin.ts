import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { definePlugin, type Host, type PluginDefinition } from '@protea/plugin-sdk';

export interface ImapConfig {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  mailbox?: string;
  mode?: 'idle' | 'poll';
  pollSec?: number;
  level?: 2 | 3 | 4;
  bulkLevel?: 3 | 4;
  important?: string[];
  snippetChars?: number;
  rejectUnauthorized?: boolean;
}

export interface MailAddress {
  name?: string;
  address?: string;
}

export interface MailMessage {
  uid: number;
  messageId?: string;
  from?: MailAddress;
  to: string[];
  subject: string;
  date?: string;
  text: string;
  attachments: Array<{ filename: string; size: number; contentType: string }>;
  /** Mailing list, newsletter or automatic mail. */
  bulk: boolean;
}

export interface MailHeader {
  uid: number;
  from?: MailAddress;
  subject: string;
  date?: string;
  seen: boolean;
}

export interface MailboxInfo {
  uidValidity: string;
  uidNext: number;
}

/** The mailbox as the plugin needs it; ImapflowClient is the real one, tests use a fake server. */
export interface MailClient {
  open(): Promise<MailboxInfo>;
  /** UIDs greater than `uid`, ascending. */
  uidsAfter(uid: number): Promise<number[]>;
  fetch(uid: number): Promise<MailMessage | null>;
  search(q: { from?: string; subject?: string; since?: Date; unseen?: boolean }): Promise<number[]>;
  headers(uids: number[]): Promise<MailHeader[]>;
  /** Poll mode: ask the server for news (NOOP). */
  check(): Promise<void>;
  onExists(cb: () => void): void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
}

export type MailClientFactory = (cfg: ImapConfig, password: string) => MailClient;

function addressList(a: AddressObject | AddressObject[] | undefined): MailAddress[] {
  return (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => ({ ...(v.name ? { name: v.name } : {}), ...(v.address ? { address: v.address } : {}) })));
}

export function formatAddress(a: MailAddress | undefined): string {
  if (!a) return '(unknown sender)';
  return a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '(unknown sender)');
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** A parsed RFC 822 message in the plugin's terms. */
export function toMessage(uid: number, p: ParsedMail): MailMessage {
  const h = p.headers;
  const precedence = String(h.get('precedence') ?? '').toLowerCase();
  const auto = String(h.get('auto-submitted') ?? '').toLowerCase();
  // mailparser folds the List-* headers into one structured "list" header.
  const bulk = h.has('list') || h.has('list-unsubscribe') || h.has('list-id') || ['bulk', 'list', 'junk'].includes(precedence) || (auto !== '' && auto !== 'no');
  const from = addressList(p.from)[0];
  return {
    uid,
    ...(p.messageId ? { messageId: p.messageId } : {}),
    ...(from ? { from } : {}),
    to: addressList(p.to).map(formatAddress),
    subject: p.subject ?? '(no subject)',
    ...(p.date ? { date: p.date.toISOString() } : {}),
    text: (p.text ?? (typeof p.html === 'string' ? stripHtml(p.html) : '')).trim(),
    attachments: p.attachments.map((a) => ({ filename: a.filename ?? '(unnamed)', size: a.size, contentType: a.contentType })),
    bulk,
  };
}

function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** imapflow on one connection, the mailbox opened read-only (nothing gets marked seen). */
export class ImapflowClient implements MailClient {
  private readonly client: ImapFlow;
  private readonly mailbox: string;

  constructor(cfg: ImapConfig, password: string) {
    this.mailbox = cfg.mailbox ?? 'INBOX';
    this.client = new ImapFlow({
      host: cfg.host,
      port: cfg.port ?? 993,
      secure: cfg.secure ?? true,
      auth: { user: cfg.user, pass: password },
      logger: false,
      disableAutoIdle: (cfg.mode ?? 'idle') === 'poll',
      // Enter IDLE a second after the last command (imapflow waits 15 s by default), so new mail shows up at once.
      autoIdleDelay: 1000,
      tls: { rejectUnauthorized: cfg.rejectUnauthorized ?? true },
    });
    this.client.on('error', () => {
      // 'close' follows; the plugin reconnects.
    });
  }

  async open(): Promise<MailboxInfo> {
    await this.client.connect();
    const mb = await this.client.mailboxOpen(this.mailbox, { readOnly: true });
    return { uidValidity: String(mb.uidValidity), uidNext: Number(mb.uidNext) };
  }

  async uidsAfter(uid: number): Promise<number[]> {
    const r = await this.client.search({ uid: `${uid + 1}:*` }, { uid: true });
    // "n:*" also matches the highest message when n is past it.
    return (Array.isArray(r) ? r : []).filter((u) => u > uid).sort((a, b) => a - b);
  }

  async fetch(uid: number): Promise<MailMessage | null> {
    const m = await this.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!m || !m.source) return null;
    return toMessage(uid, await simpleParser(m.source));
  }

  async search(q: { from?: string; subject?: string; since?: Date; unseen?: boolean }): Promise<number[]> {
    const query: Record<string, unknown> = {};
    if (q.from) query['from'] = q.from;
    if (q.subject) query['subject'] = q.subject;
    if (q.since) query['since'] = q.since;
    if (q.unseen) query['seen'] = false;
    if (Object.keys(query).length === 0) query['all'] = true;
    const r = await this.client.search(query, { uid: true });
    return Array.isArray(r) ? r : [];
  }

  async headers(uids: number[]): Promise<MailHeader[]> {
    if (uids.length === 0) return [];
    const rows = await this.client.fetchAll(uids.join(','), { uid: true, envelope: true, flags: true }, { uid: true });
    return rows.map((m) => {
      const f = m.envelope?.from?.[0];
      return {
        uid: m.uid,
        ...(f ? { from: { ...(f.name ? { name: f.name } : {}), ...(f.address ? { address: f.address } : {}) } } : {}),
        subject: m.envelope?.subject ?? '(no subject)',
        ...(m.envelope?.date ? { date: new Date(m.envelope.date).toISOString() } : {}),
        seen: m.flags?.has('\\Seen') ?? false,
      };
    });
  }

  async check(): Promise<void> {
    await this.client.noop();
  }

  onExists(cb: () => void): void {
    this.client.on('exists', () => cb());
  }

  onClose(cb: () => void): void {
    this.client.on('close', () => cb());
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

interface MailboxState {
  uidValidity: string;
  lastUid: number;
}

/**
 * New mail as events (docs/10-architecture/08-event-source-plugins.md: imap is L2): the
 * first connection only records where the mailbox stands, later messages are reported one
 * event each. The last reported UID is saved after its event is stored, so a crash re-reads
 * rather than loses; a UIDVALIDITY change starts over from the current end.
 */
export function createImapPlugin(opts: { client?: MailClientFactory } = {}): PluginDefinition<ImapConfig> {
  const factory: MailClientFactory = opts.client ?? ((cfg, pw) => new ImapflowClient(cfg, pw));
  let client: MailClient | null = null;
  let mailbox: MailboxInfo | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let lastError: string | undefined;

  const important = (cfg: ImapConfig, from?: string): boolean => {
    const addr = (from ?? '').toLowerCase();
    return (cfg.important ?? []).some((p) => (p.startsWith('@') ? addr.endsWith(p.toLowerCase()) : addr === p.toLowerCase()));
  };

  async function report(host: Host<ImapConfig>, m: MailMessage): Promise<void> {
    const cfg = host.config;
    const level = m.bulk && !important(cfg, m.from?.address) ? (cfg.bulkLevel ?? 4) : (cfg.level ?? 2);
    const trigger = level === 2 ? 'flush' : level === 3 ? 'debounce' : 'piggyback';
    const lines = [`Email from ${formatAddress(m.from)} (uid ${m.uid})${m.bulk ? ', a mailing list or automatic message' : ''}:`, `Subject: ${m.subject}`];
    if (m.date) lines.push(`Date: ${m.date}`);
    if (m.to.length) lines.push(`To: ${m.to.join(', ')}`);
    const snippet = clip(m.text, cfg.snippetChars ?? 500);
    if (snippet) lines.push('', snippet);
    if (m.attachments.length) lines.push('', `Attachments: ${m.attachments.map((a) => `${a.filename} (${formatSize(a.size)})`).join(', ')}`);
    lines.push(`Read the whole message with mail_fetch {"uid": ${m.uid}}.`);
    await host.events.push({
      type: 'mail.received',
      ts: new Date().toISOString(),
      level,
      trigger,
      text: lines.join('\n'),
      ...(m.from?.address ? { senderKey: `mail:${m.from.address.toLowerCase()}` } : {}),
      dedupeKey: `msg:${mailbox?.uidValidity ?? ''}:${m.uid}`,
      meta: { uid: m.uid, subject: m.subject, ...(m.from?.address ? { from: m.from.address } : {}), ...(m.messageId ? { messageId: m.messageId } : {}), bulk: m.bulk },
    });
  }

  /** Report everything after the saved position, one message at a time. */
  function catchUp(host: Host<ImapConfig>): Promise<void> {
    chain = chain.then(async () => {
      if (stopped || !client || !mailbox) return;
      const state = await host.kv.get<MailboxState>('mailbox');
      if (!state) return;
      for (const uid of await client.uidsAfter(state.lastUid)) {
        if (stopped) return;
        const m = await client.fetch(uid);
        if (m) await report(host, m);
        await host.kv.set('mailbox', { uidValidity: mailbox.uidValidity, lastUid: uid });
      }
    }).catch((err: Error) => {
      host.log.warn('could not read new mail', { err: err.message });
    });
    return chain;
  }

  async function connect(host: Host<ImapConfig>): Promise<void> {
    const password = host.secret('IMAP_PASSWORD');
    if (!password) throw new Error('secret IMAP_PASSWORD is not set');
    const c = factory(host.config, password);
    c.onClose(() => {
      if (client !== c || stopped) return;
      client = null;
      lastError = 'connection closed';
      scheduleRetry(host);
    });
    mailbox = await c.open();
    client = c;
    retries = 0;
    lastError = undefined;
    const saved = await host.kv.get<MailboxState>('mailbox');
    if (!saved || saved.uidValidity !== mailbox.uidValidity) {
      // First connection (or the server renumbered the mailbox): start from the current end.
      await host.kv.set('mailbox', { uidValidity: mailbox.uidValidity, lastUid: mailbox.uidNext - 1 });
      host.log.info('mailbox baseline recorded', { uidValidity: mailbox.uidValidity, lastUid: mailbox.uidNext - 1, renumbered: !!saved });
    }
    c.onExists(() => void catchUp(host));
    await catchUp(host);
  }

  function scheduleRetry(host: Host<ImapConfig>): void {
    if (stopped || retryTimer) return;
    const delay = Math.min(300_000, 5_000 * 2 ** retries++);
    host.log.warn('reconnecting to the mail server', { inMs: delay, err: lastError });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect(host).catch((err: Error) => {
        lastError = err.message;
        scheduleRetry(host);
      });
    }, delay);
    retryTimer.unref?.();
  }

  const need = (): MailClient => {
    if (!client) throw new Error(`not connected to the mail server${lastError ? ` (${lastError})` : ''}`);
    return client;
  };

  return definePlugin<ImapConfig>({
    displayName: 'Email (IMAP)',
    async start(host) {
      stopped = false;
      try {
        await connect(host);
      } catch (err) {
        lastError = (err as Error).message;
        if (lastError.includes('IMAP_PASSWORD')) throw err;
        host.log.warn('could not connect to the mail server', { err: lastError });
        scheduleRetry(host);
      }
      if ((host.config.mode ?? 'idle') === 'poll') {
        pollTimer = setInterval(() => {
          if (!client) return;
          client
            .check()
            .then(() => catchUp(host))
            .catch((err: Error) => host.log.warn('poll failed', { err: err.message }));
        }, (host.config.pollSec ?? 120) * 1000);
        pollTimer.unref?.();
      }
    },
    async stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      pollTimer = null;
      retryTimer = null;
      await chain;
      const c = client;
      client = null;
      await c?.close();
    },
    // The process is fine while the mail server is away (it reconnects on its own), so health stays ok.
    health: () => (client ? { ok: true } : { ok: true, detail: `not connected: ${lastError ?? 'connecting'}` }),
    envPromptVars: (host) => ({ user: host.config.user, mailbox: host.config.mailbox ?? 'INBOX' }),
    tools: [
      {
        name: 'mail_fetch',
        description: 'Read one email by uid: headers, the whole text and the attachment list.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['uid'],
          properties: { uid: { type: 'integer', minimum: 1 }, max_chars: { type: 'integer', minimum: 100, maximum: 100_000, default: 20_000 } },
        },
        flags: { readOnly: true },
        handler: async (i: { uid: number; max_chars?: number }) => {
          const m = await need().fetch(i.uid);
          if (!m) return { text: `no message with uid ${i.uid}`, failed: true };
          const max = i.max_chars ?? 20_000;
          const body = m.text.length > max ? `${m.text.slice(0, max)}\n[… ${m.text.length - max} more characters]` : m.text;
          return [
            `From: ${formatAddress(m.from)}`,
            `To: ${m.to.join(', ')}`,
            `Subject: ${m.subject}`,
            ...(m.date ? [`Date: ${m.date}`] : []),
            ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
            ...(m.attachments.length ? [`Attachments: ${m.attachments.map((a) => `${a.filename} (${a.contentType}, ${formatSize(a.size)})`).join(', ')}`] : []),
            '',
            body || '(no text)',
          ].join('\n');
        },
      },
      {
        name: 'mail_search',
        description: 'Find emails in the mailbox by sender, subject words, date or unread state; newest first.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string' },
            subject: { type: 'string' },
            since: { type: 'string', description: 'YYYY-MM-DD' },
            unseen: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
        flags: { readOnly: true },
        handler: async (i: { from?: string; subject?: string; since?: string; unseen?: boolean; limit?: number }) => {
          const c = need();
          let since: Date | undefined;
          if (i.since) {
            since = new Date(`${i.since}T00:00:00Z`);
            if (Number.isNaN(since.getTime())) return { text: 'since must be YYYY-MM-DD', failed: true };
          }
          const uids = (await c.search({ ...(i.from ? { from: i.from } : {}), ...(i.subject ? { subject: i.subject } : {}), ...(since ? { since } : {}), ...(i.unseen ? { unseen: true } : {}) }))
            .sort((a, b) => b - a)
            .slice(0, i.limit ?? 20);
          if (uids.length === 0) return 'No matching messages.';
          const rows = (await c.headers(uids)).sort((a, b) => b.uid - a.uid);
          return rows.map((r) => `uid ${r.uid}  ${r.date ?? ''}  ${formatAddress(r.from)} — ${r.subject}${r.seen ? '' : '  [unread]'}`).join('\n');
        },
      },
    ],
  });
}
