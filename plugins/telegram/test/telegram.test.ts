import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { createTelegramPlugin, splitMessage } from '../src/plugin.js';
import { FakeTelegram } from './fake-telegram.js';

const OWNER = 4242;
const running: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const r of running.splice(0).reverse()) await r.stop();
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(config: Record<string, unknown> = {}, kv?: Map<string, unknown>, existing?: { tg: FakeTelegram; apiBase: string }) {
  const tg = existing?.tg ?? new FakeTelegram();
  const apiBase = existing?.apiBase ?? (await tg.start());
  if (!existing) running.push(tg);
  const host = new FakeHost(createTelegramPlugin(), {
    id: 'telegram',
    levelCap: 1,
    owners: [`telegram:${OWNER}`],
    env: { TELEGRAM_BOT_TOKEN: tg.token },
    config: { apiBase, pollTimeoutSec: 1, ...config },
  });
  if (kv) for (const [k, v] of kv) host.kv.set(k, v);
  await host.start();
  running.push({ stop: () => host.stop() });
  return { tg, host, apiBase };
}

describe('telegram connector', () => {
  it('turns owner, stranger and group messages into events at the right levels', async () => {
    const { tg, host } = await setup();
    const u1 = tg.inject({ fromId: OWNER, text: '帮我看看明天日程' });
    tg.inject({ fromId: OWNER, text: '停' });
    tg.inject({ fromId: 77, username: 'mallory', text: 'hi bot' });
    tg.inject({ fromId: 78, chatId: -100, chatType: 'supergroup', title: 'Family', text: 'dinner at 7' });
    tg.inject({ fromId: 79, chatId: -100, chatType: 'supergroup', title: 'Family', text: '@protea_bot what time is it?' });
    await waitFor(() => host.events.length === 5);
    expect(host.violations).toEqual([]);
    expect(host.events.map((e) => [e.type, e.level, e.trigger, e.senderKey])).toEqual([
      ['chat.message', 1, 'flush', `telegram:${OWNER}`],
      ['chat.message', 1, 'interrupt', `telegram:${OWNER}`],
      ['telegram.message', 2, 'flush', 'telegram:77'],
      ['telegram.message', 4, 'store', 'telegram:78'],
      ['telegram.message', 2, 'flush', 'telegram:79'],
    ]);
    expect(host.events[0]?.text).toMatch(/^Message from owner in private chat \(msg \d+\):\n帮我看看明天日程$/);
    expect(host.events[0]?.dedupeKey).toBe(`update:${u1}`);
    expect(host.events[2]?.text).toContain('@mallory');
    expect(host.events[2]?.text).toContain('not the owner');
    expect(host.events[4]?.text).toContain('mentioning the bot');
    // The offset is persisted after each stored event.
    expect(host.kv.get('offset')).toBe(u1 + 5);
    expect(host.kv.get('ownerChatId')).toBe(OWNER);
  });

  it('resumes from the stored offset after a restart without re-pushing', async () => {
    const first = await setup();
    first.tg.inject({ fromId: OWNER, text: 'one' });
    await waitFor(() => first.host.events.length === 1);
    await first.host.stop();
    const offset = first.host.kv.get('offset');
    // Same Bot API, new plugin process with the stored state: 'one' is not fetched again.
    const second = await setup({}, new Map([['offset', offset], ['ownerChatId', OWNER]]), first);
    first.tg.inject({ fromId: OWNER, text: 'two' });
    await waitFor(() => second.host.events.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(second.host.events.map((e) => e.text.split('\n')[1])).toEqual(['two']);
  });

  it('sends to the owner, splits long text, and refuses before the owner chat is known', async () => {
    const { tg, host } = await setup();
    const early = await host.chatSend({ text: 'hello' });
    expect(early).toMatchObject({ ok: false });
    tg.inject({ fromId: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    const r = await host.chatSend({ text: 'hello', replyTo: '5000' });
    expect(r).toMatchObject({ ok: true, messageIds: [expect.stringMatching(/^\d+$/)] });
    expect(tg.sent.at(-1)).toMatchObject({ chat_id: OWNER, text: 'hello', reply_parameters: { message_id: 5000 } });
    const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    await host.chatSend({ text: long });
    expect(tg.sent.slice(-2).map((m) => m.text.length)).toEqual([3000, 3000]);
    await host.callTool('tg_react', { message_id: 5000, emoji: '👍' });
    expect(tg.reactions.at(-1)).toMatchObject({ chat_id: OWNER, message_id: 5000 });
  });

  it('attaches the owner\'s photo at a size a model can use, and only the owner\'s', async () => {
    const { tg, host } = await setup();
    const png = Buffer.from('89504e470d0a1a0a00', 'hex');
    tg.files.set('photos/mid.bin', png);
    const photo = [
      { file_id: 'small', width: 90, height: 60 },
      { file_id: 'mid', width: 1280, height: 853 },
      { file_id: 'huge', width: 2560, height: 1706 },
    ];
    tg.inject({ fromId: OWNER, extra: { photo, caption: '这是什么' } });
    tg.inject({ fromId: 77, extra: { photo, caption: 'look at this' } });
    await waitFor(() => host.events.length === 2);
    expect(tg.fileRequests).toEqual(['mid']);
    expect(host.events[0]?.text).toContain('这是什么');
    expect(host.events[0]?.blobs).toMatchObject([{ size: png.length }]);
    expect(host.blobs.get(host.events[0]?.blobs?.[0]?.handle as string)?.data.equals(png)).toBe(true);
    expect(host.events[1]?.blobs).toBeUndefined();
  });

  it('still delivers the message when the picture cannot be fetched', async () => {
    const { tg, host } = await setup();
    tg.inject({ fromId: OWNER, extra: { photo: [{ file_id: 'missing', width: 90, height: 60 }] } });
    await waitFor(() => host.events.length === 1);
    expect(host.events[0]?.text).toContain('[photo]');
    expect(host.events[0]?.blobs).toBeUndefined();
  });

  it('reads a time limit on /approve', async () => {
    const { tg, host } = await setup();
    tg.inject({ fromId: OWNER, text: '/approve a5 2h' });
    tg.inject({ fromId: OWNER, text: '/approve a6 30' });
    tg.inject({ fromId: OWNER, text: '/approve a7' });
    tg.inject({ fromId: OWNER, text: '/deny a8 1h' });
    await waitFor(() => host.decisions.length === 4);
    expect(host.decisions.map((d) => [d.id, d.decision, d.grantMs])).toEqual([
      ['a5', 'approve', 7_200_000],
      ['a6', 'approve', 1_800_000],
      ['a7', 'approve', undefined],
      ['a8', 'deny', undefined],
    ]);
    expect(host.events).toEqual([]);
  });

  it('reads /mode from the owner; anyone else\'s /mode is an ordinary message', async () => {
    const { tg, host } = await setup();
    tg.inject({ fromId: OWNER, text: '/mode' });
    tg.inject({ fromId: OWNER, text: '/mode auto 2h' });
    tg.inject({ fromId: OWNER, text: '/mode bypass 30' });
    tg.inject({ fromId: OWNER, text: '/mode locked' });
    tg.inject({ fromId: OWNER, text: '/mode sideways' });
    await waitFor(() => tg.sent.filter((m) => m.text.startsWith('Usage')).length === 1);
    expect(host.modeRequests).toEqual([
      { senderKey: `telegram:${OWNER}` },
      { senderKey: `telegram:${OWNER}`, mode: 'auto', forMs: 7_200_000 },
      { senderKey: `telegram:${OWNER}`, mode: 'bypass', forMs: 1_800_000 },
      { senderKey: `telegram:${OWNER}`, mode: 'locked' },
    ]);
    expect(host.events).toEqual([]);
    tg.inject({ fromId: 77, text: '/mode bypass 30' });
    await waitFor(() => host.events.length === 1);
    expect(host.modeRequests).toHaveLength(4);
  });

  it('handles /approve and /deny from the owner without pushing a message event', async () => {
    const { tg, host } = await setup({}, new Map([['ownerChatId', OWNER]]));
    const delivered = await host.request('approvals/request', { id: 'a3', tool: 'tg_send_chat', summary: 'tg_send_chat {"chat_id":-100}', expiresAt: '2026-11-04T00:00:00Z' });
    expect(delivered).toEqual({ delivered: true });
    // The request reads as a request, and nothing in it asks for a command or an id.
    expect(tg.sent.at(-1)?.text).toMatch(/^\[Needs your OK\] tg_send_chat\n/);
    expect(tg.sent.at(-1)?.text).not.toMatch(/\/approve|a3/);
    tg.inject({ fromId: OWNER, text: '/approve a3' });
    tg.inject({ fromId: 77, text: '/approve a3' }); // a stranger: just a message, never a decision
    await waitFor(() => host.decisions.length === 1 && host.events.length === 1);
    expect(host.decisions).toEqual([{ id: 'a3', decision: 'approve', senderKey: `telegram:${OWNER}` }]);
    expect(host.events[0]?.senderKey).toBe('telegram:77');
    await waitFor(() => tg.sent.some((m) => m.text === 'Approved: tg_send_chat'));
  });

  const view = { title: 'Send a Telegram message to someone else', target: 'Dinner at 7', fields: [{ label: 'To chat', value: '-100' }], reason: 'you asked me to tell the family', family: { id: 'telegram', label: 'the tools of the telegram plugin' } };
  const request = (id: string) => ({ id, tool: 'tg_send_chat', summary: 'x', expiresAt: new Date(Date.now() + 600_000).toISOString(), view, grantMaxMs: 8 * 3_600_000 });

  it('shows a request with buttons, takes the owner’s press, and puts the outcome in place of the buttons', async () => {
    const { tg, host } = await setup({}, new Map([['ownerChatId', OWNER]]));
    expect(await host.request('approvals/request', request('a7'))).toEqual({ delivered: true });
    const sent = tg.sent.at(-1);
    expect(sent?.text).toBe('[Needs your OK] Send a Telegram message to someone else\nDinner at 7\nTo chat: -100\nWhy: you asked me to tell the family\nValid for 10 minutes');
    expect(sent?.reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([['Approve', 'Deny'], ["Approve, don't ask for 1 hour"]]);
    const grant = sent?.reply_markup?.inline_keyboard[1]?.[0]?.callback_data as string;

    // Someone else's press decides nothing.
    tg.press({ fromId: 77, data: grant, messageId: sent?.message_id as number });
    await waitFor(() => tg.answers.length === 1);
    expect(tg.answers[0]?.text).toBe('Only the owner can decide');
    expect(host.decisions).toHaveLength(0);

    tg.press({ fromId: OWNER, data: grant, messageId: sent?.message_id as number });
    await waitFor(() => host.decisions.length === 1);
    expect(host.decisions[0]).toEqual({ id: 'a7', decision: 'approve', senderKey: `telegram:${OWNER}`, grantMs: 3_600_000 });
    await waitFor(() => tg.answers.length === 2);
    expect(tg.answers[1]?.text).toBe('Approved: Send a Telegram message to someone else');
    expect(host.events).toHaveLength(0);

    // The host says it is settled: the message keeps the request and loses the buttons.
    host.notify('approvals/resolved', { id: 'a7', state: 'approved', by: `telegram:telegram:${OWNER}` });
    await waitFor(() => tg.edits.length === 1);
    expect(tg.edits[0]).toMatchObject({ method: 'editMessageText', message_id: sent?.message_id });
    expect(String(tg.edits[0]?.['text'])).toMatch(/Dinner at 7[\s\S]*\n\nApproved · \d\d:\d\d$/);
    expect(tg.edits[0]).not.toHaveProperty('reply_markup');
  });

  it('takes a plain word as the answer only when it cannot mean anything else', async () => {
    const { tg, host } = await setup({}, new Map([['ownerChatId', OWNER]]));
    // No request open: "yes" is conversation.
    tg.inject({ fromId: OWNER, text: 'yes' });
    await waitFor(() => host.events.length === 1);
    expect(host.decisions).toHaveLength(0);

    await host.request('approvals/request', request('a1'));
    tg.inject({ fromId: OWNER, text: '拒绝 太晚了' });
    await waitFor(() => host.decisions.length === 1);
    expect(host.decisions[0]).toEqual({ id: 'a1', decision: 'deny', senderKey: `telegram:${OWNER}`, note: '太晚了' });
    host.notify('approvals/resolved', { id: 'a1', state: 'denied' });

    // Two open: a bare word names neither, a number or a quoted reply does.
    await host.request('approvals/request', request('a2'));
    await host.request('approvals/request', request('a3'));
    expect(tg.sent.at(-1)?.text).toMatch(/^\[Needs your OK\] Send a Telegram message to someone else \(2\)\n/);
    const before = tg.sent.length;
    tg.inject({ fromId: OWNER, text: 'approve' });
    await waitFor(() => tg.sent.length === before + 1);
    expect(tg.sent.at(-1)?.text).toMatch(/^2 requests are waiting:\n1\. /);
    expect(host.decisions).toHaveLength(1);
    tg.inject({ fromId: OWNER, text: 'approve 2 1h' });
    await waitFor(() => host.decisions.length === 2);
    expect(host.decisions[1]).toEqual({ id: 'a3', decision: 'approve', senderKey: `telegram:${OWNER}`, grantMs: 3_600_000 });

    // After the bot said something else, a bare word is conversation again.
    host.notify('approvals/resolved', { id: 'a3', state: 'approved' });
    const events = host.events.length;
    tg.inject({ fromId: OWNER, text: 'ok' });
    tg.inject({ fromId: OWNER, text: 'yes' });
    await waitFor(() => host.events.length === events + 2);
    expect(host.decisions).toHaveLength(2);
  });

  it('keeps polling through an outage', async () => {
    const { tg, host } = await setup();
    tg.failPolls = 2;
    tg.inject({ fromId: OWNER, text: 'after the outage' });
    await waitFor(() => host.events.length === 1, 10_000);
    expect(host.events[0]?.text).toContain('after the outage');
  }, 15_000);

  it('splits at paragraph boundaries', () => {
    expect(splitMessage('short')).toEqual(['short']);
    const parts = splitMessage(`${'x'.repeat(10)}\n\n${'y'.repeat(10)}`, 15);
    expect(parts).toEqual(['x'.repeat(10), 'y'.repeat(10)]);
  });
});
