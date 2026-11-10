import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchTraceResponse, ChatHistoryResponse, SessionContextResponse, StatusResponse } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-chat-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n');
  return dir;
}

const start = async (dir: string) => {
  const d = await startDaemon({ dataDir: dir, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
  running.push(d);
  const api = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${d.url}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as T;
  };
  return { d, api };
};

describe('the web chat (POST /api/chat/messages, GET /api/chat)', () => {
  it('keeps replies, explains a message that got none, and survives a restart', async () => {
    const dir = dataDir();
    const { d, api } = await start(dir);
    const chat = () => api<ChatHistoryResponse>('GET', '/api/chat');

    // No provider yet: the message is delivered, the batch fails, the chat says why.
    const first = await api<{ cursor: number }>('POST', '/api/chat/messages', { text: 'anyone there?' });
    await waitUntil(async () => (await chat()).batches.some((b) => b.endReason === 'model_error'), 'the failed batch');
    let h = await chat();
    expect(h.items).toMatchObject([{ kind: 'owner', key: `e${first.cursor}`, text: 'anyone there?', state: 'delivered', sender: 'api:admin' }]);
    expect(h.batches[0]).toMatchObject({ endReason: 'model_error', replied: false, error: expect.stringContaining('no model provider is configured') });

    // With a provider the reply is stored, tied to its batch, and announced with its id.
    await api('PUT', '/api/providers/echo', { profile: { protocol: 'echo' } });
    const outputs: Array<{ id?: number; batchId?: string; text: string }> = [];
    d.bus.on('plugin.output', (o) => outputs.push(o));
    const second = await api<{ cursor: number }>('POST', '/api/chat/messages', { text: 'hello' });
    await waitUntil(() => outputs.length > 0 && d.main.phase === 'idle', 'the reply');
    h = await chat();
    expect(h.items.map((i) => [i.kind, i.text])).toEqual([
      ['owner', 'anyone there?'],
      ['owner', 'hello'],
      ['reply', expect.stringContaining('hello')],
    ]);
    const reply = h.items[2];
    expect(reply).toMatchObject({ key: `o${outputs[0]?.id}`, channel: 'chat', platform: 'webchat', batchId: outputs[0]?.batchId });
    expect(h.items[1]).toMatchObject({ cursor: second.cursor, batchId: reply?.batchId });
    expect(h.batches.find((b) => b.id === reply?.batchId)).toMatchObject({ replied: true, sources: ['webchat'], endReason: expect.stringMatching(/^ends?_turn$/) });
    const one = await api<{ batches: ChatHistoryResponse['batches'] }>('GET', `/api/chat/batches?ids=${reply?.batchId},nope`);
    expect(one.batches.map((b) => b.id)).toEqual([reply?.batchId]);

    // An operator injection is not part of the conversation: the answer is the model's text.
    const before = (await chat()).items.length;
    const injected = await api<{ cursor: number }>('POST', '/api/events', { text: 'operator test' });
    await waitUntil(() => d.store.get(injected.cursor)?.state === 'delivered' && d.main.phase === 'idle', 'the injection');
    expect((await chat()).items).toHaveLength(before);
    expect(JSON.stringify(d.main.currentTranscript.messages.at(-1))).toContain('echo: operator test');

    // The console sees how it went: the batch step by step, and what the next request would carry.
    const trace = await api<BatchTraceResponse>('GET', `/api/batches/${reply?.batchId}/trace`);
    expect(trace.steps.map((x) => x.kind)).toEqual(expect.arrayContaining(['events', 'model', 'output', 'tool_result']));
    expect(trace.events.map((e) => e.cursor)).toContain(second.cursor);
    const ctx = await api<SessionContextResponse>('GET', '/api/sessions/main/context?limit=2');
    expect(ctx.system.map((x) => x.id)).toEqual(expect.arrayContaining(['runtime', 'env:webchat', 'env:console']));
    expect(ctx.tools.find((t) => t.name === 'chat_send')).toMatchObject({ owner: 'chat', deferred: false });
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.limits?.softTokens).toBeGreaterThan(0);
    expect((await api<StatusResponse>('GET', '/api/status')).chat).toMatchObject({ platforms: [{ id: 'webchat', markdown: 'basic' }], last: 'webchat' });
    expect((await fetch(`${d.url}/api/sessions/nope/context`, { headers: { authorization: `Bearer ${d.adminToken}` } })).status).toBe(404);
    const bad = await fetch(`${d.url}/api/chat/messages`, { method: 'POST', headers: { authorization: `Bearer ${d.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', trigger: 'store' }) });
    expect(bad.status).toBe(400);

    // Paging backwards.
    const page = await api<ChatHistoryResponse>('GET', '/api/chat?limit=2');
    expect(page.items.map((i) => i.text)).toEqual(['hello', reply?.text]);
    const older = await api<ChatHistoryResponse>('GET', `/api/chat?limit=2&before=${encodeURIComponent(page.before as string)}`);
    expect(older.items.map((i) => i.text)).toEqual(['anyone there?']);
    expect(older.before).toBeNull();

    // A restart keeps the conversation.
    await d.stop('restart');
    running.splice(running.indexOf(d), 1);
    const again = await start(dir);
    const after = await again.api<ChatHistoryResponse>('GET', '/api/chat');
    expect(after.items.map((i) => i.key)).toEqual(h.items.map((i) => i.key));
  }, 40_000);

  it('moves a conversation off the old reply tool once and keeps its history as the web chat', async () => {
    const dir = dataDir();
    const first = await start(dir);
    await first.api('PUT', '/api/providers/echo', { profile: { protocol: 'echo' } });
    first.d.main.currentTranscript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'old question' }] });
    first.d.main.currentTranscript.appendMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 'old_1', name: 'con_send', input: { text: 'old answer' } }] });
    first.d.main.currentTranscript.appendMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_1', content: 'sent' }] });
    await first.d.stop('restart');
    running.splice(running.indexOf(first.d), 1);
    const again = await start(dir);
    await waitUntil(() => !again.d.main.currentTranscript.messages.some((m) => JSON.stringify(m).includes('con_send')) && again.d.main.phase === 'idle', 'the compaction');
  }, 40_000);
});
