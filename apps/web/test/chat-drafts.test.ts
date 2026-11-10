import { describe, expect, it } from 'vitest';
import type { ChatDraftUpdate } from '@protea/protocol';
import { applyDraft, removeBatchDrafts, removeDraft, type ChatDraft } from '../src/chat-drafts';

const writing = (callId: string, offset: number, text: string, batchId = 'b1'): ChatDraftUpdate => ({ state: 'writing', batchId, callId, platform: 'webchat', offset, text });

describe('chat drafts', () => {
  it('builds up a reply', () => {
    let d: ChatDraft[] = [];
    d = applyDraft(d, writing('c1', 0, 'He'));
    d = applyDraft(d, writing('c1', 2, 'llo'));
    expect(d).toEqual([{ callId: 'c1', batchId: 'b1', text: 'Hello' }]);
  });

  it('ignores a fragment after a gap until the reply is sent', () => {
    const none: ChatDraft[] = [];
    expect(applyDraft(none, writing('c1', 5, 'late'))).toBe(none);
    const d = applyDraft(none, writing('c1', 0, 'He'));
    expect(applyDraft(d, writing('c1', 9, 'x'))).toBe(d);
  });

  it('removes a draft when withdrawn, sent or its batch ended', () => {
    const d = applyDraft(applyDraft([], writing('c1', 0, 'a')), writing('c2', 0, 'b', 'b2'));
    expect(applyDraft(d, { state: 'discarded', batchId: 'b1', callId: 'c1', platform: 'webchat' }).map((x) => x.callId)).toEqual(['c2']);
    expect(removeDraft(d, 'c2').map((x) => x.callId)).toEqual(['c1']);
    expect(removeBatchDrafts(d, 'b1').map((x) => x.callId)).toEqual(['c2']);
    expect(removeDraft(d, 'none')).toBe(d);
    expect(removeBatchDrafts(d, 'none')).toBe(d);
  });
});
