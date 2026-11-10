import crypto from 'node:crypto';
import { isImageBlock, isTextBlock, isToolResultBlock, isToolUseBlock, type ContentBlock, type Effort, type ImageBlock, type ModelRole } from '@protea/protocol';
import type { ProviderProfile } from '../config/types.js';
import { estimateTokens } from '../util/tokens.js';
import { estimateRequestTokens } from './tokens.js';
import { estimateCost } from './pricing.js';
import { joinUrl, parseArguments, request, resultText, sseMessages } from './http.js';
import { PROTOCOL_DEFAULT_URL } from './profiles.js';
import { ProviderError, type GenerateOptions, type Provider, type ProviderHealth, type ProviderRequest, type ProviderResponse, type ProviderUsage } from './types.js';

/** Context window assumed for models the profile does not describe. */
export const DEFAULT_OPENAI_CONTEXT = 128_000;

/** OpenAI's reasoning effort has three steps; Protea's two highest map to its highest. */
function reasoningEffort(e: Effort): 'low' | 'medium' | 'high' {
  return e === 'low' ? 'low' : e === 'medium' ? 'medium' : 'high';
}

/** A compaction block from Claude, kept readable for another model. */
function compactionText(b: ContentBlock): string | null {
  if (b.type !== 'compaction') return null;
  const c = b['content'];
  return typeof c === 'string' && c.trim() ? `[Summary of the earlier conversation]\n${c}` : null;
}

function assistantText(content: ContentBlock[]): string {
  return content
    .map((b) => (isTextBlock(b) ? b.text : compactionText(b)))
    .filter((t): t is string => t !== null && t !== '')
    .join('\n\n');
}

function userText(content: ContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n\n');
}

/** A resolved image as a data URL; references never get this far (providers/images.ts). */
function dataUrl(b: ImageBlock): string | null {
  return b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : null;
}

type UserPart = { kind: 'text'; text: string } | { kind: 'image'; url: string };

/**
 * What a user message says beyond its tool results, in order. Tool messages can only hold text,
 * so images a tool returned come first here, each group labelled with its call.
 */
function userParts(content: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const r of content.filter(isToolResultBlock)) {
    if (typeof r.content === 'string') continue;
    const urls = r.content.filter(isImageBlock).map(dataUrl).filter((u): u is string => u !== null);
    if (urls.length === 0) continue;
    parts.push({ kind: 'text', text: `<tool_images call_id="${r.tool_use_id}" count="${urls.length}"/>` });
    for (const url of urls) parts.push({ kind: 'image', url });
  }
  for (const b of content) {
    if (isTextBlock(b)) parts.push({ kind: 'text', text: b.text });
    else if (isImageBlock(b)) {
      const url = dataUrl(b);
      if (url) parts.push({ kind: 'image', url });
    }
  }
  return parts;
}

/** A tool result's text; its images travel in the user message after it. */
function toolResultText(content: unknown): string {
  return resultText(Array.isArray(content) ? (content as ContentBlock[]).filter((b) => !isImageBlock(b)) : content);
}

function callId(): string {
  return `call_${crypto.randomBytes(9).toString('base64url')}`;
}

/**
 * Shared by the OpenAI-style protocols: Bearer key, model per role, the context window, cost
 * from the profile's price table, and estimated usage when the server reports none.
 */
abstract class OpenAiStyleProvider implements Provider {
  protected readonly base: string;

  constructor(
    protected readonly settings: ProviderProfile,
    protected readonly apiKey: string | undefined,
    readonly id: string,
  ) {
    this.base = settings.baseUrl ?? (PROTOCOL_DEFAULT_URL[settings.protocol] as string);
  }

  modelFor(role: ModelRole): string {
    return this.settings.models[role];
  }

  health(): ProviderHealth {
    if (this.settings.apiKeySecret !== null && !this.apiKey) return { ready: false, problem: `secret ${this.settings.apiKeySecret} is not set` };
    return { ready: true };
  }

  supportsToolSearch(): boolean {
    return false;
  }

  contextWindow(): number {
    return this.settings.contextWindow ?? DEFAULT_OPENAI_CONTEXT;
  }

  /** The request field that keeps one role's requests on the same cache, for servers known to accept it. */
  protected cacheKeyField(role: ModelRole): Record<string, string> {
    const on = this.settings.openai.promptCacheKey ?? new URL(this.base).hostname === 'api.openai.com';
    return on ? { prompt_cache_key: `protea-${role}` } : {};
  }

  protected headers(): Record<string, string> {
    return { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.settings.headers };
  }

  protected check(): void {
    const h = this.health();
    if (!h.ready) throw new ProviderError('config', h.problem ?? 'provider not configured');
  }

