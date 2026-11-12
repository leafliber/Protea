import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@protea/protocol';
import { beforeOf, merge, order, reaches, trimOldest } from '../src/chat-window';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const msg = (n: number, text = `m${n}`): ChatItem => ({ key: `e${n}`, kind: 'owner', platform: 'webchat', at: at(n), text, cursor: n });
const reply = (n: number, text = `r${n}`): ChatItem => ({ key: `o${n}`, kind: 'reply', platform: 'webchat', at: at(n), text });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

describe('chat window', () => {
  it('orders by time, a message before a reply of the same instant', () => {
    expect([reply(2), msg(2), msg(1)].sort(order).map((i) => i.key)).toEqual(['e1', 'e2', 'o2']);
  });

  it('merges a newer item at the end and an update in place', () => {
    const old = range(1, 3);
    expect(merge(old, [])).toBe(old);
    expect(merge(old, [msg(4)]).map((i) => i.key)).toEqual(['e1', 'e2', 'e3', 'e4']);
    const updated = merge(old, [{ ...msg(2), state: 'delivered' }]);
    expect(updated.map((i) => i.key)).toEqual(['e1', 'e2', 'e3']);
    expect(updated[1]).toMatchObject({ text: 'm2', state: 'delivered' });
  });

  it('merges an older page and an item whose time changed into order', () => {
    expect(merge(range(4, 6), range(1, 3)).map((i) => i.key)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    expect(merge(range(1, 3), [{ ...msg(1), at: at(9) }]).map((i) => i.key)).toEqual(['e2', 'e3', 'e1']);
  });

  it('names the page before an item, except one the server has not numbered', () => {
    expect(beforeOf(msg(7))).toBe(`${at(7)}|0|7`);
    expect(beforeOf(reply(7))).toBe(`${at(7)}|1|7`);
    expect(beforeOf({ ...reply(7), key: 'o1767225607000.ab12' })).toBeNull();
  });

  it('keeps everything up to the limit', () => {
    expect(trimOldest(range(1, 10), 10, 4)).toBeNull();
  });

  it('drops the oldest beyond the limit and says how to load them again', () => {
    const cut = trimOldest(range(1, 11), 10, 4);
    expect(cut?.items.map((i) => i.key)).toEqual(['e8', 'e9', 'e10', 'e11']);
    expect(cut?.before).toBe(`${at(8)}|0|8`);
  });

  it('cuts at an item that has a page token', () => {
    const items = [...range(1, 7), { ...reply(8), key: 'o1767225608000.ab12' }, ...range(9, 11)];
    const cut = trimOldest(items, 10, 4);
    expect(cut?.items.map((i) => i.key)).toEqual(['e9', 'e10', 'e11']);
    expect(cut?.before).toBe(`${at(9)}|0|9`);
  });

  it('tells whether a page goes back to what was on screen', () => {
    expect(reaches(range(5, 9), msg(5))).toBe(true);
    expect(reaches(range(5, 9), msg(7))).toBe(true);
    expect(reaches(range(5, 9), msg(4))).toBe(false);
    expect(reaches([], msg(4))).toBe(false);
  });
});
