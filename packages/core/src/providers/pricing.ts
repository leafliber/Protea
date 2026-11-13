import type { ModelPricing } from '../config/types.js';
import type { ProviderUsage } from './types.js';

/**
 * Built-in list prices, USD per million tokens, for looking a model up when its profile names no
 * price. Entries match a model name exactly after `normalizeModelId` (no date suffixes, no vendor
 * prefixes), never by prefix: a "-flash" or "-mini" variant is a different price. A profile's
 * `pricing` always wins. Vendors change prices: `PRICES_CHECKED` says when these were read.
 */
export const PRICES_CHECKED = '2026-11-13';

export interface BuiltinPrice {
  vendor: string;
  /** Model names this price applies to, after normalizeModelId. */
  ids: string[];
  pricing: ModelPricing;
}

const claude = (ids: string[], input: number, output: number, cacheRead: number, tiers?: ModelPricing['tiers']): BuiltinPrice => ({
  vendor: 'Anthropic',
  ids,
  pricing: { input, output, cacheRead, ...(tiers ? { tiers } : {}) },
});

export const BUILTIN_PRICES: readonly BuiltinPrice[] = [
  claude(['claude-fable-5-2', 'claude-mythos-5-2'], 8, 40, 0.2),
  claude(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5'], 10, 50, 0.25),
  claude(['claude-opus-5-5'], 4, 20, 0.2),
  claude(['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'], 5, 25, 0.5),
  claude(['claude-opus-4-1', 'claude-opus-4'], 15, 75, 1.5),
  claude(['claude-sonnet-5-5'], 2, 10, 0.1),
  claude(['claude-sonnet-5'], 2, 10, 0.2),
  claude(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], 3, 15, 0.3),
  claude(['claude-haiku-5-5'], 0.1, 0.5, 0.01, [{ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 }]),
  claude(['claude-haiku-4-5'], 1, 5, 0.1),
  ...others(),
];

/** One vendor's prices: [ids, input, output, cacheRead?, extra?]. */
function vendor(name: string, rows: Array<[string[], number, number, number?, Partial<ModelPricing>?]>): BuiltinPrice[] {
  return rows.map(([ids, input, output, cacheRead, extra]) => ({ vendor: name, ids, pricing: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...extra } }));
}

/** Every rate doubles once the prompt passes `above` tokens (xAI, Gemini Pro and others bill the whole request at the higher rate). */
function doubled(above: number, input: number, output: number, cacheRead: number): Partial<ModelPricing> {
  return { tiers: [{ above, input: input * 2, output: output * 2, cacheRead: cacheRead * 2 }] };
}

/**
 * Other vendors' international (USD) list prices, read from their pricing pages on PRICES_CHECKED.
 * DeepSeek is at its peak-hour rate (off-peak is half); Qwen at the Singapore "International"
 * rate with implicit cache hits at 20 % of input; Gemini 4 and 3.6/3.8 Flash have announced
 * increases (Dec 2026, Jan 2027) that are not in here.
 */
