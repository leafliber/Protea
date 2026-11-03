import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, setConfigValue, silentLogger, textReply, toolCall, type ProviderRequest } from '@protea/core';
import type { ApprovalInfo, PluginStatus } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';
import { FakeTelegram } from '../../../plugins/telegram/test/fake-telegram.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const OWNER = 4242;

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function lastUser(req: ProviderRequest): string {
  const m = req.messages.at(-1);
  if (m?.role !== 'user') return '';
  return m.content.map((b) => (b.type === 'text' ? String(b['text']) : b.type === 'tool_result' ? String(b['content']) : '')).join('\n');
}

/** The model: answers the owner on Telegram, asks to post to a group, posts once approved. */
const provider = new ScriptedProvider([
  (req) => {
    if (req.role !== 'main') return textReply('ok');
    const last = lastUser(req);
    const family = toolCall('tg_send_chat', { chat_id: -100, text: 'Dinner at 7' });
    if (last.includes('type="approval.decided"') && last.includes('was approved')) return reply([family]);
    if (last.includes('post to family')) return reply([family]);
    if (last.includes('hello from telegram') || last.includes('while you were down')) return reply([toolCall('tg_send', { text: 'hi owner' })]);
    return reply([toolCall('idle', {})]);
  },
]);

/** Build the Telegram plugin the way it ships: one bundled file next to its manifest. */
function bundleTelegram(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-tg-build-'));
  for (const f of ['protea.plugin.json', 'config.schema.json', 'ENV_PROMPT.md']) fs.copyFileSync(path.join(REPO, 'plugins/telegram', f), path.join(out, f));
  execFileSync(process.execPath, [path.join(REPO, 'scripts/bundle-plugin.mjs'), path.join(REPO, 'plugins/telegram'), path.join(out, 'dist')], { stdio: 'pipe' });
  return out;
}

