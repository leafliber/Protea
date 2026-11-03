import { describe, expect, it } from 'vitest';
import { OwnerRegistry, gateEvent, pickTrigger, type SourceCaps } from '../src/index.js';

const owner = new OwnerRegistry([{ plugin: 'tg', senderKey: 'tg:1' }]);
const caps: SourceCaps = { source: 'tg', maxLevel: 1 };
const base = { type: 'tg.message', ts: '2026-11-03T09:00:00+08:00', level: 1 as const, trigger: 'flush' as const, text: 'hi' };

describe('gateEvent', () => {
  it('passes an owner message unchanged', () => {
    const r = gateEvent({ ...base, senderKey: 'tg:1' }, caps, owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({ source: 'tg', origin: 'external', effLevel: 1, effTrigger: 'flush', senderRole: 'owner' });
    expect(r.warnings).toEqual([]);
  });

  it('rejects schema violations', () => {
    expect(gateEvent({ ...base, text: undefined }, caps, owner).ok).toBe(false);
    expect(gateEvent({ ...base, type: 'NoDot' }, caps, owner).ok).toBe(false);
    expect(gateEvent({ ...base, ts: 'yesterday' }, caps, owner).ok).toBe(false);
    expect(gateEvent({ ...base, extra: 1 }, caps, owner).ok).toBe(false);
  });

  it('downgrades internal origin from sources that may not emit it', () => {
    const r = gateEvent({ ...base, origin: 'internal', senderKey: 'tg:1' }, caps, owner);
    expect(r.ok && r.event.origin).toBe('external');
    expect(r.ok && r.warnings.length).toBe(1);
  });

  it('caps the level at the source maximum', () => {
    const r = gateEvent({ ...base, level: 0, trigger: 'interrupt', senderKey: 'tg:1' }, caps, owner);
    expect(r.ok && r.event.effLevel).toBe(1);
    expect(r.ok && r.event.effTrigger).toBe('interrupt');
  });

  it('reserves level 1 for the owner', () => {
    const stranger = gateEvent({ ...base, senderKey: 'tg:999' }, caps, owner);
    expect(stranger.ok && stranger.event).toMatchObject({ effLevel: 2, senderRole: 'unknown' });
    const anonymous = gateEvent(base, caps, owner);
    expect(anonymous.ok && anonymous.event.effLevel).toBe(2);
  });

  it('never lets ambient or scheduled events preempt', () => {
    const l4 = gateEvent({ ...base, level: 4, trigger: 'interrupt' }, { source: 'rss', maxLevel: 4 }, owner);
    expect(l4.ok && l4.event.effTrigger).toBe('piggyback');
    const l3 = gateEvent({ ...base, level: 3, trigger: 'preempt' }, { source: 'cron', maxLevel: 3 }, owner);
    expect(l3.ok && l3.event.effTrigger).toBe('flush');
  });

  it('lets Core emit internal level-0 events', () => {
    const r = gateEvent({ ...base, level: 0, origin: 'internal' }, { source: 'core', maxLevel: 0, mayEmitInternal: true }, owner);
    expect(r.ok && r.event).toMatchObject({ origin: 'internal', effLevel: 0, effTrigger: 'flush' });
  });

  it('honours a source-specific trigger restriction', () => {
    const r = gateEvent({ ...base, senderKey: 'tg:1', trigger: 'interrupt' }, { ...caps, triggers: ['debounce', 'flush'] }, owner);
    expect(r.ok && r.event.effTrigger).toBe('flush');
  });
});

describe('pickTrigger', () => {
  it('chooses the strongest allowed mode not stronger than requested, else the weakest allowed', () => {
    expect(pickTrigger('interrupt', ['debounce', 'flush', 'piggyback'])).toBe('flush');
    expect(pickTrigger('piggyback', ['debounce', 'flush', 'preempt'])).toBe('debounce');
    expect(pickTrigger('debounce', ['flush', 'interrupt'])).toBe('flush');
    expect(pickTrigger('store', ['store', 'piggyback'])).toBe('store');
  });
});
