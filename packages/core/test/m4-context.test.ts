import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentBlock } from '@protea/protocol';
import {
  AnthropicProvider,
  ContextAssembler,
  ProviderError,
  RedactingProvider,
  ScriptedProvider,
  SystemSegments,
  ToolRegistry,
  Transcript,
  contextWindowOf,
  defaultConfig,
  echoableContent,
  prefixFingerprint,
  redactRequest,
  secretsEpoch,
  silentLogger,
  textReply,
  defaultProfile,
  type ProviderProfile,
  type ProviderRequest,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

const thinking = (n: number): ContentBlock => ({ type: 'thinking', thinking: `reasoning ${n}`, signature: `sig${n}` });

describe('thinking floor (preserved thinking)', () => {
  it('drops thinking blocks from before a prefix change, append-only and across reopen', () => {
    const file = path.join(tmpDir(), 'main.0001.jsonl');
    const { transcript: t } = Transcript.open(file);
    t.appendMessage({ role: 'user', content: [{ type: 'text', text: 'one' }] });
    t.appendMessage({ role: 'assistant', content: [thinking(1), { type: 'text', text: 'a1' }] });
    expect(t.notePrefix('p1')).toBe(true); // first fingerprint with thinking already present (an upgraded transcript)
    t.appendMessage({ role: 'user', content: [{ type: 'text', text: 'two' }] });
    t.appendMessage({ role: 'assistant', content: [thinking(2), { type: 'text', text: 'a2' }] });
    expect(t.notePrefix('p1')).toBe(false); // unchanged prefix: blocks stay
    expect(t.messages[3]?.content[0]).toEqual(thinking(2));
    expect(t.messages[1]?.content).toEqual([{ type: 'text', text: 'a1' }]);

    expect(t.notePrefix('p2')).toBe(true); // SOUL.md changed, say
    expect(t.messages.flatMap((m) => m.content).some((b) => b.type === 'thinking')).toBe(false);
    t.appendMessage({ role: 'user', content: [{ type: 'text', text: 'three' }] });
    t.appendMessage({ role: 'assistant', content: [thinking(3)] });
    t.appendMessage({ role: 'user', content: [{ type: 'text', text: 'four' }] });
    expect(t.messages.at(-2)?.content).toEqual([thinking(3)]);
    t.close();

    const { transcript: again } = Transcript.open(file);
    expect(again.messages).toEqual(t.messages);
    expect(again.notePrefix('p2')).toBe(false);
    // A message left empty by the floor disappears; the floor does not move past messages without thinking.
    expect(again.notePrefix('p3')).toBe(true);
    expect(again.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'user']);
    again.close();
  });

  it('fingerprints the system prompt and loaded tools, not deferred ones', () => {
    const base: ProviderRequest = {
      role: 'main',
      effort: 'high',
      system: [{ id: 'identity', text: 'A' }],
      messages: [],
      tools: [
        { name: 'b', description: 'b', inputSchema: {} },
        { name: 'a', description: 'a', inputSchema: {} },
      ],
    };
    const fp = prefixFingerprint(base);
    expect(prefixFingerprint({ ...base, tools: [...base.tools].reverse() })).toBe(fp);
    expect(prefixFingerprint({ ...base, tools: [...base.tools, { name: 'mcp__x__y', description: '', inputSchema: {}, deferLoading: true }] })).toBe(fp);
    expect(prefixFingerprint({ ...base, system: [{ id: 'identity', text: 'B' }] })).not.toBe(fp);
    expect(prefixFingerprint(base, 'salt')).not.toBe(fp);
    expect(prefixFingerprint({ ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })).toBe(fp);
  });
});

