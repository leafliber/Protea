import type { ContentBlock, TranscriptMessage } from '@protea/protocol';

/** Rough token estimate: ~4 characters per token for ASCII, one per CJK character. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** Rough token count of content blocks (no tokenizer): text by script, media by a flat rate. */
export function estimateContentTokens(blocks: readonly ContentBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'image' || b.type === 'document') n += 1_600;
    else if (b.type === 'thinking' || b.type === 'redacted_thinking') n += estimateTokens(String(b['thinking'] ?? b['data'] ?? '')) + 50;
    else if (b.type === 'text') n += estimateTokens(String(b['text'] ?? '')) + 4;
    else if (b.type === 'tool_result') {
      const c = b['content'];
      n += 10 + (typeof c === 'string' ? estimateTokens(c) : Array.isArray(c) ? estimateContentTokens(c as ContentBlock[]) : 0);
    } else n += estimateTokens(JSON.stringify(b)) + 4;
  }
  return n;
}

export function estimateMessagesTokens(messages: readonly TranscriptMessage[]): number {
  return messages.reduce((n, m) => n + 4 + estimateContentTokens(m.content), 0);
}
