import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenAiChatProvider,
  OpenAiResponsesProvider,
  ProviderError,
  classifyHttpStatus,
  normalizeProviderProfile,
  probeProfile,
  SecretStore,
  toChatMessages,
  toResponsesInput,
  type ProviderRequest,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A fake OpenAI-style server: each test queues the answers for the next requests. */
const seen: Seen[] = [];
let answers: Array<(res: http.ServerResponse) => void> = [];
let server: http.Server;
let base = '';

const sse = (events: unknown[]) => (res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  res.end();
};
const json = (status: number, body: unknown) => (res: http.ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const next = answers.shift();
      if (next) next(res);
      else json(500, { error: { message: 'no answer queued' } })(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
  answers = [];
});

const profile = (protocol: 'openai-chat' | 'openai-responses', over: Record<string, unknown> = {}) =>
  normalizeProviderProfile('local', { protocol, baseUrl: base, models: { main: 'm-main', cheap: 'm-cheap' }, maxRetries: 0, ...over });

const request: ProviderRequest = {
  role: 'main',
  effort: 'xhigh',
  system: [
    { id: 'identity', text: 'You are Protea.' },
    { id: 'runtime', text: 'Runtime notes.' },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: '<events>hi</events>' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
        { type: 'text', text: 'Looking it up.' },
        { type: 'tool_use', id: 'toolu_1', name: 'mem_search', input: { q: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'found' }], is_error: false },
        { type: 'text', text: 'and more' },
      ],
    },
  ],
  tools: [{ name: 'con_send', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
};

describe('canonical messages in OpenAI shapes', () => {
  it('maps tool results to tool messages and leaves thinking behind (Chat Completions)', () => {
    expect(toChatMessages(request)).toEqual([
      { role: 'system', content: 'You are Protea.\n\nRuntime notes.' },
      { role: 'user', content: '<events>hi</events>' },
      { role: 'assistant', content: 'Looking it up.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'mem_search', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'found' },
      { role: 'user', content: 'and more' },
    ]);
  });

  it('maps the same conversation to Responses input items', () => {
    expect(toResponsesInput(request)).toEqual([
      { role: 'user', content: '<events>hi</events>' },
      { role: 'assistant', content: 'Looking it up.' },
      { type: 'function_call', call_id: 'toolu_1', name: 'mem_search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'found' },
      { role: 'user', content: 'and more' },
    ]);
  });

  it('keeps a compaction summary readable', () => {
    const msgs = toChatMessages({ ...request, system: [], messages: [{ role: 'assistant', content: [{ type: 'compaction', content: 'we agreed on three things' }] }] });
    expect(msgs).toEqual([{ role: 'assistant', content: '[Summary of the earlier conversation]\nwe agreed on three things' }]);
  });
});

describe('OpenAiChatProvider', () => {
  it('streams text and tool calls split across chunks, with usage and the key as a Bearer header', async () => {
    answers.push(
      sse([
        { model: 'm-main-2026', choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo', tool_calls: [{ index: 0, id: 'call_a', function: { name: 'con_send', arguments: '{"te' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } },
        '[DONE]',
      ]),
    );
    const deltas: string[] = [];
    const p = new OpenAiChatProvider(profile('openai-chat', { pricing: { 'm-main-2026': { input: 1, output: 2, cacheRead: 0.1 } } }), 'sk-test', 'local');
    const r = await p.generate(request, { signal: AbortSignal.timeout(5000), onText: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('Hello');
    expect(r.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'call_a', name: 'con_send', input: { text: 'hi' } },
    ]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 });
    expect(r.model).toBe('m-main-2026');
    expect(r.requestedModel).toBe('m-main');
    expect(r.costUsd).toBeCloseTo((200 * 1 + 20 * 2 + 800 * 0.1) / 1e6, 12);
    const s = seen[0] as Seen;
    expect(s.path).toBe('/v1/chat/completions');
    expect(s.headers.authorization).toBe('Bearer sk-test');
    expect(s.body).toMatchObject({ model: 'm-main', stream: true, stream_options: { include_usage: true }, max_tokens: 8192 });
    expect(s.body['tools']).toEqual([{ type: 'function', function: { name: 'con_send', description: 'send', parameters: request.tools[0]?.inputSchema } }]);
    expect(s.body).not.toHaveProperty('reasoning_effort');
  });

  it('sends reasoning effort and the other output field when the profile asks for them', async () => {
    answers.push(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'length' }] }, '[DONE]']));
    const p = new OpenAiChatProvider(profile('openai-chat', { openai: { reasoningEffort: true, maxTokensField: 'max_completion_tokens' }, maxOutputTokens: 1000 }), 'k', 'local');
    const r = await p.generate({ ...request, role: 'cheap', effort: 'medium' }, { signal: AbortSignal.timeout(5000) });
    expect(r.stopReason).toBe('max_tokens');
    expect(seen[0]?.body).toMatchObject({ model: 'm-cheap', reasoning_effort: 'medium', max_completion_tokens: 1000 });
    expect(seen[0]?.body).not.toHaveProperty('max_tokens');
    // No usage from the server: an estimate, so budgets and handoff still see something.
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });

  it('accepts a plain JSON completion from a server that ignores stream', async () => {
    answers.push(json(200, { model: 'm', choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    const r = await new OpenAiChatProvider(profile('openai-chat'), 'k', 'local').generate(request, { signal: AbortSignal.timeout(5000) });
    expect(r.content).toEqual([{ type: 'text', text: 'plain' }]);
    expect(r.stopReason).toBe('end_turn');
  });

  it('retries 429 and 5xx, and classifies rejected keys and overflows', async () => {
    answers.push(json(429, { error: { message: 'slow down' } }), sse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']));
    const p = new OpenAiChatProvider(profile('openai-chat', { maxRetries: 1 }), 'k', 'local');
    expect((await p.generate(request, { signal: AbortSignal.timeout(10_000) })).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(seen).toHaveLength(2);

    answers.push(json(401, { error: { message: 'Incorrect API key provided' } }));
    await expect(p.generate(request, { signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ kind: 'config', status: 401 });
    answers.push(json(400, { error: { message: "This model's maximum context length is 8192 tokens", code: 'context_length_exceeded' } }));
    await expect(new OpenAiChatProvider(profile('openai-chat'), 'k', 'local').generate(request, { signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ kind: 'overflow' });
    expect(classifyHttpStatus(503, 'busy')).toMatchObject({ kind: 'retryable' });
    expect(classifyHttpStatus(404, '{"error":{"message":"model not found"}}').message).toContain('model not found');
  });

  it('is not ready without its key, and needs none when the profile has no key secret', () => {
    expect(new OpenAiChatProvider(profile('openai-chat'), undefined, 'local').health()).toEqual({ ready: false, problem: 'secret PROVIDER_LOCAL_API_KEY is not set' });
    expect(new OpenAiChatProvider(profile('openai-chat', { apiKeySecret: null }), undefined, 'local').health()).toEqual({ ready: true });
  });

  it('turns arguments that are not JSON into an input the schema check rejects', async () => {
    answers.push(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'con_send', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']));
    const r = await new OpenAiChatProvider(profile('openai-chat'), 'k', 'local').generate(request, { signal: AbortSignal.timeout(5000) });
    expect(r.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'con_send', input: { _raw: '{oops' } }]);
  });

  it('lists the endpoint models', async () => {
    answers.push(json(200, { data: [{ id: 'b' }, { id: 'a' }] }));
    expect(await new OpenAiChatProvider(profile('openai-chat'), 'k', 'local').listModels(AbortSignal.timeout(5000))).toEqual(['a', 'b']);
    expect(seen[0]?.path).toBe('/v1/models');
  });
});

describe('OpenAiResponsesProvider', () => {
  it('streams a response with instructions, store: false, function calls and cached usage', async () => {
    answers.push(
      sse([
        { type: 'response.created', response: { status: 'in_progress' } },
        { type: 'response.output_text.delta', delta: 'On ' },
        { type: 'response.output_text.delta', delta: 'it.' },
        {
          type: 'response.completed',
          response: {
            model: 'gpt-x',
            status: 'completed',
            output: [
              { type: 'reasoning', summary: [] },
              { type: 'message', content: [{ type: 'output_text', text: 'On it.' }] },
              { type: 'function_call', call_id: 'fc_1', name: 'con_send', arguments: '{"text":"done"}' },
            ],
            usage: { input_tokens: 500, output_tokens: 9, input_tokens_details: { cached_tokens: 400 } },
          },
        },
      ]),
    );
    const deltas: string[] = [];
    const r = await new OpenAiResponsesProvider(profile('openai-responses', { openai: { reasoningEffort: true } }), 'k', 'oa').generate(request, {
      signal: AbortSignal.timeout(5000),
      onText: (d) => deltas.push(d),
    });
    expect(deltas.join('')).toBe('On it.');
    expect(r.content).toEqual([
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'fc_1', name: 'con_send', input: { text: 'done' } },
    ]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 9, cacheReadTokens: 400, cacheWriteTokens: 0 });
    const s = seen[0] as Seen;
    expect(s.path).toBe('/v1/responses');
    expect(s.body).toMatchObject({ model: 'm-main', stream: true, store: false, instructions: 'You are Protea.\n\nRuntime notes.', max_output_tokens: 8192, reasoning: { effort: 'high' } });
    expect(s.body['tools']).toEqual([{ type: 'function', name: 'con_send', description: 'send', parameters: request.tools[0]?.inputSchema, strict: false }]);
  });

  it('maps an incomplete response and a failed one', async () => {
    answers.push(sse([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }]));
    const p = new OpenAiResponsesProvider(profile('openai-responses'), 'k', 'oa');
    expect((await p.generate(request, { signal: AbortSignal.timeout(5000) })).stopReason).toBe('max_tokens');
    answers.push(sse([{ type: 'response.failed', response: { status: 'failed', error: { message: 'boom', code: 'server_error' } } }]));
    await expect(p.generate(request, { signal: AbortSignal.timeout(5000) })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('probeProfile', () => {
  it('tests an unsaved profile with a key typed into the form, and reports failures without throwing', async () => {
    const secrets = new SecretStore(tmpDir(), {});
    answers.push(sse([{ model: 'm-main', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]']));
    const ok = await probeProfile('local', profile('openai-chat'), secrets, { what: 'test', apiKey: 'sk-typed' });
    expect(ok).toMatchObject({ ok: true, model: 'm-main', reply: 'OK', stopReason: 'end_turn' });
    expect(seen[0]?.headers.authorization).toBe('Bearer sk-typed');
    expect(seen[0]?.body['max_tokens']).toBe(256);

    const missing = await probeProfile('local', profile('openai-chat'), secrets, { what: 'test' });
    expect(missing).toMatchObject({ ok: false, kind: 'config', error: 'secret PROVIDER_LOCAL_API_KEY is not set' });
    answers.push(json(401, { error: { message: 'bad key' } }));
    expect(await probeProfile('local', profile('openai-chat'), secrets, { what: 'models', apiKey: 'x' })).toMatchObject({ ok: false, kind: 'config', status: 401 });
  });
});
