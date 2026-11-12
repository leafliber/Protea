import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError, ScriptedProvider, reply, silentLogger, textReply, toolCall, type ProviderRequest, type ScriptStep } from '@protea/core';
import type { MemoryOverview, StatusResponse } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const CONFIG = `scheduler:
  levels:
    1: { debounceMs: 5, maxWaitMs: 0 }
    2: { debounceMs: 5, maxWaitMs: 0 }
context:
  idleCompaction: { minTokens: 2000, earlyTokens: 100000, earlyAfterMs: 30000, coldAfterMs: 60000, keepTokens: 300, minDroppableTokens: 800, minIntervalMs: 1000 }
memory:
  dream: { enabled: false, model: fork }
`;

function newDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-layers-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
  return dir;
}

interface Rig {
  d: Daemon;
  dir: string;
  provider: ScriptedProvider;
  mainCalls: () => ProviderRequest[];
  send: (text: string) => Promise<void>;
  idleFor: (ms: number) => void;
  clock: { now: () => number };
}

async function boot(steps: { cheap?: ScriptStep; main?: ScriptStep; fork?: ScriptStep } = {}, reuse?: { dir: string; provider: ScriptedProvider }): Promise<Rig> {
  const dir = reuse?.dir ?? newDataDir();
  const provider =
    reuse?.provider ??
    new ScriptedProvider([
      (req, i, ctx) => {
        if (req.role === 'cheap') return steps.cheap ? steps.cheap(req, i, ctx) : textReply('## Commitments\n- tea on Friday');
        if (req.role === 'fork') {
          if (steps.fork) return steps.fork(req, i, ctx);
          // A consolidation writes something, then reports.
          const wrote = req.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
          return wrote ? textReply('merged two notes') : reply([toolCall('memory', { command: 'append', path: 'journal/2026-11-12.md', text: '- consolidated' })]);
        }
        return steps.main ? steps.main(req, i, ctx) : reply([toolCall('idle', {})]);
      },
    ]);
  let offset = 0;
  const clock = { now: () => Date.now() + offset };
  const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', logger: silentLogger(), clock, processMetrics: false, env: {} });
  running.push(d);
  const mainCalls = (): ProviderRequest[] => provider.calls.filter((c) => c.role === 'main');
  return {
    d,
    dir,
    provider,
    mainCalls,
    clock,
    idleFor: (ms) => {
      offset += ms;
    },
    send: async (text) => {
      const before = mainCalls().length;
      d.console.receive(text, { senderKey: 'console:admin' });
      await waitUntil(() => mainCalls().length > before && !d.main.busy && d.store.pendingCounts()[1] === 0, `the batch for ${text.slice(0, 20)}`);
    },
  };
}

const blocks = (req: ProviderRequest | undefined): string[] => (req?.messages ?? []).flatMap((m) => m.content.map((b) => (b.type === 'text' ? String(b['text']) : '')));
const lastUser = (req: ProviderRequest | undefined): string => (req?.messages.at(-1)?.content ?? []).map((b) => (b.type === 'text' ? String(b['text']) : '')).join('\n');
const long = (i: number): string => `第${i}段：${'一段很长的对话内容。'.repeat(300)}`;
const memoryFiles = (d: Daemon, dir: string): string[] => d.memory.listFiles().map((f) => f.path).filter((p) => p.startsWith(dir));

