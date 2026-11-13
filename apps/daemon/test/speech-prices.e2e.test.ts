import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ProvidersResponse, SpeechTestResponse, SpeechView, TranscribeResponse } from '@protea/protocol';
import { startDaemon, type Daemon } from '../src/index.js';

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop('test end');
});

/** A fake OpenAI-style transcription server: records each upload and answers with its size. */
const uploads: Array<{ auth: string | undefined; type: string; body: string }> = [];
let stt: http.Server;
let sttUrl = '';
beforeAll(async () => {
  stt = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts).toString('latin1');
      uploads.push({ auth: req.headers.authorization, type: String(req.headers['content-type']), body });
      res.writeHead(req.url === '/v1/audio/transcriptions' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: `听到了 ${parts.reduce((n, p) => n + p.length, 0) > 0 ? '内容' : ''}` }));
    });
  });
  await new Promise<void>((r) => stt.listen(0, '127.0.0.1', () => r()));
  sttUrl = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => stt.close(() => r())));

async function daemon(yaml = ''): Promise<{ d: Daemon; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protea-speech-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), `observability:\n  logLevel: silent\n${yaml}`);
  const d = await startDaemon({ dataDir: dir, listen: '127.0.0.1:0', env: {}, processMetrics: false, announce: () => undefined });
  running.push(d);
  return { d, dir };
}

async function call<T>(d: Daemon, method: string, p: string, body?: unknown, raw?: { type: string; data: Buffer }): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${d.adminToken}` };
  let payload: Uint8Array | string | undefined;
  if (raw) {
    headers['content-type'] = raw.type;
    payload = new Uint8Array(raw.data);
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${d.url}${p}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

describe('speech-to-text from the console', () => {
  it('is off until set up, then saves the endpoint and key, tests it and transcribes the web chat\'s recordings', async () => {
    const { d, dir } = await daemon();
    const off = await call<SpeechView>(d, 'GET', '/api/speech');
    expect(off.json).toMatchObject({ ready: false, settings: { baseUrl: null } });
    expect(off.json.presets.map((p) => p.id)).toContain('siliconflow');
    expect((await call(d, 'POST', '/api/speech/transcribe', undefined, { type: 'audio/webm', data: Buffer.from('x') })).status).toBe(409);

    const bad = await call<{ error: { message: string } }>(d, 'PUT', '/api/speech', { settings: { baseUrl: sttUrl } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('speech.model is required');

    const saved = await call<SpeechView>(d, 'PUT', '/api/speech', { settings: { baseUrl: sttUrl, model: 'sense-voice', language: 'zh', apiKeySecret: 'SPEECH_API_KEY' }, apiKey: 'sk-voice' });
    expect(saved.json).toMatchObject({ ready: true, key: { required: true, set: true }, settings: { baseUrl: sttUrl, model: 'sense-voice', language: 'zh' } });
    const yaml = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(yaml).toContain('sense-voice');
    expect(yaml).not.toContain('sk-voice');

    const test = await call<SpeechTestResponse>(d, 'POST', '/api/speech/test', {});
    expect(test.json).toMatchObject({ ok: true });
    expect(uploads.at(-1)).toMatchObject({ auth: 'Bearer sk-voice' });
    expect(uploads.at(-1)?.body).toContain('filename="voice.wav"');

    const r = await call<TranscribeResponse>(d, 'POST', '/api/speech/transcribe', undefined, { type: 'audio/webm;codecs=opus', data: Buffer.from('opus-frames') });
    expect(r.status).toBe(200);
    expect(r.json.text).toBe('听到了 内容');
    expect(uploads.at(-1)?.body).toContain('filename="voice.webm"');
    expect(uploads.at(-1)?.body).toContain('name="language"');
    expect((await call(d, 'POST', '/api/speech/transcribe', { text: 'not audio' })).status).toBe(400);

    const offAgain = await call<SpeechView>(d, 'PUT', '/api/speech', { settings: { ...saved.json.settings, baseUrl: null, model: '' } });
    expect(offAgain.json.ready).toBe(false);
  });
});

describe('model prices from the console', () => {
  it('shows each model\'s price and where it comes from, and keeps the prices the owner sets', async () => {
    const { d } = await daemon(
      ['providers:', '  default: glm', '  profiles:', '    glm:', '      protocol: openai-chat', '      baseUrl: http://127.0.0.1:9/v1', '      apiKeySecret: null', '      models: { main: glm-5.3, cheap: glm-5.3-flash, fork: my-tuned-model }'].join('\n'),
    );
    const v = await call<ProvidersResponse>(d, 'GET', '/api/providers');
    expect(v.json.pricesChecked).toMatch(/^\d{4}-\d\d-\d\d$/);
    const rows = v.json.profiles.find((p) => p.id === 'glm')?.prices ?? [];
    expect(rows.find((x) => x.model === 'glm-5.3')).toMatchObject({ source: 'builtin', roles: ['main', 'judge'], pricing: { input: 1.4, output: 4.4 } });
    expect(rows.find((x) => x.model === 'glm-5.3-flash')).toMatchObject({ source: 'builtin', pricing: { input: 0.15 } });
    expect(rows.find((x) => x.model === 'my-tuned-model')).toMatchObject({ source: null });

    const profile = v.json.profiles.find((p) => p.id === 'glm')?.profile as Record<string, unknown>;
    const saved = await call<ProvidersResponse>(d, 'PUT', '/api/providers/glm', { profile: { ...profile, pricing: { 'my-*': { input: 1, output: 2 }, 'glm-5.3': { input: 2, output: 8, cacheRead: 0.5 } } } });
    expect(saved.status).toBe(200);
    const after = saved.json.profiles.find((p) => p.id === 'glm')?.prices ?? [];
    expect(after.find((x) => x.model === 'my-tuned-model')).toMatchObject({ source: 'custom', key: 'my-*', pricing: { input: 1, output: 2 } });
    expect(after.find((x) => x.model === 'glm-5.3')).toMatchObject({ source: 'custom', pricing: { input: 2, cacheRead: 0.5 } });

    const wrong = await call<{ error: { message: string } }>(d, 'PUT', '/api/providers/glm', { profile: { ...profile, pricing: { m: { input: 1 } } } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.message).toContain('pricing.m.output is required');
  });
});
