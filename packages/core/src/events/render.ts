import { type EventEnvelope, type Level, type RunPhase, type TextBlock, LEVELS } from '@protea/protocol';

/** Escape for XML attribute values. */
function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Neutralise only the sequences that would break the batch structure; the text is otherwise untouched. */
export function escapeStructural(text: string): string {
  return text.replace(/<(\/?)(events?|status)\b/gi, '&lt;$1$2');
}

export function senderAttr(e: EventEnvelope): string | undefined {
  if (e.senderRole === 'owner') return 'owner';
  if (e.senderRole === 'unknown') return `unknown:${e.senderKey ?? ''}`;
  return undefined;
}

export function renderEvent(e: EventEnvelope): string {
  const attrs: Array<[string, string]> = [
    ['cursor', String(e.cursor)],
    ['type', e.type],
    ['source', e.source],
    ['origin', e.origin],
    ['level', String(e.effLevel)],
    ['ts', e.ts],
  ];
  const sender = senderAttr(e);
  if (sender !== undefined) attrs.push(['sender', sender]);
  if (e.correlation !== undefined) attrs.push(['correlation', e.correlation]);
  const head = attrs.map(([k, v]) => `${k}="${attr(v)}"`).join(' ');
  return `<event ${head}>\n${escapeStructural(e.text)}\n</event>`;
}

/** One batch of events as a single text block (docs/10-architecture/02-event-model.md §7). */
export function renderEventsBlock(events: readonly EventEnvelope[], batchId: string): TextBlock {
  const sorted = [...events].sort((a, b) => a.cursor - b.cursor);
  const body = sorted.map(renderEvent).join('\n');
  return { type: 'text', text: `<events batch="${attr(batchId)}" count="${sorted.length}">\n${body}\n</events>` };
}

export interface StatusSnapshot {
  now: string;
  phase: RunPhase;
  pending: Record<Level, number>;
}

/** The dynamic status block. It always goes last in the message so the history before it stays cacheable. */
export function renderStatusBlock(s: StatusSnapshot): TextBlock {
  const pending = LEVELS.map((l) => `pending_l${l}="${s.pending[l] ?? 0}"`).join(' ');
  return { type: 'text', text: `<status now="${attr(s.now)}" phase="${s.phase}" ${pending}/>` };
}
