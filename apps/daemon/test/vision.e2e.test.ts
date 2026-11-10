import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalGrantInfo, ChatHistoryResponse, ContentBlock, McpServerStatus } from '@protea/protocol';
import { ScriptedProvider, reply, textReply, toolCall, type ProviderRequest } from '@protea/core';
import { startDaemon, type Daemon } from '../src/index.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
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

function dataDir(extra = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-vision-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), `observability:\n  logLevel: silent\n  recordProvider: full\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n${extra}`);
  return dir;
}

async function start(dir: string, provider: ScriptedProvider, env: NodeJS.ProcessEnv = {}) {
  const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env, processMetrics: false, announce: () => undefined });
  running.push(d);
  const api = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${d.url}${p}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as T };
  };
  return { d, api };
}

const flatten = (req: ProviderRequest): ContentBlock[] => req.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' && Array.isArray(b['content']) ? (b['content'] as ContentBlock[]) : [b])));
const transcriptText = (dir: string): string =>
  fs
    .readdirSync(path.join(dir, 'sessions'))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(dir, 'sessions', f), 'utf8'))
    .join('\n');

describe('images end to end', () => {
  it('carries a picture from the chat and from a tool to the model, with only references on disk', async () => {
    const base64 = PNG.toString('base64');
    const dir = dataDir();
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace', 'plot.png'), PNG);
    const provider = new ScriptedProvider([
      () => reply([toolCall('view_image', { path: 'plot.png' })]),
      () => textReply('I see it'),
    ]);
    const { d, api } = await start(dir, provider);

    const up = await api<{ handle: string; mime: string }>('POST', '/api/blobs', { dataBase64: base64 });
    expect(up.status).toBe(201);
    expect(up.json.mime).toBe('image/png');
    expect((await api('POST', '/api/blobs', { dataBase64: Buffer.from('<svg/>').toString('base64') })).status).toBe(422);
    const sent = await api('POST', '/api/chat/messages', { text: '', images: [up.json] });
    expect(sent.status).toBe(201);
    expect((await api('POST', '/api/chat/messages', { text: 'x', images: [{ handle: `blob:${'a'.repeat(64)}`, mime: 'image/png' }] })).status).toBe(400);

    await waitUntil(() => provider.calls.length >= 2, 'the second model call');
    const first = flatten(provider.calls[0] as ProviderRequest);
    expect(first.some((b) => b.type === 'text' && String(b['text']).startsWith('<event_images cursor='))).toBe(true);
    expect(first.filter((b) => b.type === 'image')).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }]);
    expect(first.at(-1)?.type).toBe('text'); // the status block stays last
    const second = flatten(provider.calls[1] as ProviderRequest);
    expect(second.filter((b) => b.type === 'image')).toHaveLength(2);

    await waitUntil(() => transcriptText(dir).includes('view_image') && transcriptText(dir).includes('I see it'), 'the transcript');
    const onDisk = transcriptText(dir);
    expect(onDisk).toContain(up.json.handle);
    expect(onDisk).not.toContain(base64);
    const runDir = fs.readdirSync(path.join(dir, 'runs'))[0] as string;
    const recording = fs.readFileSync(path.join(dir, 'runs', runDir, 'provider.jsonl'), 'utf8');
    expect(recording).toContain(up.json.handle);
    expect(recording).not.toContain(base64);

    const chat = await api<ChatHistoryResponse>('GET', '/api/chat');
    expect(chat.json.items.find((i) => i.kind === 'owner')?.images).toEqual([{ handle: up.json.handle, mime: 'image/png' }]);
    const served = await fetch(`${d.url}/api/blobs/${encodeURIComponent(up.json.handle)}`, { headers: { authorization: `Bearer ${d.adminToken}` } });
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(`${d.url}/api/blobs/${encodeURIComponent(up.json.handle)}`)).status).toBe(401);
  });

  it('adds the browser only where there is one, and shows a warning without the sandbox', async () => {
    const provider = new ScriptedProvider([() => textReply('')]);
    const noBrowser = await start(dataDir(), provider, { PROTEA_IMAGE: 'full' });
    expect((await noBrowser.api('POST', '/api/mcp/presets/browser', {})).status).toBe(409);

    // A stand-in for the binary: the server fails to start, but the entry and its warning are real.
    const { api } = await start(dataDir(), provider, { PROTEA_IMAGE: 'browser' });
    const r = await api<McpServerStatus>('POST', '/api/mcp/presets/browser', { noSandbox: true });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe('browser');
    expect(r.json.warnings?.[0]).toContain("Chromium's sandbox is off");
  });

  it('serves grants over the API', async () => {
    const provider = new ScriptedProvider([() => reply([toolCall('sh_run', { command: 'true' })]), () => textReply('')]);
    const { api } = await start(dataDir('plugins:\n  shell:\n    enabled: true\n    config: { backend: local }\n'), provider);
    await waitUntil(async () => ((await api<{ plugins: Array<{ id: string; state: string }> }>('GET', '/api/plugins')).json.plugins.find((p) => p.id === 'shell')?.state ?? '') === 'running', 'the shell plugin');
    await api('POST', '/api/chat/messages', { text: 'go' });
    let id = '';
    await waitUntil(async () => {
      id = (await api<{ approvals: Array<{ id: string }> }>('GET', '/api/approvals?state=pending')).json.approvals[0]?.id ?? '';
      return id !== '';
    }, 'the approval');
    expect((await api('POST', `/api/approvals/${id}/decide`, { decision: 'approve', grantMs: -1 })).status).toBe(400);
    const decided = await api<{ grantId: string }>('POST', `/api/approvals/${id}/decide`, { decision: 'approve', grantMs: 60_000 });
    expect(decided.json.grantId).toBe('g1');
    const { json } = await api<{ grants: ApprovalGrantInfo[] }>('GET', '/api/approvals/grants');
    expect(json.grants).toMatchObject([{ id: 'g1', family: 'shell', active: true }]);
    expect((await api<ApprovalGrantInfo>('POST', '/api/approvals/grants/g1/revoke')).json.active).toBe(false);
  });
});