  protected post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return request({ url: joinUrl(this.base, path), headers: { ...this.headers(), accept: 'text/event-stream' }, body, signal, timeoutMs: this.settings.timeoutMs, maxRetries: this.settings.maxRetries });
  }

  protected finish(req: ProviderRequest, content: ContentBlock[], stopReason: string, usage: ProviderUsage | null, model: string | null): ProviderResponse {
    const requested = this.modelFor(req.role);
    const u = usage ?? { inputTokens: estimateRequestTokens(req), outputTokens: estimateTokens(JSON.stringify(content)), cacheReadTokens: 0, cacheWriteTokens: 0 };
    const res: ProviderResponse = { content, stopReason, usage: u, model: model || requested, requestedModel: requested };
    const cost = estimateCost(this.settings.pricing[res.model] ?? this.settings.pricing[requested], u, { fiveMinute: 0, oneHour: 0 });
    if (cost !== undefined) res.costUsd = cost;
    return res;
  }

  /** The endpoint's model names (GET /models). */
  async listModels(signal: AbortSignal): Promise<string[]> {
    this.check();
    const res = await request({ url: joinUrl(this.base, '/models'), method: 'GET', headers: this.headers(), signal, timeoutMs: 30_000, maxRetries: 0 });
    const j = (await res.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
    const list = j.data ?? j.models ?? [];
    return list.map((m) => String((m as { id?: unknown }).id ?? (m as { name?: unknown }).name ?? '')).filter(Boolean).sort();
  }

  abstract generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse>;
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Canonical (Anthropic-shaped) messages as Chat Completions messages; thinking and server-tool blocks stay behind. */
export function toChatMessages(req: ProviderRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = req.system.map((s) => s.text).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      for (const r of m.content.filter(isToolResultBlock)) {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: `${r.is_error ? 'Error: ' : ''}${toolResultText(r.content)}` });
      }
      const parts = userParts(m.content);
      if (parts.some((p) => p.kind === 'image')) {
        out.push({ role: 'user', content: parts.map((p): ChatContentPart => (p.kind === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.url } })) });
      } else {
        const text = userText(m.content);
        if (text) out.push({ role: 'user', content: text });
      }
    } else {
      const text = assistantText(m.content);
      const calls = m.content.filter(isToolUseBlock).map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

function chatStop(finish: string | null, hasCalls: boolean): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  return hasCalls ? 'tool_use' : 'end_turn';
}

interface ChatChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null; prompt_cache_hit_tokens?: number } | null;
  error?: { message?: string };
}

/** Chat Completions usage: prompt tokens include the cached ones. */
function chatUsage(u: NonNullable<ChatChunk['usage']>): ProviderUsage {
  const prompt = u.prompt_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  return { inputTokens: Math.max(0, prompt - cached), outputTokens: u.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/**
 * OpenAI Chat Completions (`POST {baseUrl}/chat/completions`, streamed): OpenAI, DeepSeek,
 * Qwen, Kimi, GLM, OpenRouter, Ollama, vLLM, LM Studio and other compatible servers. Tools are
 * function calls; caching is the server's own (reported cached tokens count as cache reads).
 */
export class OpenAiChatProvider extends OpenAiStyleProvider {
  buildBody(req: ProviderRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelFor(req.role),
      messages: toChatMessages(req),
      stream: true,
      stream_options: { include_usage: true },
      [this.settings.openai.maxTokensField]: req.maxOutputTokens ?? this.settings.maxOutputTokens,
      ...this.cacheKeyField(req.role),
    };
    if (req.tools.length > 0) body['tools'] = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (this.settings.openai.reasoningEffort) body['reasoning_effort'] = reasoningEffort(req.effort);
    return body;
  }

  async generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse> {
    this.check();
    const res = await this.post('/chat/completions', this.buildBody(req), opts.signal);
    let text = '';
    const calls: Array<{ id: string; name: string; args: string }> = [];
    let finish: string | null = null;
    let usage: ProviderUsage | null = null;
    let model: string | null = null;
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // A server that ignored `stream`: one JSON completion.
      const j = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: ChatChunk['usage'] };
      const c = j.choices?.[0];
      text = c?.message?.content ?? '';
      if (text) opts.onText?.(text);
      for (const tc of c?.message?.tool_calls ?? []) calls.push({ id: tc.id ?? callId(), name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' });
      finish = c?.finish_reason ?? null;
      usage = j.usage ? chatUsage(j.usage) : null;
      model = j.model ?? null;
    } else {
      const byIndex = new Map<number, { id: string; name: string; args: string }>();
      for await (const m of sseMessages(res, opts.signal)) {
        if (m.data === '[DONE]') break;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(m.data) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError('retryable', `the server reported an error mid-stream: ${chunk.error.message ?? 'unknown'}`);
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chatUsage(chunk.usage);
        for (const choice of chunk.choices ?? []) {
          const d = choice.delta;
          if (d?.content) {
            text += d.content;
            opts.onText?.(d.content);
          }
          // Servers that stream their reasoning beside the answer (DeepSeek and others).
          if (d?.reasoning_content) opts.onThinking?.(d.reasoning_content);
          for (const tc of d?.tool_calls ?? []) {
            const index = tc.index ?? (tc.id || byIndex.size === 0 ? byIndex.size : byIndex.size - 1);
            let cur = byIndex.get(index);
            if (!cur) {
              cur = { id: tc.id || callId(), name: '', args: '' };
              byIndex.set(index, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) {
              cur.args += tc.function.arguments;
              opts.onToolInput?.({ id: cur.id, name: cur.name, json: tc.function.arguments });
            }
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
      for (const [, c] of [...byIndex].sort((a, b) => a[0] - b[0])) calls.push({ ...c, id: c.id || callId() });
    }
    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArguments(c.args) });
    return this.finish(req, content, chatStop(finish, calls.length > 0), usage, model);
  }
}

type ResponsesContentPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };

type ResponsesItem =
  | { role: 'user' | 'assistant'; content: string | ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** Canonical messages as Responses input items. */
export function toResponsesInput(req: ProviderRequest): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      for (const r of m.content.filter(isToolResultBlock)) out.push({ type: 'function_call_output', call_id: r.tool_use_id, output: `${r.is_error ? 'Error: ' : ''}${toolResultText(r.content)}` });
      const parts = userParts(m.content);
      if (parts.some((p) => p.kind === 'image')) {
        out.push({ role: 'user', content: parts.map((p): ResponsesContentPart => (p.kind === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.url })) });
      } else {
        const text = userText(m.content);
        if (text) out.push({ role: 'user', content: text });
      }
    } else {
      const text = assistantText(m.content);
      if (text) out.push({ role: 'assistant', content: text });
      for (const b of m.content.filter(isToolUseBlock)) out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
  }
  return out;
}

