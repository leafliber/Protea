import { describe, expect, it } from 'vitest';
import { priceLine, pricingOf } from '../src/pages/Providers';
import { HOLD_MS, gestureOf, pickMime } from '../src/voice';

describe('voice input', () => {
  it('records Opus in WebM where it can, MP4 on Safari, or lets the browser choose', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMime(() => false)).toBe('');
  });

  it('tells a tap (dictate) from a hold (talk, send on release)', () => {
    expect(gestureOf(HOLD_MS - 1)).toBe('tap');
    expect(gestureOf(HOLD_MS)).toBe('hold');
  });
});

describe('model prices in the console', () => {
  it('turns the typed prices into config, dropping empty rows and keeping tiers', () => {
    const before = { 'glm-5.3': { input: 9, output: 9, tiers: [{ above: 1000, input: 1, output: 1 }] } };
    expect(
      pricingOf(
        {
          'glm-5.3': { input: '1.4', output: '4.4', cacheRead: '0.26' },
          'glm-*': { input: '', output: '', cacheRead: '' },
          other: { input: '0', output: '0', cacheRead: '' },
        },
        before,
      ),
    ).toEqual({ 'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, tiers: [{ above: 1000, input: 1, output: 1 }] }, other: { input: 0, output: 0 } });
  });

  it('asks for both input and output prices', () => {
    expect(() => pricingOf({ m: { input: '1', output: '', cacheRead: '' } }, {})).toThrow('m 的输出价格');
  });

  it('reads a price per million tokens', () => {
    expect(priceLine({ input: 2, output: 10, cacheRead: 0.1 })).toBe('输入 $2 · 输出 $10 · 缓存读 $0.1');
    expect(priceLine({ input: 0.1, output: 0.5, tiers: [{ above: 100_000, input: 0.5, output: 2.5 }] })).toBe('输入 $0.1 · 输出 $0.5 · 缓存读 $0.1；超过 100K token 另计');
  });
});
