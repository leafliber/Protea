import crypto from 'node:crypto';
import type { ContentBlock, TranscriptMessage } from '@protea/protocol';
import type { ProviderRequest } from '../providers/types.js';

/** Block types that carry model reasoning bound to the request prefix that produced it. */
export const THINKING_TYPES: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking']);

export function hasThinking(content: readonly ContentBlock[]): boolean {
  return content.some((b) => THINKING_TYPES.has(b.type));
}

/** The message without its reasoning blocks (text, tool calls and results stay). */
export function stripThinking(msg: TranscriptMessage): TranscriptMessage {
  if (!hasThinking(msg.content)) return msg;
  return { role: msg.role, content: msg.content.filter((b) => !THINKING_TYPES.has(b.type)) };
}

/**
 * Fingerprint of what a thinking block is bound to besides the messages before it: the
 * system prompt and the loaded tool set (deferred tools are left out: adding them is not
 * an edit). `salt` covers anything else that rewrites the request, such as the set of
 * secrets that redaction replaces.
 */
export function prefixFingerprint(req: ProviderRequest, salt = ''): string {
  const tools = req.tools
    .filter((t) => !t.deferLoading)
    .map((t) => ({ n: t.name, d: t.description, s: t.inputSchema }))
    .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ system: req.system.map((s) => s.text), tools, search: req.toolSearch === true, salt }));
  return h.digest('hex').slice(0, 16);
}
