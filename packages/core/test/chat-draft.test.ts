import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatDraftUpdate } from '@protea/protocol';
import { ChatDraftStream, ProviderError, partialStringFields, reply, sleep, textReply, toolCall } from '../src/index.js';
import { makeHarness, waitFor, type Harness } from './helpers.js';

const call = (json: string, id = 'c1', name = 'chat_send') => ({ id, name, json });

function stream(shows: (p: string) => boolean = () => true) {
  const out: ChatDraftUpdate[] = [];
  return { out, drafts: new ChatDraftStream('b1', shows, (d) => out.push(d), 10_000) };
}

describe('partialStringFields', () => {
  it('reads what has arrived of each top-level string', () => {
    const f = partialStringFields('{"platform":"webchat","n":{"text":"nested"},"list":[1,"x"],"text":"Hel');
    expect(f.get('platform')).toEqual({ value: 'webchat', complete: true });
    expect(f.get('text')).toEqual({ value: 'Hel', complete: false });
    expect(f.has('n')).toBe(false);
  });

  it('decodes escapes and holds back a cut-off escape or surrogate pair', () => {
    expect(partialStringFields('{"text":"a\\n\\"b\\u4f60').get('text')?.value).toBe('a\n"b你');
    expect(partialStringFields('{"text":"a\\').get('text')?.value).toBe('a');
    expect(partialStringFields('{"text":"a\\u4f').get('text')?.value).toBe('a');
    expect(partialStringFields('{"text":"a\\ud83d').get('text')?.value).toBe('a');
    expect(partialStringFields('{"text":"a\\ud83d\\ude00').get('text')?.value).toBe('a😀');
  });

  it('stops at malformed input without throwing', () => {
    expect(partialStringFields('')).toEqual(new Map());
    expect(partialStringFields('[1]')).toEqual(new Map());
    expect(partialStringFields('{"text" oops').size).toBe(0);
  });

  it('every prefix of an object gives a prefix of its text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.string(), (text, other) => {
        const json = JSON.stringify({ platform: other, count: 3, nested: { text: 'no' }, text });
        let last = '';
        for (let i = 0; i <= json.length; i++) {
          const v = partialStringFields(json.slice(0, i)).get('text')?.value ?? '';
          expect(text.startsWith(v)).toBe(true);
          expect(v.length).toBeGreaterThanOrEqual(last.length);
          last = v;
        }
        expect(last).toBe(text);
      }),
      { numRuns: 50 },
    );
  });
});

describe('ChatDraftStream', () => {
  it('coalesces fragments and continues at an offset', () => {
    const { out, drafts } = stream();
    drafts.push(call('{"platform":"webchat","te'));
    drafts.push(call('xt":"He'));
    drafts.flush();
    drafts.push(call('llo"}'));
    drafts.flush();
    drafts.flush();
    expect(out).toEqual([
      { state: 'writing', batchId: 'b1', callId: 'c1', platform: 'webchat', offset: 0, text: 'He' },
      { state: 'writing', batchId: 'b1', callId: 'c1', platform: 'webchat', offset: 2, text: 'llo' },
    ]);
  });

  it('holds text until the call has named its platform', () => {
    const { out, drafts } = stream();
    drafts.push(call('{"text":"Hello","platform":"web'));
    drafts.flush();
    expect(out).toEqual([]);
    drafts.push(call('chat"}'));
    drafts.flush();
    expect(out).toEqual([{ state: 'writing', batchId: 'b1', callId: 'c1', platform: 'webchat', offset: 0, text: 'Hello' }]);
  });

  it('shows nothing for other tools or for a platform without drafts', () => {
    const { out, drafts } = stream((p) => p === 'webchat');
    drafts.push(call('{"platform":"webchat","text":"secret"}', 'c1', 'other_tool'));
    drafts.push(call('{"platform":"telegram","text":"hi"}', 'c2'));
    drafts.flush();
    drafts.discard();
    expect(out).toEqual([]);
  });

  it('accepts a name that arrives in pieces', () => {
    const { out, drafts } = stream();
    drafts.push(call('{"platform":"webchat",', 'c1', 'chat_'));
    drafts.push(call('"text":"hi"}', 'c1', 'chat_send'));
    drafts.flush();
    expect(out).toMatchObject([{ state: 'writing', text: 'hi' }]);
  });

  it('withdraws only what was shown, once', () => {
    const { out, drafts } = stream();
    drafts.push(call('{"platform":"webchat","text":"hi"', 'c1'));
    drafts.push(call('{"platform":"webchat","text":"', 'c2'));
    drafts.flush();
    out.length = 0;
    drafts.discard();
    drafts.discard();
    expect(out).toEqual([{ state: 'discarded', batchId: 'b1', callId: 'c1', platform: 'webchat' }]);
  });
});

