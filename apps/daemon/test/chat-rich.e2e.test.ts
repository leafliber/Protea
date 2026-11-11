import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatHistoryResponse, PluginStatus, StatusResponse, WidgetResponse } from '@protea/protocol';
import { ScriptedProvider, reply, textReply, toolCall, type ProviderRequest } from '@protea/core';
import { startDaemon, type Daemon } from '../src/index.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const WIDGET = '<button id="b">+1</button> <output id="o">0</output><script>var n = 0; document.getElementById("b").onclick = function () { document.getElementById("o").textContent = ++n; };</script>';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function dataDir(extra = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-rich-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), `observability:\n  logLevel: silent\nscheduler:\n  levels:\n    1: { debounceMs: 20, maxWaitMs: 0 }\n${extra}`);
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace', 'plot.png'), PNG);
  return dir;
}

/** A stand-in for the built console: the daemon serves whatever is in this directory. */
function webDir(): string {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-web-'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>console</title>');
  fs.writeFileSync(path.join(web, 'widget-frame.html'), '<!doctype html><title>frame</title>');
  return web;
}

async function start(dir: string, provider: ScriptedProvider, env: NodeJS.ProcessEnv = {}) {
  const d = await startDaemon({ dataDir: dir, provider, listen: '127.0.0.1:0', env, processMetrics: false, announce: () => undefined });
  running.push(d);
  const as =
    (token: string | null) =>
    async <T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T; headers: Headers }> => {
      const res = await fetch(`${d.url}${p}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return { status: res.status, json: json as T, headers: res.headers };
    };
  return { d, api: as(d.adminToken), as };
}

const lastUser = (req: ProviderRequest): string => JSON.stringify(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');

describe('rich replies in the web chat', () => {
  it('carries images, choices and a widget, keeps them across a reload, and takes the answer', async () => {
    const provider = new ScriptedProvider([
      (req) => {
        const last = lastUser(req);
        if (last.includes('sent to webchat') || last.includes('does not')) return textReply('done');
        if (last.includes('Train')) return reply([toolCall('chat_send', { platform: 'webchat', text: 'Booked the train.' }, 'call_done')]);
        if (last.includes('plan the trip')) {
          return reply([
            toolCall(
              'chat_send',
              {
                platform: 'webchat',
                text: '| Way | Cost |\n|---|---:|\n| Train | 553 |\n\nWhich one?',
                images: ['plot.png'],
                choices: { options: [{ label: 'Train', detail: 'Friday 14:00' }, { label: 'Plane' }] },
                widget: { title: 'Counter', code: WIDGET },
              },
              'call_plan',
            ),
          ]);
        }
        return textReply('ok');
      },
    ]);
    const dir = dataDir();
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets', 'PROTEA_READONLY_TOKEN'), 'readonly-token-123456\n');
    const { d, api, as } = await start(dir, provider, { PROTEA_WEB_DIR: webDir() });
    const chat = async () => (await api<ChatHistoryResponse>('GET', '/api/chat')).json;

    // The model is told what this platform shows, from what the platform declared.
    expect((await api<StatusResponse>('GET', '/api/status')).json.chat.platforms).toMatchObject([{ id: 'webchat', markdown: 'full', images: true, choices: true, widgets: true, drafts: true }]);

    await api('POST', '/api/chat/messages', { text: 'plan the trip' });
    await waitUntil(async () => (await chat()).items.some((i) => i.kind === 'reply') && d.main.phase === 'idle', 'the rich reply');
    const tool = provider.calls[0]?.tools.find((t) => t.name === 'chat_send');
    expect(tool?.description).toContain('webchat: full Markdown, up to 20000 characters a message, images, choices, widget');
    const rich = (await chat()).items.find((i) => i.kind === 'reply');
    expect(rich).toMatchObject({
      callId: 'call_plan',
      text: expect.stringContaining('| Train | 553 |'),
      images: [{ handle: expect.stringMatching(/^blob:[a-f0-9]{64}$/), mime: 'image/png' }],
      choices: { options: [{ label: 'Train', detail: 'Friday 14:00' }, { label: 'Plane' }] },
      widget: { id: expect.stringMatching(/^w[a-f0-9]{32}$/), title: 'Counter' },
    });
    // The history names the widget; its code comes only from its own JSON endpoint.
    expect(JSON.stringify(rich)).not.toContain('<button');
    const widget = await api<WidgetResponse>('GET', `/api/widgets/${rich?.widget?.id}`);
    expect(widget.status).toBe(200);
    expect(widget.headers.get('content-type')).toContain('application/json');
    expect(widget.json).toEqual({ id: rich?.widget?.id, title: 'Counter', code: WIDGET });
    expect((await api('GET', '/api/widgets/w00000000000000000000000000000000')).status).toBe(404);
    expect((await as(null)('GET', `/api/widgets/${rich?.widget?.id}`)).status).toBe(401);

    // The owner taps a choice: an ordinary message that names the reply it answers.
    const bad = await api('POST', '/api/chat/messages', { text: 'Train', answer: { to: 'call_plan' } });
    expect(bad.status).toBe(400);
    const answered = await api<{ cursor: number }>('POST', '/api/chat/messages', { text: 'Train', answer: { to: 'call_plan', labels: ['Train'] } });
    expect(answered.status).toBe(201);
    expect(d.store.get(answered.json.cursor)).toMatchObject({ type: 'chat.message', text: 'Train', meta: { answer: { to: 'call_plan', labels: ['Train'] } } });
    await waitUntil(async () => (await chat()).items.some((i) => i.text === 'Booked the train.') && d.main.phase === 'idle', 'the follow-up');
    expect((await chat()).items.map((i) => [i.kind, i.answer?.to ?? i.callId])).toEqual([
      ['owner', undefined],
      ['reply', 'call_plan'],
      ['owner', 'call_plan'],
      ['reply', 'call_done'],
    ]);

    // A read-only account reads the conversation and the widget; of the images, only those in a conversation.
    const ro = as('readonly-token-123456');
    const handle = rich?.images?.[0]?.handle as string;
    expect((await ro<ChatHistoryResponse>('GET', '/api/chat')).json.items).toHaveLength(4);
    expect((await ro('GET', `/api/widgets/${rich?.widget?.id}`)).status).toBe(200);
    expect((await ro('GET', `/api/blobs/${encodeURIComponent(handle)}`)).status).toBe(200);
    const hidden = (await api<{ handle: string }>('POST', '/api/blobs', { dataBase64: Buffer.concat([PNG, Buffer.from([1])]).toString('base64') })).json.handle;
    expect((await api('GET', `/api/blobs/${encodeURIComponent(hidden)}`)).status).toBe(200);
    expect((await ro('GET', `/api/blobs/${encodeURIComponent(hidden)}`)).status).toBe(403);
    expect((await ro('POST', '/api/blobs', { dataBase64: PNG.toString('base64') })).status).toBe(403);

    // The sandbox page is the one page that may be framed, and only by this host; it has no network.
    const frame = await as(null)('GET', '/widget-frame.html');
    const csp = frame.headers.get('content-security-policy') ?? '';
    expect(frame.status).toBe(200);
    expect(frame.json).toContain('<title>frame</title>');
    expect(csp.split('; ')).toEqual(expect.arrayContaining(['sandbox allow-scripts', "default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]));
    expect(csp).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|https?:|'self'(?!$)/);
    expect(frame.headers.get('x-dns-prefetch-control')).toBe('off');
    const index = await as(null)('GET', '/');
    expect(index.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(index.headers.get('x-frame-options')).toBe('DENY');

    // After a restart everything is still there.
    await d.stop('restart');
    running.splice(running.indexOf(d), 1);
    const again = await start(dir, provider, { PROTEA_WEB_DIR: webDir() });
    const kept = (await again.api<ChatHistoryResponse>('GET', '/api/chat')).json.items.find((i) => i.callId === 'call_plan');
    expect(kept).toMatchObject({ images: [{ handle }], choices: { options: [{ label: 'Train' }, { label: 'Plane' }] }, widget: { title: 'Counter' } });
    expect((await again.api<WidgetResponse>('GET', `/api/widgets/${kept?.widget?.id}`)).json.code).toBe(WIDGET);
  });

  it('refuses a widget when widgets are turned off, and says so', async () => {
    const provider = new ScriptedProvider([
      (req) => (lastUser(req).includes('widgets are turned off') ? textReply('done') : reply([toolCall('chat_send', { platform: 'webchat', text: 'x', widget: { title: 'W', code: '<b>x</b>' } }, 'call_w')])),
    ]);
    const { d, api } = await start(dataDir('chat:\n  widgets: false\n'), provider);
    expect((await api<StatusResponse>('GET', '/api/status')).json.chat.platforms[0]).toMatchObject({ widgets: false });
    await api('POST', '/api/chat/messages', { text: 'show me' });
    await waitUntil(() => provider.calls.length >= 2 && d.main.phase === 'idle', 'the refused call');
    // With the setting off the tool does not offer the field at all.
    expect(Object.keys((provider.calls[0]?.tools.find((t) => t.name === 'chat_send')?.inputSchema as { properties: object }).properties)).not.toContain('widget');
    expect((await api<ChatHistoryResponse>('GET', '/api/chat')).json.items.filter((i) => i.kind === 'reply')).toEqual([]);
  });
});

/** The example connector the way a plugin ships: one bundled file next to its manifest. */
function bundleExample(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-ts-chat-'));
  for (const f of ['protea.plugin.json', 'ENV_PROMPT.md']) fs.copyFileSync(path.join(REPO, 'examples/plugins/ts-chat', f), path.join(out, f));
  execFileSync(process.execPath, [path.join(REPO, 'scripts/bundle-plugin.mjs'), path.join(REPO, 'examples/plugins/ts-chat'), path.join(out, 'dist')], { stdio: 'pipe' });
  return out;
}

describe('an out-of-process chat platform', () => {
  it('gets drafts, images, choices and a widget over the plugin protocol, and its answer comes back as a chat.message', async () => {
    const provider = new ScriptedProvider([
      async (req, _i, { onToolInput }) => {
        const last = lastUser(req);
        if (last.includes('sent to ts-chat')) return textReply('done');
        if (last.includes('B, C')) return reply([toolCall('chat_send', { platform: 'ts-chat', text: 'Noted: B and C.' }, 'call_noted')]);
        if (last.includes('withdrawn')) {
          // The model starts a reply and the call is cancelled: the preview must go.
          onToolInput?.({ id: 'call_gone', name: 'chat_send', json: '{"platform":"ts-chat","text":"Never mi' });
          await new Promise((r) => setTimeout(r, 500));
          return new Error('the model call failed');
        }
        if (last.includes('ask me')) {
          onToolInput?.({ id: 'call_ask', name: 'chat_send', json: '{"platform":"ts-chat","text":"Pick' });
          await new Promise((r) => setTimeout(r, 450));
          onToolInput?.({ id: 'call_ask', name: 'chat_send', json: ' some.","choices":{"options":[' });
          await new Promise((r) => setTimeout(r, 450));
          return reply([
            toolCall(
              'chat_send',
              { platform: 'ts-chat', text: 'Pick some.', images: ['plot.png'], choices: { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiple: true }, widget: { title: 'Counter', code: WIDGET } },
              'call_ask',
            ),
          ]);
        }
        return textReply('ok');
      },
    ]);
    const dir = dataDir('owner:\n  identities:\n    - { plugin: webchat, senderKey: "*" }\n    - { plugin: ts-chat, senderKey: "ts-chat:owner" }\ncontrol:\n  publicUrl: https://protea.example\n');
    const { d, api } = await start(dir, provider);
    const installed = await api<PluginStatus>('POST', '/api/plugins', { path: bundleExample() });
    expect(installed.status).toBe(201);
    expect(installed.json).toMatchObject({ id: 'ts-chat', state: 'running' });
    expect((await api<StatusResponse>('GET', '/api/status')).json.chat.platforms.find((p) => p.id === 'ts-chat')).toMatchObject({ markdown: 'full', images: true, choices: true, widgets: true, drafts: true });

    const data = path.join(dir, 'plugin-data', 'ts-chat');
    const outbox = (): Array<Record<string, unknown>> => {
      const f = path.join(data, 'outbox.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    };
    const say = (line: Record<string, unknown>) => fs.appendFileSync(path.join(data, 'inbox.jsonl'), `${JSON.stringify(line)}\n`);

    say({ text: 'ask me' });
    await waitUntil(() => outbox().some((l) => l['kind'] === 'message'), 'the message on the platform');
    const lines = outbox();
    const drafts = lines.filter((l) => l['kind'] === 'draft');
    // Previews carry the whole text so far and say what else is coming; then the message replaces them.
    expect(drafts.map((l) => l['callId'])).toEqual(drafts.map(() => 'call_ask'));
    expect(drafts[0]).toMatchObject({ text: 'Pick' });
    expect(drafts.at(-1)).toMatchObject({ text: 'Pick some.', pending: ['choices'] });
    const message = lines.at(-1);
    expect(message).toMatchObject({
      kind: 'message',
      callId: 'call_ask',
      text: 'Pick some.',
      images: [{ handle: expect.stringMatching(/^blob:/), mime: 'image/png', size: PNG.length }],
      choices: { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiple: true },
      widget: { id: expect.stringMatching(/^w[a-f0-9]{32}$/), title: 'Counter', url: expect.stringMatching(/^https:\/\/protea\.example\/#\/widget\/w[a-f0-9]{32}$/) },
    });
    expect(lines.filter((l) => l['kind'] === 'discarded')).toEqual([]);

    // The owner chooses two. The answer is a chat.message that names the reply; the console shows both sides.
    say({ choose: ['B', 'C'] });
    await waitUntil(() => outbox().some((l) => l['text'] === 'Noted: B and C.') && d.main.phase === 'idle', 'the reply to the answer');
    const all = (await api<ChatHistoryResponse>('GET', '/api/chat?platform=ts-chat')).json.items;
    expect(all.map((i) => [i.kind, i.text])).toEqual([
      ['owner', 'ask me'],
      ['reply', 'Pick some.'],
      ['owner', 'B, C'],
      ['reply', 'Noted: B and C.'],
    ]);
    expect(all[2]).toMatchObject({ answer: { to: 'call_ask', labels: ['B', 'C'] } });
    // Those choices are closed now: a late tap goes nowhere.
    say({ choose: ['A'] });
    await new Promise((r) => setTimeout(r, 900));
    expect((await api<ChatHistoryResponse>('GET', '/api/chat?platform=ts-chat')).json.items).toHaveLength(4);

    // A reply that never arrives takes its preview back.
    say({ text: 'withdrawn' });
    await waitUntil(() => outbox().some((l) => l['kind'] === 'discarded'), 'the withdrawn preview', 30_000);
    const tail = outbox();
    expect(tail.filter((l) => l['callId'] === 'call_gone').map((l) => l['kind'])).toEqual(['draft', 'discarded']);
  });
});
