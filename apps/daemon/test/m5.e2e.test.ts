import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, reply, silentLogger, textReply, toolCall, type ProviderRequest } from '@protea/core';
import type { BatchInfo, ConfigResponse, EventEnvelope, ForkInfo, LogRecord, PluginStatus, SecretInfo, SkillInfo, StatusResponse, WsServerMessage } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-m5-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    `# operator comment that must survive edits\nobservability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n    2: { debounceMs: 20, maxWaitMs: 0 }\n    3: { debounceMs: 20, maxWaitMs: 0 }\n${yaml}`,
  );
  return dir;
}

function lastUser(req: ProviderRequest): string {
  const m = req.messages.at(-1);
  return m?.role === 'user' ? m.content.map((b) => (b.type === 'text' ? String(b['text']) : b.type === 'tool_result' ? String(b['content']) : '')).join('\n') : '';
}

/** Answers every batch with a reply on the console; forks finish at once. */
const answering = () =>
  new ScriptedProvider([
    (req) => {
      if (req.role !== 'main') return textReply('fork done');
      return lastUser(req).includes('<events') ? reply([toolCall('chat_send', { platform: 'webchat', text: 'got it' })]) : reply([toolCall('idle', {})]);
    },
  ]);

async function start(dir: string, provider: ScriptedProvider = answering(), env: NodeJS.ProcessEnv = {}): Promise<Daemon> {
  const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env, processMetrics: false });
  running.push(d);
  return d;
}

