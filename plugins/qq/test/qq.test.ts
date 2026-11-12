import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHost } from '@protea/plugin-sdk/testing';
import type { ChatSendResult, PluginLoginStatus } from '@protea/protocol';
import { decryptSecret } from '../src/login.js';
import { SECRET, answerOf, createQqPlugin } from '../src/plugin.js';
import { FakeQq, sealSecret, type BindStep } from './fake-qq.js';

const OWNER = 'E4F5A1B2C3D4OWNER';
const APP = '102000001';
const APP_SECRET = 'app-secret-one';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

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

interface SetupOptions {
  /** The secret in the environment; null: not signed in. */
  secret?: string | null;
  kv?: Map<string, unknown>;
  existing?: { qq: FakeQq; base: string };
  config?: Record<string, unknown>;
  /** Write the sign-in record for the secret (default: when there is a secret and no kv given). */
  signedIn?: boolean;
}

async function setup(o: SetupOptions = {}) {
  const qq = o.existing?.qq ?? new FakeQq();
  const base = o.existing?.base ?? (await qq.start());
  if (!o.existing) running.push(qq);
  qq.apps.set(APP, APP_SECRET);
  const secret = o.secret === undefined ? APP_SECRET : o.secret;
  const host = new FakeHost(createQqPlugin({ bindPollMs: 5, retryMs: 20 }), {
    id: 'qq',
    levelCap: 1,
    owners: [`qq:${OWNER}`],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'protea-qq-test-')),
    ...(secret ? { env: { [SECRET]: secret } } : {}),
    config: { apiBase: base, tokenBase: base, bindBase: base, ...o.config },
  });
  if (secret && (o.signedIn ?? !o.kv)) host.kv.set('signIn', { appId: APP, secretSha256: sha256(secret) });
  if (o.kv) for (const [k, v] of o.kv) host.kv.set(k, v);
  await host.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await host.stop();
  };
  running.push({ stop });
  return { qq, host, base, stop };
}

/** Connected, and the owner has written once (so there is someone to answer). */
async function talking(o: SetupOptions = {}) {
  const ctx = await setup(o);
  await waitFor(() => ctx.qq.online === 1);
  const first = ctx.qq.c2c({ from: OWNER, text: 'hi' });
  await waitFor(() => ctx.host.events.length === 1);
  return { ...ctx, first };
}

