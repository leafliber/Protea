import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingFile, ScriptedProvider, SecretStore, cacheHitRatio, createDiagnostics, reply, rotatedLogName, textReply, toolCall } from '@protea/core';
import { VERSION, startDaemon, type Daemon } from '../src/index.js';

const SECRET = 'diag-secret-value-8f3k2m';
const PRIVATE = 'my private shopping list';

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

function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-diag-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    'observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n',
  );
  return dir;
}

function logLines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Every file of an extracted bundle, as text. */
function extract(archive: string): { root: string; files: Map<string, string> } {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-diag-x-'));
  execFileSync('tar', ['-xzf', archive, '-C', out]);
  const [top] = fs.readdirSync(out);
  const root = path.join(out, top as string);
  const files = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(root, r)).isDirectory()) walk(r);
      else files.set(r, fs.readFileSync(path.join(root, r), 'utf8'));
    }
  };
  walk('');
  return { root, files };
}

describe('real-world testing support: trace logs and diagnostics bundles', () => {
  it('logs model calls, events, batches and tools as metadata, and exports a redacted bundle', async () => {
    const dir = dataDir();
    const provider = new ScriptedProvider([(req) => (req.role === 'main' ? reply([toolCall('idle', {})]) : textReply('x'))]);
    const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env: { PROTEA_SECRET_DIAG_TOKEN: SECRET }, processMetrics: false });
    running.push(d);
    const cursor = d.console.receive(`${PRIVATE}; the token is ${SECRET}`, { senderKey: 'local' }).cursor as number;
    await waitUntil(() => d.store.get(cursor as number)?.state === 'delivered', 'the console event delivered');
    await waitUntil(() => logLines(path.join(d.runDir, 'log.jsonl')).some((l) => l['msg'] === 'tool done'), 'the tool log line');

    // Trace lines: what happened, how big and how long — never the text.
    const lines = logLines(path.join(d.runDir, 'log.jsonl'));
    const stored = lines.find((l) => l['msg'] === 'event stored' && l['source'] === 'console');
    expect(stored).toMatchObject({ level: 30, component: 'trace', type: 'console.message', eventLevel: 1, origin: 'external' });
    expect(stored?.['chars']).toBeGreaterThan(20);
    expect(stored).not.toHaveProperty('text');
    expect(lines.find((l) => l['msg'] === 'batch started')).toMatchObject({ level: 30, batchLevel: 1, events: expect.any(Number) });
    expect(lines.find((l) => l['msg'] === 'model call')).toMatchObject({ component: 'model', role: 'main', inputTokens: 10, outputTokens: 5, cacheHit: 0, stop: 'tool_use' });
    expect(lines.find((l) => l['msg'] === 'tool done')).toMatchObject({ tool: 'idle', failed: false });
    const raw = fs.readFileSync(path.join(d.runDir, 'log.jsonl'), 'utf8');
    expect(raw).not.toContain(PRIVATE);
    expect(raw).not.toContain(SECRET);

    // A metadata-only bundle through the API.
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${d.url}${p}`, {
        method,
        headers: { authorization: `Bearer ${d.adminToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return res;
    };
    const made = await call('POST', '/api/diagnostics', {});
    expect(made.status).toBe(200);
    const a = (await made.json()) as { name: string; bytes: number };
    expect(a.name).toMatch(/^protea-diag-\d{8}T\d{6}Z(-\d+)?\.tar\.gz$/);
    const plain = extract(path.join(dir, 'exports', a.name));
    for (const f of ['manifest.json', 'summary.json', 'system.json', 'config.yaml', 'db/events.jsonl', 'db/usage.jsonl', 'db/batches.jsonl', 'live/status.json', 'live/metrics.prom', 'live/config.effective.json', `runs/${d.runId}/log.jsonl`]) {
      expect(plain.files.has(f), f).toBe(true);
    }
    expect([...plain.files.keys()].some((f) => f.startsWith('secrets'))).toBe(false);
    for (const [f, text] of plain.files) {
      expect(text, f).not.toContain(SECRET);
      expect(text, f).not.toContain(PRIVATE);
    }
    const ev = plain.files.get('db/events.jsonl')?.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['cursor'] === cursor);
    expect(ev).toMatchObject({ source: 'console', state: 'delivered', eff_level: 1 });
    expect(ev).not.toHaveProperty('text');
    const summary = JSON.parse(plain.files.get('summary.json') as string) as { usage: { total: { calls: number; cacheHit: number | null } }; events: { total: number } };
    expect(summary.usage.total.calls).toBeGreaterThanOrEqual(1);
    expect(summary.events.total).toBeGreaterThanOrEqual(1);
    expect(plain.files.get('live/metrics.prom')).toContain('protea_events_total');

    // With content: the text is there, the secret value still is not.
    const withContent = (await (await call('POST', '/api/diagnostics', { content: true, transcripts: true })).json()) as { name: string };
    expect(withContent.name).not.toBe(a.name);
    const full = extract(path.join(dir, 'exports', withContent.name));
    expect(full.files.get('db/events.jsonl')).toContain(PRIVATE);
    expect(full.files.get('db/events.jsonl')).toContain('[REDACTED:DIAG_TOKEN]');
    expect([...full.files.keys()].some((f) => f.startsWith('sessions/main.'))).toBe(true);
    for (const [f, text] of full.files) expect(text, f).not.toContain(SECRET);

    // Listing and download.
    const list = (await (await call('GET', '/api/diagnostics')).json()) as { archives: Array<{ name: string; bytes: number }> };
    expect(list.archives.map((x) => x.name)).toEqual([withContent.name, a.name]);
    const dl = await call('GET', `/api/diagnostics/${a.name}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/gzip');
    expect((await dl.arrayBuffer()).byteLength).toBe(a.bytes);
    expect((await call('GET', '/api/diagnostics/..%2Fprotea.db')).status).toBe(400);
    expect((await call('POST', '/api/diagnostics', { sinceHours: -1 })).status).toBe(400);
  }, 30_000);

  it('builds the same bundle offline from a stopped daemon’s data directory', async () => {
    const dir = dataDir();
    const provider = new ScriptedProvider([(req) => (req.role === 'main' ? reply([toolCall('idle', {})]) : textReply('x'))]);
    const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env: {}, processMetrics: false });
    const cursor = d.console.receive('hello', { senderKey: 'local' }).cursor as number;
    await waitUntil(() => d.store.get(cursor as number)?.state === 'delivered', 'delivered');
    await d.stop('test');
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets', 'LATE_TOKEN'), SECRET);
    fs.appendFileSync(path.join(dir, 'runs', d.runId, 'log.jsonl'), `${JSON.stringify({ level: 30, time: Date.now(), msg: `leaked ${SECRET}` })}\n`);
    const secrets = new SecretStore(path.join(dir, 'secrets'), {});
    const r = await createDiagnostics({ dataDir: dir, version: VERSION, redact: (t) => secrets.redactJsonText(t), sinceHours: 1, runs: 1 });
    const x = extract(r.path);
    expect(x.files.has(`runs/${d.runId}/shutdown.json`)).toBe(true);
    expect(x.files.has('live/status.json')).toBe(false);
    expect(x.files.get(`runs/${d.runId}/log.jsonl`)).toContain('leaked [REDACTED:LATE_TOKEN]');
    expect(JSON.parse(x.files.get('manifest.json') as string)).toMatchObject({ format: 1, protea: VERSION, options: { sinceHours: 1, runs: 1, content: false } });
  }, 30_000);

  it('rotates a log file past its size and keeps the newest rotated files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-rot-'));
    const file = path.join(dir, 'log.jsonl');
    const f = new RotatingFile(file, 1000, 2);
    const line = `${'x'.repeat(99)}\n`;
    for (let i = 0; i < 45; i++) f.write(line);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(dir).sort()).toEqual(['log.1.jsonl', 'log.2.jsonl', 'log.jsonl']);
    expect(fs.statSync(rotatedLogName(file, 1)).size).toBe(1000);
    expect(fs.statSync(file).size).toBe(500);
  });

  it('computes the cache share of the prompt', () => {
    expect(cacheHitRatio({ inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 })).toBe(0.8);
    expect(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});