type Res<T> = { status: number; json: T; headers: Headers; text: string };
function client(d: Daemon, token: string | null = d.adminToken, extra: Record<string, string> = {}) {
  return async <T = Record<string, unknown>>(method: string, p: string, body?: unknown, opts: { text?: boolean } = {}): Promise<Res<T>> => {
    const headers: Record<string, string> = { ...extra };
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = opts.text ? 'text/plain' : 'application/json';
    const res = await fetch(`${d.url}${p}`, { method, headers, ...(body !== undefined ? { body: opts.text ? String(body) : JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json: json as T, headers: res.headers, text };
  };
}

/** A copy of the Python example plugin (installed disabled: no Python process is needed). */
function pluginSource(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-src-plugin-'));
  fs.cpSync(path.join(REPO, 'examples/plugins/py-notes'), dir, { recursive: true });
  return dir;
}

function gitRepo(dir: string): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return `file://${dir}`;
}

describe('M5: auth roles, console session and audit', () => {
  it('admin and read-only tokens, cookie login with CSRF, login rate limit, audit of writes', async () => {
    const dir = dataDir();
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets', 'PROTEA_READONLY_TOKEN'), 'readonly-token-123456\n');
    const d = await start(dir);
    const admin = client(d);
    const ro = client(d, 'readonly-token-123456');
    const anon = client(d, null);

    expect((await anon('GET', '/api/status')).status).toBe(401);
    expect((await ro('GET', '/api/status')).status).toBe(200);
    expect((await ro('GET', '/api/events')).status).toBe(200);
    expect((await ro('POST', '/api/events', { text: 'hi' })).status).toBe(403);
    expect((await ro('GET', '/api/memory/tree')).status).toBe(403);
    expect((await ro('GET', '/api/sessions/main/context')).status).toBe(403);
    expect((await ro('GET', '/api/secrets')).status).toBe(403);
    expect((await ro('GET', '/api/persona/files')).status).toBe(403);
    expect((await ro('GET', '/metrics')).status).toBe(200);
    expect((await anon('GET', '/metrics')).status).toBe(401);

    // Console login: an HttpOnly, SameSite=Strict cookie; writes need the CSRF header.
    expect((await anon('POST', '/api/auth/login', { token: 'wrong' })).status).toBe(401);
    const login = await anon<{ role: string }>('POST', '/api/auth/login', { token: d.adminToken });
    expect(login.json.role).toBe('admin');
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^protea_session=v2\./); // a random session key; the database keeps its hash
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toContain(d.adminToken);
    const session = cookie.split(';')[0] as string;
    const browser = client(d, null, { cookie: session });
    expect((await browser<{ role: string; via: string }>('GET', '/api/auth/whoami')).json).toEqual({ role: 'admin', via: 'cookie' });
    expect((await browser('POST', '/api/events', { text: 'from the console' })).status).toBe(403);
    const csrf = client(d, null, { cookie: session, 'x-protea-csrf': '1' });
    const pushed = await csrf<{ cursor: number }>('POST', '/api/events', { text: 'from the console' });
    expect(pushed.status).toBe(201);
    expect((await admin<{ event: EventEnvelope }>('GET', `/api/events/${pushed.json.cursor}`)).json.event.senderKey).toBe('console:admin');

    // Read-only login works too, and stays read-only.
    const roCookie = ((await anon('POST', '/api/auth/login', { token: 'readonly-token-123456' })).headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect((await client(d, null, { cookie: roCookie, 'x-protea-csrf': '1' })('POST', '/api/scheduler/pause')).status).toBe(403);

    // Ten failed logins from one address (the successful logins above reset the count), then a pause.
    for (let i = 0; i < 10; i++) expect((await anon('POST', '/api/auth/login', { token: `bad-${i}` })).status).toBe(401);
    expect((await anon('POST', '/api/auth/login', { token: 'bad-last' })).status).toBe(429);
    expect((await anon('POST', '/api/auth/login', { token: d.adminToken })).status).toBe(429);

    const audit = await admin<{ audit: Array<{ kind: string; summary: string; owner: string; outcome: string }> }>('GET', '/api/audit?kind=control_write');
    expect(audit.json.audit.some((a) => a.summary === 'POST /api/events' && a.owner === 'console:admin' && a.outcome === '201')).toBe(true);
    expect(audit.json.audit.some((a) => a.summary === 'POST /api/events' && a.outcome === '403')).toBe(false); // refused before the handler
  });
});

describe('M5: operations without SSH', () => {
  it('events, batches, scheduler, config, secrets, persona and logs through the API', async () => {
    const dir = dataDir('budget:\n  dailyUsd: 4\n');
    const d = await start(dir);
    const api = client(d);

    // Events: pagination, promote, withdraw, batches with their rounds.
    const sent: number[] = [];
    for (let i = 0; i < 5; i++) sent.push((await api<{ cursor: number }>('POST', '/api/events', { text: `note ${i}`, level: 3, trigger: 'store' })).json.cursor);
    const page1 = await api<{ events: EventEnvelope[]; nextCursor: number | null }>('GET', '/api/events?source=console&limit=2');
    expect(page1.json.events.map((e) => e.cursor)).toEqual([sent[4], sent[3]]);
    const page2 = await api<{ events: EventEnvelope[]; nextCursor: number | null }>('GET', `/api/events?source=console&limit=2&cursor=${page1.json.nextCursor}`);
    expect(page2.json.events.map((e) => e.cursor)).toEqual([sent[2], sent[1]]);
    expect((await api<{ event: EventEnvelope }>('POST', `/api/events/${sent[0]}/withdraw`)).json.event.state).toBe('withdrawn');
    expect((await api('POST', `/api/events/${sent[0]}/withdraw`)).status).toBe(409);
    expect((await api('POST', '/api/events/99999/promote')).status).toBe(404);
    await api('POST', `/api/events/${sent[1]}/promote`, { trigger: 'flush' });
    await waitUntil(() => d.store.get(sent[1] as number)?.state === 'delivered', 'the promoted event to be delivered');
    const batches = await api<{ batches: BatchInfo[] }>('GET', '/api/batches?limit=5');
    const b = batches.json.batches.find((x) => x.endReason !== null) as BatchInfo;
    const detail = await api<{ batch: BatchInfo; events: EventEnvelope[]; rounds: Array<{ model: string }> }>('GET', `/api/batches/${b.id}`);
    expect(detail.json.events.map((e) => e.cursor)).toContain(sent[1]);
    expect(detail.json.rounds.length).toBe(b.rounds);

    // Scheduler: pause keeps events pending (and survives in status), discard, resume delivers.
    expect((await api<{ paused: string }>('POST', '/api/scheduler/pause')).json.paused).toBe('api:admin');
    const held = (await api<{ cursor: number }>('POST', '/api/events', { text: 'wait for me', level: 1 })).json.cursor;
    await new Promise((r) => setTimeout(r, 150));
    expect(d.store.get(held)?.state).toBe('pending');
    expect((await api<StatusResponse>('GET', '/api/status')).json.scheduler.paused).toBe('api:admin');
    expect((await api<{ ready: boolean; reasons: string[] }>('GET', '/readyz')).json.reasons).toContain('event delivery paused by api:admin');
    for (let i = 0; i < 3; i++) await api('POST', '/api/events', { text: `low ${i}`, level: 3, trigger: 'store' });
    expect((await api('POST', '/api/scheduler/discard', { levels: [1] })).status).toBe(400);
    expect((await api<{ discarded: number }>('POST', '/api/scheduler/discard', { levels: [3] })).json.discarded).toBe(3);
    expect(d.store.get(held)?.state).toBe('pending'); // other levels stay
    await api('POST', '/api/scheduler/resume');
    await waitUntil(() => d.store.get(held)?.state === 'delivered', 'delivery after resume');

    // Configuration: effective (secret values redacted), sources, merge patch that keeps comments.
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    await api('PUT', '/api/secrets/DEMO_TOKEN', 'sekrit-value-42', { text: true });
    fs.appendFileSync(path.join(dir, 'config.yaml'), 'daemon:\n  language: sekrit-value-42\n');
    await d.reloadConfig();
    const cfg = await api<ConfigResponse>('GET', '/api/config');
    expect(JSON.stringify(cfg.json)).not.toContain('sekrit-value-42');
    expect((cfg.json.config['daemon'] as Record<string, unknown>)['language']).toBe('[REDACTED:DEMO_TOKEN]');
    expect(cfg.json.sources['budget.dailyUsd']).toBe('file');
    expect(cfg.json.sources['scheduler.levels.4.debounceMs']).toBe('defaults');
    expect(cfg.json.hot).toContain('budget');
    const patched = await api<{ changed: string[]; restartRequired: string[] }>('PATCH', '/api/config', { budget: { dailyUsd: 8 }, daemon: { timezone: 'Asia/Shanghai' } });
    expect(patched.json).toEqual({ changed: ['budget.dailyUsd', 'daemon.timezone'], restartRequired: ['daemon'] });
    expect(d.budget.status().dailyUsd).toBe(8); // hot
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain('# operator comment that must survive edits');
    const before = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect((await api('PATCH', '/api/config', { session: { rounds: { soft: 50, hard: 10 } } })).status).toBe(400);
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe(before);
    await api('PATCH', '/api/permissions', { tools: { chat_send: 'ask' } });
    const perms = await api<{ tools: Array<{ name: string; policy: string; rule: string }> }>('GET', '/api/permissions');
    expect(perms.json.tools.find((t) => t.name === 'chat_send')).toMatchObject({ policy: 'ask', rule: 'permissions.tools.chat_send' });
    expect((await api<{ settings: { dailyUsd: number } }>('PATCH', '/api/budget', { dailyUsd: 2 })).json.settings.dailyUsd).toBe(2);

    // Secrets: names only; the admin token cannot be deleted.
    const secrets = await api<{ secrets: SecretInfo[] }>('GET', '/api/secrets');
    expect(secrets.json.secrets.map((s) => s.name)).toEqual(expect.arrayContaining(['DEMO_TOKEN', 'PROTEA_ADMIN_TOKEN']));
    expect(secrets.text).not.toContain('sekrit');
    expect((await api('DELETE', '/api/secrets/PROTEA_ADMIN_TOKEN')).status).toBe(400);
    expect((await api('PUT', '/api/secrets/lower', 'x', { text: true })).status).toBe(400);
    expect((await api('DELETE', '/api/secrets/DEMO_TOKEN')).json).toEqual({ ok: true, stillSetByEnvironment: false });

    // Persona: Markdown files only, inside the directory; a write reloads the persona.
    const files = await api<{ files: Array<{ path: string }> }>('GET', '/api/persona/files');
    expect(files.json.files.map((f) => f.path)).toEqual(expect.arrayContaining(['OPERATING.md', 'SOUL.md', 'USER.md']));
    let personaChanged = false;
    d.bus.on('persona.changed', () => (personaChanged = true));
    expect((await api('PUT', '/api/persona/file?path=SOUL.md', '# Soul\nYou are Fern.', { text: true })).status).toBe(200);
    await waitUntil(() => personaChanged, 'the persona to reload');
    expect(d.persona.current.soul).toBe('# Soul\nYou are Fern.');
    expect((await api('PUT', '/api/persona/file?path=hooks.mjs', 'export default {}', { text: true })).status).toBe(400);
    expect((await api('GET', '/api/persona/file?path=../config.yaml')).status).toBe(400);

    // Logs: this run's ring buffer, filtered; plugin logs; runs.
    const logs = await api<{ logs: LogRecord[] }>('GET', '/api/logs?component=scheduler&q=paused');
    expect(logs.json.logs.some((l) => l.msg === 'event delivery paused')).toBe(true);
    expect(logs.json.logs.every((l) => l['component'] === 'scheduler')).toBe(true);
    expect((await api('GET', '/api/logs?level=nonsense')).status).toBe(400);
    const runs = await api<{ current: string; runs: Array<{ id: string }> }>('GET', '/api/runs');
    expect(runs.json.current).toBe(d.runId);
    expect(runs.json.runs[0]?.id).toBe(d.runId);

    // The pause outlives a restart; a clean stop leaves shutdown.json.
    await api('POST', '/api/scheduler/pause');
    await d.stop('restart test');
    running.splice(running.indexOf(d), 1);
    const shutdown = JSON.parse(fs.readFileSync(path.join(dir, 'runs', d.runId, 'shutdown.json'), 'utf8')) as Record<string, unknown>;
    expect(shutdown).toMatchObject({ reason: 'restart test', batchFinished: true });
    expect(Object.keys(shutdown['steps'] as object)).toEqual(['drain', 'mcp', 'plugins', 'server']);
    const d2 = await start(dir);
    expect(d2.status().scheduler.paused).toBe('api:admin');
    const later = (await client(d2)<{ cursor: number }>('POST', '/api/events', { text: 'still paused', level: 1 })).json.cursor;
    await new Promise((r) => setTimeout(r, 150));
    expect(d2.store.get(later)?.state).toBe('pending');
    await client(d2)('POST', '/api/scheduler/resume');
    await waitUntil(() => d2.store.get(later)?.state === 'delivered', 'delivery after resume on the new run');
    expect((await client(d2)<{ runs: Array<{ id: string; hasShutdown: boolean }> }>('GET', '/api/runs')).json.runs.find((r) => r.id === d.runId)?.hasShutdown).toBe(true);
  });

  it('forks: spawn, operator pause and resume (kept across a restart), transcripts without thinking', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new ScriptedProvider([
      async (req) => {
        if (req.role === 'main') return reply([toolCall('idle', {})]);
        await gate;
        return reply([{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'fork result' }]);
      },
    ]);
    const dir = dataDir();
    const env = { PROTEA_SCHEDULER__FORKS__MAX_CONCURRENT: '1' };
    const d = await start(dir, provider, env);
    const api = client(d);
    const a = await api<ForkInfo>('POST', '/api/sessions/forks', { goal: 'first', level: 3 });
    expect(a.status).toBe(201);
    const b = await api<ForkInfo>('POST', '/api/sessions/forks', { goal: 'second', level: 3, reportTo: 'none' });
    expect((await api('POST', '/api/sessions/forks', { level: 3 })).status).toBe(400);
    await waitUntil(() => d.forks.get(a.json.id)?.state === 'running', 'the first fork to run');
    expect((await api<ForkInfo>('POST', `/api/sessions/forks/${b.json.id}/pause`)).json).toMatchObject({ state: 'paused', pauseReason: 'operator' });
    release();
    await waitUntil(() => d.forks.get(a.json.id)?.state === 'idle', 'the first fork to complete');
    await new Promise((r) => setTimeout(r, 100));
    expect(d.forks.get(b.json.id)?.state).toBe('paused'); // a free slot does not start an operator-paused fork

    await d.stop('restart');
    running.splice(running.indexOf(d), 1);
    const d2 = await start(dir, provider, env);
    expect(d2.forks.get(b.json.id)).toMatchObject({ state: 'paused', pauseReason: 'operator' });
    await client(d2)('POST', `/api/sessions/forks/${b.json.id}/resume`);
    await waitUntil(() => d2.forks.get(b.json.id)?.state === 'completed', 'the resumed fork to complete');
    const t = await client(d2)<{ messages: Array<{ content: Array<Record<string, unknown>> }> }>('GET', `/api/sessions/${b.json.id}/transcript?thinking=none`);
    const blocks = t.json.messages.flatMap((m) => m.content);
    expect(blocks.some((x) => x['type'] === 'thinking')).toBe(false);
    const withThinking = await client(d2)<{ messages: Array<{ content: Array<Record<string, unknown>> }> }>('GET', `/api/sessions/${b.json.id}/transcript`);
    const thinking = withThinking.json.messages.flatMap((m) => m.content).find((x) => x['type'] === 'thinking');
    expect(thinking).toEqual({ type: 'thinking', thinking: 'hmm' }); // never the signature
  });

  it('installs plugins and skills from git and tarball sources, and serves plugin config with its schema', async () => {
    const d = await start(dataDir());
    const api = client(d);

    const repo = gitRepo(pluginSource());
    const viaGit = await api<PluginStatus>('POST', '/api/plugins', { source: 'git', url: repo, enable: false });
    expect(viaGit.status).toBe(201);
    expect(viaGit.json).toMatchObject({ id: 'py-notes', origin: 'data', enabled: false });
    expect(fs.existsSync(path.join(d.dataDir, 'plugins', 'py-notes', '.git'))).toBe(false);
    const details = await api<PluginStatus & { manifest: Record<string, unknown> }>('GET', '/api/plugins/py-notes');
    expect(details.json.manifest).toMatchObject({ displayName: 'Notes (Python example)', kind: 'tool' });
    await api('DELETE', '/api/plugins/py-notes');

    // A tarball over HTTP (npm-style "package/" wrapper).
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-tgz-'));
    fs.cpSync(pluginSource(), path.join(pkg, 'package'), { recursive: true });
    const tgz = path.join(pkg, 'plugin.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', pkg, 'package']);
    const server = http.createServer((_req, res) => res.end(fs.readFileSync(tgz)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/plugin.tgz`;
      expect((await api<PluginStatus>('POST', '/api/plugins', { source: 'tarball', url, enable: false })).json.id).toBe('py-notes');
    } finally {
      server.close();
    }
    expect((await api('POST', '/api/plugins', { source: 'git', url: 'ftp://nope' })).status).toBe(400);
    expect((await api('POST', '/api/plugins', { source: 'git', url: 'file:///does/not/exist' })).status).toBe(400);

    // The configuration of a plugin with a schema (Telegram ships one; x-secret values are masked).
    const tg = await api<{ config: Record<string, unknown>; schema: Record<string, unknown> | null; coldKeys: string[] }>('GET', '/api/plugins/telegram/config');
    expect(tg.json.schema?.['type']).toBe('object');

    // A skill from a git repository.
    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-skill-'));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: tea-time\ndescription: Suggest a tea for the afternoon.\n---\n\nPick a tea.\n');
    const skill = await api<SkillInfo>('POST', '/api/skills', { gitUrl: gitRepo(skillDir) });
    expect(skill.status).toBe(201);
    expect(skill.json).toMatchObject({ name: 'tea-time', origin: 'user', listed: true });
  });
});

describe('M5: live stream, metrics and the console', () => {
  it('the WebSocket carries events, scheduler actions, usage and logs; replays from a cursor', async () => {
    // A long first round so a preempting event arrives while it runs.
    const provider = new ScriptedProvider([
      async (req, _i, { signal }) => {
        if (req.role !== 'main') return textReply('');
        if (lastUser(req).includes('slow job')) await new Promise((r, j) => (setTimeout(r, 2_000), signal.addEventListener('abort', () => j(new Error('aborted')))));
        return reply([toolCall('idle', {})]);
      },
    ]);
    const d = await start(dataDir(), provider);
    const api = client(d);
    const first = (await api<{ cursor: number }>('POST', '/api/events', { text: 'before connecting', level: 3, trigger: 'store' })).json.cursor;

    const seen: WsServerMessage[] = [];
    const ws = new WebSocket(`${d.url.replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${d.adminToken}` } } as never);
    ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)) as WsServerMessage);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(JSON.stringify({ subscribe: ['events', 'scheduler', 'usage', 'logs', 'phase'], since: first - 1, logFilter: { component: 'scheduler' } }));
    await waitUntil(() => seen.some((m) => m.topic === 'event' && m.data.cursor === first), 'the replayed event');
    expect(seen[0]).toMatchObject({ topic: 'hello', data: { role: 'admin' } });

    await api('POST', '/api/events', { text: 'slow job', level: 2, trigger: 'flush' });
    await waitUntil(() => seen.some((m) => m.topic === 'phase' && m.data.phase === 'model'), 'the slow batch to start');
    await api('POST', '/api/events', { text: 'urgent', level: 1, trigger: 'preempt' });
    await waitUntil(() => seen.some((m) => m.topic === 'scheduler' && m.data.kind === 'preempt'), 'the preempt action');
    await waitUntil(() => seen.some((m) => m.topic === 'usage'), 'a usage record');
    await api('POST', '/api/scheduler/pause');
    await waitUntil(() => seen.some((m) => m.topic === 'log' && m.data.msg === 'event delivery paused'), 'a matching log line');
    expect(seen.filter((m) => m.topic === 'log').every((m) => m.topic === 'log' && m.data['component'] === 'scheduler')).toBe(true);
    // The internal event that records the intervention arrives on the events topic too.
    await waitUntil(() => seen.some((m) => m.topic === 'event' && m.data.type === 'session.preempted'), 'the session.preempted internal event');
    const cursors = seen.flatMap((m) => (m.topic === 'event' ? [m.data.cursor] : []));
    expect(new Set(cursors).size).toBe(cursors.length);

    ws.send(JSON.stringify({ subscribe: ['nonsense'] }));
    await waitUntil(() => seen.some((m) => m.topic === 'error'), 'an error for an unknown topic');
    ws.close();

    // No token: refused. A cookie from another origin: refused.
    const refused = await new Promise<number>((resolve) => {
      const req = http.get(`${d.url}/ws`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('error', () => resolve(-1));
    });
    expect(refused).toBe(401);
    const cookie = ((await client(d, null)('POST', '/api/auth/login', { token: d.adminToken })).headers.get('set-cookie') ?? '').split(';')[0] as string;
    const crossSite = await new Promise<number>((resolve) => {
      const req = http.get(`${d.url}/ws`, {
        headers: { cookie, origin: 'https://evil.example', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('error', () => resolve(-1));
    });
    expect(crossSite).toBe(403);
  });

  it('serves Prometheus metrics that follow the event stream', async () => {
    const d = await start(dataDir());
    const api = client(d);
    await api('POST', '/api/events', { text: 'count me', level: 1 });
    await waitUntil(() => d.store.query({ source: 'console' }).every((e) => e.state === 'delivered'), 'delivery');
    await waitUntil(() => d.main.phase === 'idle', 'the batch to end');
    const res = await api('GET', '/metrics');
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = res.text;
    expect(text).toMatch(/^protea_info\{version="0\.1\.0",run="[0-9A-Z]{26}"\} 1$/m);
    expect(text).toMatch(/^protea_events_total\{source="console",level="1",outcome="delivered"\} 1$/m);
    expect(text).toMatch(/^protea_events_pending\{level="4"\} \d+$/m);
    expect(text).toMatch(/^protea_turns_total\{session_kind="main",end_reason="[a-z_]+"\} [1-9]/m);
    expect(text).toMatch(/^protea_batch_wait_seconds_count\{level="1"\} 1$/m);
    expect(text).toMatch(/^protea_tool_calls_total\{tool="chat_send",outcome="ok"\} 1$/m);
    expect(text).toMatch(/^protea_plugin_state\{plugin="console",state="running"\} 1$/m);
    expect(text).toMatch(/^protea_model_tokens_total\{role="main",kind="input"\} \d+$/m);
    expect(text).toMatch(/^protea_context_tokens\{session="main"\} \d+$/m);
    // Every sample line is well-formed exposition text.
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.e+Inf-]+$/);
    }
    const patched = await api<{ restartRequired: string[] }>('PATCH', '/api/config', { control: { publicMetrics: true } });
    // control is not a hot section: it waits for a restart.
    expect(patched.json.restartRequired).toEqual(['control']);
    expect((await client(d, null)('GET', '/metrics')).status).toBe(401);
  });

  it('hosts the console with a strict content security policy', async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-web-'));
    fs.mkdirSync(path.join(web, 'assets'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>console</title>');
    fs.writeFileSync(path.join(web, 'assets', 'app-abc.js'), 'console.log(1)');
    const d = await start(dataDir(), answering(), { PROTEA_WEB_DIR: web });
    const anon = client(d, null);
    const index = await anon('GET', '/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<title>console</title>');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(index.headers.get('x-frame-options')).toBe('DENY');
    const asset = await anon('GET', '/assets/app-abc.js');
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await anon('GET', '/assets/..%2f..%2fconfig.yaml')).text).toContain('<title>console</title>');

    const bare = await start(dataDir(), answering(), { PROTEA_WEB_DIR: path.join(web, 'missing') });
    expect((await client(bare, null)('GET', '/')).text).toContain('not built');
  });
});
