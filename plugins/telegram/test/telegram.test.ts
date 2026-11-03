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
      ['telegram.message', 1, 'flush', `telegram:${OWNER}`],
      ['telegram.message', 1, 'interrupt', `telegram:${OWNER}`],
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
    const early = await host.callTool('tg_send', { text: 'hello' });
    expect(early).toMatchObject({ failed: true });
    tg.inject({ fromId: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    const r = await host.callTool('tg_send', { text: 'hello', reply_to: 5000 });
    expect(r.text).toMatch(/^sent message \d+ to the owner$/);
    expect(tg.sent.at(-1)).toMatchObject({ chat_id: OWNER, text: 'hello', reply_parameters: { message_id: 5000 } });
    const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    await host.callTool('tg_send', { text: long });
    expect(tg.sent.slice(-2).map((m) => m.text.length)).toEqual([3000, 3000]);
    await host.callTool('tg_react', { message_id: 5000, emoji: '👍' });
    expect(tg.reactions.at(-1)).toMatchObject({ chat_id: OWNER, message_id: 5000 });
  });

  it('handles /approve and /deny from the owner without pushing a message event', async () => {
    const { tg, host } = await setup({}, new Map([['ownerChatId', OWNER]]));
    const delivered = await host.request('approvals/request', { id: 'a3', tool: 'tg_send_chat', summary: 'tg_send_chat {"chat_id":-100}', expiresAt: '2026-11-04T00:00:00Z' });
    expect(delivered).toEqual({ delivered: true });
    expect(tg.sent.at(-1)?.text).toContain('Reply /approve a3 or /deny a3');
    tg.inject({ fromId: OWNER, text: '/approve a3' });
    tg.inject({ fromId: 77, text: '/approve a3' }); // a stranger: just a message, never a decision
    await waitFor(() => host.decisions.length === 1 && host.events.length === 1);
    expect(host.decisions).toEqual([{ id: 'a3', decision: 'approve', senderKey: `telegram:${OWNER}` }]);
    expect(host.events[0]?.senderKey).toBe('telegram:77');
    await waitFor(() => tg.sent.some((m) => m.text === 'a3 approved.'));
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
