import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import { _resetForTest as forgetSessionPauses } from '@tencent-weixin/openclaw-weixin/dist/src/api/session-guard.js';
import type { ChatSendResult, PluginLoginStatus } from '@protea/protocol';
import { TOKEN_SECRET, createWechatPlugin } from '../src/plugin.js';
import { FakeIlink, encryptMedia } from './fake-ilink.js';

const OWNER = 'owner@im.wechat';
const TOKEN = 'bot-token-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

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

let bots = 0;

interface SetupOptions {
  token?: string | null;
  kv?: Map<string, unknown>;
  existing?: { il: FakeIlink; base: string };
  config?: Record<string, unknown>;
  botId?: string;
}

async function setup(o: SetupOptions = {}) {
  const il = o.existing?.il ?? new FakeIlink();
  const base = o.existing?.base ?? (await il.start());
  if (!o.existing) running.push(il);
  const token = o.token === undefined ? TOKEN : o.token;
  const host = new FakeHost(createWechatPlugin({ loginPollMs: 5, retryMs: 10 }), {
    id: 'wechat',
    levelCap: 1,
    owners: [`wechat:${OWNER}`],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'protea-wechat-test-')),
    ...(token ? { env: { [TOKEN_SECRET]: token } } : {}),
    config: { apiBase: base, cdnBase: `${base}/c2c`, ...o.config },
  });
  // The official session guard is process-wide and keyed by bot id.
  if (token) host.kv.set('botId', o.botId ?? `bot-${++bots}`);
  if (token) host.kv.set('baseUrl', base);
  if (o.kv) for (const [k, v] of o.kv) host.kv.set(k, v);
  await host.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await host.stop();
  };
  running.push({ stop });
  return { il, host, base, stop };
}

/** Sign-in steps of the service, then the state the plugin reaches. */
async function signIn(script: Array<Record<string, unknown>>, until: (s: PluginLoginStatus) => boolean, o: SetupOptions = { token: null }) {
  const ctx = await setup(o);
  ctx.il.qrScript.push(...script);
  const first = await ctx.host.login.start();
  let last = first;
  const t0 = Date.now();
  while (!until(last) && Date.now() - t0 < 5000) {
    last = await ctx.host.login.status();
    await new Promise((r) => setTimeout(r, 5));
  }
  return { ...ctx, first, last };
}

const chatSend = (host: FakeHost, text: string): Promise<ChatSendResult> => host.chatSend({ text });