describe('M2 acceptance: plugins are hot-pluggable while the main session keeps running', () => {
  let tg: FakeTelegram;
  let apiBase: string;
  let d: Daemon;
  let dataDir: string;
  const api = async <T>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${d.url}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  const plugin = async (): Promise<PluginStatus> => (await api<PluginStatus>('GET', '/api/plugins/telegram')).json;

  beforeAll(async () => {
    tg = new FakeTelegram();
    apiBase = await tg.start();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m2-'));
    fs.writeFileSync(
      path.join(dataDir, 'config.yaml'),
      [
        '# operator comments survive edits made through the API',
        'owner:',
        '  identities:',
        '    - { plugin: console, senderKey: "*" }',
        `    - { plugin: telegram, senderKey: "telegram:${OWNER}" }`,
        'pluginHost:',
        '  restartBackoffMs: [200]',
        '',
      ].join('\n'),
    );
    d = await startDaemon({
      dataDir,
      provider,
      listen: '127.0.0.1:0',
      logger: silentLogger(),
      env: { PROTEA_SECRET_TELEGRAM_BOT_TOKEN: tg.token },
    });
  });

  afterAll(async () => {
    await d?.stop('test end');
    await tg?.stop();
  });

  it('runs the whole lifecycle', async () => {
    const runId = d.runId;
    const transcript = d.transcript;

    // The built-in plugins are discovered; Telegram is off until it is configured.
    expect(await plugin()).toMatchObject({ state: 'loaded', enabled: false, origin: 'builtin', version: '0.1.0' });
    expect((await api<{ plugins: PluginStatus[] }>('GET', '/api/plugins')).json.plugins.map((p) => p.id)).toEqual([
      'console',
      'cron',
      'filewatch',
      'imap',
      'rss',
      'telegram',
      'webhook',
    ]);

    // Configure, then install a shipped build into the data volume — all while running.
    expect((await api('PATCH', '/api/plugins/telegram/config', { config: { apiBase, pollTimeoutSec: 1 } })).status).toBe(200);
    const installed = await api<PluginStatus>('POST', '/api/plugins', { path: bundleTelegram() });
    expect(installed.status).toBe(201);
    expect(installed.json).toMatchObject({ state: 'running', enabled: true, origin: 'data', tools: ['tg_react', 'tg_send', 'tg_send_chat'] });
    const yaml = fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf8');
    expect(yaml).toContain('# operator comments survive edits made through the API');
    expect(yaml).toMatch(/telegram:\n\s+config:\n\s+apiBase:/);

    // The owner writes; the assistant answers on Telegram.
    tg.inject({ fromId: OWNER, text: 'hello from telegram' });
    await waitUntil(() => tg.sent.some((m) => m.text === 'hi owner'), 'reply to the owner');
    expect(tg.sent.find((m) => m.text === 'hi owner')?.chat_id).toBe(OWNER);
    const asked = provider.calls.find((c) => lastUser(c).includes('hello from telegram'));
    expect(asked?.tools.map((t) => t.name)).toContain('tg_send');
    expect(asked?.system.map((s) => s.id)).toContain('env:telegram');
    expect(asked?.system.find((s) => s.id === 'permissions')?.text).toContain("Needs the owner's approval: tg_send_chat");

    // A side effect that needs approval: requested on Telegram, approved there, then run once.
    tg.inject({ fromId: OWNER, text: 'post to family' });
    await waitUntil(() => tg.sent.some((m) => m.text.includes('Reply /approve a1')), 'approval request');
    expect(tg.sent.some((m) => m.chat_id === -100)).toBe(false);
    tg.inject({ fromId: OWNER, text: '/approve a1' });
    await waitUntil(() => tg.sent.some((m) => m.chat_id === -100 && m.text === 'Dinner at 7'), 'approved post');
    expect(((await api<ApprovalInfo>('GET', '/api/approvals?state=used')).json as unknown as { approvals: ApprovalInfo[] }).approvals).toMatchObject([
      { id: 'a1', tool: 'tg_send_chat', state: 'used', decidedBy: `telegram:telegram:${OWNER}` },
    ]);
    expect(d.audit.list({ tool: 'tg_send_chat' }).map((r) => `${r.kind}:${r.outcome ?? ''}`).reverse()).toEqual([
      'approval_requested:',
      'tool_blocked:pending_approval',
      'approval_decided:approved',
      'tool_call:ok',
    ]);

    // kill -9: the plugin comes back, and a message sent meanwhile is not lost.
    const before = await plugin();
    process.kill(before.pid as number, 'SIGKILL');
    tg.inject({ fromId: OWNER, text: 'while you were down' });
    await waitUntil(() => tg.sent.filter((m) => m.text === 'hi owner').length === 2, 'reply after the restart');
    const after = await plugin();
    expect(after).toMatchObject({ state: 'running', restarts: 1 });
    expect(after.pid).not.toBe(before.pid);
    expect(d.store.query({ type: 'telegram.message' }).filter((e) => e.text.includes('while you were down'))).toHaveLength(1);
    expect(d.store.query({ type: 'plugin.crashed' })).toHaveLength(1);

    // Reload new code: the new version runs.
    const manifestFile = path.join(dataDir, 'plugins', 'telegram', 'protea.plugin.json');
    fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('"version": "0.1.0"', '"version": "0.2.0"'));
    const reloaded = await api<PluginStatus>('POST', '/api/plugins/telegram/reload');
    expect(reloaded.json).toMatchObject({ state: 'running', version: '0.2.0' });
    expect(reloaded.json.pid).not.toBe(after.pid);

    // Disable: its tools leave the next request.
    expect((await api<PluginStatus>('POST', '/api/plugins/telegram/disable')).json).toMatchObject({ state: 'stopped', enabled: false, tools: [] });
    const calls = provider.calls.length;
    await api('POST', '/api/events', { text: 'anything new?' });
    await waitUntil(() => provider.calls.length > calls && !d.main.busy, 'next turn');
    expect(provider.calls.at(-1)?.tools.map((t) => t.name).filter((n) => n.startsWith('tg_'))).toEqual([]);
    expect(provider.calls.at(-1)?.system.map((s) => s.id)).not.toContain('env:telegram');

    // Uninstall: the built-in comes back, unconfigured.
    const removed = await api<{ replacedBy: PluginStatus }>('DELETE', '/api/plugins/telegram');
    expect(removed.json.replacedBy).toMatchObject({ origin: 'builtin', state: 'loaded', enabled: false });
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'telegram'))).toBe(false);

    // The main session was never restarted.
    expect(d.runId).toBe(runId);
    expect(d.transcript).toBe(transcript);
    expect(fs.readdirSync(path.join(dataDir, 'sessions')).filter((f) => f.startsWith('main.') && f.endsWith('.jsonl'))).toEqual(['main.0001.jsonl']);
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM batches WHERE end_reason IS NULL').get()).toEqual({ n: 0 });
  }, 90_000);

  it('applies config.yaml edits without a restart', async () => {
    setConfigValue(dataDir, ['permissions', 'tools', 'con_send'], 'deny');
    await waitUntil(() => d.config.permissions.tools['con_send'] === 'deny', 'config reload');
    const calls = provider.calls.length;
    await api('POST', '/api/events', { text: 'status?' });
    await waitUntil(() => provider.calls.length > calls && !d.main.busy, 'next turn');
    expect(provider.calls.at(-1)?.system.find((s) => s.id === 'permissions')?.text).toContain('Not allowed: con_send');
    setConfigValue(dataDir, ['permissions', 'tools', 'con_send'], undefined);
    await waitUntil(() => d.config.permissions.tools['con_send'] === undefined, 'config reload back');
  });

  it('forwards /hooks/<name> to the webhook plugin, which verifies signatures', async () => {
    fs.writeFileSync(path.join(dataDir, 'secrets', 'ALERT_TOKEN'), 'tok-alerts-1\n', { mode: 0o600 });
    setConfigValue(dataDir, ['plugins', 'webhook'], { enabled: true, config: { hooks: [{ name: 'alerts', verify: 'token', secret: '${secret:ALERT_TOKEN}' }] } });
    await waitUntil(() => d.plugins.get('webhook')?.state === 'running', 'webhook running');
    const post = (token: string) =>
      fetch(`${d.url}/hooks/alerts`, { method: 'POST', headers: { 'x-webhook-token': token, 'content-type': 'text/plain' }, body: 'disk 91% full' });
    expect((await post('wrong')).status).toBe(401);
    const ok = await post('tok-alerts-1');
    expect(ok.status).toBe(202);
    const { cursor } = (await ok.json()) as { cursor: number };
    expect(d.store.get(cursor)).toMatchObject({ type: 'webhook.alerts', source: 'webhook', effLevel: 2, text: 'Webhook alerts received text/plain, 13 bytes:\ndisk 91% full' });
    expect((await fetch(`${d.url}/hooks/nobody`, { method: 'POST' })).status).toBe(404);
  });
});
