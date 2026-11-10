import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, silentLogger, textReply, toolCall, type ProviderRequest } from '@protea/core';
import type { PluginLoginView, PluginStatus } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';
import { FakeIlink } from '../../../plugins/wechat/test/fake-ilink.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNER = 'scanner@im.wechat';
const TOKEN = 'wechat-token-from-the-service';
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

const provider = new ScriptedProvider([
  (req) => {
    if (req.role !== 'main') return textReply('ok');
    return lastUser(req).includes('hello from wechat') ? reply([toolCall('chat_send', { platform: 'wechat', text: 'hi owner' })]) : reply([toolCall('idle', {})]);
  },
]);

/** The plugin the way it ships: one bundled file next to its manifest, away from any node_modules. */
function bundleWechat(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-wechat-build-'));
  for (const f of ['protea.plugin.json', 'config.schema.json', 'ENV_PROMPT.md']) fs.copyFileSync(path.join(REPO, 'plugins/wechat', f), path.join(out, f));
  execFileSync(process.execPath, [path.join(REPO, 'scripts/bundle-plugin.mjs'), path.join(REPO, 'plugins/wechat'), path.join(out, 'dist')], { stdio: 'pipe' });
  return out;
}

describe('WeChat: scan to sign in, then talk to the owner', () => {
  let il: FakeIlink;
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
  const loginState = async (): Promise<PluginLoginView> => (await call<PluginLoginView>('GET', '/api/plugins/wechat/login')).json;

  beforeAll(async () => {
    il = new FakeIlink();
    base = await il.start();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-wechat-'));
    fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'secrets', 'PROTEA_READONLY_TOKEN'), `${READONLY}\n`);
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), ['# kept across edits', 'pluginHost:', '  restartBackoffMs: [200]', ''].join('\n'));
    d = await startDaemon({ dataDir, provider, listen: '127.0.0.1:0', logger: silentLogger(), env: {} });
  });

  afterAll(async () => {
    await d?.stop('test end');
    await il?.stop();
  });

  it('runs the whole sign-in and conversation with the bundled plugin', async () => {
    // Discovered, off until an operator turns it on, and it says so instead of failing.
    expect((await call<PluginStatus>('GET', '/api/plugins/wechat')).json).toMatchObject({ state: 'loaded', enabled: false });
    expect((await loginState()).state).toBe('unavailable');
    expect((await call('POST', '/api/plugins/telegram/login')).status).toBe(404);

    expect((await call('PATCH', '/api/plugins/wechat/config', { config: { apiBase: base, cdnBase: `${base}/c2c` } })).status).toBe(200);
    expect((await call<PluginStatus>('POST', '/api/plugins', { path: bundleWechat() })).status).toBe(201);
    await waitUntil(async () => (await call<PluginStatus>('GET', '/api/plugins/wechat')).json.state === 'running', 'the plugin to run');
    expect(await loginState()).toEqual({ state: 'idle' });
    // Not signed in: the platform answers with the reason, the daemon stays up.
    expect(il.callsTo('/getupdates')).toHaveLength(0);

    // A read-only caller can neither read the QR code nor start a sign-in.
    expect((await call('GET', '/api/plugins/wechat/login', undefined, READONLY)).status).toBe(403);
    expect((await call('POST', '/api/plugins/wechat/login', {}, READONLY)).status).toBe(403);

    // The operator signs in; the code is drawn on our side.
    const started = (await call<PluginLoginView>('POST', '/api/plugins/wechat/login', {})).json;
    expect(started).toMatchObject({ state: 'waiting', qr: { text: 'https://liteapp.example/q/1' } });
    expect(started.qr?.svg).toMatch(/^<svg /);
    expect(started.qr?.terminal.length).toBeGreaterThan(100);
    il.qrScript.push({ status: 'scaned' }, { status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-e2e@im.bot', ilink_user_id: SCANNER, baseurl: base });
    await waitUntil(async () => (await loginState()).state === 'connected', 'the sign-in', 20_000);
    expect(await loginState()).toEqual({ state: 'connected', account: SCANNER });

    // The token went to the secret store, and to no response or file of the plugin's.
    const secrets = (await call<{ secrets: Array<{ name: string; source: string }> }>('GET', '/api/secrets')).json.secrets;
    expect(secrets.find((s) => s.name === 'WECHAT_BOT_TOKEN')).toMatchObject({ source: 'file' });
    expect(fs.readFileSync(path.join(dataDir, 'secrets', 'WECHAT_BOT_TOKEN'), 'utf8').trim()).toBe(TOKEN);
    expect(fs.statSync(path.join(dataDir, 'secrets', 'WECHAT_BOT_TOKEN')).mode & 0o777).toBe(0o600);
    expect((await call('GET', '/api/config')).text).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(dataDir, 'plugin-data', 'wechat', 'openclaw.json'), 'utf8')).not.toContain(TOKEN);

    // The scanner is the owner now, and that is written down.
    const yaml = fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8');
    expect(yaml).toContain('# kept across edits');
    expect(yaml).toContain(`wechat:${SCANNER}`);

    // The restarted plugin polls with the token. The headers prove the shipped bundle found the
    // official package's identity, which it reads from a package.json next to the bundle.
    await waitUntil(() => il.callsTo('/getupdates').length > 0, 'the first poll');
    const poll = il.callsTo('/getupdates')[0];
    expect(poll?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(poll?.headers['ilink-app-id']).toBe('bot');
    expect(poll?.headers['ilink-app-clientversion']).toBe(String((2 << 16) | (4 << 8) | 10));
    expect(poll?.body['base_info']).toEqual({ channel_version: '2.4.10', bot_agent: 'Protea/0.1.0' });
    expect(il.callsTo('/notifystart').length).toBeGreaterThan(0);

    // The owner writes; the assistant answers through chat_send.
    il.inject({ from: SCANNER, text: 'hello from wechat', contextToken: 'ctx-owner' });
    await waitUntil(() => il.sent.length > 0, 'the reply');
    expect(il.sent[0]).toEqual({ to: SCANNER, text: 'hi owner', contextToken: 'ctx-owner' });
    const stored = d.store.query({ type: 'chat.message', source: 'wechat' });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ senderRole: 'owner', level: 1 });

    // Someone else's message is stored and wakes nobody.
    il.inject({ from: 'stranger@im.wechat', text: 'who is this' });
    await waitUntil(() => d.store.query({ type: 'wechat.message', source: 'wechat' }).length === 1, 'the stranger’s event');
    expect(il.sent).toHaveLength(1);

    // Signing out forgets the token and the owner, and the platform stays up, signed out.
    const pollsBefore = il.callsTo('/getupdates').length;
    expect((await call<PluginStatus>('DELETE', '/api/plugins/wechat/login')).status).toBe(200);
    await waitUntil(async () => (await loginState()).state === 'idle', 'the sign-out');
    expect(fs.existsSync(path.join(dataDir, 'secrets', 'WECHAT_BOT_TOKEN'))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8')).not.toContain(`wechat:${SCANNER}`);
    await new Promise((r) => setTimeout(r, 400));
    expect(il.callsTo('/getupdates').length).toBeLessThanOrEqual(pollsBefore + 1);
  }, 60_000);
});