describe('wechat connector', () => {
  it('speaks the official client protocol, notifying the service before the first poll', async () => {
    const { il } = await setup();
    await waitFor(() => il.callsTo('/getupdates').length > 0);
    expect(il.calls[0]?.path).toBe('/ilink/bot/msg/notifystart');
    const poll = il.callsTo('/getupdates')[0];
    expect(poll?.headers['ilink-app-id']).toBe('bot');
    expect(poll?.headers['ilink-app-clientversion']).toBe(String((2 << 16) | (4 << 8) | 10));
    expect(poll?.headers['authorizationtype']).toBe('ilink_bot_token');
    expect(poll?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(poll?.headers['x-wechat-uin']).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(poll?.body['base_info']).toEqual({ channel_version: '2.4.10', bot_agent: 'Protea/0.1.0' });
  });

  it('notifies the service when it stops', async () => {
    const { il, stop } = await setup();
    await waitFor(() => il.callsTo('/getupdates').length > 0);
    await stop();
    expect(il.callsTo('/notifystop')).toHaveLength(1);
  });

  it('turns owner, stranger and group messages into events at the right levels', async () => {
    const { il, host } = await setup();
    const id = il.inject({ from: OWNER, text: '帮我看看明天日程' });
    il.inject({ from: OWNER, text: '停' });
    il.inject({ from: 'stranger@im.wechat', text: 'hi bot' });
    il.inject({ from: OWNER, groupId: 'group-1', text: 'in a group' });
    il.inject({ from: 'bot@im.bot', text: 'my own echo', messageType: 2 });
    await waitFor(() => host.events.length === 4);
    expect(host.violations).toEqual([]);
    expect(host.events.map((e) => [e.type, e.level, e.trigger, e.senderKey])).toEqual([
      ['chat.message', 1, 'flush', `wechat:${OWNER}`],
      ['chat.message', 1, 'interrupt', `wechat:${OWNER}`],
      ['wechat.message', 4, 'store', 'wechat:stranger@im.wechat'],
      ['wechat.message', 4, 'store', `wechat:${OWNER}`],
    ]);
    expect(host.events[0]?.text).toBe(`Message from owner in private chat (msg ${id}):\n帮我看看明天日程`);
    expect(host.events[0]?.dedupeKey).toBe(`msg:${id}`);
    expect(host.events[0]?.correlation).toBe(id);
    expect(host.events[2]?.text).toContain('not the owner');
    expect(host.events[3]?.text).toContain('group-1');
    await waitFor(() => host.kv.get('cursor') === 'buf-5');
  });

  it('does not lose messages the owner repeats or that end like a file name', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: '好' });
    il.inject({ from: OWNER, text: '好' });
    il.inject({ from: OWNER, text: '看看 report.pdf' });
    await waitFor(() => host.events.length === 3);
    expect(host.events.map((e) => e.text.split('\n')[1])).toEqual(['好', '好', '看看 report.pdf']);
  });

  it('resumes from the stored cursor and context after a restart, without re-pushing', async () => {
    const first = await setup({ botId: 'bot-restart' });
    first.il.inject({ from: OWNER, text: 'one', contextToken: 'ctx-one' });
    await waitFor(() => first.host.kv.get('cursor') === 'buf-1');
    await first.stop();
    const kv = new Map(first.host.kv);
    const second = await setup({ existing: { il: first.il, base: first.base }, kv, botId: 'bot-restart' });
    await waitFor(() => first.il.callsTo('/getupdates').some((c) => c.body['get_updates_buf'] === 'buf-1'));
    expect(second.host.events).toHaveLength(0);
    expect(await chatSend(second.host, 'back again')).toMatchObject({ ok: true });
    expect(first.il.sent.at(-1)).toMatchObject({ to: OWNER, text: 'back again', contextToken: 'ctx-one' });
  });

  it('keeps polling through an outage', async () => {
    const { il, host } = await setup();
    il.failPolls = 2;
    il.inject({ from: OWNER, text: 'still there?' });
    await waitFor(() => host.events.length === 1);
    expect(host.logs.some((l) => l.msg === 'wechat poll failed; retrying')).toBe(true);
    expect(await host.request('health', {})).toMatchObject({ ok: true });
  });

  it('answers the owner with the newest context, splitting long text', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: 'first', contextToken: 'ctx-a' });
    il.inject({ from: OWNER, text: 'second', contextToken: 'ctx-b' });
    await waitFor(() => host.events.length === 2);
    const r = await chatSend(host, `${'x'.repeat(3000)}\n\n${'y'.repeat(3000)}`);
    expect(r.ok).toBe(true);
    expect(r.messageIds).toHaveLength(2);
    expect(il.sent.map((s) => [s.to, s.contextToken, s.text.length])).toEqual([
      [OWNER, 'ctx-b', 3000],
      [OWNER, 'ctx-b', 3000],
    ]);
  });

  it('removes markdown images the way the official client does', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    await chatSend(host, 'look ![cat](https://example.com/cat.png) **now**');
    expect(il.sent.at(-1)?.text).toBe('look  **now**');
  });

  it('refuses to start a conversation, and says why', async () => {
    const { host, il } = await setup();
    await waitFor(() => il.callsTo('/getupdates').length > 0);
    const r = await chatSend(host, 'hello?');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot start a conversation/);
    expect(il.sent).toHaveLength(0);
  });

  it('reports a closed reply window so the model can use another platform', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    il.sendResults.push({ ret: -2, errmsg: 'prepare failed' });
    const r = await chatSend(host, 'too many');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reply window is closed/);
    expect(r.error).toMatch(/another platform/);
  });

  it('says how much of a long reply went out before a failure', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    il.sendResults.push({ ret: 0 }, { ret: -2 });
    const r = await chatSend(host, `${'x'.repeat(3000)}\n\n${'y'.repeat(3000)}`);
    expect(r.error).toMatch(/1 of 2 parts/);
    expect(il.sent).toHaveLength(1);
  });

  it('pauses on an expired session, tells the owner once and survives a restart without repeating it', async () => {
    const first = await setup({ botId: 'bot-expired' });
    first.il.inject({ from: OWNER, text: 'hi' });
    await waitFor(() => first.host.events.length === 1);
    first.il.pollError = { ret: -14, errcode: -14, errmsg: 'session timeout' };
    await waitFor(() => first.host.events.length === 2);
    expect(first.host.events[1]).toMatchObject({ type: 'wechat.session_expired', level: 2, trigger: 'flush' });
    expect(await first.host.request('health', {})).toMatchObject({ ok: false, detail: expect.stringContaining('expired') });
    const refused = await chatSend(first.host, 'are you there');
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('session expired') });
    const polls = first.il.callsTo('/getupdates').length;
    await new Promise((r) => setTimeout(r, 100));
    expect(first.il.callsTo('/getupdates').length).toBe(polls);
    await first.stop();
    expect(first.host.kv.get('sessionExpiredAt')).toEqual(expect.any(String));
    // A new process knows nothing of the pause; the session is still dead.
    forgetSessionPauses();
    const before = first.il.callsTo('/getupdates').length;
    const second = await setup({ existing: { il: first.il, base: first.base }, kv: new Map(first.host.kv), botId: 'bot-expired' });
    await waitFor(() => first.il.callsTo('/getupdates').length > before);
    await new Promise((r) => setTimeout(r, 30));
    expect(second.host.events).toHaveLength(0);
  });

  it('clears the expiry once polling works again, so a later expiry is reported', async () => {
    const { il, host } = await setup({ botId: 'bot-recover', kv: new Map([['sessionExpiredAt', '2026-11-01T00:00:00.000Z']]) });
    await waitFor(() => !host.kv.has('sessionExpiredAt'));
    il.pollError = { ret: -14 };
    await waitFor(() => host.events.some((e) => e.type === 'wechat.session_expired'));
  });

  it('treats -14 on a send as an expired session', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    il.sendResults.push({ ret: -14, errmsg: 'session timeout' });
    expect((await chatSend(host, 'x')).error).toMatch(/session expired/);
    await waitFor(() => host.events.some((e) => e.type === 'wechat.session_expired'));
  });

  it('takes approvals and mode commands from the owner, and answers on WeChat', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, text: '/approve a12 1h' });
    await waitFor(() => host.decisions.length === 1);
    expect(host.decisions[0]).toMatchObject({ id: 'a12', decision: 'approve', senderKey: `wechat:${OWNER}`, grantMs: 3_600_000 });
    await waitFor(() => il.sent.length === 1);
    expect(il.sent[0]?.text).toBe('a12 approved (and its tools for 1h).');
    il.inject({ from: OWNER, text: '/mode' });
    await waitFor(() => il.sent.length === 2);
    expect(il.sent[1]?.text).toMatch(/^Permission mode: ask/);
    expect(host.events).toHaveLength(0);
  });

  it('ignores commands from anyone else', async () => {
    const { il, host } = await setup();
    il.inject({ from: 'mallory@im.wechat', text: '/approve a12' });
    await waitFor(() => host.events.length === 1);
    expect(host.decisions).toHaveLength(0);
    expect(il.sent).toHaveLength(0);
  });

  it('delivers an approval request when it can, and says when it could not', async () => {
    const { il, host } = await setup();
    const req = { id: 'a1', tool: 'x_y', summary: 'do it', expiresAt: new Date(0).toISOString() };
    await waitFor(() => il.callsTo('/getupdates').length > 0);
    expect(await host.request('approvals/request', req)).toEqual({ delivered: false });
    il.inject({ from: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    expect(await host.request('approvals/request', req)).toEqual({ delivered: true });
    expect(il.sent.at(-1)?.text).toContain('Reply /approve a1');
  });

  it.each([
    ['image_item.aeskey (hex)', (key: Buffer) => ({ aeskey: key.toString('hex'), media: { encrypt_query_param: 'p1' } })],
    ['media.aes_key (base64 of the raw key)', (key: Buffer) => ({ media: { encrypt_query_param: 'p1', aes_key: key.toString('base64') } })],
    ['media.aes_key (base64 of the hex key)', (key: Buffer) => ({ media: { encrypt_query_param: 'p1', aes_key: Buffer.from(key.toString('hex')).toString('base64') } })],
  ])('decrypts the owner’s picture with %s', async (_name, item) => {
    const { il, host } = await setup();
    const key = crypto.randomBytes(16);
    il.cdn.set('p1', encryptMedia(PNG, key));
    il.inject({ from: OWNER, items: [{ type: 2, image_item: item(key) }] });
    await waitFor(() => host.events.length === 1);
    const blob = host.events[0]?.blobs?.[0];
    expect(blob).toBeDefined();
    expect(host.blobs.get(blob?.handle as string)?.data.equals(PNG)).toBe(true);
    expect(host.events[0]?.text).toContain('[图片]');
  });

  it('keeps the message when its picture cannot be fetched', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, items: [{ type: 2, image_item: { media: { encrypt_query_param: 'missing', aes_key: crypto.randomBytes(16).toString('base64') } } }] });
    await waitFor(() => host.events.length === 1);
    expect(host.events[0]?.blobs).toBeUndefined();
    expect(host.events[0]?.text).toContain('could not be downloaded');
    expect(JSON.stringify(host.logs)).not.toContain('missing');
  });

  it('does not fetch pictures from strangers', async () => {
    const { il, host } = await setup();
    il.inject({ from: 'stranger@im.wechat', items: [{ type: 2, image_item: { media: { encrypt_query_param: 'p2', aes_key: crypto.randomBytes(16).toString('base64') } } }] });
    await waitFor(() => host.events.length === 1);
    expect(il.callsTo('/c2c/download')).toHaveLength(0);
  });

  it('uses the transcript of a voice message and the text of a quote', async () => {
    const { il, host } = await setup();
    il.inject({ from: OWNER, items: [{ type: 3, voice_item: { text: '明天八点叫我' } }] });
    il.inject({ from: OWNER, items: [{ type: 1, text_item: { text: '这个呢' }, ref_msg: { message_item: { type: 1, text_item: { text: '原来那句' } } } }] });
    await waitFor(() => host.events.length === 2);
    expect(host.events[0]?.text).toContain('明天八点叫我');
    expect(host.events[1]?.text).toContain('[quoted: 原来那句]\n这个呢');
  });
});

