import { describe, expect, it } from 'vitest';
import type { ChatDraftUpdate } from '@protea/protocol';
import { ChatPrinter } from '../src/chat-printer.js';

function setup() {
  let out = '';
  const notes: string[] = [];
  const p = new ChatPrinter((s) => (out += s), (s) => notes.push(s));
  const write = (callId: string, offset: number, text: string) => p.draft({ state: 'writing', batchId: 'b', callId, platform: 'webchat', offset, text } as ChatDraftUpdate);
  return { p, write, notes, out: () => out };
}

describe('ChatPrinter', () => {
  it('finishes a draft with what is not on screen yet', () => {
    const { p, write, out } = setup();
    write('c1', 0, 'Hel');
    write('c1', 3, 'lo');
    p.final('Hello world', 'c1');
    expect(out()).toBe('Hello world\n');
  });

  it('writes a reply without a draft whole, and a different text in full', () => {
    const { p, write, out } = setup();
    p.final('plain');
    write('c1', 0, 'draft');
    p.final('something else', 'c1');
    expect(out()).toBe('plain\ndraft\nsomething else\n');
  });

  it('ends the line and says so when a draft is withdrawn', () => {
    const { p, write, notes, out } = setup();
    write('c1', 0, 'half');
    p.draft({ state: 'discarded', batchId: 'b', callId: 'c1', platform: 'webchat' });
    p.final('again');
    expect(out()).toBe('half\nagain\n');
    expect(notes).toEqual(['(draft withdrawn)']);
  });

  it('ignores a withdrawal after the reply was sent, and fragments that do not line up', () => {
    const { p, write, notes, out } = setup();
    write('c1', 4, 'late');
    write('c2', 0, 'ok');
    p.final('ok', 'c2');
    p.draft({ state: 'discarded', batchId: 'b', callId: 'c2', platform: 'webchat' });
    expect(out()).toBe('ok\n');
    expect(notes).toEqual([]);
  });

  it('close is idempotent', () => {
    const { p, write, out } = setup();
    write('c1', 0, 'x');
    p.close();
    p.close();
    expect(out()).toBe('x\n');
  });
});
