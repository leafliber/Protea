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
import type { AnthropicSettings } from '../config/types.js';
import { AbortedError } from '../util/abort.js';
import { DEFAULT_PRICING, estimateCost } from './pricing.js';
import { ProviderError, type Provider, type ProviderHealth, type ProviderRequest, type ProviderResponse } from './types.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models without server-side fallback support (sending `fallbacks` to them is pointless or rejected). */
function supportsFallbacks(model: string): boolean {
  return !model.startsWith('claude-haiku');
}

/**
 * Claude via the Messages API (beta namespace, for `fallbacks`). Always streams;
 * adaptive thinking; effort per request; one explicit cache breakpoint at the end of
 * the system prefix plus top-level automatic caching for the conversation tail.
 */
export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  private readonly client: Anthropic | null;

  constructor(
    private readonly settings: AnthropicSettings,
    apiKey: string | undefined,
  ) {
    this.client = apiKey
      ? new Anthropic({
          apiKey,
          maxRetries: settings.maxRetries,
          timeout: settings.timeoutMs,
          ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
        })
      : null;
  }

  modelFor(role: ModelRole): string {
    return this.settings.models[role];
  }

  health(): ProviderHealth {
    return this.client ? { ready: true } : { ready: false, problem: `secret ${this.settings.apiKeySecret} is not set` };
  }

  buildParams(req: ProviderRequest): BetaMessageStreamParams {
    const model = this.modelFor(req.role);
    const cache = { type: 'ephemeral' as const, ttl: this.settings.cacheTtl };
    const system: BetaTextBlockParam[] = req.system.map((s, i, all) =>
      i === all.length - 1 ? { type: 'text', text: s.text, cache_control: cache } : { type: 'text', text: s.text },
    );
    const tools: BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool['input_schema'],
      eager_input_streaming: true,
    }));
    const params: BetaMessageStreamParams = {
      model,
      max_tokens: this.settings.maxOutputTokens,
      system,
      messages: req.messages as unknown as BetaMessageParam[],
      thinking: { type: 'adaptive', display: this.settings.thinkingDisplay },
      output_config: { effort: req.effort },
      cache_control: cache,
    };
    if (tools.length > 0) params.tools = tools;
    if (this.settings.fallbacks && supportsFallbacks(model)) {
      params.fallbacks = this.settings.fallbacks;
      params.betas = [FALLBACK_BETA];
    }
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
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? (this.settings.cacheTtl === '1h' ? usage.cacheWriteTokens : 0);
    const pricing = this.settings.pricing[message.model] ?? DEFAULT_PRICING[message.model];
    const cost = estimateCost(pricing, usage, { oneHour, fiveMinute: Math.max(0, usage.cacheWriteTokens - oneHour) });
    const res: ProviderResponse = {
      content: message.content as unknown as ContentBlock[],
      stopReason: message.stop_reason ?? 'end_turn',
      usage,
      model: message.model,
      requestedModel: params.model,
    };
    if (cost !== undefined) res.costUsd = cost;
    if (message.stop_details) res.stopDetails = message.stop_details;
    return res;
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
  if (err instanceof Anthropic.APIError) {
    const retry = err.status === 408 || err.status === 409;
    return new ProviderError(retry ? 'retryable' : 'fatal', `API error ${err.status ?? ''}: ${err.message}`, err.status, {
      cause: err,
    });
  }
  return new ProviderError('fatal', err instanceof Error ? err.message : String(err), undefined, { cause: err });
}
