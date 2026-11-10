import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ContentBlock, ModelRole } from '@protea/protocol';
import type { ProviderProfile } from '../config/types.js';
import { AbortedError } from '../util/abort.js';
import { DEFAULT_PRICING, estimateCost } from './pricing.js';
import { ProviderError, type Provider, type ProviderHealth, type ProviderRequest, type ProviderResponse } from './types.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const COMPACT_BETA = 'compact-2026-01-12';

const TOOL_SEARCH_TOOL = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' } as const;

/** Tool search needs Claude 4.5 or later. */
function supportsToolSearchModel(model: string): boolean {
  return !/^claude-(3|2|instant)|^claude-(opus|sonnet)-4(-[01])?(-\d{8})?$/.test(model);
}

/** Input tokens a model accepts: 1M for the current generation, 200k for older models. */
export function contextWindowOf(model: string): number {
  if (/^claude-(fable|mythos|opus|sonnet|haiku)-5/.test(model)) return 1_000_000;
  if (/^claude-(opus|sonnet)-4-([6-9])/.test(model)) return 1_000_000;
  return 200_000;
}

const MODEL_INTERNAL = new Set(['thinking', 'redacted_thinking', 'tool_use']);

/**
 * After a refusal fallback mid-output, the declined model's reasoning and tool calls before
 * the last `fallback` block must not be echoed back (only its text and paired server-tool
 * blocks). Everything from the boundary on is kept as is.
 */
export function echoableContent(content: ContentBlock[]): ContentBlock[] {
  let last = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') last = i;
  });
  if (last <= 0) return content;
  const before = content.slice(0, last);
  const results = new Set(before.filter((b) => b.type.endsWith('_tool_result')).map((b) => String(b['tool_use_id'])));
  const kept = before.filter((b) => {
    if (MODEL_INTERNAL.has(b.type)) return false;
    if (b.type === 'server_tool_use') return results.has(String(b['id']));
    return b.type === 'text' || b.type.endsWith('_tool_result');
  });
  return [...kept, ...content.slice(last)];
}

/** Models without server-side fallback support (sending `fallbacks` to them is pointless or rejected). */
function supportsFallbacks(model: string): boolean {
  return !model.startsWith('claude-haiku');
}

/**
 * Claude via the Messages API (beta namespace, for `fallbacks`). Always streams;
 * adaptive thinking; effort per request; one explicit cache breakpoint at the end of
 * the system prefix plus top-level automatic caching for the conversation tail.
 * With `anthropic.features: basic` (other vendors' Anthropic-compatible endpoints) only the
 * plain Messages fields are sent: no thinking or effort, no betas, a block-level cache mark.
 */
export class AnthropicProvider implements Provider {
  private readonly client: Anthropic | null;
  private readonly full: boolean;

  constructor(
    private readonly settings: ProviderProfile,
    apiKey: string | undefined,
    readonly id = 'anthropic',
  ) {
    this.full = settings.anthropic.features === 'full';
    const key = apiKey ?? (settings.apiKeySecret === null ? 'none' : undefined);
    this.client = key
      ? new Anthropic({
          apiKey: key,
          maxRetries: settings.maxRetries,
          timeout: settings.timeoutMs,
          ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
          ...(Object.keys(settings.headers).length > 0 ? { defaultHeaders: settings.headers } : {}),
        })
      : null;
  }

  modelFor(role: ModelRole): string {
    return this.settings.models[role];
  }

  supportsToolSearch(role: ModelRole): boolean {
    return this.full && supportsToolSearchModel(this.modelFor(role));
  }

  contextWindow(role: ModelRole): number {
    return this.settings.contextWindow ?? contextWindowOf(this.modelFor(role));
  }

  cacheHorizonMs(): number | undefined {
    if (!this.full) return undefined;
    return this.settings.anthropic.cacheTtl === '1h' ? 3_600_000 : 300_000;
  }

