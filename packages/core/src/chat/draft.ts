import { CHAT_PENDING, type ChatDraftUpdate, type ChatPending } from '@protea/protocol';
import type { ToolInputDelta } from '../providers/types.js';
import { CHAT_SEND } from './hub.js';

const DRAFT_MS = 50;

export interface PartialField {
  value: string;
  /** The closing quote has arrived. */
  complete: boolean;
}

const ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function readString(s: string, start: number): PartialField & { end: number } {
  let value = '';
  let i = start + 1;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '"') return { value, complete: true, end: i + 1 };
    if (c !== '\\') {
      value += c;
      i++;
      continue;
    }
    const e = s[i + 1];
    if (e === undefined) break;
    if (e === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    value += ESCAPES[e] ?? e;
    i += 2;
  }
  // Half of a surrogate pair waits for the other half.
  if (value.length > 0 && isHighSurrogate(value.charCodeAt(value.length - 1))) value = value.slice(0, -1);
  return { value, complete: false, end: i };
}

/** Index after a non-string value (at the `,` or `}` that follows a scalar), or -1 when it is cut off. */
function skipValue(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      const r = readString(s, i);
      if (!r.complete) return -1;
      i = r.end - 1;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      if (depth === 0) return i;
      if (--depth === 0) return i + 1;
    } else if (c === ',' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The top-level fields of a JSON object that may be cut off anywhere: the string ones with their
 * text so far, and the name of every field whose value has begun. A value's text only grows as
 * more of the object arrives. Stops quietly at anything malformed: the tool's real input is
 * parsed and validated when the call is complete, and this is only a preview of it.
 */
export function partialObject(json: string): { strings: Map<string, PartialField>; started: string[] } {
  const strings = new Map<string, PartialField>();
  const started: string[] = [];
  const skip = (from: number): number => {
    let i = from;
    while (i < json.length && /\s/.test(json[i] as string)) i++;
    return i;
  };
  let i = skip(0);
  if (json[i] !== '{') return { strings, started };
  i = skip(i + 1);
  while (i < json.length && json[i] !== '}') {
    if (json[i] === ',') {
      i = skip(i + 1);
      continue;
    }
    if (json[i] !== '"') break;
    const key = readString(json, i);
    if (!key.complete) break;
    i = skip(key.end);
    if (json[i] !== ':') break;
    i = skip(i + 1);
    if (i >= json.length) break;
    started.push(key.value);
    if (json[i] === '"') {
      const v = readString(json, i);
      strings.set(key.value, { value: v.value, complete: v.complete });
      if (!v.complete) break;
      i = skip(v.end);
    } else {
      const end = skipValue(json, i);
      if (end < 0) break;
      i = skip(end);
    }
  }
  return { strings, started };
}

/** The top-level string fields of a JSON object that may be cut off anywhere. */
export function partialStringFields(json: string): Map<string, PartialField> {
  return partialObject(json).strings;
}

interface Call {
  name: string;
  json: string;
  platform: string | null;
  sent: number;
  /** The structured parts announced so far, joined. */
  pending: string;
}

/**
 * The `chat_send` calls of one model call, as previews of the replies being written. Coalesces
 * like the run stream. Text waits until the call has named its platform, so a platform that does
 * not show drafts never sees any. One instance per attempt: a retry is a new set of calls.
 */
export class ChatDraftStream {
  private readonly calls = new Map<string, Call>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly batchId: string,
    private readonly shows: (platform: string) => boolean,
    private readonly emit: (d: ChatDraftUpdate) => void,
    private readonly intervalMs = DRAFT_MS,
  ) {}

  push(d: ToolInputDelta): void {
    // Some servers split the name across fragments; anything else is not a reply.
    if (!CHAT_SEND.startsWith(d.name)) return;
    let c = this.calls.get(d.id);
    if (!c) {
      c = { name: d.name, json: '', platform: null, sent: 0, pending: '' };
      this.calls.set(d.id, c);
    }
    c.name = d.name;
    c.json += d.json;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    this.stopTimer();
    for (const [callId, c] of this.calls) {
      if (c.name !== CHAT_SEND) continue;
      const { strings: fields, started } = partialObject(c.json);
      const platform = fields.get('platform');
      if (!platform?.complete || !this.shows(platform.value)) continue;
      c.platform = platform.value;
      const text = fields.get('text')?.value ?? '';
      const pending = CHAT_PENDING.filter((k) => started.includes(k)) as ChatPending[];
      if (text.length <= c.sent && pending.join() === c.pending) continue;
      this.emit({ state: 'writing', batchId: this.batchId, callId, platform: c.platform, offset: c.sent, text: text.slice(c.sent), ...(pending.length > 0 ? { pending } : {}) });
      c.sent = Math.max(c.sent, text.length);
      c.pending = pending.join();
    }
  }

  /** Withdraw every draft that was shown. A reply that was sent has already replaced its draft, so this is a no-op for it. */
  discard(): void {
    this.stopTimer();
    for (const [callId, c] of this.calls) {
      if (c.platform !== null && (c.sent > 0 || c.pending !== '')) this.emit({ state: 'discarded', batchId: this.batchId, callId, platform: c.platform });
    }
    this.calls.clear();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