describe('wechat sign-in', () => {
  it('runs without a token, polls nothing and says it is not signed in', async () => {
    const { il, host } = await setup({ token: null });
    expect(await host.login.status()).toEqual({ state: 'idle' });
    expect(await host.request('health', {})).toEqual({ ok: true, detail: 'not signed in' });
    expect((await chatSend(host, 'x')).error).toMatch(/not signed in/);
    expect(il.callsTo('/getupdates')).toHaveLength(0);
  });

  it('declares the capability', async () => {
    const { host } = await setup({ token: null });
    expect(host.capabilities.login).toBe(true);
    expect(host.capabilities.chat).toBe(true);
    expect(host.capabilities.approvals).toBe(true);
  });

  it('hands the credentials to the host and names the scanner as owner', async () => {
    const { host, il, first, last } = await signIn(
      [{ status: 'scaned' }, { status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'scanner@im.wechat', baseurl: 'https://region.example' }],
      (s) => s.state === 'connected',
    );
    expect(first).toMatchObject({ state: 'waiting', qr: 'https://liteapp.example/q/1' });
    expect(Date.parse(first.expiresAt as string)).toBeGreaterThan(Date.now());
    expect(last).toEqual({ state: 'connected', account: 'scanner@im.wechat' });
    expect(host.logins).toEqual([{ secrets: { [TOKEN_SECRET]: 'new-token' }, ownerSenderKey: 'wechat:scanner@im.wechat' }]);
    expect(host.kv.get('baseUrl')).toBe('https://region.example');
    expect(host.kv.get('botId')).toBe('b1@im.bot');
    expect(host.kv.get('ownerUserId')).toBe('scanner@im.wechat');
    expect(il.calls[0]?.path).toBe('/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(il.calls[0]?.body).toEqual({ local_token_list: [] });
    expect(JSON.stringify(last)).not.toContain('new-token');
  });

  it('starts a new account from a clean state', async () => {
    const kv = new Map<string, unknown>([
      ['cursor', 'buf-old'],
      ['contextToken', 'ctx-old'],
    ]);
    const { host, il } = await signIn([{ status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'b2@im.bot', ilink_user_id: 'scanner@im.wechat' }], (s) => s.state === 'connected', { kv, botId: 'bot-relogin' });
    expect(il.calls.find((c) => c.path.includes('get_bot_qrcode'))?.body).toEqual({ local_token_list: [TOKEN] });
    expect(host.kv.has('cursor')).toBe(false);
    expect(host.kv.has('contextToken')).toBe(false);
  });

  it('shows a fresh code when one expires, and gives up after three', async () => {
    const seen = new Set<string>();
    const { host, il } = await setup({ token: null });
    il.qrScript.push({ status: 'expired' });
    seen.add((await host.login.start()).qr as string);
    await waitFor(() => il.callsTo('/get_bot_qrcode').length === 2);
    await waitFor(() => il.qrScript.length === 0);
    await new Promise((r) => setTimeout(r, 20));
    seen.add((await host.login.status()).qr as string);
    expect(seen).toEqual(new Set(['https://liteapp.example/q/1', 'https://liteapp.example/q/2']));
    il.qrScript.push({ status: 'expired' }, { status: 'expired' });
    let s = await host.login.status();
    const t0 = Date.now();
    while (s.state !== 'failed' && Date.now() - t0 < 5000) {
      s = await host.login.status();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(s.state).toBe('failed');
    expect(s.message).toMatch(/expired too many/);
  });

  it('asks for the number on the phone, also when the first one was wrong', async () => {
    const { host, il } = await setup({ token: null });
    il.qrScript.push({ status: 'need_verifycode' });
    await host.login.start();
    const until = async (want: (s: PluginLoginStatus) => boolean): Promise<PluginLoginStatus> => {
      for (let i = 0; i < 500; i++) {
        const s = await host.login.status();
        if (want(s)) return s;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('timed out');
    };
    expect((await until((s) => s.state === 'need_code')).message).toMatch(/Enter the number/);
    il.qrScript.push({ status: 'need_verifycode' });
    await host.login.submit('1234');
    expect((await until((s) => s.state === 'need_code')).message).toMatch(/did not match/);
    il.qrScript.push({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b3@im.bot' });
    await host.login.submit('5678');
    await until((s) => s.state === 'connected');
    const polls = il.callsTo('/get_qrcode_status').map((c) => new URL(c.path, 'http://x').searchParams.get('verify_code'));
    expect(polls).toContain('1234');
    expect(polls).toContain('5678');
    expect(host.logins[0]).toEqual({ secrets: { [TOKEN_SECRET]: 'tok' } });
  });

  it('never touches the protocol stream when asked for the number', async () => {
    // The official helper reads stdin here, which is the plugin protocol.
    const before = process.stdin.listenerCount('data');
    const { host, il } = await setup({ token: null });
    il.qrScript.push({ status: 'need_verifycode' });
    await host.login.start();
    await waitFor(() => il.qrScript.length === 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(process.stdin.listenerCount('data')).toBe(before);
    await host.login.cancel();
  });

  it('reports an account the service says is already linked', async () => {
    const { last, host } = await signIn([{ status: 'binded_redirect' }], (s) => s.state === 'already_bound');
    expect(last.state).toBe('already_bound');
    expect(host.logins).toHaveLength(0);
  });

  it('follows a redirect to another host, and ignores a malformed one', async () => {
    const target = new FakeIlink();
    const targetBase = await target.start();
    running.push(target);
    target.qrScript.push({ status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'b4@im.bot' });
    const { il, last } = await signIn([{ status: 'scaned_but_redirect', redirect_host: 'not a host/' }, { status: 'scaned_but_redirect', redirect_host: new URL(targetBase).host }], (s) => s.state === 'connected');
    expect(last.state).toBe('connected');
    expect(il.callsTo('/get_qrcode_status')).toHaveLength(2);
    expect(target.callsTo('/get_qrcode_status')).toHaveLength(1);
  });

  it('can be cancelled', async () => {
    const { host, il } = await setup({ token: null });
    await host.login.start();
    expect(await host.login.cancel()).toEqual({ state: 'idle' });
    il.qrScript.push({ status: 'confirmed', bot_token: 'late', ilink_bot_id: 'b5@im.bot' });
    await new Promise((r) => setTimeout(r, 60));
    expect(host.logins).toHaveLength(0);
  });

  it('reports a service it cannot reach', async () => {
    const { host, il } = await setup({ token: null });
    await il.stop();
    const s = await host.login.start();
    expect(s.state).toBe('failed');
    expect(s.message).toMatch(/Could not get a QR code/);
  });

  it('forgets the old account when it starts signed out', async () => {
    const kv = new Map<string, unknown>([
      ['cursor', 'buf-old'],
      ['contextToken', 'ctx-old'],
      ['ownerUserId', OWNER],
      ['account', OWNER],
      ['botId', 'old'],
    ]);
    const { host } = await setup({ token: null, kv });
    for (const key of ['cursor', 'contextToken', 'ownerUserId', 'account', 'botId']) expect(host.kv.has(key)).toBe(false);
  });

  it('reports a signed-in account when resting', async () => {
    const { host } = await setup({ kv: new Map([['account', OWNER]]) });
    expect(await host.login.status()).toEqual({ state: 'connected', account: OWNER });
  });
});