interface ResponsesResult {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; call_id?: string; name?: string; arguments?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } | null } | null;
}

/**
 * OpenAI Responses (`POST {baseUrl}/responses`, streamed, `store: false`): OpenAI's current
 * API. Nothing is kept on the server; earlier reasoning items are not sent back.
 */
export class OpenAiResponsesProvider extends OpenAiStyleProvider {
  buildBody(req: ProviderRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelFor(req.role),
      input: toResponsesInput(req),
      stream: true,
      store: false,
      max_output_tokens: req.maxOutputTokens ?? this.settings.maxOutputTokens,
      ...this.cacheKeyField(req.role),
    };
    const instructions = req.system.map((s) => s.text).join('\n\n');
    if (instructions) body['instructions'] = instructions;
    if (req.tools.length > 0) body['tools'] = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
    if (this.settings.openai.reasoningEffort) body['reasoning'] = { effort: reasoningEffort(req.effort) };
    return body;
  }

  async generate(req: ProviderRequest, opts: GenerateOptions): Promise<ProviderResponse> {
    this.check();
    const res = await this.post('/responses', this.buildBody(req), opts.signal);
    let final: ResponsesResult | null = null;
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      final = (await res.json()) as ResponsesResult;
    } else {
      const fnCalls = new Map<number, { id: string; name: string }>();
      for await (const m of sseMessages(res, opts.signal)) {
        let ev: { type?: string; delta?: string; response?: ResponsesResult; message?: string; code?: string; output_index?: number; item?: { type?: string; call_id?: string; name?: string } };
        try {
          ev = JSON.parse(m.data) as typeof ev;
        } catch {
          continue;
        }
        const type = ev.type ?? m.event;
        if (type === 'response.output_text.delta' && ev.delta) opts.onText?.(ev.delta);
        else if (type === 'response.reasoning_summary_text.delta' && ev.delta) opts.onThinking?.(ev.delta);
        else if (type === 'response.output_item.added' && ev.item?.type === 'function_call' && ev.output_index !== undefined && ev.item.call_id) fnCalls.set(ev.output_index, { id: ev.item.call_id, name: ev.item.name ?? '' });
        else if (type === 'response.function_call_arguments.delta' && ev.delta) {
          const call = ev.output_index !== undefined ? fnCalls.get(ev.output_index) : undefined;
          if (call) opts.onToolInput?.({ ...call, json: ev.delta });
        }
        else if (type === 'response.completed' || type === 'response.incomplete') final = ev.response ?? null;
        else if (type === 'response.failed') {
          const e = ev.response?.error;
          throw new ProviderError('fatal', `the response failed: ${e?.message ?? 'unknown'}${e?.code ? ` (${e.code})` : ''}`);
        } else if (type === 'error') {
          throw new ProviderError('retryable', `the server reported an error mid-stream: ${ev.message ?? 'unknown'}${ev.code ? ` (${ev.code})` : ''}`);
        }
      }
    }
    if (!final) throw new ProviderError('retryable', 'the response stream ended without a result');
    if (final.error) throw new ProviderError('fatal', `the response failed: ${final.error.message ?? 'unknown'}`);
    const content: ContentBlock[] = [];
    let text = '';
    const calls: ContentBlock[] = [];
    for (const item of final.output ?? []) {
      if (item.type === 'message') for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) text += c.text;
      if (item.type === 'function_call') calls.push({ type: 'tool_use', id: item.call_id ?? callId(), name: item.name ?? '', input: parseArguments(item.arguments ?? '') });
    }
    if (text) content.push({ type: 'text', text });
    content.push(...calls);
    const reason = final.incomplete_details?.reason;
    const stop = reason === 'max_output_tokens' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : calls.length > 0 ? 'tool_use' : 'end_turn';
    const u = final.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    const usage = u ? { inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached), outputTokens: u.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 } : null;
    return this.finish(req, content, stop, usage, final.model ?? null);
  }
}
