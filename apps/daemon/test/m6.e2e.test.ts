import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, UsageRepo, createBackup, listBackups, readRecording, reply, restoreBackup, textReply, toolCall, type ProviderRequest, type UsageRecord } from '@protea/core';
import type { BudgetStatus, EventEnvelope, Level } from '@protea/protocol';
import { VERSION, replay, startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function dataDir(yaml = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m6-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    `observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n    2: { debounceMs: 20, maxWaitMs: 0 }\n    3: { debounceMs: 20, maxWaitMs: 0 }\n${yaml}`,
  );
  return dir;
}

function lastText(req: ProviderRequest): string {
  return JSON.stringify(req.messages.at(-1) ?? '');
}

async function start(dir: string, provider: ScriptedProvider, opts: { listen?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Daemon> {
  const d = await startDaemon({ dataDir: dir, provider, listen: opts.listen ?? '127.0.0.1:0', env: opts.env ?? {}, processMetrics: false });
  running.push(d);
  return d;
}

function api(d: Daemon, base = d.url) {
  return async <T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
  };
}

/** Spend attributed to a level, as the provider would report it. */
function spend(d: Daemon, level: Level, costUsd: number): void {
  const now = Date.now();
  const rec: UsageRecord = {
    at: new Date(now).toISOString(),
    atMs: now,
    provider: 'p',
    model: 'm',
    role: 'main',
    sessionId: 'main',
    level,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  };
  new UsageRepo(d.db).record(rec);
  d.bus.emit('usage.recorded', rec);
}

const idle = () => new ScriptedProvider([(req) => (req.role === 'main' ? reply([toolCall('idle', {})]) : textReply('done'))]);

describe('M6: budget enforcement', () => {
  it('holds new events of an exhausted pool, refuses forks, and a release returns them to delivery', async () => {
    const d = await start(dataDir('budget:\n  dailyUsd: 1\n'), idle());
    const call = api(d);
    spend(d, 3, 0.2); // L3 pool is $0.15
    await waitUntil(() => d.store.query({ type: 'budget.exhausted' }).length === 1, 'the exhausted notice');
    const notice = d.store.query({ type: 'budget.exhausted' })[0] as EventEnvelope;
    expect(notice).toMatchObject({ origin: 'internal', effLevel: 0, effTrigger: 'flush' });

    const held = d.gateway.push({ source: 'rss', maxLevel: 3 }, { ts: new Date().toISOString(), type: 'rss.item', level: 3, trigger: 'flush', text: 'a feed item' });
    expect(held).toMatchObject({ ok: true, effectiveTrigger: 'store' });
    expect(d.store.get(held.cursor as number)?.state).toBe('archived');
    const status = (await call<{ status: BudgetStatus }>('GET', '/api/budget')).json.status;
    expect(status).toMatchObject({ enforced: true, levels: { 3: { held: 1 } } });

    const fork = await call<{ error: { message: string } }>('POST', '/api/sessions/forks', { goal: 'look into it', level: 3 });
    expect(fork.status).toBe(422);
    expect(fork.json.error.message).toMatch(/L3 budget is exhausted/);

    const bad = await call('POST', '/api/budget/release', { levels: [1] });
    expect(bad.status).toBe(400);
    const rel = await call<{ levels: number[]; promoted: number[]; until: string }>('POST', '/api/budget/release', { levels: [3], hours: 1 });
    expect(rel.status).toBe(200);
    expect(rel.json).toMatchObject({ levels: [3], promoted: [held.cursor] });
    await waitUntil(() => d.store.get(held.cursor as number)?.state === 'delivered', 'the released event delivered');
    expect(d.store.query({ type: 'budget.released' })).toHaveLength(1);
    expect(d.audit.list({ kind: 'control_write' }).some((a) => (a.summary ?? '').includes('/api/budget/release'))).toBe(true);
  });
});

describe('M6: outbound rate limit', () => {
  it('refuses connector calls past pluginHost.outboundPerMinute within one minute', async () => {
    const provider = new ScriptedProvider([
      (req) => {
        if (lastText(req).includes('spam me')) return reply([toolCall('chat_send', { platform: 'webchat', text: '1' }), toolCall('chat_send', { platform: 'webchat', text: '2' }), toolCall('chat_send', { platform: 'webchat', text: '3' })]);
        return reply([toolCall('idle', {})]);
      },
    ]);
    const d = await start(dataDir('pluginHost:\n  outboundPerMinute: 2\n'), provider);
    const outputs: string[] = [];
    d.bus.on('plugin.output', (o) => outputs.push(o.text));
    d.console.receive('spam me', { senderKey: 'local' });
    await waitUntil(() => provider.calls.some((c) => lastText(c).includes('outbound calls in the last minute')), 'the refused call');
    expect(outputs).toEqual(['1', '2']);
    await waitUntil(() => d.store.query({ type: 'outbound.rate_limited' }).length === 1, 'the rate-limit notice');
  });
});

describe('M6: control.allowCidrs', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  it.skipIf(!lan)('answers loopback and allowed ranges only, for HTTP and WebSocket; webhooks stay reachable', async () => {
    const d = await start(dataDir('control:\n  allowCidrs: [203.0.113.0/24]\n'), idle(), { listen: '0.0.0.0:0' });
    const port = new URL(d.url).port;
    const viaLan = `http://${lan}:${port}`;
    expect((await api(d, `http://127.0.0.1:${port}`)('GET', '/api/status')).status).toBe(200);
    const refused = await api(d, viaLan)('GET', '/api/status');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('allowCidrs');
    expect((await fetch(`${viaLan}/healthz`)).status).toBe(403);
    // /hooks/* is verified by the webhook plugin, not by the address list (no such hook here: 404).
    expect((await fetch(`${viaLan}/hooks/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    // A WebSocket upgrade from outside the list is refused before authentication.
    const upgrade = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({
          host,
          port: Number(port),
          path: '/ws',
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', authorization: `Bearer ${d.adminToken}` },
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await upgrade(lan as string)).toBe(403);
    expect(await upgrade('127.0.0.1')).toBe(101);
  });
});

describe('M6: backup, restore and replay', () => {
  it('backs up online, restores into a new directory, and replays the recorded run offline', async () => {
    const provider = new ScriptedProvider([
      (req) => {
        if (req.role !== 'main') return textReply('notes');
        const last = lastText(req);
        if (last.includes('<events')) return reply([toolCall('chat_send', { platform: 'webchat', text: `answer to ${/remember (\w+)/.exec(last)?.[1] ?? 'it'}` })]);
        return reply([toolCall('idle', {})]);
      },
    ]);
    const dir = dataDir();
    // dataDir() already writes an observability section; record model calls under it.
    fs.writeFileSync(path.join(dir, 'config.yaml'), fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').replace('  logLevel: silent\n', '  logLevel: silent\n  recordProvider: responses\n'));
    const d = await start(dir, provider, { env: { PROTEA_SECRET_SOME_TOKEN: 'never-in-a-backup-123' } });
    d.console.receive('please remember alpha', { senderKey: 'local' });
    await waitUntil(() => d.store.query({ type: 'console.message' }).every((e) => e.state === 'delivered') && !d.main.busy, 'the first message answered');
    d.console.receive('please remember beta', { senderKey: 'local' });
    await waitUntil(() => d.store.query({ type: 'console.message' }).filter((e) => e.state === 'delivered').length === 2 && !d.main.busy, 'the second message answered');
    await waitUntil(() => !d.main.busy, 'idle');
    // Latency metric: stored → the model request that carried it.
    const metrics = await (await fetch(`${d.url}/metrics`, { headers: { authorization: `Bearer ${d.adminToken}` } })).text();
    expect(metrics).toMatch(/protea_event_to_request_seconds_count\{level="1"\} 2/);
    expect(metrics).toMatch(/protea_db_size_bytes\{file="db"\} [1-9]/);

    // Online backup through the API while the daemon runs.
    const made = await api(d)<{ path: string; manifest: { items: string[]; excluded: string[] } }>('POST', '/api/backups', {});
    expect(made.status).toBe(200);
    expect(made.json.manifest.items).toEqual(expect.arrayContaining(['protea.db', 'config.yaml', 'sessions', 'memory', 'persona']));
    expect(made.json.manifest.excluded).toEqual(expect.arrayContaining(['secrets', 'cache']));
    expect(fs.existsSync(path.join(made.json.path, 'secrets'))).toBe(false);
    expect((await api(d)<{ backups: unknown[] }>('GET', '/api/backups')).json.backups).toHaveLength(1);
    expect((await api(d)('POST', '/api/backups', { to: '/tmp/elsewhere' })).status).toBe(400);
    const archive = await createBackup({ dataDir: dir, version: VERSION, archive: true, now: new Date(Date.now() + 1000) });
    expect(archive.path.endsWith('.tar.gz')).toBe(true);
    expect(listBackups(dir).map((b) => [b.archive, typeof b.createdAt])).toEqual([
      [true, 'string'],
      [false, 'string'],
    ]);

    const recording = path.join(d.runDir, 'provider.jsonl');
    const calls = readRecording(recording);
    expect(calls.length).toBe(provider.calls.length);
    expect(JSON.stringify(calls)).not.toContain('never-in-a-backup');
    const runId = d.runId;
    await d.stop('test');
    running.splice(running.indexOf(d), 1);

    // Restore into a fresh directory: the conversation and the events are all there.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m6-restore-'));
    const restored = restoreBackup({ from: archive.path, dataDir: target });
    expect(restored.restored).toEqual(expect.arrayContaining(['protea.db', 'sessions']));
    expect(() => restoreBackup({ from: made.json.path, dataDir: target })).toThrow(/--force/);
    const again = restoreBackup({ from: made.json.path, dataDir: target, force: true });
    expect(again.movedAside).toBeDefined();
    const r2 = await start(target, idle());
    expect(r2.store.query({ type: 'console.message' }).map((e) => [e.text, e.state])).toEqual([
      ['please remember alpha', 'delivered'],
      ['please remember beta', 'delivered'],
    ]);
    expect(JSON.stringify(r2.transcript.messages)).toContain('answer to beta');
    await r2.stop('test');
    running.splice(running.indexOf(r2), 1);
    expect(() => restoreBackup({ from: made.json.path, dataDir: dir, force: true })).not.toThrow();

    // Offline replay of the recording: same batches, every model call served, tools from the transcript.
    // (Backups leave runs/ out, so the recording is replayed from the original directory.)
    const eventsBefore = fs.statSync(path.join(dir, 'protea.db')).mtimeMs;
    const report = await replay({ dataDir: dir, provider: 'recorded', run: runId, out: path.join(dir, 'replays', 'r1') });
    expect(report.batches).toBeGreaterThanOrEqual(2);
    expect(report.modelCalls).toBe(calls.length);
    expect(report.remaining).toEqual({ main: 0 });
    expect(report.tools.recorded).toBe(4); // chat_send and idle, twice each
    expect(report.tools.stubbed).toBe(0);
    const replayed = fs.readFileSync(report.transcript, 'utf8');
    expect(replayed).toContain('please remember alpha');
    expect(replayed).toContain('answer to beta');
    // The production database was only read.
    expect(fs.statSync(path.join(dir, 'protea.db')).mtimeMs).toBe(eventsBefore);
    await expect(replay({ dataDir: target, provider: 'recorded' })).rejects.toThrow(/no recording/);
  });
});

describe('M6: shell tool', () => {
  it('asks the owner first, then runs in the workspace with a clean environment', async () => {
    const command = 'echo "home=$HOME"; echo "leaked=$(env | grep -c -e SHELL_PEN -e PROTEA_ -e ANTHROPIC || true)"; pwd';
    const provider = new ScriptedProvider([
      (req) => {
        if (req.role !== 'main') return textReply('ok');
        const last = lastText(req);
        if (last.includes('run the check') || (last.includes('approval.decided') && last.includes('was approved'))) return reply([toolCall('sh_run', { command })]);
        return reply([toolCall('idle', {})]);
      },
    ]);
    process.env['SHELL_PEN_TOKEN'] = 'in-the-daemon-environment';
    try {
      const dir = dataDir('plugins:\n  shell:\n    enabled: true\n');
      const d = await start(dir, provider);
      await waitUntil(() => d.plugins.get('shell')?.state === 'running', 'the shell plugin');
      d.console.receive('run the check', { senderKey: 'local' });
      let id = '';
      await waitUntil(async () => {
        const r = await api(d)<{ approvals: Array<{ id: string; tool: string }> }>('GET', '/api/approvals?state=pending');
        id = r.json.approvals.find((a) => a.tool === 'sh_run')?.id ?? '';
        return id !== '';
      }, 'the approval request');
      expect(fs.existsSync(path.join(dir, 'workspace', 'never'))).toBe(false);
      expect((await api(d)('POST', `/api/approvals/${id}/decide`, { decision: 'approve' })).status).toBe(200);
      await waitUntil(() => provider.calls.some((c) => lastText(c).includes('exit code 0')), 'the command result');
      const result = lastText(provider.calls.find((c) => lastText(c).includes('exit code 0')) as ProviderRequest);
      const ws = fs.realpathSync(path.join(dir, 'workspace'));
      expect(result).toContain(`home=${path.join(dir, 'workspace')}`);
      expect(result).toContain('leaked=0');
      expect(result).toContain(ws);
      expect(d.audit.list({ tool: 'sh_run' }).map((a) => a.kind)).toEqual(expect.arrayContaining(['approval_requested', 'tool_call']));
    } finally {
      delete process.env['SHELL_PEN_TOKEN'];
    }
  });
});
