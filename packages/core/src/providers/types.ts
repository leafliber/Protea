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
  effort: Effort;
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
  requestedModel: string;
  costUsd?: number;
  stopDetails?: unknown;
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
  /** Streams internally; resolves with the complete message. Throws ProviderError or an abort error. */
  generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse>;
}
