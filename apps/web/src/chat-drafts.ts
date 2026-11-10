import type { ChatDraftUpdate } from '@protea/protocol';

/** A reply the assistant is still writing, shown until it is sent or withdrawn. */
export interface ChatDraft {
  callId: string;
  batchId: string;
  text: string;
}

/**
 * Apply one update. A fragment that does not continue the text is dropped (the page opened or
 * reconnected partway through); the finished reply still arrives as a normal message.
 */
export function applyDraft(drafts: ChatDraft[], d: ChatDraftUpdate): ChatDraft[] {
  if (d.state === 'discarded') return removeDraft(drafts, d.callId);
  const cur = drafts.find((x) => x.callId === d.callId);
  if (!cur) return d.offset === 0 ? [...drafts, { callId: d.callId, batchId: d.batchId, text: d.text }] : drafts;
  if (d.offset !== cur.text.length) return drafts;
  return drafts.map((x) => (x === cur ? { ...x, text: x.text + d.text } : x));
}

export function removeDraft(drafts: ChatDraft[], callId: string): ChatDraft[] {
  return drafts.some((x) => x.callId === callId) ? drafts.filter((x) => x.callId !== callId) : drafts;
}

export function removeBatchDrafts(drafts: ChatDraft[], batchId: string): ChatDraft[] {
  return drafts.some((x) => x.batchId === batchId) ? drafts.filter((x) => x.batchId !== batchId) : drafts;
}