function others(): BuiltinPrice[] {
  return [
    ...vendor('OpenAI', [
      [['gpt-6-astra'], 10, 50, 1],
      [['gpt-6.1-sol', 'gpt-6-sol'], 2, 10, 0.1],
      [['gpt-6.1-terra'], 1, 5, 0.05],
      [['gpt-6-luna'], 0.1, 0.5, 0.01],
      [['gpt-5.6-sol'], 4, 20, 0.4],
      [['gpt-5.6-terra'], 2, 12, 0.2],
      [['gpt-5.6-luna'], 0.2, 1.2, 0.02],
      [['gpt-5.5', 'gpt-5.5-chat'], 5, 30, 0.5],
      [['gpt-5.4'], 2.5, 15, 0.25],
      [['gpt-5.4-mini'], 0.75, 4.5, 0.075],
      [['gpt-5.4-nano'], 0.2, 1.25, 0.02],
      [['gpt-5.3-codex', 'gpt-5.2'], 1.75, 14, 0.175],
      [['gpt-5.1', 'gpt-5'], 1.25, 10, 0.125],
      [['gpt-5-mini'], 0.25, 2, 0.025],
      [['gpt-5-nano'], 0.05, 0.4, 0.005],
      [['gpt-4.1'], 2, 8, 0.5],
      [['gpt-4o-mini'], 0.15, 0.6, 0.075],
      [['o3'], 2, 8, 0.5],
    ]),
    ...vendor('DeepSeek', [
      [['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash'], 0.3, 1.2, 0.006],
      [['deepseek-v4-pro'], 1.32, 3.96, 0.044],
    ]),
    ...vendor('Alibaba Qwen', [
      [['qwen3.8-max'], 2, 6],
      [['qwen3.7-max'], 2.5, 7.5, 0.5],
      [['qwen-max'], 1.6, 6.4, 0.32],
      [['qwen3.7-plus'], 0.4, 1.6, 0.08, { tiers: [{ above: 256_000, input: 1.2, output: 4.8, cacheRead: 0.24 }] }],
      [['qwen3.6-plus'], 0.5, 3, 0.1, { tiers: [{ above: 256_000, input: 2, output: 6, cacheRead: 0.4 }] }],
      [['qwen3.5-plus'], 0.4, 2.4, 0.08, { tiers: [{ above: 256_000, input: 0.5, output: 3, cacheRead: 0.1 }] }],
      [['qwen-plus'], 0.4, 1.2, 0.08, { tiers: [{ above: 256_000, input: 1.2, output: 3.6, cacheRead: 0.24 }] }],
      [['qwen3.8-flash'], 0.15, 0.47],
      [['qwen3.7-flash'], 0.03, 0.13, 0.006, { tiers: [{ above: 32_000, input: 0.1, output: 0.4, cacheRead: 0.02 }, { above: 256_000, input: 0.2, output: 0.8, cacheRead: 0.04 }] }],
      [['qwen3.6-flash'], 0.25, 1.5, 0.05, { tiers: [{ above: 256_000, input: 1, output: 4, cacheRead: 0.2 }] }],
      [['qwen3.5-flash'], 0.1, 0.4, 0.02],
      [['qwen-flash'], 0.05, 0.4, 0.01, { tiers: [{ above: 256_000, input: 0.25, output: 2, cacheRead: 0.05 }] }],
      [['qwen3-coder-flash'], 0.3, 1.5, 0.06, { tiers: [{ above: 32_000, input: 0.5, output: 2.5, cacheRead: 0.1 }, { above: 128_000, input: 0.8, output: 4, cacheRead: 0.16 }, { above: 256_000, input: 1.6, output: 9.6, cacheRead: 0.32 }] }],
    ]),
    ...vendor('Moonshot Kimi', [
      [['kimi-k3.1-pro'], 2, 10, 0.2, { cacheWrite: 2 }],
      [['kimi-k3.1-pro-highspeed'], 4, 20, 0.2, { cacheWrite: 4 }],
      [['kimi-k3'], 3, 15, 0.3, { cacheWrite: 3 }],
      [['kimi-k2.7-code', 'kimi-k2.6'], 0.95, 4, 0.19],
      [['kimi-k2.7-code-highspeed'], 1.9, 8, 0.38],
    ]),
    ...vendor('Zhipu GLM', [
      [['glm-5.3', 'glm-5.2', 'glm-5.1'], 1.4, 4.4, 0.26],
      [['glm-5'], 1, 3.2, 0.2],
      [['glm-5.3-flash'], 0.15, 0.5, 0.03],
      [['glm-5.3-flashx'], 0.37, 1.25, 0.075],
      [['glm-4.7', 'glm-4.6', 'glm-4.5'], 0.6, 2.2, 0.11],
      [['glm-4.5-x'], 2.2, 8.9, 0.45],
      [['glm-4.5-air'], 0.2, 1.1, 0.03],
      [['glm-4.5-airx'], 1.1, 4.5, 0.22],
      [['glm-4.7-flashx'], 0.07, 0.4, 0.01],
      [['glm-4.7-flash', 'glm-4.5-flash'], 0, 0, 0],
    ]),
    ...vendor('Google Gemini', [
      [['gemini-4-carbon', 'gemini-4-argon'], 2, 10, 0.1],
      [['gemini-4-hydrogen'], 1.5, 7.5, 0.075],
      [['gemini-3.8-flash', 'gemini-3.6-flash'], 0.75, 3.75, 0.075],
      [['gemini-3.5-flash-lite'], 0.3, 2.5, 0.03],
      [['gemini-3.1-flash-lite'], 0.25, 1.5, 0.025],
      [['gemini-3-flash-preview'], 0.5, 3, 0.05],
      [['gemini-3.1-pro-preview'], 2, 12, 0.2, { tiers: [{ above: 200_000, input: 4, output: 18, cacheRead: 0.4 }] }],
      [['gemini-2.5-pro'], 1.25, 10, 0.125, { tiers: [{ above: 200_000, input: 2.5, output: 15, cacheRead: 0.25 }] }],
      [['gemini-2.5-flash'], 0.3, 2.5, 0.03],
      [['gemini-2.5-flash-lite'], 0.1, 0.4, 0.01],
    ]),
    ...vendor('MiniMax', [
      [['minimax-m3'], 0.3, 1.2, 0.06, doubled(512_000, 0.3, 1.2, 0.06)],
      [['minimax-m3.1-flash'], 0.15, 0.6, 0.015],
    ]),
    ...vendor('xAI', [
      [['grok-4.7', 'grok-4.6'], 2, 6, 0.5, doubled(200_000, 2, 6, 0.5)],
      [['grok-4.5'], 2, 6, 0.3, doubled(200_000, 2, 6, 0.3)],
      [['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-4.20-multi-agent-0309'], 1.25, 2.5, 0.2, doubled(200_000, 1.25, 2.5, 0.2)],
      [['grok-build-0.1'], 1, 2, 0.2],
    ]),
  ];
}