describe('secret redaction (invariant I-7)', () => {
  const secrets = { knownValues: () => [{ name: 'API_TOKEN', value: 'sk-very-secret-123' }] };

  it('replaces secret values in system text, messages, tool inputs and results, leaving thinking alone', () => {
    const req: ProviderRequest = {
      role: 'main',
      effort: 'high',
      system: [{ id: 'owner', text: 'token sk-very-secret-123' }],
      tools: [{ name: 't', description: 'uses sk-very-secret-123', inputSchema: {} }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'my key is sk-very-secret-123!' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'sk-very-secret-123', signature: 's' },
            { type: 'tool_use', id: 'u1', name: 't', input: { q: ['sk-very-secret-123'] } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'got sk-very-secret-123' }] }] },
      ],
    };
    const { req: out, hits } = redactRequest(req, secrets);
    expect(hits).toEqual(['API_TOKEN']);
    const json = JSON.stringify({ ...out, messages: out.messages.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== 'thinking') })) });
    expect(json).not.toContain('sk-very-secret-123');
    expect(json).toContain('[REDACTED:API_TOKEN]');
    expect(out.messages[1]?.content[0]).toEqual(req.messages[1]?.content[0]);
    // Deterministic, so the cached prefix stays stable from request to request.
    expect(JSON.stringify(redactRequest(req, secrets).req)).toBe(JSON.stringify(out));
    expect(secretsEpoch(secrets)).toBe(secretsEpoch(secrets));
    expect(secretsEpoch({ knownValues: () => [] })).not.toBe(secretsEpoch(secrets));
  });

  it('wraps a provider and reports which secrets it removed', async () => {
    const inner = new ScriptedProvider([() => textReply('ok')]);
    const heard: string[][] = [];
    const p = new RedactingProvider(inner, secrets, (n) => heard.push(n));
    await p.generate(
      { role: 'main', effort: 'high', system: [], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'sk-very-secret-123' }] }] },
      { signal: new AbortController().signal },
    );
    expect(JSON.stringify(inner.calls[0])).not.toContain('sk-very-secret-123');
    expect(heard).toEqual([['API_TOKEN']]);
  });
});

describe('refusal fallback echo rules', () => {
  it('drops the declined model’s reasoning and tool calls before the last fallback block', () => {
    const content: ContentBlock[] = [
      thinking(1),
      { type: 'text', text: 'partial' },
      { type: 'tool_use', id: 'u1', name: 'x', input: {} },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      { type: 'server_tool_use', id: 's2', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-5' } },
      thinking(2),
      { type: 'text', text: 'final' },
    ];
    expect(echoableContent(content).map((b) => `${b.type}${b['id'] ? `:${String(b['id'])}` : ''}`)).toEqual([
      'text',
      'server_tool_use:s1',
      'web_search_tool_result',
      'fallback',
      'thinking',
      'text',
    ]);
    const plain: ContentBlock[] = [thinking(1), { type: 'text', text: 'x' }];
    expect(echoableContent(plain)).toBe(plain);
  });
});

describe('AnthropicProvider (M4 additions)', () => {
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
  const req: ProviderRequest = {
    role: 'main',
    effort: 'high',
    system: [{ id: 'identity', text: 'You are Protea.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [
      { name: 'memory', description: 'mem', inputSchema: { type: 'object' }, providerType: 'memory_20250818' },
      { name: 'idle', description: 'idle', inputSchema: { type: 'object' } },
    ],
  };

  it('declares provider tool types, compaction, per-request output budgets and the binding control', () => {
    const p = new AnthropicProvider(settings(), 'k').buildParams({ ...req, maxOutputTokens: 900, compaction: { triggerTokens: 150_000, instructions: 'Keep promises.' } });
    expect(p.tools?.[0]).toEqual({ type: 'memory_20250818', name: 'memory' });
    expect(p.max_tokens).toBe(900);
    expect(p.context_management).toEqual({ edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 }, instructions: 'Keep promises.' }] });
    expect(p.betas).toEqual(['thinking-binding-controls-2026-08-01', 'compact-2026-01-12', 'server-side-fallback-2026-07-01']);
    const strict = new AnthropicProvider(settings({ thinkingMismatch: 'error' }), 'k').buildParams(req);
    expect(strict.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: 'error' } });
  });

  it('knows context windows', () => {
    expect(contextWindowOf('claude-opus-5-5')).toBe(1_000_000);
    expect(contextWindowOf('claude-sonnet-4-6')).toBe(1_000_000);
    expect(contextWindowOf('claude-haiku-4-5')).toBe(200_000);
  });

  describe('against a local API', () => {
    let server: http.Server;
    let baseUrl = '';
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sse = (events: Array<[string, unknown]>): string => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

    beforeAll(async () => {
      server = http.createServer((r, res) => {
        let raw = '';
        r.on('data', (c: Buffer) => (raw += c.toString()));
        r.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          seen.push({ url: r.url ?? '', body });
          if (r.url?.startsWith('/v1/messages/count_tokens')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ input_tokens: 4321 }));
            return;
          }
          if ((body['system'] as Array<{ text: string }>)[0]?.text === 'too long') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1200000 tokens > 1000000 maximum' } }));
            return;
          }
          const usage = {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            iterations: [
              { type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            ],
          };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            sse([
              ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage, input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' }] } }],
              ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'u1', name: 'idle', input: {} } }],
              ['content_block_stop', { type: 'content_block_stop', index: 0 }],
              ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: 'cyber' } } }],
              ['content_block_stop', { type: 'content_block_stop', index: 1 }],
              ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }],
              ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'served' } }],
              ['content_block_stop', { type: 'content_block_stop', index: 2 }],
              ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }],
              ['message_stop', { type: 'message_stop' }],
            ]),
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('counts tokens, prices every attempt and keeps only what may be echoed after a fallback', async () => {
      const p = new AnthropicProvider(settings({ baseUrl }), 'test-key');
      expect(await p.countTokens(req, { signal: new AbortController().signal })).toBe(4321);
      expect(seen.at(-1)?.body).not.toHaveProperty('max_tokens');
      const res = await p.generate(req, { signal: new AbortController().signal });
      expect(res.model).toBe('claude-opus-5');
      expect(res.content.map((b) => b.type)).toEqual(['fallback', 'text']);
      // Opus 5.5 at $4/$20, Opus 5 at $5/$25 per million tokens.
      expect(res.costUsd).toBeCloseTo((1_000 * 4 + 10 * 20 + 100 * 5 + 50 * 25) / 1e6, 10);
      expect(res.inputTransformations).toEqual([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' }]);
    });

    it('reports a too-long prompt as overflow', async () => {
      const p = new AnthropicProvider(settings({ baseUrl }), 'test-key');
      const err = await p.generate({ ...req, system: [{ id: 'x', text: 'too long' }] }, { signal: new AbortController().signal }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('overflow');
    });
  });
});

