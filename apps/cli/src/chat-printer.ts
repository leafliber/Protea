import type { ChatDraftUpdate, ChatReplyParts } from '@protea/protocol';

/** What a reply carries besides text, as lines a terminal can show. */
export function replyExtras(parts: ChatReplyParts): string[] {
  const lines: string[] = [];
  for (const i of parts.images ?? []) lines.push(`[image: ${i.handle}]`);
  if (parts.widget) lines.push(`[widget: ${parts.widget.title}] (open the web chat to see it)`);
  parts.choices?.options.forEach((o, n) => lines.push(`  ${n + 1}. ${o.label}${o.detail ? ` — ${o.detail}` : ''}`));
  return lines;
}

/**
 * Writes `protea chat` replies to a terminal as they are composed. A sent reply finishes its
 * draft (only the part not on screen yet is written); a reply with no draft is written whole.
 */
export class ChatPrinter {
  private readonly shown = new Map<string, string>();
  /** The call whose text the cursor is at the end of. */
  private current: string | null = null;

  constructor(
    private readonly write: (s: string) => void,
    private readonly note: (s: string) => void,
  ) {}

  draft(d: ChatDraftUpdate): void {
    if (d.state === 'discarded') {
      if (!this.shown.delete(d.callId)) return;
      if (this.current === d.callId) this.close();
      this.note('(draft withdrawn)');
      return;
    }
    const before = this.shown.get(d.callId) ?? '';
    if (d.offset !== before.length) return;
    if (this.current !== d.callId) this.close();
    this.current = d.callId;
    this.shown.set(d.callId, before + d.text);
    this.write(d.text);
  }

  final(text: string, callId?: string, parts: ChatReplyParts = {}): void {
    const before = callId !== undefined ? this.shown.get(callId) : undefined;
    if (callId !== undefined) this.shown.delete(callId);
    if (before !== undefined && this.current === callId && text.startsWith(before)) {
      this.write(`${text.slice(before.length)}\n`);
      this.current = null;
    } else {
      this.close();
      this.write(`${text}\n`);
    }
    for (const line of replyExtras(parts)) this.write(`${line}\n`);
  }

  /** End the line of an unfinished draft. */
  close(): void {
    if (this.current !== null) this.write('\n');
    this.current = null;
  }
}
