import type { ModelPricing } from '../config/types.js';
import type { ProviderUsage } from './types.js';

/** USD per million tokens. Approximate list prices; override with providers.anthropic.pricing. */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Cache writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL. */
export function estimateCost(
  pricing: ModelPricing | undefined,
  usage: ProviderUsage,
  writes: { fiveMinute: number; oneHour: number },
): number | undefined {
  if (!pricing) return undefined;
  const perTok = (usd: number): number => usd / 1_000_000;
  return (
    usage.inputTokens * perTok(pricing.input) +
    usage.outputTokens * perTok(pricing.output) +
    usage.cacheReadTokens * perTok(pricing.cacheRead) +
    writes.fiveMinute * perTok(pricing.input * 1.25) +
    writes.oneHour * perTok(pricing.input * 2)
  );
}
