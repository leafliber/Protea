import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatHistoryResponse } from '@protea/protocol';
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

describe('console conversation (GET /api/chat)', () => {
  it('keeps replies, explains a message that got none, and survives a restart', async () => {
    const dir = dataDir();
    const { d, api } = await start(dir);
    const chat = () => api<ChatHistoryResponse>('GET', '/api/chat');

    // No provider yet: the message is delivered, the batch fails, the chat says why.
    const first = await api<{ cursor: number }>('POST', '/api/events', { text: 'anyone there?' });
    await waitUntil(async () => (await chat()).batches.some((b) => b.endReason === 'model_error'), 'the failed batch');
    let h = await chat();
    expect(h.items).toMatchObject([{ kind: 'owner', key: `e${first.cursor}`, text: 'anyone there?', state: 'delivered', sender: 'api:admin' }]);
    expect(h.batches[0]).toMatchObject({ endReason: 'model_error', replied: false, error: expect.stringContaining('no model provider is configured') });

    // With a provider the reply is stored, tied to its batch, and announced with its id.
    await api('PUT', '/api/providers/echo', { profile: { protocol: 'echo' } });
    const outputs: Array<{ id?: number; batchId?: string; text: string }> = [];
    d.bus.on('plugin.output', (o) => outputs.push(o));
    const second = await api<{ cursor: number }>('POST', '/api/events', { text: 'hello' });
    await waitUntil(() => outputs.length > 0 && d.main.phase === 'idle', 'the reply');
    h = await chat();
    expect(h.items.map((i) => [i.kind, i.text])).toEqual([
      ['owner', 'anyone there?'],
      ['owner', 'hello'],
      ['reply', expect.stringContaining('hello')],
    ]);
    const reply = h.items[2];
    expect(reply).toMatchObject({ key: `o${outputs[0]?.id}`, channel: 'console', batchId: outputs[0]?.batchId });
    expect(h.items[1]).toMatchObject({ cursor: second.cursor, batchId: reply?.batchId });
    expect(h.batches.find((b) => b.id === reply?.batchId)).toMatchObject({ replied: true, sources: ['console'], endReason: expect.stringMatching(/^ends?_turn$/) });
    const one = await api<{ batches: ChatHistoryResponse['batches'] }>('GET', `/api/chat/batches?ids=${reply?.batchId},nope`);
    expect(one.batches.map((b) => b.id)).toEqual([reply?.batchId]);

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
});
