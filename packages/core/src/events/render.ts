import { type EventEnvelope, type Level, type RunPhase, type TextBlock, LEVELS } from '@protea/protocol';
import { escapeStructural } from '../util/escape.js';

export { escapeStructural };

/** Escape for XML attribute values. */
function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  /** Remaining budget per limited level, in percent. */
  budget?: Partial<Record<Level, number>>;
  /** Forks that are queued, running or paused. */
  forks?: number;
  /** The running chat platform where the owner last wrote. */
  lastChat?: string;
}

/** The dynamic status block. It always goes last in the message so the history before it stays cacheable. */
export function renderStatusBlock(s: StatusSnapshot): TextBlock {
  const parts = [`now="${attr(s.now)}"`, `phase="${s.phase}"`, ...LEVELS.map((l) => `pending_l${l}="${s.pending[l] ?? 0}"`)];
  for (const l of LEVELS) {
    const left = s.budget?.[l];
    if (left !== undefined) parts.push(`budget_l${l}="${left}%"`);
  }
  if (s.forks) parts.push(`forks="${s.forks}"`);
  if (s.lastChat) parts.push(`last_chat="${attr(s.lastChat)}"`);
  return { type: 'text', text: `<status ${parts.join(' ')}/>` };
}