  async countTokens(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined> {
    if (!this.client || !this.full) return undefined;
    const p = this.buildParams(req);
    try {
      const res = await this.client.beta.messages.countTokens(
        {
          model: p.model,
          messages: p.messages,
          ...(p.system ? { system: p.system } : {}),
          ...(p.tools ? { tools: p.tools } : {}),
          ...(p.thinking ? { thinking: p.thinking } : {}),
          ...(p.context_management ? { context_management: p.context_management } : {}),
          ...(p.betas ? { betas: p.betas } : {}),
        },
        { signal: opts.signal },
      );
      return res.input_tokens;
    } catch (err) {
      throw classifyAnthropicError(err, opts.signal);
    }
  }

  health(): ProviderHealth {
    return this.client ? { ready: true } : { ready: false, problem: `secret ${this.settings.apiKeySecret} is not set` };
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    if (!this.client) throw new ProviderError('config', this.health().problem ?? 'provider not configured');
    const out: string[] = [];
    try {
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) out.push(m.id);
    } catch (err) {
      throw classifyAnthropicError(err, signal);
    }
    return out.sort();
  }

  buildParams(req: ProviderRequest): BetaMessageStreamParams {
    if (!this.full) return this.basicParams(req);
    const opt = this.settings.anthropic;
    const model = this.modelFor(req.role);
    const cache = { type: 'ephemeral' as const, ttl: opt.cacheTtl };
    const system: BetaTextBlockParam[] = req.system.map((s, i, all) =>
      i === all.length - 1 ? { type: 'text', text: s.text, cache_control: cache } : { type: 'text', text: s.text },
    );
    const tools: BetaToolUnion[] = req.tools.map((t) =>
      t.providerType
        ? ({ type: t.providerType, name: t.name } as unknown as BetaToolUnion)
        : {
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as BetaTool['input_schema'],
            eager_input_streaming: true,
            ...(t.deferLoading ? { defer_loading: true } : {}),
          },
    );
    const betas: string[] = [];
    // Deferred definitions stay out of the cached prefix; the search tool itself always loads.
    if (req.toolSearch) tools.push({ ...TOOL_SEARCH_TOOL });
    const params: BetaMessageStreamParams = {
      model,
      max_tokens: req.maxOutputTokens ?? this.settings.maxOutputTokens,
      system,
      messages: req.messages as unknown as BetaMessageParam[],
      thinking: {
        type: 'adaptive',
        display: opt.thinkingDisplay,
        ...(opt.thinkingMismatch ? { block_binding: { prefix_mismatch_behavior: opt.thinkingMismatch } } : {}),
      },
      output_config: { effort: req.effort },
      cache_control: cache,
    };
    if (tools.length > 0) params.tools = tools;
    if (opt.thinkingMismatch) betas.push(BINDING_BETA);
    if (req.compaction) {
      params.context_management = {
        edits: [
          {
            type: 'compact_20260112',
            trigger: { type: 'input_tokens', value: req.compaction.triggerTokens },
            ...(req.compaction.instructions ? { instructions: req.compaction.instructions } : {}),
          },
        ],
      };
      betas.push(COMPACT_BETA);
    }
    if (opt.fallbacks && supportsFallbacks(model)) {
      params.fallbacks = opt.fallbacks;
      betas.push(FALLBACK_BETA);
    }
    if (betas.length > 0) params.betas = betas;
    return params;
  }