describe('compaction while idle', () => {
  it('starts over from the board, the notes and a short tail, keeping the original for review', async () => {
    const { d, provider, mainCalls, send, idleFor } = await boot();
    d.board.apply({ command: 'add', section: 'todo', text: '给主人发测试步骤', due: '2026-11-20' }, 'main');
    for (let i = 0; i < 4; i++) await send(long(i));
    const systemBefore = JSON.stringify(mainCalls().at(-1)?.system);

    await d.maintenance.tick();
    expect(path.basename(d.transcript.file)).toBe('main.0001.jsonl'); // not idle long enough yet

    idleFor(70_000);
    await d.maintenance.tick();
    expect(path.basename(d.transcript.file)).toBe('main.0002.jsonl');
    expect(provider.calls.filter((c) => c.role === 'cheap')).toHaveLength(1);
    expect(d.status().context.lastCompaction).toMatchObject({ kind: 'idle' });

    const [raw] = memoryFiles(d, 'raw/');
    expect(d.memory.readText(raw as string)).toContain('第0段');
    const [notes] = memoryFiles(d, 'handoff/');
    expect(d.memory.readText(notes as string)).toContain('tea on Friday');

    await send('继续');
    const req = mainCalls().at(-1);
    const [event, board, handoffNotes] = blocks(req);
    expect(event).toContain('type="session.handoff"');
    expect(event).toContain(`/memories/${notes}`);
    expect(event).not.toContain('tea on Friday');
    expect(board).toContain('- t1 给主人发测试步骤 (due 2026-11-20)');
    expect(handoffNotes).toMatch(/^<handoff_notes path="\/memories\/handoff\/.*">\n## Commitments\n- tea on Friday\n<\/handoff_notes>$/);
    expect(blocks(req).join('')).not.toContain('第0段');
    expect(JSON.stringify(req?.system)).toBe(systemBefore);
  });

  it('gives way to an urgent event and leaves the conversation as it was', async () => {
    let cheapStarted = false;
    const { d, send, mainCalls, idleFor } = await boot({
      cheap: (_req, _i, ctx) =>
        new Promise((_resolve, reject) => {
          cheapStarted = true;
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    for (let i = 0; i < 3; i++) await send(long(i));
    idleFor(70_000);
    const tick = d.maintenance.tick();
    await waitUntil(() => cheapStarted, 'the notes request');
    expect(d.main.phase).toBe('handoff');
    const before = mainCalls().length;
    d.console.receive('紧急的事', { senderKey: 'console:admin' });
    await tick;
    expect(path.basename(d.transcript.file)).toBe('main.0001.jsonl');
    expect(memoryFiles(d, 'handoff/')).toEqual([]);
    expect(memoryFiles(d, 'raw/')).toEqual([]);
    await waitUntil(() => mainCalls().length > before, 'the urgent batch');
    expect(lastUser(mainCalls().at(-1))).toContain('紧急的事');
  });

  it('waits for a better moment when the notes model fails, without mechanical notes', async () => {
    let cheapCalls = 0;
    const { d, send, idleFor } = await boot({
      cheap: () => {
        cheapCalls++;
        return new ProviderError('retryable', 'overloaded');
      },
    });
    for (let i = 0; i < 3; i++) await send(long(i));
    idleFor(70_000);
    await d.maintenance.tick();
    expect(cheapCalls).toBe(1);
    expect(path.basename(d.transcript.file)).toBe('main.0001.jsonl');
    expect(memoryFiles(d, 'handoff/')).toEqual([]);
    await d.maintenance.tick();
    expect(cheapCalls).toBe(1);
  });

  it('is not mistaken for an interrupted batch after a restart', async () => {
    const first = await boot();
    for (let i = 0; i < 3; i++) await first.send(long(i));
    first.idleFor(70_000);
    await first.d.maintenance.tick();
    expect(path.basename(first.d.transcript.file)).toBe('main.0002.jsonl');
    const calls = first.mainCalls().length;
    await first.d.stop('restart');
    running.splice(running.indexOf(first.d), 1);

    const second = await boot({}, { dir: first.dir, provider: first.provider });
    await new Promise((r) => setTimeout(r, 100));
    expect(path.basename(second.d.transcript.file)).toBe('main.0002.jsonl');
    expect(second.mainCalls()).toHaveLength(calls);
    expect(second.d.main.needsResume()).toBe(false);
  });

  it('does nothing while the conversation is short', async () => {
    const { d, send, idleFor } = await boot();
    await send('你好');
    idleFor(600_000);
    await d.maintenance.tick();
    expect(path.basename(d.transcript.file)).toBe('main.0001.jsonl');
  });
});

describe('whiteboard in the conversation', () => {
  it('shows it after someone else changed it, once, without touching the cached prefix', async () => {
    const { d, send, mainCalls } = await boot();
    await send('a');
    const count = (r: ProviderRequest | undefined): number => blocks(r).filter((t) => t.startsWith('<board')).length;

    d.board.apply({ command: 'add', section: 'notes', text: '主人下午不回消息' }, 'external');
    await send('b');
    expect(lastUser(mainCalls().at(-1))).toContain('- n1 主人下午不回消息');
    await send('c');
    expect(count(mainCalls().at(-1))).toBe(1);

    d.board.apply({ command: 'add', section: 'todo', text: 'mine' }, 'main');
    await send('d');
    expect(count(mainCalls().at(-1))).toBe(1);

    d.board.apply({ command: 'drop', id: 'n1' }, 'external');
    d.board.apply({ command: 'drop', id: 't2' }, 'external');
    await send('e');
    expect(lastUser(mainCalls().at(-1))).toContain('empty="true"');

    const calls = mainCalls();
    expect(new Set(calls.map((c) => JSON.stringify(c.system))).size).toBe(1);
    expect(new Set(calls.map((c) => JSON.stringify(c.tools))).size).toBe(1);
    const flat = calls.map((c) => c.messages.flatMap((m) => m.content.map((b) => JSON.stringify(b))));
    for (let i = 1; i < flat.length; i++) expect((flat[i] as string[]).slice(0, (flat[i - 1] as string[]).length)).toEqual(flat[i - 1]);
  });

  it('does not repeat itself after a restart', async () => {
    const first = await boot();
    await first.send('a');
    first.d.board.apply({ command: 'add', section: 'notes', text: 'x' }, 'external');
    await first.send('b');
    await first.d.stop('restart');
    running.splice(running.indexOf(first.d), 1);
    const second = await boot({}, { dir: first.dir, provider: first.provider });
    await second.send('c');
    expect(blocks(second.mainCalls().at(-1)).filter((t) => t.startsWith('<board'))).toHaveLength(1);
  });

  it('answers the model with a receipt, not the whole board', async () => {
    let turn = 0;
    const { send, mainCalls, d } = await boot({
      main: () => (turn++ === 0 ? reply([toolCall('board', { command: 'add', section: 'todo', text: '交报告', due: '2026-11-21' })]) : reply([toolCall('idle', {})])),
    });
    await send('记一下');
    await waitUntil(() => !d.main.busy && mainCalls().length >= 2, 'the tool round');
    const results = (mainCalls().at(-1)?.messages ?? []).flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(String(results[0]?.['content'])).toMatch(/^added t1 to todo \(board rev 1/);
    expect(d.board.open()).toMatchObject([{ id: 't1', text: '交报告', due: '2026-11-21' }]);
    expect(d.board.externalRev).toBe(0);
  });
});

describe('resident memory in the prefix', () => {
  it('changes only at chosen moments', async () => {
    const { d, send, mainCalls } = await boot();
    const segment = (id: string): string => mainCalls().at(-1)?.system.find((s) => s.id === id)?.text ?? '';
    await send('a');
    expect(segment('rules')).toBe('');

    // The assistant's own writes wait for the next compaction: the conversation has them already.
    d.memory.write('core/rules.md', '- 图片一律走 QQ');
    d.memory.write('notes/a.md', '---\nsummary: 笔记 A\n---\nbody');
    await send('b');
    expect(segment('rules')).toBe('');
    expect(segment('memory-index')).toBe('');

    // The owner's edits from the console show at once (the session is idle).
    const res = await fetch(`${d.url}/api/memory/file?path=core/owner.md`, { method: 'PUT', headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'text/plain' }, body: '主人说中文' });
    expect(res.status).toBe(200);
    await send('c');
    expect(segment('owner')).toContain('主人说中文');
    expect(segment('rules')).toContain('图片一律走 QQ');
    expect(segment('memory-index')).toContain('- notes/a.md — 笔记 A');

    d.memory.write('notes/b.md', '---\nsummary: 笔记 B\n---\nbody');
    await send('d');
    expect(segment('memory-index')).not.toContain('notes/b.md');
    const handoff = await fetch(`${d.url}/api/sessions/main/handoff`, { method: 'POST', headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(handoff.status).toBe(200);
    await send('e');
    expect(segment('memory-index')).toContain('- notes/b.md — 笔记 B');

    // Over the limit: refused from the console too.
    const big = await fetch(`${d.url}/api/memory/file?path=core/owner.md`, { method: 'PUT', headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'text/plain' }, body: 'x'.repeat(2001) });
    expect(big.status).toBe(400);
    const history = (await (await fetch(`${d.url}/api/memory/history?path=core/owner.md`, { headers: { authorization: `Bearer ${d.adminToken}` } })).json()) as { versions: unknown[] };
    expect(history.versions).toHaveLength(0);
  });
});

describe('control API', () => {
  const call = async <T>(d: Daemon, method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${d.url}${p}`, { method, headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as T };
  };

  it('reads and writes the whiteboard, as a change the session did not make', async () => {
    const { d } = await boot();
    expect((await call(d, 'GET', '/api/memory/board')).json).toEqual({ rev: 0, items: [] });
    const added = await call<{ receipt: string }>(d, 'POST', '/api/memory/board', { command: 'add', section: 'goals', text: '定方案' });
    expect(added.status).toBe(200);
    expect(added.json.receipt).toMatch(/^added g1/);
    expect(d.board.externalRev).toBe(1);
    expect((await call(d, 'POST', '/api/memory/board', { command: 'add', section: 'nope', text: 'x' })).status).toBe(400);
    await call(d, 'POST', '/api/memory/board', { command: 'done', id: 'g1', outcome: '定了' });
    expect((await call(d, 'GET', '/api/memory/board?closed=1')).json).toMatchObject({ items: [], closed: [{ id: 'g1', outcome: '定了' }] });
    expect((await call<StatusResponse>(d, 'GET', '/api/status')).json.memory).toMatchObject({ board: { open: 0, rev: 2 } });
    expect(d.audit.list({ kind: 'memory_write', limit: 5 }).map((r) => String(r.summary))).toEqual(expect.arrayContaining([expect.stringMatching(/^board: added g1/)]));
  });

  it('runs a consolidation on request with memory tools only; other forks do not get the board', async () => {
    const { d, provider } = await boot();
    const started = await call<{ started: boolean; forkId: string }>(d, 'POST', '/api/memory/dream');
    expect(started.status).toBe(202);
    await waitUntil(() => d.dream.status().result !== undefined, 'the consolidation');
    expect(d.dream.status()).toMatchObject({ result: 'completed', acceptedAt: expect.any(String) });
    expect(d.dream.status()).toMatchObject({ running: false, summary: 'merged two notes', date: expect.any(String) });
    const names = (r: ProviderRequest | undefined): string[] => (r?.tools ?? []).map((t) => t.name).sort();
    expect(names(provider.calls.find((c) => c.role === 'fork'))).toEqual(['board', 'memory', 'memory_search', 'skill_load']);
    expect(provider.calls.find((c) => c.role === 'fork')?.messages[0]?.content.map((b) => String(b['text'] ?? '')).join('')).toContain('<memory_state>');
    const overview = await call<MemoryOverview>(d, 'GET', '/api/memory/overview');
    expect(overview.json).toMatchObject({ core: [{ path: 'core/owner.md', chars: 0, limit: 2000 }, { path: 'core/rules.md', chars: 0, limit: 4000 }], index: null, checks: [] });

    const before = provider.calls.length;
    const fork = d.forks.spawn({ goal: 'look something up', level: 4, reportTo: 'none' });
    await waitUntil(() => d.forks.get(fork.id)?.state === 'completed', 'the fork');
    const tools = names(provider.calls.slice(before).find((c) => c.role === 'fork'));
    expect(tools).toContain('memory');
    expect(tools).not.toContain('board');
  });
});