describe('memory-index segment and persona hooks in the prefix', () => {
  it('puts INDEX.md last and lets a hook reorder segments; a failing hook falls back', () => {
    let index: string | null = '# Memory index\n- notes/';
    let hook: ((ctx: { defaults: Array<{ id: string; text: string }> }) => Array<{ id: string; text: string }>) | null = null;
    const segs = new SystemSegments({
      persona: () => ({ dir: '/nowhere', soul: 'I am Protea.' }),
      hooks: () => (hook ? { systemSegments: hook } : null),
      memoryIndex: () => index,
      plugins: { envSources: () => [] },
      timezone: 'UTC',
      overridesDir: '/nowhere',
      log: silentLogger(),
    });
    expect(segs.segments().map((s) => s.id)).toEqual(['identity', 'runtime', 'memory-index']);
    expect(segs.segments().at(-1)?.text).toBe('<memory_index path="/memories/INDEX.md">\n# Memory index\n- notes/\n</memory_index>');
    index = null;
    hook = ({ defaults }) => [{ id: 'custom', text: 'first' }, ...defaults.filter((s) => s.id !== 'runtime')];
    segs.refresh();
    expect(segs.segments().map((s) => s.id)).toEqual(['custom', 'identity']);
    hook = () => {
      throw new Error('boom');
    };
    segs.refresh();
    expect(segs.segments().map((s) => s.id)).toEqual(['identity', 'runtime']);
    // The assembler passes compaction only to main-session requests.
    const a = new ContextAssembler(segs, new ToolRegistry(), undefined, () => ({ triggerTokens: 100_000, instructions: null }));
    expect(a.build([], { role: 'main', effort: 'high' }).compaction).toEqual({ triggerTokens: 100_000, instructions: null });
    expect(a.build([], { role: 'fork', effort: 'high' }).compaction).toBeUndefined();
  });
});
