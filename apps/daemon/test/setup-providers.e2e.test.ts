import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountInfo, ProbeProviderResponse, ProvidersResponse, StatusResponse } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function dataDir(yaml = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-setup-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), `observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n${yaml}`);
  return dir;
}

/** A fake OpenAI-compatible model server: answers every batch with chat_send, then ends the turn. */
const calls: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
let model: http.Server;
let modelUrl = '';
beforeAll(async () => {
  model = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-large' }, { id: 'fake-small' }] }));
        return;
      }
      const messages = (body['messages'] as Array<{ role: string; content: string | null }> | undefined) ?? [];
      const last = messages.at(-1);
      const chunks =
        last?.role === 'user' && String(last.content).includes('<event')
          ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'chat_send', arguments: JSON.stringify({ platform: 'webchat', text: 'hello from the fake model' }) } }] }, finish_reason: 'tool_calls' }] }]
          : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify({ model: body['model'], ...c })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => model.close(() => r())));

type Res<T> = { status: number; json: T; cookie: string | null };
function client(d: Daemon, auth: { token?: string; cookie?: string } = {}) {
  return async <T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<Res<T>> => {
    const headers: Record<string, string> = {};
    if (auth.token) headers['authorization'] = `Bearer ${auth.token}`;
    if (auth.cookie) {
      headers['cookie'] = auth.cookie;
      headers['x-protea-csrf'] = '1';
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${d.url}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
  };
}

describe('first-run setup, accounts and provider profiles', () => {
  it('creates the admin account with the printed setup code, then configures a provider from the console', async () => {
    const dir = dataDir();
    const printed: string[] = [];
    const d = await startDaemon({ dataDir: dir, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: (t) => printed.push(t) });
    running.push(d);
    const anon = client(d);
    const api = client(d, { token: d.adminToken });

    // Nothing configured: setup pending, no provider.
    const codeFile = path.join(dir, 'secrets', 'PROTEA_SETUP_CODE');
    const code = fs.readFileSync(codeFile, 'utf8').trim();
    expect(printed.join('')).toContain(code);
    expect(fs.readFileSync(path.join(d.runDir, 'log.jsonl'), 'utf8')).not.toContain(code);
    expect((await anon<{ required: boolean }>('GET', '/api/setup')).json).toEqual({ required: true });
    const st = (await api<StatusResponse>('GET', '/api/status')).json;
    expect(st.setupRequired).toBe(true);
    expect(st.provider).toMatchObject({ id: 'none', ready: false, problem: expect.stringContaining('no model provider is configured') });

    // Setup: a wrong code is refused; the right one creates the admin and signs in.
    expect((await anon('POST', '/api/setup', { code: 'AAAA-BBBB-CCCC-DDDD', username: 'owner', password: 'long enough' })).status).toBe(401);
    expect((await anon('POST', '/api/setup', { code, username: 'owner', password: 'short' })).status).toBe(400);
    const setup = await anon<{ username: string }>('POST', '/api/setup', { code: code.toLowerCase(), username: 'owner', password: 'long enough' });
    expect(setup.status).toBe(201);
    expect(setup.cookie).toMatch(/^protea_session=v2\./);
    expect(fs.existsSync(codeFile)).toBe(false);
    expect((await anon('POST', '/api/setup', { code, username: 'second', password: 'long enough' })).status).toBe(409);
    const owner = client(d, { cookie: setup.cookie as string });
    expect((await owner('GET', '/api/auth/whoami')).json).toEqual({ role: 'admin', via: 'cookie', username: 'owner' });

    // Password sign-in; a wrong password is refused.
    expect((await anon('POST', '/api/auth/login', { username: 'owner', password: 'not it at all' })).status).toBe(401);
    const login = await anon<{ username: string }>('POST', '/api/auth/login', { username: 'owner', password: 'long enough' });
    expect(login.json.username).toBe('owner');

    // Test the form's values before saving: a key typed into the form, the endpoint's models.
    const profile = { protocol: 'openai-chat', baseUrl: modelUrl, models: { main: 'fake-large', cheap: 'fake-small' } };
    const models = await owner<ProbeProviderResponse>('POST', '/api/providers/models', { id: 'fake', profile, apiKey: 'sk-fake-123456' });
    expect(models.json).toMatchObject({ ok: true, models: ['fake-large', 'fake-small'] });
    const test = await owner<ProbeProviderResponse>('POST', '/api/providers/test', { id: 'fake', profile, apiKey: 'sk-fake-123456' });
    expect(test.json).toMatchObject({ ok: true, model: 'fake-large', reply: 'OK' });
    expect(calls.at(-1)?.auth).toBe('Bearer sk-fake-123456');

    // Save it with the key: the first profile becomes the default and applies without a restart.
    const saved = await owner<ProvidersResponse>('PUT', '/api/providers/fake', { profile, apiKey: 'sk-fake-123456' });
    expect(saved.status).toBe(200);
    expect(saved.json.default).toBe('fake');
    expect(saved.json.ready).toBe(true);
    expect(saved.json.profiles[0]).toMatchObject({ id: 'fake', roles: ['main', 'fork', 'cheap'], key: { required: true, set: true, source: 'file' }, endpoint: modelUrl, ready: true });
    expect(fs.readFileSync(path.join(dir, 'secrets', 'PROVIDER_FAKE_API_KEY'), 'utf8').trim()).toBe('sk-fake-123456');
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).not.toContain('sk-fake');
    expect(JSON.stringify(saved.json)).not.toContain('sk-fake');
    expect(d.status().provider).toMatchObject({ id: 'fake', protocol: 'openai-chat', mainModel: 'fake-large', ready: true });

    // A console message now goes to the fake model and its reply comes back.
    const before = calls.length;
    const pushed = await owner<{ cursor: number }>('POST', '/api/events', { text: 'hi there' });
    expect(pushed.status).toBe(201);
    await waitUntil(() => d.store.get(pushed.json.cursor)?.state === 'delivered', 'the console event delivered');
    await waitUntil(() => calls.slice(before).filter((c) => c.path === '/v1/chat/completions').length >= 2, 'the tool result sent back');
    const used = calls.slice(before).find((c) => c.path === '/v1/chat/completions');
    expect(used?.auth).toBe('Bearer sk-fake-123456');
    expect(used?.body['model']).toBe('fake-large');
    expect(d.store.get(pushed.json.cursor)?.senderKey).toBe('console:owner');
    const lines = fs.readFileSync(path.join(d.runDir, 'log.jsonl'), 'utf8');
    expect(lines).toContain('"provider":"fake"');
    expect(lines).not.toContain('sk-fake-123456');

    // Per-role profile, then removing the default profile.
    expect((await owner<ProvidersResponse>('PATCH', '/api/providers', { roles: { cheap: 'echo' } })).json.roles).toEqual({ cheap: 'echo' });
    expect(d.providers?.profileFor('cheap')).toBe('echo');
    const removed = await owner<ProvidersResponse>('DELETE', '/api/providers/fake');
    expect(removed.json.default).toBeNull();
    expect(fs.existsSync(path.join(dir, 'secrets', 'PROVIDER_FAKE_API_KEY'))).toBe(false);
    expect(removed.json.ready).toBe(false);
  }, 30_000);

  it('manages accounts: a read-only account looks but cannot change, passwords change, the last admin stays', async () => {
    const dir = dataDir();
    const d = await startDaemon({ dataDir: dir, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
    running.push(d);
    await d.accounts.create('owner', 'long enough', 'admin');
    const api = client(d, { token: d.adminToken });
    expect((await api<{ account: AccountInfo }>('POST', '/api/accounts', { username: 'viewer', password: 'viewer-pass', role: 'readonly' })).status).toBe(201);
    expect((await api('POST', '/api/accounts', { username: 'viewer', password: 'viewer-pass' })).status).toBe(409);
    const list = (await api<{ accounts: AccountInfo[] }>('GET', '/api/accounts')).json.accounts;
    expect(list.map((a) => [a.username, a.role])).toEqual([
      ['owner', 'admin'],
      ['viewer', 'readonly'],
    ]);
    expect(JSON.stringify(list)).not.toContain('scrypt');

    const anon = client(d);
    const viewer = client(d, { cookie: (await anon('POST', '/api/auth/login', { username: 'viewer', password: 'viewer-pass' })).cookie as string });
    expect((await viewer('GET', '/api/providers')).status).toBe(200);
    expect((await viewer('PUT', '/api/providers/x', { profile: { protocol: 'echo' } })).status).toBe(403);
    expect((await viewer('GET', '/api/accounts')).status).toBe(403);
    expect((await viewer('POST', '/api/auth/password', { current: 'wrong-pass', password: 'viewer-pass-2' })).status).toBe(401);
    expect((await viewer('POST', '/api/auth/password', { current: 'viewer-pass', password: 'viewer-pass-2' })).status).toBe(200);
    expect((await anon('POST', '/api/auth/login', { username: 'viewer', password: 'viewer-pass-2' })).status).toBe(200);

    expect((await api('DELETE', '/api/accounts/owner')).status).toBe(409);
    expect((await api('PATCH', '/api/accounts/viewer', { password: 'reset-by-admin' })).status).toBe(200);
    expect((await viewer('GET', '/api/status')).status).toBe(401); // a reset ends the account's sessions
    expect((await api('DELETE', '/api/accounts/viewer')).status).toBe(200);
    const audit = (await api<{ audit: Array<{ summary: string; owner: string }> }>('GET', '/api/audit?kind=control_write')).json.audit;
    expect(audit.some((a) => a.summary === 'POST /api/auth/password' || a.summary === 'POST /api/accounts')).toBe(true);
  }, 30_000);

  it('ends the setup when an admin account is created with the API token instead', async () => {
    const dir = dataDir();
    const d = await startDaemon({ dataDir: dir, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
    running.push(d);
    const codeFile = path.join(dir, 'secrets', 'PROTEA_SETUP_CODE');
    const code = fs.readFileSync(codeFile, 'utf8').trim();
    expect((await client(d, { token: d.adminToken })('POST', '/api/accounts', { username: 'ops', password: 'long enough' })).status).toBe(201);
    expect(fs.existsSync(codeFile)).toBe(false);
    expect((await client(d)('POST', '/api/setup', { code, username: 'late', password: 'long enough' })).status).toBe(409);
  }, 30_000);

  it('moves an old data volume to provider profiles at start', async () => {
    const dir = dataDir('providers:\n  default: anthropic\n  anthropic:\n    models: { main: claude-fable-5-1 }\n');
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets', 'ANTHROPIC_API_KEY'), 'sk-ant-legacy-0001\n');
    const d = await startDaemon({ dataDir: dir, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
    running.push(d);
    expect(fs.existsSync(path.join(dir, 'secrets', 'PROVIDER_ANTHROPIC_API_KEY'))).toBe(true);
    expect(d.status().provider).toMatchObject({ id: 'anthropic', protocol: 'anthropic', mainModel: 'claude-fable-5-1', ready: true });
    expect(fs.readFileSync(path.join(d.runDir, 'log.jsonl'), 'utf8')).toContain('provider settings migrated to provider profiles');
  }, 30_000);
});
