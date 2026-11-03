import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { createImapPlugin, type ImapConfig } from '../src/plugin.js';
import { FakeImap, mail } from './fake-imap.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(extra: Partial<ImapConfig> = {}, opts: { server?: FakeImap; kv?: Map<string, unknown>; pass?: string } = {}) {
  const server = opts.server ?? new FakeImap();
  const port = opts.server ? undefined : await server.start();
  if (!opts.server) cleanups.push(() => server.stop());
  const cfg: ImapConfig = { host: '127.0.0.1', port: port ?? (extra.port as number), secure: false, user: 'me@example.com', ...extra };
  const h = new FakeHost(createImapPlugin(), { id: 'imap', levelCap: 2, config: { ...cfg }, env: { IMAP_PASSWORD: opts.pass ?? 'secret-pw' } });
  if (opts.kv) for (const [k, v] of opts.kv) h.kv.set(k, v);
  await h.start();
  cleanups.push(() => h.stop());
  return { h, server, port: cfg.port as number };
}

describe('imap source (imapflow against a fake IMAP server)', () => {
  it('records the mailbox end on the first connection, then reports new mail pushed during IDLE', async () => {
    const pre = new FakeImap();
    const port = await pre.start();
    cleanups.push(() => pre.stop());
    pre.add(mail({ from: 'Old <old@example.com>', subject: 'already there', body: 'old' }));
    const { h } = await setup({ port }, { server: pre });
    await waitFor(() => h.kv.get('mailbox') !== undefined);
    expect(h.kv.get('mailbox')).toEqual({ uidValidity: '1001', lastUid: 1 });
    expect(h.events).toEqual([]);

    pre.add(mail({ from: 'Alice Example <alice@example.com>', subject: 'Lunch tomorrow?', body: 'Shall we meet at noon?\nAlice', id: 'lunch-1' }));
    await waitFor(() => h.events.length === 1);
    expect(h.events[0]).toMatchObject({
      type: 'mail.received',
      level: 2,
      trigger: 'flush',
      senderKey: 'mail:alice@example.com',
      dedupeKey: 'msg:1001:2',
      meta: { uid: 2, subject: 'Lunch tomorrow?', from: 'alice@example.com', messageId: '<lunch-1@example.com>', bulk: false },
    });
    expect(h.events[0]?.text).toBe(
      [
        'Email from Alice Example <alice@example.com> (uid 2):',
        'Subject: Lunch tomorrow?',
        'Date: 2026-11-03T09:00:00.000Z',
        'To: Me <me@example.com>',
        '',
        'Shall we meet at noon?\nAlice',
        'Read the whole message with mail_fetch {"uid": 2}.',
      ].join('\n'),
    );
    await waitFor(() => (h.kv.get('mailbox') as { lastUid: number }).lastUid === 2);
    expect(pre.commands).toContain('EXAMINE');
    expect(pre.commands).toContain('IDLE');

    // Newsletters arrive low, unless the sender is marked important.
    pre.add(mail({ from: 'News <news@lists.example.org>', subject: 'Weekly digest', body: 'Lots of links', headers: { 'List-Unsubscribe': '<mailto:unsub@lists.example.org>' } }));
    await waitFor(() => h.events.length === 2);
    expect(h.events[1]).toMatchObject({ level: 4, trigger: 'piggyback', meta: { bulk: true } });
    expect(h.events[1]?.text.split('\n')[0]).toBe('Email from News <news@lists.example.org> (uid 3), a mailing list or automatic message:');
    expect(h.violations).toEqual([]);
  });

  it('reads and searches mail with the tools', async () => {
    const { h, server } = await setup();
    await waitFor(() => h.kv.get('mailbox') !== undefined);
    server.add(mail({ from: 'Bob <bob@example.com>', subject: 'Invoice 42', body: 'Please find the invoice attached.', id: 'inv' }), true);
    server.add(mail({ from: 'Carol <carol@example.com>', subject: 'Re: plans', body: 'x'.repeat(300) }));
    await waitFor(() => h.events.length === 2);
    expect((await h.callTool('mail_fetch', { uid: 1 })).text).toBe(
      ['From: Bob <bob@example.com>', 'To: Me <me@example.com>', 'Subject: Invoice 42', 'Date: 2026-11-03T09:00:00.000Z', 'Message-ID: <inv@example.com>', '', 'Please find the invoice attached.'].join('\n'),
    );
    expect((await h.callTool('mail_fetch', { uid: 2, max_chars: 100 })).text).toMatch(/x{100}\n\[… 200 more characters\]$/);
    expect(await h.callTool('mail_fetch', { uid: 99 })).toMatchObject({ failed: true, text: 'no message with uid 99' });
    expect((await h.callTool('mail_search', {})).text).toBe(
      ['uid 2  2026-11-03T09:00:00.000Z  Carol <carol@example.com> — Re: plans  [unread]', 'uid 1  2026-11-03T09:00:00.000Z  Bob <bob@example.com> — Invoice 42'].join('\n'),
    );
    expect((await h.callTool('mail_search', { from: 'bob' })).text).toMatch(/^uid 1 /);
    expect((await h.callTool('mail_search', { unseen: true })).text).toMatch(/^uid 2 .*\[unread\]$/);
    expect((await h.callTool('mail_search', { subject: 'nothing-like-this' })).text).toBe('No matching messages.');
  });

  it('reconnects after the connection drops and catches up on what arrived meanwhile', async () => {
    const { h, server } = await setup({}, {});
    await waitFor(() => h.kv.get('mailbox') !== undefined);
    server.kick();
    server.add(mail({ from: 'dave@example.com', subject: 'While you were away', body: 'hi' }));
    // The reconnect backoff starts at 5 s.
    await waitFor(() => h.events.length === 1, 15_000);
    expect(h.events[0]?.text).toContain('Subject: While you were away');
  }, 30_000);

  it('polls when IDLE is off, and resumes from the saved position after a restart', async () => {
    const server = new FakeImap();
    const port = await server.start();
    cleanups.push(() => server.stop());
    const first = await setup({ port, mode: 'poll', pollSec: 0.1 as unknown as number }, { server });
    await waitFor(() => first.h.kv.get('mailbox') !== undefined);
    server.add(mail({ from: 'erin@example.com', subject: 'polled', body: 'p' }));
    await waitFor(() => first.h.events.length === 1);
    expect(server.commands).toContain('NOOP');
    expect(server.commands).not.toContain('IDLE');
    await waitFor(() => (first.h.kv.get('mailbox') as { lastUid: number }).lastUid === 1);
    const kv = new Map(first.h.kv);
    await first.h.stop();
    server.add(mail({ from: 'frank@example.com', subject: 'while stopped', body: 'q' }));
    const second = await setup({ port, mode: 'poll', pollSec: 60 }, { server, kv });
    await waitFor(() => second.h.events.length === 1);
    expect(second.h.events[0]?.text).toContain('Subject: while stopped');
  });

  it('starts over from the current end when UIDVALIDITY changes, and refuses to start without the password', async () => {
    const server = new FakeImap();
    const port = await server.start();
    cleanups.push(() => server.stop());
    server.add(mail({ from: 'a@example.com', subject: 's', body: 'b' }));
    const kv = new Map<string, unknown>([['mailbox', { uidValidity: '999', lastUid: 0 }]]);
    const { h } = await setup({ port }, { server, kv });
    await waitFor(() => (h.kv.get('mailbox') as { uidValidity: string }).uidValidity === '1001');
    expect(h.kv.get('mailbox')).toEqual({ uidValidity: '1001', lastUid: 1 });
    expect(h.events).toEqual([]);

    const bad = new FakeHost(createImapPlugin(), { id: 'imap', levelCap: 2, config: { host: '127.0.0.1', port, secure: false, user: 'me@example.com' }, env: {} });
    await expect(bad.start()).rejects.toThrow(/IMAP_PASSWORD/);
  });
});
