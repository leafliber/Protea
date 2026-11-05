import type { ContentBlock, Effort, ModelRole, TranscriptMessage } from '@protea/protocol';
import type { ProviderToolDef } from '../tools/registry.js';

export interface SystemSegment {
  id: string;
  text: string;
}

/**
 * Provider-neutral request. Messages use the canonical (Anthropic-shaped) content
 * blocks; each provider maps them to its own API and decides cache placement.
 */
export interface ProviderRequest {
  role: ModelRole;
  system: SystemSegment[];
  messages: TranscriptMessage[];
  tools: ProviderToolDef[];
  /** Some tools are deferred: declare the provider's tool search tool. */
  toolSearch?: boolean;
  effort: Effort;
  /** Output budget for this request; the provider's configured maximum when omitted. */
  maxOutputTokens?: number;
  /** Let the provider compact the conversation server-side above this many input tokens. */
  compaction?: { triggerTokens: number; instructions: string | null };
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: string;
  usage: ProviderUsage;
  /** Model that produced the final content (differs from the requested one after a fallback). */
  model: string;
  /** Provider profile that served the request (set by the router). */
  provider?: string;
  requestedModel: string;
  costUsd?: number;
  stopDetails?: unknown;
  /** Changes the provider made to the input, e.g. thinking blocks it dropped (logged, never fatal). */
  inputTransformations?: Array<{ type: string; path?: string; reason?: string }>;
}

export type ProviderErrorKind = 'retryable' | 'fatal' | 'overflow' | 'config';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface ProviderHealth {
  ready: boolean;
  problem?: string;
}

export interface Provider {
  readonly id: string;
  modelFor(role: ModelRole): string;
  health(): ProviderHealth;
  /** Can search deferred tool definitions (`deferLoading`) for this role. */
  supportsToolSearch?(role: ModelRole): boolean;
  /** Input tokens the model for this role accepts (its context window), when known. */
  contextWindow?(role: ModelRole): number | undefined;
  /** Exact input tokens of a request, when the provider can count them; undefined otherwise. */
  countTokens?(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined>;
  /** Model names the endpoint offers (for the console's model picker), when it can list them. */
  listModels?(signal: AbortSignal): Promise<string[]>;
  /** Streams internally; resolves with the complete message. Throws ProviderError or an abort error. */
  generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse>;
}