const BY_ID: ReadonlyMap<string, BuiltinPrice> = new Map(BUILTIN_PRICES.flatMap((p) => p.ids.map((id) => [id, p] as const)));

/**
 * The name a price is looked up by: lower case, without a router's vendor path
 * ("anthropic/claude-sonnet-4.5"), a cloud's prefix ("us.anthropic."), a version or date
 * suffix ("@20251101", "-20251101", "-2025-11-01", "-v1:0", "-latest"); Claude's dotted
 * versions become dashes ("claude-sonnet-4.5" is "claude-sonnet-4-5").
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.slice(m.lastIndexOf('/') + 1);
  m = m.replace(/^(?:(?:us|eu|apac|global|jp|au)\.)?anthropic\./, '');
  m = m.replace(/@.*$/, '').replace(/-v\d+:\d+$/, '');
  m = m.replace(/-(?:20\d{6}|20\d\d-\d\d-\d\d|latest)$/, '');
  if (m.startsWith('claude-')) m = m.replace(/\./g, '-');
  return m;
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

export interface PriceMatch {
  pricing: ModelPricing;
  /** `custom`: the profile's own price; `builtin`: the table above. */
  source: 'custom' | 'builtin';
  /** The profile entry (a model name or a pattern with *) or the built-in id that matched. */
  key: string;
}

/**
 * The price of a model: the profile's entry for that exact name, then for its normalized name,
 * then the most specific pattern with "*" (the longest), then the built-in table.
 */
export function findPricing(model: string, custom: Record<string, ModelPricing> = {}): PriceMatch | null {
  if (!model) return null;
  const norm = normalizeModelId(model);
  for (const key of [model, norm]) {
    const p = custom[key];
    if (p) return { pricing: p, source: 'custom', key };
  }
  const patterns = Object.keys(custom)
    .filter((k) => k.includes('*'))
    .sort((a, b) => b.length - a.length);
  for (const key of patterns) {
    const re = globToRegExp(key);
    if (re.test(model) || re.test(norm)) return { pricing: custom[key] as ModelPricing, source: 'custom', key };
  }
  const builtin = BY_ID.get(norm);
  return builtin ? { pricing: builtin.pricing, source: 'builtin', key: norm } : null;
}

/** Rates for a request of this many prompt tokens: the highest tier it passes, else the base price. */
function ratesFor(p: ModelPricing, promptTokens: number): { input: number; output: number; cacheRead: number } {
  let r = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input };
  for (const t of [...(p.tiers ?? [])].sort((a, b) => a.above - b.above)) {
    if (promptTokens > t.above) r = { input: t.input, output: t.output, cacheRead: t.cacheRead ?? t.input };
  }
  return r;
}

/**
 * USD for one call. Cache reads cost `cacheRead` (the input price when a price names none).
 * Cache writes cost `cacheWrite` when the price names one; otherwise Claude's rule: 1.25x input
 * for the 5-minute TTL and 2x for the 1-hour TTL.
 */
export function estimateCost(
  pricing: ModelPricing | undefined,
  usage: ProviderUsage,
  writes: { fiveMinute: number; oneHour: number },
): number | undefined {
  if (!pricing) return undefined;
  const perTok = (usd: number): number => usd / 1_000_000;
  const r = ratesFor(pricing, usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
  const writeCost =
    pricing.cacheWrite !== undefined
      ? (writes.fiveMinute + writes.oneHour) * perTok(pricing.cacheWrite)
      : writes.fiveMinute * perTok(r.input * 1.25) + writes.oneHour * perTok(r.input * 2);
  return usage.inputTokens * perTok(r.input) + usage.outputTokens * perTok(r.output) + usage.cacheReadTokens * perTok(r.cacheRead) + writeCost;
}