  /** Plain Messages fields only; thinking blocks of earlier turns stay out (they belong to Claude). */
  private basicParams(req: ProviderRequest): BetaMessageStreamParams {
    const system: BetaTextBlockParam[] = req.system.map((s, i, all) =>
      i === all.length - 1 ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: s.text },
    );
    const tools: BetaToolUnion[] = req.tools
      .filter((t) => !t.providerType)
      .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as BetaTool['input_schema'] }));
    const messages = req.messages
      .map((m) => ({ role: m.role, content: m.content.filter((b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image') }))
      .filter((m) => m.content.length > 0);
    const params: BetaMessageStreamParams = {
      model: this.modelFor(req.role),
      max_tokens: req.maxOutputTokens ?? this.settings.maxOutputTokens,
      system,
      messages: messages as unknown as BetaMessageParam[],
    };
    if (tools.length > 0) params.tools = tools;
    return params;
  }

  async generate(
    req: ProviderRequest,
    opts: { signal: AbortSignal; onText?: (delta: string) => void },
  ): Promise<ProviderResponse> {
    if (!this.client) throw new ProviderError('config', this.health().problem ?? 'provider not configured');
    const params = this.buildParams(req);
    let message: BetaMessage;
    try {
      const stream = this.client.beta.messages.stream(params, { signal: opts.signal });
      if (opts.onText) stream.on('text', opts.onText);
      message = await stream.finalMessage();
    } catch (err) {
      throw classifyAnthropicError(err, opts.signal);
    }
    const u = message.usage;
    const usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    const cost = this.cost(message);
    const res: ProviderResponse = {
      content: echoableContent(message.content as unknown as ContentBlock[]),
      stopReason: message.stop_reason ?? 'end_turn',
      usage,
      model: message.model,
      requestedModel: params.model,
    };
    if (cost !== undefined) res.costUsd = cost;
    if (message.stop_details) res.stopDetails = message.stop_details;
    const transformations = (message as { input_transformations?: Array<{ type: string; path?: string; reason?: string }> | null }).input_transformations;
    if (transformations && transformations.length > 0) res.inputTransformations = transformations;
    return res;
  }

  /**
   * Cost of every attempt: `usage.iterations` lists each model that ran (declined attempts,
   * fallback models, compaction) at its own rates; the top-level usage covers only the last.
   */
  private cost(message: BetaMessage): number | undefined {
    type Iter = { type?: string; model?: string | null; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } | null };
    const u = message.usage as BetaMessage['usage'] & { iterations?: Iter[] | null };
    const attempts: Iter[] = u.iterations && u.iterations.length > 0 ? u.iterations : [u as unknown as Iter];
    let total = 0;
    for (const it of attempts) {
      const model = it.model ?? message.model;
      const pricing = this.settings.pricing[model] ?? DEFAULT_PRICING[model];
      const write = it.cache_creation_input_tokens ?? 0;
      const oneHour = it.cache_creation?.ephemeral_1h_input_tokens ?? (this.full && this.settings.anthropic.cacheTtl === '1h' ? write : 0);
      const c = estimateCost(
        pricing,
        { inputTokens: it.input_tokens ?? 0, outputTokens: it.output_tokens ?? 0, cacheReadTokens: it.cache_read_input_tokens ?? 0, cacheWriteTokens: write },
        { oneHour, fiveMinute: Math.max(0, write - oneHour) },
      );
      if (c === undefined) return undefined;
      total += c;
    }
    return total;
  }
}

/** Map SDK errors to retry semantics, most specific first (docs: shared error-codes table). */
export function classifyAnthropicError(err: unknown, signal?: AbortSignal): Error {
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return new AbortedError(signal?.reason ?? 'aborted');
  if (err instanceof Anthropic.NotFoundError) return new ProviderError('fatal', `model or endpoint not found: ${err.message}`, 404, { cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('config', `credentials rejected: ${err.message}`, err.status, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('retryable', `rate limited: ${err.message}`, 429, { cause: err });
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('retryable', `connection error: ${err.message}`, undefined, { cause: err });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ProviderError('retryable', `server error ${err.status}: ${err.message}`, err.status, { cause: err });
  }
  if (err instanceof Anthropic.APIError && (err.status === 413 || (err.status === 400 && /prompt is too long|too many (input )?tokens|exceeds? the (model's )?context/i.test(err.message)))) {
    return new ProviderError('overflow', `input too long: ${err.message}`, err.status, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const retry = err.status === 408 || err.status === 409;
    return new ProviderError(retry ? 'retryable' : 'fatal', `API error ${err.status ?? ''}: ${err.message}`, err.status, {
      cause: err,
    });
  }
  return new ProviderError('fatal', err instanceof Error ? err.message : String(err), undefined, { cause: err });
}
