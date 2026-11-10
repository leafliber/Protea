import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AbortedError,
  AnthropicProvider,
  ProviderError,
  classifyAnthropicError,
  defaultProfile,
  type ProviderProfile,
  type ProviderRequest,
} from '../src/index.js';

const ANTHROPIC_OPTION_KEYS = ['features', 'fallbacks', 'thinkingDisplay', 'cacheTtl', 'thinkingMismatch'];
/** An Anthropic profile; option keys (fallbacks, thinkingMismatch, …) go to profile.anthropic. */
const settings = (over: Record<string, unknown> = {}): ProviderProfile => {
  const base = defaultProfile('anthropic');
  const out = { ...base, maxRetries: 0, anthropic: { ...base.anthropic } } as ProviderProfile & Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (ANTHROPIC_OPTION_KEYS.includes(k)) (out.anthropic as unknown as Record<string, unknown>)[k] = v;
    else out[k] = v;
  }
  return out;
};

const request: ProviderRequest = {
  role: 'main',
  effort: 'medium',
  system: [
    { id: 'identity', text: 'You are Protea.' },
    { id: 'runtime', text: 'Runtime notes.' },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: '<events/>' }] }],
  tools: [{ name: 'chat_send', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
};

describe('AnthropicProvider.buildParams', () => {
  it('places one cache breakpoint after the system prefix and enables automatic caching', () => {
    const p = new AnthropicProvider(settings(), 'k').buildParams(request);
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.system).toEqual([
      { type: 'text', text: 'You are Protea.' },
      { type: 'text', text: 'Runtime notes.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(p.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.tools?.[0]).toMatchObject({ name: 'chat_send', eager_input_streaming: true });
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toEqual(['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01']);
    expect(p).not.toHaveProperty('tool_choice');
    expect(p).not.toHaveProperty('temperature');
  });

  it('omits fallbacks when disabled or unsupported', () => {
    expect(new AnthropicProvider(settings({ fallbacks: null }), 'k').buildParams(request)).not.toHaveProperty('fallbacks');
    const haiku = settings({ models: { main: 'claude-haiku-5-5', fork: 'x', cheap: 'y' } });
    expect(new AnthropicProvider(haiku, 'k').buildParams(request).betas).toEqual(['thinking-binding-controls-2026-08-01']);
    const plain = new AnthropicProvider(settings({ models: { main: 'claude-haiku-5-5', fork: 'x', cheap: 'y' }, thinkingMismatch: null }), 'k');
    expect(plain.buildParams(request)).not.toHaveProperty('betas');
  });

  it('reports missing credentials instead of calling the API', async () => {
    const p = new AnthropicProvider(settings(), undefined);
    expect(p.health()).toEqual({ ready: false, problem: 'secret PROVIDER_ANTHROPIC_API_KEY is not set' });
    await expect(p.generate(request, { signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('classifyAnthropicError', () => {
  const gen = (status: number) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'm' } }, 'm', new Headers());
  it('maps HTTP failures to retry semantics', () => {
    expect((classifyAnthropicError(gen(429)) as ProviderError).kind).toBe('retryable');
    expect((classifyAnthropicError(gen(529)) as ProviderError).kind).toBe('retryable');
    expect((classifyAnthropicError(gen(500)) as ProviderError).kind).toBe('retryable');
    expect((classifyAnthropicError(gen(408)) as ProviderError).kind).toBe('retryable');
    expect((classifyAnthropicError(gen(400)) as ProviderError).kind).toBe('fatal');
    expect((classifyAnthropicError(gen(404)) as ProviderError).kind).toBe('fatal');
    expect((classifyAnthropicError(gen(401)) as ProviderError).kind).toBe('config');
    expect((classifyAnthropicError(new Anthropic.APIConnectionError({ message: 'down' })) as ProviderError).kind).toBe('retryable');
    expect(classifyAnthropicError(new Anthropic.APIUserAbortError())).toBeInstanceOf(AbortedError);
  });
});

describe('AnthropicProvider.generate against a local Messages API', () => {
  let server: http.Server;
  let baseUrl = '';
  const seen: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];

  const sse = (events: Array<[string, unknown]>): string => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ headers: req.headers, body });
        if ((body['system'] as Array<{ text: string }>)[0]?.text === 'fail') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          sse([
            ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 } } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'chat_send', input: {} } }],
            ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"你' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '好"}' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 1 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }],
            ['message_stop', { type: 'message_stop' }],
          ]),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('streams a message and maps content, usage and cost', async () => {
    const p = new AnthropicProvider(settings({ baseUrl }), 'test-key');
    const inputs: Array<{ id: string; name: string; json: string }> = [];
    const res = await p.generate(request, { signal: new AbortController().signal, onToolInput: (d) => inputs.push(d) });
    expect(inputs).toEqual([
      { id: 'toolu_1', name: 'chat_send', json: '{"text":"你' },
      { id: 'toolu_1', name: 'chat_send', json: '好"}' },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.content[0]).toMatchObject({ type: 'thinking', signature: 'sig123' });
    expect(res.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'chat_send', input: { text: '你好' } });
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 200 });
    // 12*4 + 40*20 + 3000*0.2 + 200*4*2, per million tokens
    expect(res.costUsd).toBeCloseTo((12 * 4 + 40 * 20 + 3000 * 0.2 + 200 * 8) / 1e6, 10);
    const last = seen.at(-1);
    // The SDK chooses the auth header form (x-api-key or Bearer); either must carry the key.
    expect([last?.headers['x-api-key'], last?.headers['authorization']]).toContain(
      last?.headers['x-api-key'] ? 'test-key' : 'Bearer test-key',
    );
    expect(String(last?.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(last?.body).toMatchObject({ stream: true, fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(last?.body).not.toHaveProperty('betas');
  });

  it('surfaces API errors as ProviderError', async () => {
    const p = new AnthropicProvider(settings({ baseUrl }), 'test-key');
    const req = { ...request, system: [{ id: 'x', text: 'fail' }] };
    await expect(p.generate(req, { signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'fatal', status: 400 });
  });
});