describe('the main session', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const collect = (x: Harness) => {
    const seen: ChatDraftUpdate[] = [];
    x.bus.on('chat.draft', (d) => seen.push(d));
    return seen;
  };
  const shows = () => true;

  it('streams a reply, and withdraws it when the call does not deliver', async () => {
    h = makeHarness({
      showsChatDrafts: shows,
      steps: [
        async (_r, _i, { onToolInput }) => {
          onToolInput?.(call('{"platform":"webchat","text":"He'));
          await sleep(120);
          onToolInput?.(call('llo"}'));
          // chat_send is not registered in the harness, so the call fails.
          return reply([toolCall('chat_send', { platform: 'webchat', text: 'Hello' }, 'c1')]);
        },
        () => textReply('done'),
      ],
    });
    const seen = collect(h);
    let ended = 0;
    h.bus.on('batch.ended', () => ended++);
    h.push({ text: 'go' });
    await waitFor(() => ended === 1);
    expect(seen.map((d) => (d.state === 'writing' ? [d.offset, d.text] : d.state))).toEqual([[0, 'He'], [2, 'llo'], 'discarded']);
  });

  it('withdraws a draft before the batch ends', async () => {
    h = makeHarness({
      showsChatDrafts: shows,
      steps: [
        (_r, _i, { onToolInput }) => {
          onToolInput?.(call('{"platform":"webchat","text":"cut off'));
          return reply([{ type: 'text', text: 'never finished the call' }]);
        },
      ],
    });
    const order: string[] = [];
    h.bus.on('chat.draft', (d) => order.push(d.state));
    h.bus.on('batch.ended', () => order.push('ended'));
    h.push({ text: 'go' });
    await waitFor(() => order.includes('ended'));
    expect(order).toEqual(['writing', 'discarded', 'ended']);
  });

  it('a draft leaves the call preemptible; preempting withdraws it', async () => {
    h = makeHarness({
      showsChatDrafts: shows,
      steps: [
        async (req, _i, { signal, onToolInput }) => {
          if (JSON.stringify(req.messages).includes('quick question')) return textReply('answered');
          onToolInput?.(call('{"platform":"webchat","text":"Good morning'));
          await sleep(5000, signal);
          return textReply('never');
        },
      ],
    });
    const seen = collect(h);
    const actions: string[] = [];
    h.bus.on('scheduler.action', (a) => actions.push(a.kind));
    h.push({ text: 'schedule fired', level: 3, trigger: 'flush', type: 'cron.tick' }, 'cron', 3);
    await waitFor(() => seen.length > 0);
    expect(h.main.runningTurn()?.externalOutput).toBe(false);
    h.push({ text: 'quick question', level: 1, trigger: 'preempt' });
    await waitFor(() => actions.includes('preempt'));
    await waitFor(() => seen.some((d) => d.state === 'discarded'));
  });

  it('withdraws the draft of a failed attempt, and the retry starts over', async () => {
    h = makeHarness({
      showsChatDrafts: shows,
      steps: [
        async (_r, _i, { onToolInput }) => {
          onToolInput?.(call('{"platform":"webchat","text":"first'));
          await sleep(120);
          return new ProviderError('retryable', 'try again');
        },
        async (_r, _i, { onToolInput }) => {
          onToolInput?.(call('{"platform":"webchat","text":"second"}', 'c2'));
          await sleep(120);
          return textReply('ok');
        },
      ],
    });
    const seen = collect(h);
    let ended = 0;
    h.bus.on('batch.ended', () => ended++);
    h.push({ text: 'go' });
    await waitFor(() => ended === 1);
    expect(seen.map((d) => [d.callId, d.state, d.state === 'writing' ? d.text : ''])).toEqual([
      ['c1', 'writing', 'first'],
      ['c1', 'discarded', ''],
      ['c2', 'writing', 'second'],
      ['c2', 'discarded', ''],
    ]);
  });

  it('publishes no drafts without a platform that shows them', async () => {
    let asked = false;
    h = makeHarness({
      steps: [
        (_r, _i, opts) => {
          asked = opts.onToolInput !== undefined;
          return textReply('ok');
        },
      ],
    });
    let ended = 0;
    h.bus.on('batch.ended', () => ended++);
    h.push({ text: 'go' });
    await waitFor(() => ended === 1);
    expect(asked).toBe(false);
  });
});