/** Sign-in steps of the service, then the state the plugin reaches. */
async function signIn(script: BindStep[], until: (s: PluginLoginStatus) => boolean, o: SetupOptions = { secret: null }) {
  const ctx = await setup(o);
  ctx.qq.bindScript.push(...script);
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

describe('qq connector', () => {
  it('connects with the AppID and AppSecret and identifies on the gateway', async () => {
    const { qq, host } = await setup();
    await waitFor(() => qq.online === 1);
    expect(qq.callsTo('/app/getAppAccessToken')[0]?.body).toEqual({ appId: APP, clientSecret: APP_SECRET });
    expect(qq.callsTo('/gateway')[0]?.headers['authorization']).toBe(`QQBot access-${APP}`);
    expect(qq.handshakes[0]).toMatchObject({ op: 2, d: { token: `QQBot access-${APP}`, shard: [0, 1] } });
    expect(Number(qq.handshakes[0]?.d['intents']) & (1 << 25)).toBe(1 << 25); // group and C2C messages
    await waitFor(() => host.kv.has('session'));
    expect(await host.request('health', {})).toMatchObject({ ok: true });
  });

  it('turns owner, stranger and group messages into events at the right levels', async () => {
    const { qq, host } = await setup();
    await waitFor(() => qq.online === 1);
    const id = qq.c2c({ from: OWNER, text: '帮我看看明天日程' });
    qq.c2c({ from: OWNER, text: '停' });
    qq.c2c({ from: 'STRANGER', text: 'hi bot' });
    qq.group({ group: 'GROUP1', from: 'MEMBER1', text: 'hello bot' });
    qq.group({ group: 'GROUP1', from: 'MEMBER1', text: 'just chatting', at: false });
    await waitFor(() => host.events.length === 5);
    expect(host.violations).toEqual([]);
    expect(host.events.map((e) => [e.type, e.level, e.trigger, e.senderKey])).toEqual([
      ['chat.message', 1, 'flush', `qq:${OWNER}`],
      ['chat.message', 1, 'interrupt', `qq:${OWNER}`],
      ['qq.message', 4, 'store', 'qq:STRANGER'],
      ['qq.message', 4, 'store', 'qq:MEMBER1'],
      ['qq.message', 4, 'store', 'qq:MEMBER1'],
    ]);
    expect(host.events[0]?.text).toBe(`Message from owner in private chat (msg ${id}):\n帮我看看明天日程`);
    expect(host.events[0]).toMatchObject({ dedupeKey: `msg:${id}`, correlation: id, meta: { kind: 'c2c', openid: OWNER, messageId: id } });
    expect(host.events[2]?.text).toContain('not the owner');
    expect(host.events[3]?.text).toMatch(/^Message from member MEMBER1 in QQ group GROUP1 \(msg grp-\d+\):\nhello bot$/);
    expect(await host.tools()).toEqual([]);
  });

  it('answers the owner as a reply to their newest message, splitting long text', async () => {
    const { qq, host } = await talking();
    const second = qq.c2c({ from: OWNER, text: 'and another thing' });
    await waitFor(() => host.events.length === 2);
    const r = await chatSend(host, `${'x'.repeat(4000)}\n\n${'y'.repeat(4000)}`);
    expect(r).toMatchObject({ ok: true, messageIds: ['out-1', 'out-2'] });
    expect(qq.sent.map((s) => [s.scope, s.target, s.msgId, s.content.length])).toEqual([
      ['c2c', OWNER, second, 4000],
      ['c2c', OWNER, second, 4000],
    ]);
  });

  it('sends without the reply reference once QQ refuses it, until the owner writes again', async () => {
    const { qq, host, first } = await talking();
    qq.sendResults.push({ status: 400, body: { code: 40034025, message: 'msg_id expired' } });
    expect(await chatSend(host, 'one')).toMatchObject({ ok: true });
    expect(await chatSend(host, 'two')).toMatchObject({ ok: true });
    expect(qq.sent.map((s) => [s.content, s.msgId])).toEqual([
      ['one', undefined],
      ['two', undefined],
    ]);
    expect(qq.callsTo(`/v2/users/${OWNER}/messages`).map((c) => c.body['msg_id'])).toEqual([first, undefined, undefined]);
    const next = qq.c2c({ from: OWNER, text: 'again' });
    await waitFor(() => host.events.length === 2);
    await chatSend(host, 'three');
    expect(qq.sent.at(-1)).toMatchObject({ content: 'three', msgId: next });
  });

  it('reports a refusal so the model can use another platform', async () => {
    const { qq, host } = await talking();
    qq.sendResults.push({ status: 400, body: { code: 40034025, message: 'msg_id expired' } }, { status: 400, body: { code: 22009, message: 'msg limit exceed' } });
    const r = await chatSend(host, 'too many');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('QQ refused the message: msg limit exceed (code 22009)');
    expect(r.error).toMatch(/another platform/);
  });

  it('says how much of a long reply went out before a failure', async () => {
    const { qq, host } = await talking();
    qq.sendResults.push({ status: 200, body: {} }, { status: 400, body: { code: 1, message: 'no' } }, { status: 400, body: { code: 1, message: 'no' } });
    const r = await chatSend(host, `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('(1 of 2 parts had already been delivered.)');
  });

  it('cannot start a conversation, and says why', async () => {
    const { qq, host } = await setup();
    await waitFor(() => qq.online === 1);
    const r = await chatSend(host, 'hello?');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot start a conversation/);
    expect(qq.sent).toHaveLength(0);
  });

  it('takes approvals and mode commands from the owner, and answers on QQ', async () => {
    const { qq, host } = await talking();
    const id = qq.c2c({ from: OWNER, text: '/approve a12 1h' });
    await waitFor(() => qq.sent.length === 1);
    expect(host.decisions[0]).toMatchObject({ id: 'a12', decision: 'approve', senderKey: `qq:${OWNER}`, grantMs: 3_600_000 });
    expect(qq.sent[0]).toMatchObject({ content: 'Approved: a12 (not asking again for 1 hour)', msgId: id });
    qq.c2c({ from: 'MALLORY', text: '/approve a13' });
    await waitFor(() => host.events.length === 2);
    expect(host.decisions).toHaveLength(1);
    expect(host.events[1]).toMatchObject({ type: 'qq.message', level: 4 });
  });

  it('delivers an approval request when it can, and says when it could not', async () => {
    const { qq, host } = await setup();
    await waitFor(() => qq.online === 1);
    const req = { id: 'a1', summary: 'shell rm -rf /tmp/x', tool: 'shell', expiresAt: '2026-11-11T10:00:00.000Z' };
    expect(await host.request('approvals/request', req)).toEqual({ delivered: false });
    qq.c2c({ from: OWNER, text: 'hi' });
    await waitFor(() => host.events.length === 1);
    expect(await host.request('approvals/request', req)).toEqual({ delivered: true });
    // Buttons, and nothing to type: no command, no id.
    const sent = qq.sent.at(-1);
    expect(sent?.content).toBe('[Needs your OK] shell\nshell rm -rf /tmp/x');
    expect(sent?.keyboard?.content.rows.map((r) => r.buttons.map((b) => b.render_data.label))).toEqual([['Approve', 'Deny']]);
  });

  it('decides a request from its buttons, for the owner only, and once', async () => {
    const { qq, host } = await talking();
    const req = { id: 'a5', tool: 'sh_run', summary: 'x', expiresAt: new Date(Date.now() + 600_000).toISOString(), grantMaxMs: 3_600_000, view: { title: 'Run a command', target: 'npm publish', fields: [], family: { id: 'shell', label: 'the tools of the shell plugin' } } };
    expect(await host.request('approvals/request', req)).toEqual({ delivered: true });
    const sent = qq.sent.at(-1);
    expect(sent?.content).toBe('[Needs your OK] Run a command\nnpm publish\nValid for 10 minutes');
    const rows = sent?.keyboard?.content.rows ?? [];
    expect(rows.map((r) => r.buttons.map((b) => b.render_data.label))).toEqual([['Approve', 'Deny'], ["Approve, don't ask for 1 hour"]]);
    const deny = rows[0]?.buttons[1]?.action.data as string;

    const stranger = qq.press({ from: 'MALLORY', data: deny });
    await waitFor(() => qq.acks.some((a) => a.id === stranger));
    expect(qq.acks.find((a) => a.id === stranger)?.code).not.toBe(0);
    expect(host.decisions).toHaveLength(0);

    const press = qq.press({ from: OWNER, data: deny });
    await waitFor(() => qq.acks.some((a) => a.id === press));
    expect(qq.acks.find((a) => a.id === press)?.code).toBe(0);
    expect(host.decisions).toEqual([{ id: 'a5', decision: 'deny', senderKey: `qq:${OWNER}` }]);
    // The button's own label shows the outcome: no receipt is spent on it.
    expect(qq.sent.at(-1)).toBe(sent);
    expect(host.events).toHaveLength(1);
  });

  it('falls back to words when QQ will not send buttons', async () => {
    const { qq, host } = await talking();
    qq.keyboardResults.push({ status: 403, body: { code: 304082, message: 'no permission for keyboards' } });
    const req = { id: 'a6', tool: 'sh_run', summary: 'x', expiresAt: new Date(Date.now() + 600_000).toISOString(), view: { title: 'Run a command', target: 'ls', fields: [], family: { id: 'shell', label: 'shell' } } };
    expect(await host.request('approvals/request', req)).toEqual({ delivered: true });
    expect(qq.sent.at(-1)?.keyboard).toBeUndefined();
    expect(qq.sent.at(-1)?.content).toBe('[Needs your OK] Run a command\nls\nValid for 10 minutes\nReply: approve / deny');
    qq.c2c({ from: OWNER, text: '同意' });
    await waitFor(() => host.decisions.length === 1);
    expect(host.decisions[0]).toEqual({ id: 'a6', decision: 'approve', senderKey: `qq:${OWNER}` });
  });

  it('brings the owner’s pictures along, and notes what could not be fetched', async () => {
    const { qq, host, base } = await setup();
    await waitFor(() => qq.online === 1);
    qq.images.set('/img/cat.png', PNG);
    qq.c2c({ from: OWNER, text: 'look', attachments: [{ content_type: 'image/png', url: `${base}/img/cat.png`, filename: 'cat.png' }] });
    await waitFor(() => host.events.length === 1);
    expect(host.events[0]?.blobs).toHaveLength(1);
    expect(host.events[0]?.text).toMatch(/\nlook$/);
    qq.c2c({ from: OWNER, attachments: [{ content_type: 'image/png', url: `${base}/img/gone.png` }] });
    await waitFor(() => host.events.length === 2);
    expect(host.events[1]?.blobs).toBeUndefined();
    expect(host.events[1]?.text).toContain('[the image could not be downloaded]');
    expect(host.logs.some((l) => JSON.stringify(l).includes('/img/gone.png'))).toBe(false);
  });

  it('does not fetch pictures from strangers', async () => {
    const { qq, host, base } = await setup();
    await waitFor(() => qq.online === 1);
    qq.images.set('/img/cat.png', PNG);
    qq.c2c({ from: 'STRANGER', attachments: [{ content_type: 'image/png', url: `${base}/img/cat.png` }] });
    await waitFor(() => host.events.length === 1);
    expect(host.events[0]?.text).toMatch(/\n\[image\]$/);
    expect(qq.callsTo('/img/cat.png')).toHaveLength(0);
  });

  it('uses the transcript of a voice message, names files and shows quotes and faces', async () => {
    const { qq, host } = await setup();
    await waitFor(() => qq.online === 1);
    qq.c2c({ from: OWNER, attachments: [{ content_type: 'voice', url: 'https://example.invalid/v.silk', asr_refer_text: '明天八点叫我' }] });
    qq.c2c({ from: OWNER, text: '看看这个', attachments: [{ content_type: 'file', url: 'https://example.invalid/f', filename: 'report.pdf' }] });
    const face = Buffer.from(JSON.stringify({ text: '[微笑]' })).toString('base64');
    qq.c2c({ from: OWNER, text: `好的 <faceType=1,faceId="14",ext="${face}">`, quoted: '原来那条' });
    await waitFor(() => host.events.length === 3);
    expect(host.events.map((e) => e.text.split('\n').slice(1).join('\n'))).toEqual(['[voice] 明天八点叫我', '看看这个\n[file report.pdf]', '[quoted: 原来那条]\n好的 【表情: [微笑]】']);
  });

  it('keeps the order of messages that arrive together', async () => {
    const { qq, host } = await setup();
    await waitFor(() => qq.online === 1);
    for (let i = 0; i < 20; i++) qq.c2c({ from: OWNER, text: `m${i}` });
    await waitFor(() => host.events.length === 20);
    expect(host.events.map((e) => e.text.split('\n')[1])).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });

  it('resumes its gateway session after a restart', async () => {
    const first = await setup();
    await waitFor(() => first.qq.online === 1);
    first.qq.c2c({ from: OWNER, text: 'one' });
    await waitFor(() => first.host.events.length === 1);
    await first.stop();
    const kv = new Map(first.host.kv);
    const second = await setup({ existing: { qq: first.qq, base: first.base }, kv });
    await waitFor(() => first.qq.handshakes.length === 2);
    expect(first.qq.handshakes[1]).toMatchObject({ op: 6, d: { session_id: 'session-1' } });
    expect(await chatSend(second.host, 'back again')).toMatchObject({ ok: true });
    expect(first.qq.sent.at(-1)).toMatchObject({ target: OWNER, content: 'back again' });
  });

  it('stops and tells the owner once when QQ refuses the connection for good', async () => {
    const first = await setup();
    await waitFor(() => first.qq.online === 1);
    first.qq.refuseWith = 4914;
    first.qq.closeAll(4914, 'offline');
    await waitFor(() => first.host.events.length === 1);
    expect(first.host.events[0]).toMatchObject({ type: 'qq.connection_refused', level: 2, trigger: 'flush' });
    expect(first.host.events[0]?.text).toContain('close code 4914');
    expect(await first.host.request('health', {})).toMatchObject({ ok: false });
    expect((await chatSend(first.host, 'hi')).error).toMatch(/closed the bot's connection for good/);
    const connections = first.qq.handshakes.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(first.qq.handshakes).toHaveLength(connections);
    await first.stop();
    // Still refused after a restart: not told again.
    const second = await setup({ existing: { qq: first.qq, base: first.base }, kv: new Map(first.host.kv) });
    await waitFor(() => first.qq.handshakes.length === connections + 1);
    await waitFor(() => second.host.logs.some((l) => l.msg === 'the QQ gateway refused the bot; not reconnecting'));
    expect(second.host.events).toHaveLength(0);
    // Once QQ serves the bot again, a later refusal is news.
    await second.stop();
    first.qq.refuseWith = null;
    const third = await setup({ existing: { qq: first.qq, base: first.base }, kv: new Map(second.host.kv) });
    await waitFor(() => first.qq.online === 1);
    await waitFor(() => !third.host.kv.has('refusedAt'));
    first.qq.refuseWith = 4914;
    first.qq.closeAll(4914, 'offline');
    await waitFor(() => third.host.events.length === 1);
  });

  it('keeps retrying when the credentials are refused, and says why', async () => {
    const { qq, host } = await setup({ secret: 'wrong-secret' });
    await waitFor(() => qq.callsTo('/app/getAppAccessToken').length >= 2);
    const h = (await host.request('health', {})) as { ok: boolean; detail?: string };
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/could not connect/);
    expect(host.logs.some((l) => l.msg === 'QQ connection failed; retrying')).toBe(true);
    expect(JSON.stringify(host.logs)).not.toContain('wrong-secret');
  });

  it('runs without credentials, connects nowhere and says it is not signed in', async () => {
    const { qq, host } = await setup({ secret: null, kv: new Map<string, unknown>([['ownerOpenid', 'OLD'], ['lastMsgId', 'm1'], ['session', { sessionId: 's', lastSeq: 3 }]]) });
    expect(await host.login.status()).toEqual({ state: 'idle' });
    expect(await host.request('health', {})).toEqual({ ok: true, detail: 'not signed in' });
    expect((await chatSend(host, 'hi')).error).toMatch(/not signed in/);
    expect(qq.calls).toHaveLength(0);
    expect([...host.kv.keys()]).toEqual([]);
  });

  it('declares the capabilities', async () => {
    const { host } = await setup({ secret: null });
    expect(host.capabilities.login).toBe(true);
    expect(host.capabilities.chat).toBe(true);
    expect(host.capabilities.chatDrafts).toBe(true);
    expect(host.capabilities.approvals).toBe(true);
  });
});

describe('qq groups', () => {
  it('delivers group messages that mention the bot and answers in the group', async () => {
    const { qq, host } = await setup({ config: { groups: true } });
    await waitFor(() => qq.online === 1);
    const id = qq.group({ group: 'GROUP1', from: 'MEMBER1', text: '机器人，今天几号？' });
    qq.group({ group: 'GROUP1', from: 'MEMBER1', text: 'not for the bot', at: false });
    await waitFor(() => host.events.length === 2);
    expect(host.events.map((e) => [e.type, e.level, e.trigger])).toEqual([
      ['qq.message', 2, 'flush'],
      ['qq.message', 4, 'store'],
    ]);
    expect(host.events[0]?.text).toBe(`Message from member MEMBER1 in QQ group GROUP1 (msg ${id}), mentioning the bot:\n机器人，今天几号？`);
    expect((await host.tools()).map((t) => t.name)).toEqual(['qq_group_reply']);
    expect(await host.callTool('qq_group_reply', { message_id: id, text: '11 月 11 日' })).toMatchObject({ text: `answered message ${id} in QQ group GROUP1` });
    expect(qq.sent).toEqual([{ scope: 'group', target: 'GROUP1', content: '11 月 11 日', msgId: id, msgType: 0 }]);
  });

  it('answers only group messages it delivered, and reports refusals', async () => {
    const { qq, host } = await setup({ config: { groups: true } });
    await waitFor(() => qq.online === 1);
    const quiet = qq.group({ group: 'GROUP1', from: 'MEMBER1', text: 'not for the bot', at: false });
    await waitFor(() => host.events.length === 1);
    expect(await host.callTool('qq_group_reply', { message_id: quiet, text: 'hi' })).toMatchObject({ failed: true });
    expect(await host.callTool('qq_group_reply', { message_id: 'made-up', text: 'hi' })).toMatchObject({ failed: true });
    const id = qq.group({ group: 'GROUP1', from: 'MEMBER1', text: 'hi bot' });
    await waitFor(() => host.events.length === 2);
    qq.sendResults.push({ status: 400, body: { code: 40054005, message: 'msg_id expired' } });
    const r = await host.callTool('qq_group_reply', { message_id: id, text: 'late' });
    expect(r).toMatchObject({ failed: true });
    expect(r.text).toContain('QQ refused the group message: msg_id expired (code 40054005)');
    expect(qq.sent).toHaveLength(0);
  });
});

describe('qq sign-in', () => {
  it('shows the connect page, hands the credentials to the host and names the scanner as owner', async () => {
    const { host, first, last, qq, base } = await signIn([{ status: 1 }, { complete: { appId: '102999888', appSecret: 'fresh-secret', userOpenid: 'SCANNER' } }], (s) => s.state === 'connected');
    expect(first).toEqual({ state: 'waiting', qr: `${base}/qqbot/openclaw/connect.html?task_id=task-1&source=&_wv=2`, message: expect.stringContaining('Scan this code with QQ') });
    expect(last).toEqual({ state: 'connected', account: '102999888' });
    expect(host.logins).toEqual([{ secrets: { [SECRET]: 'fresh-secret' }, ownerSenderKey: 'qq:SCANNER' }]);
    expect(host.kv.get('signIn')).toEqual({ appId: '102999888', secretSha256: sha256('fresh-secret') });
    expect(host.kv.get('ownerOpenid')).toBe('SCANNER');
    // Our key went to the service once, with the task; the secret never travelled in the clear.
    const key = String(qq.callsTo('/lite/create_bind_task')[0]?.body['key']);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(JSON.stringify(qq.calls)).not.toContain('fresh-secret');
  });

  it('starts a new bot from a clean state', async () => {
    const kv = new Map<string, unknown>([['lastMsgId', 'old-msg'], ['session', { sessionId: 'old', lastSeq: 9 }], ['refusedAt', 'yesterday']]);
    const { host } = await signIn([{ complete: { appId: '102999888', appSecret: 'fresh-secret', userOpenid: 'SCANNER' } }], (s) => s.state === 'connected', { kv });
    expect(host.kv.has('lastMsgId')).toBe(false);
    expect(host.kv.has('session')).toBe(false);
    expect(host.kv.has('refusedAt')).toBe(false);
  });

  it('does not change the owner when the service does not say who scanned', async () => {
    const { host } = await signIn([{ complete: { appId: '102999888', appSecret: 'fresh-secret' } }], (s) => s.state === 'connected');
    expect(host.logins).toEqual([{ secrets: { [SECRET]: 'fresh-secret' } }]);
  });

  it('shows a fresh code when one expires, and gives up after three', async () => {
    const { host, qq } = await setup({ secret: null });
    qq.bindScript.push({ status: 3 }, { status: 1 });
    expect((await host.login.start()).qr).toContain('task_id=task-1&');
    await waitFor(() => qq.callsTo('/lite/create_bind_task').length === 2);
    let s = await host.login.status();
    expect(s).toMatchObject({ state: 'waiting', message: 'The QR code expired; here is a new one.' });
    expect(s.qr).toContain('task_id=task-2&');
    qq.bindScript.push({ status: 3 }, { status: 3 });
    await waitFor(() => qq.callsTo('/lite/create_bind_task').length === 3);
    const t0 = Date.now();
    while (s.state !== 'failed' && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 5));
      s = await host.login.status();
    }
    expect(s).toEqual({ state: 'failed', message: 'The QR code expired too many times. Try again later.' });
    expect(qq.callsTo('/lite/create_bind_task')).toHaveLength(3);
    expect([...new Set(qq.callsTo('/lite/poll_bind_result').map((c) => c.body['task_id']))]).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('keeps waiting through a failed poll, and stops when cancelled', async () => {
    const { host, qq } = await setup({ secret: null });
    await host.login.start();
    await waitFor(() => qq.callsTo('/lite/poll_bind_result').length >= 3);
    expect((await host.login.status()).state).toBe('waiting');
    expect(await host.login.cancel()).toEqual({ state: 'idle' });
    const polls = qq.callsTo('/lite/poll_bind_result').length;
    await new Promise((r) => setTimeout(r, 100));
    expect(qq.callsTo('/lite/poll_bind_result').length).toBeLessThanOrEqual(polls + 1);
    expect(host.logins).toEqual([]);
  });

  it('opens what the service seals, and nothing sealed to another key', () => {
    const key = crypto.randomBytes(32).toString('base64');
    expect(decryptSecret(sealSecret('秘密 secret', key), key)).toBe('秘密 secret');
    expect(() => decryptSecret(sealSecret('x', key), crypto.randomBytes(32).toString('base64'))).toThrow();
    expect(() => decryptSecret('c2hvcnQ=', key)).toThrow();
  });

  it('fails when the credentials do not open', async () => {
    const sealed = sealSecret('x', crypto.randomBytes(32).toString('base64'));
    const { host, last } = await signIn([{ raw: { status: 2, bot_appid: '102999888', bot_encrypt_secret: sealed, user_openid: 'SCANNER' } }], (s) => s.state === 'failed');
    expect(last).toEqual({ state: 'failed', message: 'Could not open the credentials the service returned.' });
    expect(host.logins).toEqual([]);
  });

  it('fails when the service confirms without credentials, or gives no code', async () => {
    const { host, last, qq } = await signIn([{ raw: { status: 2, bot_appid: '0', bot_encrypt_secret: '' } }], (s) => s.state === 'failed');
    expect(last).toEqual({ state: 'failed', message: 'The service confirmed the sign-in but gave no credentials.' });
    await qq.stop();
    expect(await host.login.start()).toMatchObject({ state: 'failed', message: expect.stringMatching(/^Could not get a QR code/) });
  });

  it('answers a number with the same state: QQ asks for none', async () => {
    const { host } = await setup({ secret: null });
    const started = await host.login.start();
    expect(await host.login.submit('1234')).toEqual(started);
  });
});

describe('qq set up by hand', () => {
  it('uses config.appId with a secret stored by hand', async () => {
    const { qq } = await setup({ signedIn: false, config: { appId: APP } });
    await waitFor(() => qq.online === 1);
    expect(qq.callsTo('/app/getAppAccessToken')[0]?.body).toEqual({ appId: APP, clientSecret: APP_SECRET });
  });

  it('says what is missing when only the secret is there', async () => {
    const { qq, host } = await setup({ signedIn: false });
    const h = (await host.request('health', {})) as { ok: boolean; detail?: string };
    expect(h).toMatchObject({ ok: false });
    expect(h.detail).toMatch(/AppID is unknown/);
    expect((await chatSend(host, 'hi')).error).toMatch(/AppID is unknown/);
    expect(qq.calls).toHaveLength(0);
  });

  it('drops a QR sign-in whose secret was replaced by hand', async () => {
    const kv = new Map<string, unknown>([['signIn', { appId: '102999888', secretSha256: sha256('old-secret') }], ['ownerOpenid', 'OPENID-OF-THE-OLD-BOT'], ['lastMsgId', 'old']]);
    const { qq, host } = await setup({ kv, signedIn: false, config: { appId: APP } });
    await waitFor(() => qq.online === 1);
    expect(qq.callsTo('/app/getAppAccessToken')[0]?.body).toEqual({ appId: APP, clientSecret: APP_SECRET });
    expect(host.kv.has('signIn')).toBe(false);
    expect(host.kv.has('ownerOpenid')).toBe(false);
    expect((await chatSend(host, 'hi')).error).toMatch(/cannot start a conversation/);
  });
});

const choices = { options: [{ label: '周五下午', detail: '15:00' }, { label: '下周一' }] };

describe('qq rich replies', () => {
  it('sends pictures after the text, as replies to the owner', async () => {
    const { qq, host, first } = await talking();
    const handle = `blob:${'a'.repeat(64)}`;
    host.blobs.set(handle, { data: PNG, mime: 'image/png' });
    const r = await host.chatSend({ text: 'here', images: [{ handle, mime: 'image/png' }] });
    expect(r).toMatchObject({ ok: true, messageIds: ['out-1', 'out-2'] });
    expect(qq.uploads).toMatchObject([{ target: OWNER, fileType: 1 }]);
    expect(qq.uploads[0]?.data.equals(PNG)).toBe(true);
    expect(qq.sent.map((s) => [s.msgType, s.content, s.fileInfo, s.msgId])).toEqual([
      [0, 'here', undefined, first],
      [7, '', 'fi-1', first],
    ]);
  });

  it('offers one choice as buttons, and a press from the owner answers it', async () => {
    const { qq, host } = await talking();
    const r = await host.chatSend({ text: 'When?', callId: 'call_q', choices });
    expect(r).toMatchObject({ ok: true, messageIds: ['out-1'] });
    expect(qq.sent).toHaveLength(1);
    expect(qq.sent[0]?.content).toBe('When?');
    expect(qq.sent[0]?.keyboard?.content.rows.flatMap((row) => row.buttons.map((b) => [b.render_data.label, b.action.data]))).toEqual([
      ['周五下午', 'choice:0'],
      ['下周一', 'choice:1'],
    ]);
    // Someone else, or a group, cannot answer for the owner.
    qq.press({ from: 'STRANGER', data: 'choice:0', messageId: 'out-1' });
    qq.press({ from: OWNER, group: 'GROUP1', data: 'choice:0', messageId: 'out-1' });
    const mine = qq.press({ from: OWNER, data: 'choice:1', messageId: 'out-1' });
    await waitFor(() => qq.acks.length === 3 && host.events.length === 2);
    expect(qq.acks.map((a) => a.code)).toEqual([4, 4, 0]);
    expect(host.events[1]).toMatchObject({ type: 'chat.message', level: 1, senderKey: `qq:${OWNER}`, text: expect.stringContaining('下周一'), meta: { answer: { to: 'call_q', labels: ['下周一'] }, interaction: mine } });
    // Answered: a second press goes nowhere.
    qq.press({ from: OWNER, data: 'choice:0', messageId: 'out-1' });
    await waitFor(() => qq.acks.length === 4);
    expect(qq.acks[3]?.code).toBe(1);
    expect(host.events).toHaveLength(2);
    expect(host.kv.has('choices')).toBe(false);
  });

  it('falls back to a numbered list when QQ will not show buttons, and takes a number as the answer', async () => {
    const { qq, host, first } = await talking();
    qq.keyboardResults.push({ status: 400, body: { code: 304023, message: 'no permission for keyboard' } });
    const r = await host.chatSend({ text: 'When?', callId: 'call_q', choices });
    expect(r).toMatchObject({ ok: true });
    expect(qq.sent).toEqual([{ scope: 'c2c', target: OWNER, content: 'When?\n\n回复编号选择：\n1. 周五下午（15:00）\n2. 下周一', msgId: first, msgType: 0 }]);
    expect(host.kv.get('choices')).toEqual({ callId: 'call_q', labels: ['周五下午', '下周一'], multiple: false });
    const id = qq.c2c({ from: OWNER, text: ' 2 ' });
    await waitFor(() => host.events.length === 2);
    expect(host.events[1]).toMatchObject({ type: 'chat.message', correlation: id, text: expect.stringContaining('下周一'), meta: { answer: { to: 'call_q', labels: ['下周一'] } } });
    // A button of an older message does not answer the newest options.
    await host.chatSend({ text: 'And?', callId: 'call_q2', choices });
    qq.press({ from: OWNER, data: 'choice:0', messageId: 'out-0' });
    await waitFor(() => qq.acks.length === 1);
    expect(qq.acks[0]?.code).toBe(1);
    qq.c2c({ from: OWNER, text: 'skip' });
    await waitFor(() => host.events.length === 3);
    // The options are closed: another number is an ordinary message.
    qq.c2c({ from: OWNER, text: '1' });
    await waitFor(() => host.events.length === 4);
    expect(host.events[3]?.meta).not.toHaveProperty('answer');
  });

  it('asks for numbers when several may be chosen, and anything else closes the options', async () => {
    const { qq, host } = await talking();
    await host.chatSend({ text: 'Which?', callId: 'call_m', choices: { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiple: true } });
    expect(qq.sent[0]?.keyboard).toBeUndefined();
    expect(qq.sent[0]?.content).toContain('可以选多个，回复编号，用空格隔开：\n1. A\n2. B\n3. C');
    qq.c2c({ from: OWNER, text: '3，1' });
    await waitFor(() => host.events.length === 2);
    expect(host.events[1]?.meta).toMatchObject({ answer: { to: 'call_m', labels: ['A', 'C'] } });
    await host.chatSend({ text: 'Again?', callId: 'call_n', choices: { options: [{ label: 'A' }, { label: 'B' }], multiple: true } });
    qq.c2c({ from: OWNER, text: 'never mind' });
    await waitFor(() => host.events.length === 3);
    expect(host.events[2]?.meta).not.toHaveProperty('answer');
    expect(host.kv.has('choices')).toBe(false);
  });

  it('reads an answer only from numbers or a label', () => {
    const open = { labels: ['周五下午', '下周一'], multiple: false };
    expect(answerOf('1', open)).toEqual(['周五下午']);
    expect(answerOf('下周一', open)).toEqual(['下周一']);
    expect(answerOf('1 2', open)).toBeNull();
    expect(answerOf('3', open)).toBeNull();
    expect(answerOf('1 and', open)).toBeNull();
    expect(answerOf('2 1 2', { ...open, multiple: true })).toEqual(['周五下午', '下周一']);
  });

  it('shows the reply while it is written, and the sent reply finishes that same message', async () => {
    const { qq, host, first } = await talking();
    host.chatDraft({ callId: 'call_s', batchId: 'b1', state: 'writing', text: 'Hel' });
    await waitFor(() => qq.streamFrames.length === 1);
    host.chatDraft({ callId: 'call_s', batchId: 'b1', state: 'writing', text: 'Hello wor' });
    const r = await host.chatSend({ text: 'Hello world', callId: 'call_s' });
    expect(r).toMatchObject({ ok: true, messageIds: ['stm-1'] });
    const frames = qq.streamFrames.map((f) => [f['index'], f['input_state'], f['content_raw'], f['msg_id']]);
    expect(frames[0]).toEqual([0, 1, 'Hel', first]);
    expect(frames.at(-1)).toEqual([frames.length - 1, 10, 'Hello world', first]);
    // Nothing was sent as a separate message.
    expect(qq.sent).toEqual([]);
  });

  it('rewrites a preview whose reply is withdrawn', async () => {
    const { qq, host } = await talking();
    host.chatDraft({ callId: 'call_x', batchId: 'b1', state: 'writing', text: 'Let me' });
    await waitFor(() => qq.streamFrames.length === 1);
    host.chatDraft({ callId: 'call_x', batchId: 'b1', state: 'discarded' });
    await waitFor(() => qq.streamFrames.some((f) => f['input_state'] === 10));
    expect(qq.streamFrames.at(-1)).toMatchObject({ input_state: 10, content_raw: '（这条回复没有写完，已撤回）' });
  });

  it('sends the reply whole when QQ will not stream', async () => {
    const { qq, host, first } = await talking();
    qq.streamResults.push({ status: 400, body: { code: 304050, message: 'stream not allowed' } });
    host.chatDraft({ callId: 'call_f', batchId: 'b1', state: 'writing', text: 'Hi' });
    host.chatDraft({ callId: 'call_f', batchId: 'b1', state: 'writing', text: 'Hi there' });
    expect(await host.chatSend({ text: 'Hi there!', callId: 'call_f' })).toMatchObject({ ok: true, messageIds: ['out-1'] });
    expect(qq.streamFrames).toEqual([]);
    expect(qq.sent).toMatchObject([{ content: 'Hi there!', msgId: first }]);
  });

  it('keeps open options across a restart, but previews only after a new message', async () => {
    const first = await talking();
    await first.host.chatSend({ text: 'When?', callId: 'call_r', choices });
    await first.stop();
    const second = await setup({ existing: { qq: first.qq, base: first.base }, kv: new Map(first.host.kv) });
    await waitFor(() => first.qq.handshakes.length === 2);
    // The window to stream may have passed while it was down: no preview, the reply comes whole.
    second.host.chatDraft({ callId: 'call_late', batchId: 'b2', state: 'writing', text: 'Back' });
    expect(await second.host.chatSend({ text: 'Back.', callId: 'call_late' })).toMatchObject({ ok: true });
    expect(first.qq.streamFrames).toEqual([]);
    // The buttons sent before the restart still answer.
    first.qq.press({ from: OWNER, data: 'choice:0', messageId: 'out-1' });
    await waitFor(() => second.host.events.length === 1);
    expect(second.host.events[0]?.meta).toMatchObject({ answer: { to: 'call_r', labels: ['周五下午'] } });
  });

  it('streams the text, then sends pictures and options after it', async () => {
    const { qq, host } = await talking();
    const handle = `blob:${'b'.repeat(64)}`;
    host.blobs.set(handle, { data: PNG, mime: 'image/png' });
    host.chatDraft({ callId: 'call_all', batchId: 'b1', state: 'writing', text: 'Look', pending: ['images'] });
    await waitFor(() => qq.streamFrames.length === 1);
    const r = await host.chatSend({ text: 'Look at this.', callId: 'call_all', images: [{ handle, mime: 'image/png' }], choices });
    expect(r).toMatchObject({ ok: true, messageIds: ['stm-1', 'out-1', 'out-2'] });
    expect(qq.streamFrames.at(-1)).toMatchObject({ input_state: 10, content_raw: 'Look at this.' });
    expect(qq.sent.map((s) => [s.msgType, s.content, !!s.keyboard])).toEqual([
      [7, '', false],
      [0, '请选择：', true],
    ]);
  });
});
