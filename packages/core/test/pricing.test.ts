import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICES, estimateCost, findPricing, normalizeModelId } from '../src/providers/pricing.js';
import { checkPricing } from '../src/providers/profiles.js';

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const none = { fiveMinute: 0, oneHour: 0 };

describe('model prices', () => {
  it('normalizes the names routers, clouds and snapshots use', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('us.anthropic.claude-opus-4-6-v1:0')).toBe('claude-opus-4-6');
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('gpt-5.4-2026-03-05')).toBe('gpt-5.4');
    expect(normalizeModelId('z-ai/GLM-5.3')).toBe('glm-5.3');
  });

  it('finds the built-in price by exact name, never a cheaper or dearer variant by prefix', () => {
    expect(findPricing('glm-5.3-flash')).toMatchObject({ source: 'builtin', key: 'glm-5.3-flash', pricing: { input: 0.15, output: 0.5 } });
    expect(findPricing('glm-5.3')).toMatchObject({ pricing: { input: 1.4, output: 4.4 } });
    expect(findPricing('glm-5.3-turbo-preview')).toBeNull();
    expect(findPricing('claude-sonnet-5-5')?.pricing).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
    expect(findPricing('openrouter/anthropic/claude-fable-5.2')?.pricing).toMatchObject({ input: 8, output: 40 });
    expect(findPricing('qwen3:8b')).toBeNull();
  });

  it('prefers the profile: exact name, then normalized name, then the longest pattern', () => {
    const custom = { 'glm-*': { input: 9, output: 9 }, 'glm-5.3*': { input: 1, output: 2 }, 'my-model': { input: 3, output: 4 } };
    expect(findPricing('glm-5.3-flash', custom)).toMatchObject({ source: 'custom', key: 'glm-5.3*' });
    expect(findPricing('glm-4.7', custom)).toMatchObject({ source: 'custom', key: 'glm-*' });
    expect(findPricing('vendor/My-Model', custom)).toMatchObject({ source: 'custom', key: 'my-model' });
    expect(findPricing('claude-opus-5-5', custom)).toMatchObject({ source: 'builtin' });
  });

  it('costs cache reads at the input price unless given, and applies the tier a prompt passes', () => {
    expect(estimateCost({ input: 2, output: 8 }, usage(1000, 100, 1000), none)).toBeCloseTo((1000 * 2 + 100 * 8 + 1000 * 2) / 1e6, 12);
    const haiku = findPricing('claude-haiku-5-5')?.pricing;
    expect(estimateCost(haiku, usage(1000, 100), none)).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 12);
    expect(estimateCost(haiku, usage(50_000, 100, 60_000), none)).toBeCloseTo((50_000 * 0.5 + 100 * 2.5 + 60_000 * 0.05) / 1e6, 12);
  });

  it('costs cache writes at cacheWrite when given, else 1.25x / 2x input', () => {
    expect(estimateCost({ input: 4, output: 20 }, usage(0, 0, 0, 300), { fiveMinute: 100, oneHour: 200 })).toBeCloseTo((100 * 5 + 200 * 8) / 1e6, 12);
    expect(estimateCost({ input: 4, output: 20, cacheWrite: 4 }, usage(0, 0, 0, 300), { fiveMinute: 100, oneHour: 200 })).toBeCloseTo((300 * 4) / 1e6, 12);
  });

  it('checks prices from config and the console', () => {
    expect(checkPricing('p', { 'm*': { input: 1, output: 2, cacheRead: 0.1, tiers: [{ above: 1000, input: 2, output: 4 }] } })).toEqual({ 'm*': { input: 1, output: 2, cacheRead: 0.1, tiers: [{ above: 1000, input: 2, output: 4 }] } });
    expect(() => checkPricing('p', { m: { input: 1 } })).toThrow('p.m.output is required');
    expect(() => checkPricing('p', { m: { input: -1, output: 1 } })).toThrow('at least 0');
    expect(() => checkPricing('p', { m: { input: 1, output: 1, cents: 3 } })).toThrow('p.m.cents');
  });

  it('lists every built-in id once', () => {
    const ids = BUILTIN_PRICES.flatMap((p) => p.ids);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(normalizeModelId(id)).toBe(id);
  });
});
