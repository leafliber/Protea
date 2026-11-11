import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, silentLogger, textReply, toolCall, type ProviderRequest } from '@protea/core';
import type { PluginLoginView, PluginStatus } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';
import { FakeQq } from '../../../plugins/qq/test/fake-qq.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNER = 'SCANNER0OPENID';
const APP = '102345678';
const APP_SECRET = 'qq-secret-from-the-service';
const READONLY = 'readonly-token-123456';

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function lastUser(req: ProviderRequest): string {
  const m = req.messages.at(-1);
  if (m?.role !== 'user') return '';
  return m.content.map((b) => (b.type === 'text' ? String(b['text']) : b.type === 'tool_result' ? String(b['content']) : '')).join('\n');
}

/** Whether any file under `dir` but the secret store holds `text`. A file renamed or removed meanwhile is skipped. */
function anyFileHolds(dir: string, text: string): string | undefined {
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => path.join(f.parentPath, f.name));
  return files.filter((f) => !f.includes(`${path.sep}secrets${path.sep}`)).find((f) => {
    try {
      return fs.readFileSync(f).includes(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  });
}

let groupMessage = '';
const provider = new ScriptedProvider([
  (req) => {
    if (req.role !== 'main') return textReply('ok');
    const said = lastUser(req);
    if (said.includes('hello from qq')) return reply([toolCall('chat_send', { platform: 'qq', text: 'hi owner' })]);
    // Asked first, and again once the owner approved, with the same input.
    if (said.includes('hello group bot') || /Approval \S+ was approved by the owner/.test(said)) return reply([toolCall('qq_group_reply', { message_id: groupMessage, text: 'hi group' })]);
    return reply([toolCall('idle', {})]);
  },
]);

/** The plugin the way it ships: one bundled file next to its manifest, away from any node_modules. */
function bundleQq(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-qq-build-'));
  for (const f of ['protea.plugin.json', 'config.schema.json', 'ENV_PROMPT.md']) fs.copyFileSync(path.join(REPO, 'plugins/qq', f), path.join(out, f));
  execFileSync(process.execPath, [path.join(REPO, 'scripts/bundle-plugin.mjs'), path.join(REPO, 'plugins/qq'), path.join(out, 'dist')], { stdio: 'pipe' });
  return out;
}

describe('QQ: scan to create the bot and sign in, then talk to the owner', () => {
  let qq: FakeQq;
  let base: string;
  let d: Daemon;
  let dataDir: string;
  const call = async <T>(method: string, p: string, body?: unknown, token = d.adminToken): Promise<{ status: number; json: T; text: string }> => {
    const res = await fetch(`${d.url}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as T, text };
  };
  const loginState = async (): Promise<PluginLoginView> => (await call<PluginLoginView>('GET', '/api/plugins/qq/login')).json;

  beforeAll(async () => {
    qq = new FakeQq();
    base = await qq.start();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-qq-'));
    fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'secrets', 'PROTEA_READONLY_TOKEN'), `${READONLY}\n`);
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), ['# kept across edits', 'pluginHost:', '  restartBackoffMs: [200]', ''].join('\n'));
    d = await startDaemon({ dataDir, provider, listen: '127.0.0.1:0', logger: silentLogger(), env: {} });
  });

  afterAll(async () => {
    await d?.stop('test end');
    await qq?.stop();
  });

  it('runs the whole sign-in and conversation with the bundled plugin', async () => {
    // Discovered, off until an operator turns it on, and it says so instead of failing.
    expect((await call<PluginStatus>('GET', '/api/plugins/qq')).json).toMatchObject({ state: 'loaded', enabled: false });
    expect((await loginState()).state).toBe('unavailable');

    expect((await call('PATCH', '/api/plugins/qq/config', { config: { apiBase: base, tokenBase: base, bindBase: base, groups: true } })).status).toBe(200);
    expect((await call<PluginStatus>('POST', '/api/plugins', { path: bundleQq() })).status).toBe(201);
    await waitUntil(async () => (await call<PluginStatus>('GET', '/api/plugins/qq')).json.state === 'running', 'the plugin to run');
    expect(await loginState()).toEqual({ state: 'idle' });
    expect(qq.callsTo('/app/getAppAccessToken')).toHaveLength(0);

    // A read-only caller can neither read the QR code nor start a sign-in.
    expect((await call('GET', '/api/plugins/qq/login', undefined, READONLY)).status).toBe(403);
    expect((await call('POST', '/api/plugins/qq/login', {}, READONLY)).status).toBe(403);

    // The operator starts the sign-in; the code is drawn on our side.
    const started = (await call<PluginLoginView>('POST', '/api/plugins/qq/login', {})).json;
    expect(started).toMatchObject({ state: 'waiting', qr: { text: `${base}/qqbot/openclaw/connect.html?task_id=task-1&source=&_wv=2` } });
    expect(started.qr?.svg).toMatch(/^<svg /);
    // The owner scans with QQ and confirms: QQ creates the bot and hands over its credentials.
    qq.apps.set(APP, APP_SECRET);
    qq.bindScript.push({ status: 1 }, { complete: { appId: APP, appSecret: APP_SECRET, userOpenid: SCANNER } });
    await waitUntil(async () => (await loginState()).state === 'connected', 'the sign-in', 20_000);
    expect(await loginState()).toEqual({ state: 'connected', account: APP });

    // The AppSecret went to the secret store, and to no response, file or log of anyone else's.
    const secrets = (await call<{ secrets: Array<{ name: string; source: string }> }>('GET', '/api/secrets')).json.secrets;
    expect(secrets.find((s) => s.name === 'QQ_APP_SECRET')).toMatchObject({ source: 'file' });
    expect(fs.readFileSync(path.join(dataDir, 'secrets', 'QQ_APP_SECRET'), 'utf8').trim()).toBe(APP_SECRET);
    expect(fs.statSync(path.join(dataDir, 'secrets', 'QQ_APP_SECRET')).mode & 0o777).toBe(0o600);
    expect((await call('GET', '/api/config')).text).not.toContain(APP_SECRET);
    expect((await call('GET', '/api/plugins/qq')).text).not.toContain(APP_SECRET);

    // The scanner is the owner now, and that is written down.
    const yaml = fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8');
    expect(yaml).toContain('# kept across edits');
    expect(yaml).toContain(`qq:${SCANNER}`);

    // The restarted plugin connects with the bot's credentials.
    await waitUntil(() => qq.online === 1, 'the gateway connection');
    expect(qq.callsTo('/app/getAppAccessToken').at(-1)?.body).toEqual({ appId: APP, clientSecret: APP_SECRET });
    expect((await call<PluginStatus>('GET', '/api/plugins/qq')).json.tools).toEqual(['qq_group_reply']);

    // The owner writes; the assistant answers through chat_send, as a reply to that message.
    const hello = qq.c2c({ from: SCANNER, text: 'hello from qq' });
    await waitUntil(() => qq.sent.length > 0, 'the reply');
    expect(qq.sent[0]).toEqual({ scope: 'c2c', target: SCANNER, content: 'hi owner', msgId: hello });
    const stored = d.store.query({ type: 'chat.message', source: 'qq' });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ senderRole: 'owner', level: 1 });

    // With groups on, someone mentions the bot in a group. Answering there asks first, and the
    // owner approves on QQ.
    groupMessage = qq.group({ group: 'GROUP1', from: 'MEMBER1', text: 'hello group bot' });
    await waitUntil(() => qq.sent.some((s) => s.content.startsWith('Approval ')), 'the approval request on QQ');
    const asked = qq.sent.find((s) => s.content.startsWith('Approval '));
    expect(asked).toMatchObject({ scope: 'c2c', target: SCANNER, msgId: hello });
    expect(asked?.content).toContain('qq_group_reply');
    expect(qq.sent.some((s) => s.scope === 'group')).toBe(false);
    const approval = /^Approval (\S+) requested/.exec(asked?.content ?? '')?.[1] as string;
    qq.c2c({ from: SCANNER, text: `/approve ${approval}` });
    await waitUntil(() => qq.sent.some((s) => s.scope === 'group'), 'the group answer');
    expect(qq.sent.find((s) => s.scope === 'group')).toEqual({ scope: 'group', target: 'GROUP1', content: 'hi group', msgId: groupMessage });

    // Someone else's private message is stored and wakes nobody.
    const sentBefore = qq.sent.length;
    qq.c2c({ from: 'STRANGER', text: 'who is this' });
    await waitUntil(() => d.store.query({ type: 'qq.message', source: 'qq' }).length === 2, 'the stranger’s event');
    expect(qq.sent).toHaveLength(sentBefore);

    expect(anyFileHolds(dataDir, APP_SECRET)).toBeUndefined();

    // Signing out forgets the secret and the owner, and the platform stays up, signed out.
    expect((await call<PluginStatus>('DELETE', '/api/plugins/qq/login')).status).toBe(200);
    await waitUntil(async () => (await loginState()).state === 'idle', 'the sign-out');
    expect(fs.existsSync(path.join(dataDir, 'secrets', 'QQ_APP_SECRET'))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).not.toContain(`qq:${SCANNER}`);
    await waitUntil(() => qq.online === 0, 'the gateway to close');
  }, 90_000);
});
