import fs from 'node:fs';
import path from 'node:path';
import {
  isToolResultBlock,
  isToolUseBlock,
  type ContentBlock,
  type ToolResultBlock,
  type TranscriptMessage,
} from '@protea/protocol';
import { hasThinking, stripThinking } from '../context/prefix.js';

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface MsgRecord {
  t: 'msg';
  role: 'user' | 'assistant';
  content: ContentBlock[];
  at: string;
  batch?: string;
  cursors?: number[];
  usage?: UsageSummary;
  stop?: string;
  model?: string;
  /** Written by startup repair rather than by a turn. */
  repair?: boolean;
  /** This message showed the whiteboard as of this external revision. */
  boardRev?: number;
}

export interface MarkRecord {
  t: 'mark';
  kind: string;
  at: string;
  [key: string]: unknown;
}

export type TranscriptRecord = MsgRecord | MarkRecord;

export type RepairAction =
  | { action: 'drop-result'; msgIndex: number; toolUseId: string }
  | { action: 'insert-results'; afterMsgIndex: number; toolUseIds: string[] };

export interface RepairReport {
  file: string;
  terminatedLastLine: boolean;
  truncatedBytes: number;
  actions: RepairAction[];
  placeholderResults: string[];
}

export const MISSING_RESULT_TEXT = '[result missing (process restart)]';
export const FORK_MISSING_RESULT_TEXT = '[result missing (fork paused/restarted)]';

export class TranscriptCorruptError extends Error {
  override readonly name = 'TranscriptCorruptError';
}

function placeholder(toolUseId: string, text = MISSING_RESULT_TEXT): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: true };
}

interface Derived {
  msg: TranscriptMessage;
  /** Index into the raw msg records, or null for a message synthesised by a repair action. */
  src: number | null;
}

/** Rebuild the message list from raw records and recorded repair actions. Deterministic. */
export function deriveMessages(
  records: readonly MsgRecord[],
  repairs: readonly RepairAction[],
  missingText = MISSING_RESULT_TEXT,
): Derived[] {
  const drops = new Map<number, Set<string>>();
  const inserts = new Map<number, string[]>();
  for (const r of repairs) {
    if (r.action === 'drop-result') {
      const set = drops.get(r.msgIndex) ?? new Set<string>();
      set.add(r.toolUseId);
      drops.set(r.msgIndex, set);
    } else {
      inserts.set(r.afterMsgIndex, [...(inserts.get(r.afterMsgIndex) ?? []), ...r.toolUseIds]);
    }
  }
  const out: Derived[] = [];
  let prepend: ToolResultBlock[] = [];
  records.forEach((rec, i) => {
    const dropped = drops.get(i);
    let content = dropped
      ? rec.content.filter((b) => !(isToolResultBlock(b) && dropped.has(b.tool_use_id)))
      : rec.content;
    if (prepend.length > 0) {
      content = [...prepend, ...content];
      prepend = [];
    }
    if (content.length > 0) out.push({ msg: { role: rec.role, content }, src: i });
    const ins = inserts.get(i);
    if (ins && ins.length > 0) {
      const blocks = ins.map((id) => placeholder(id, missingText));
      if (records[i + 1]?.role === 'user') prepend = blocks;
      else out.push({ msg: { role: 'user', content: blocks }, src: null });
    }
  });
  if (prepend.length > 0) out.push({ msg: { role: 'user', content: prepend }, src: null });
  return out;
}

/** Find structural problems and the append-only actions that fix them. */
export function planRepairs(derived: readonly Derived[]): { actions: RepairAction[]; appendPlaceholders: string[] } {
  const actions: RepairAction[] = [];
  let appendPlaceholders: string[] = [];
  if (derived[0] && derived[0].msg.role !== 'user') {
    throw new TranscriptCorruptError('transcript does not start with a user message');
  }
  derived.forEach((d, k) => {
    if (d.msg.role === 'assistant') {
      const uses = d.msg.content.filter(isToolUseBlock).map((b) => b.id);
      if (uses.length === 0) return;
      const next = derived[k + 1];
      if (!next) {
        appendPlaceholders = uses;
        return;
      }
      const answered = new Set(next.msg.role === 'user' ? next.msg.content.filter(isToolResultBlock).map((b) => b.tool_use_id) : []);
      const missing = uses.filter((id) => !answered.has(id));
      if (missing.length > 0 && d.src !== null) actions.push({ action: 'insert-results', afterMsgIndex: d.src, toolUseIds: missing });
    } else {
      if (d.src === null) return;
      const prev = derived[k - 1];
      const valid = new Set(prev?.msg.role === 'assistant' ? prev.msg.content.filter(isToolUseBlock).map((b) => b.id) : []);
      const seen = new Set<string>();
      for (const b of d.msg.content) {
        if (!isToolResultBlock(b)) continue;
        if (!valid.has(b.tool_use_id) || seen.has(b.tool_use_id)) {
          actions.push({ action: 'drop-result', msgIndex: d.src, toolUseId: b.tool_use_id });
        }
        seen.add(b.tool_use_id);
      }
    }
  });
  return { actions, appendPlaceholders };
}

/**
 * Append-only session transcript (JSONL). Committed lines are never rewritten
 * (invariant I-4); startup repairs are recorded as `repair` marks or as new
 * messages and re-applied on every load. See docs/10-architecture/05-sessions-and-agent-loop.md §6.
 */
export class Transcript {
  private records: MsgRecord[] = [];
  private repairs: RepairAction[] = [];
  private derived: Derived[] = [];
  private trailingBatchEnd: { resumable: boolean } | null = null;
  /** Messages from records before this index go out without thinking blocks (see notePrefix). */
  private floor = 0;
  private prefix: string | null = null;
  /** Notes of the handoff that started this transcript (memory-relative path). */
  private handoffNotes: string | null = null;
  private shownBoardRev = 0;
  private fd: number;

  private constructor(
    readonly file: string,
    private readonly now: () => string,
    private readonly missingText: string,
  ) {
    this.fd = fs.openSync(file, 'a');
  }

  static open(
    file: string,
    opts: {
      now?: () => string;
      onDiscarded?: (record: Record<string, unknown>) => void;
      /** Text of placeholder results for tool calls whose result was lost. */
      missingResultText?: string;
    } = {},
  ): { transcript: Transcript; report: RepairReport } {
    const now = opts.now ?? (() => new Date().toISOString());
    const report: RepairReport = { file, terminatedLastLine: false, truncatedBytes: 0, actions: [], placeholderResults: [] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const isNew = !fs.existsSync(file);
    if (!isNew) {
      const buf = fs.readFileSync(file);
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
        const lastNl = buf.lastIndexOf(0x0a);
        const tail = buf.subarray(lastNl + 1).toString('utf8');
        let parsed = false;
        try {
          JSON.parse(tail);
          parsed = true;
        } catch {
          parsed = false;
        }
        if (parsed) {
          fs.appendFileSync(file, '\n');
          report.terminatedLastLine = true;
        } else {
          // An unterminated line was never committed; drop it and keep a copy.
          fs.truncateSync(file, lastNl + 1);
          report.truncatedBytes = buf.length - (lastNl + 1);
          opts.onDiscarded?.({ kind: 'truncated-tail', file, text: tail });
        }
      }
    }

    const missingText = opts.missingResultText ?? MISSING_RESULT_TEXT;
    const t = new Transcript(file, now, missingText);
    if (isNew) t.appendMark('session_start', { file: path.basename(file) });
    else t.load(opts.onDiscarded);

    const plan = planRepairs(t.derived);
    if (plan.actions.length > 0) {
      for (const a of plan.actions) {
        if (a.action === 'drop-result') {
          const block = t.records[a.msgIndex]?.content.find((b) => isToolResultBlock(b) && b.tool_use_id === a.toolUseId);
          opts.onDiscarded?.({ kind: 'orphan-result-drop', file, msgIndex: a.msgIndex, block });
        }
      }
      t.appendMark('repair', { actions: plan.actions });
      t.repairs.push(...plan.actions);
      t.derived = deriveMessages(t.records, t.repairs, missingText);
      report.actions = plan.actions;
    }
    if (plan.appendPlaceholders.length > 0) {
      t.appendMessage({ role: 'user', content: plan.appendPlaceholders.map((id) => placeholder(id, missingText)), repair: true });
      report.placeholderResults = plan.appendPlaceholders;
    }
    return { transcript: t, report };
  }

  private load(onDiscarded?: (record: Record<string, unknown>) => void): void {
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      let rec: TranscriptRecord;
      try {
        rec = JSON.parse(line) as TranscriptRecord;
      } catch (err) {
        throw new TranscriptCorruptError(`${this.file}:${i + 1}: unparseable record (${(err as Error).message})`);
      }
      if (rec.t === 'msg') {
        if ((rec.role !== 'user' && rec.role !== 'assistant') || !Array.isArray(rec.content)) {
          throw new TranscriptCorruptError(`${this.file}:${i + 1}: malformed message record`);
        }
        this.records.push(rec);
        if (typeof rec.boardRev === 'number') this.shownBoardRev = rec.boardRev;
        this.trailingBatchEnd = null;
      } else if (rec.t === 'mark') {
        if (rec.kind === 'repair' && Array.isArray(rec['actions'])) this.repairs.push(...(rec['actions'] as RepairAction[]));
        if (rec.kind === 'batch_ended') this.trailingBatchEnd = { resumable: rec['resumable'] === true };
        if (rec.kind === 'handoff_from' && typeof rec['notes'] === 'string') this.handoffNotes = rec['notes'];
        if (rec.kind === 'prefix') {
          if (typeof rec['hash'] === 'string') this.prefix = rec['hash'];
          if (typeof rec['floor'] === 'number') this.floor = Math.max(this.floor, rec['floor']);
        }
      } else {
        onDiscarded?.({ kind: 'unknown-record', file: this.file, line: i + 1 });
      }
    });
    this.derived = deriveMessages(this.records, this.repairs, this.missingText);
  }

  private writeLine(obj: TranscriptRecord): void {
    fs.writeSync(this.fd, `${JSON.stringify(obj)}\n`);
    fs.fdatasyncSync(this.fd);
  }

  appendMessage(m: Omit<MsgRecord, 't' | 'at'>): void {
    const rec: MsgRecord = { t: 'msg', ...m, at: this.now() };
    this.writeLine(rec);
    this.records.push(rec);
    if (rec.content.length > 0) this.derived.push({ msg: { role: rec.role, content: rec.content }, src: this.records.length - 1 });
    if (typeof rec.boardRev === 'number') this.shownBoardRev = rec.boardRev;
    this.trailingBatchEnd = null;
  }

  /** The external whiteboard revision this conversation has already been shown. */
  get boardRev(): number {
    return this.shownBoardRev;
  }

  appendMark(kind: string, data: Record<string, unknown> = {}): void {
    const { t: _t, kind: _k, at: _a, ...rest } = data;
    this.writeLine({ t: 'mark', kind, ...rest, at: this.now() });
    if (kind === 'batch_ended') this.trailingBatchEnd = { resumable: data['resumable'] === true };
    if (kind === 'handoff_from' && typeof data['notes'] === 'string') this.handoffNotes = data['notes'];
  }

  get messages(): TranscriptMessage[] {
    if (this.floor === 0) return this.derived.map((d) => d.msg);
    const out: TranscriptMessage[] = [];
    for (const d of this.derived) {
      const m = d.src !== null && d.src < this.floor ? stripThinking(d.msg) : d.msg;
      if (m.content.length > 0) out.push(m);
    }
    return out;
  }

  /**
   * Record the request prefix (system prompt and tools) the next model call uses. Thinking
   * blocks are bound to the prefix that produced them, so when it changes every earlier
   * thinking block is dropped from later requests (removing a leading run of thinking blocks
   * keeps the rest valid). Append-only: a `prefix` mark with the new floor. Returns true
   * when the floor moved, so the caller rebuilds its messages.
   */
  notePrefix(hash: string): boolean {
    if (hash === this.prefix) return false;
    const pending = this.records.slice(this.floor).some((r) => hasThinking(r.content));
    this.prefix = hash;
    if (!pending) {
      this.appendMark('prefix', { hash });
      return false;
    }
    this.floor = this.records.length;
    this.appendMark('prefix', { hash, floor: this.floor });
    return true;
  }

  get length(): number {
    return this.derived.length;
  }

  lastMessage(): TranscriptMessage | undefined {
    return this.derived.at(-1)?.msg;
  }

  /** True when the last message awaits a model reply and the last batch did not end deliberately. */
  needsResume(): boolean {
    const last = this.lastMessage();
    if (!last || last.role !== 'user') return false;
    return this.trailingBatchEnd === null || this.trailingBatchEnd.resumable;
  }

  /** Every event cursor that has been written into this transcript. */
  deliveredCursors(): Set<number> {
    const set = new Set<number>();
    for (const r of this.records) for (const c of r.cursors ?? []) set.add(c);
    return set;
  }

  /** Notes of the handoff this transcript started from, if any. */
  get previousNotes(): string | null {
    return this.handoffNotes;
  }

  /** Records (with batch and cursors) behind `messages`, for copying a tail into a new transcript. */
  recordsFrom(messageIndex: number): Array<{ msg: TranscriptMessage; batch?: string; cursors?: number[] }> {
    const msgs = this.messages;
    const out: Array<{ msg: TranscriptMessage; batch?: string; cursors?: number[] }> = [];
    // `messages` drops messages left empty by the thinking floor; map back through the same filter.
    const kept = this.derived.filter((d) => {
      const m = d.src !== null && d.src < this.floor ? stripThinking(d.msg) : d.msg;
      return m.content.length > 0;
    });
    kept.forEach((d, i) => {
      if (i < messageIndex) return;
      const rec = d.src !== null ? this.records[d.src] : undefined;
      out.push({ msg: msgs[i] as TranscriptMessage, ...(rec?.batch ? { batch: rec.batch } : {}), ...(rec?.cursors ? { cursors: rec.cursors } : {}) });
    });
    return out;
  }

  /** Index into `messages` of the first message of a batch (`messages.length` when it has none yet). */
  batchStart(batchId: string): number {
    const msgs = this.recordsFrom(0);
    const i = msgs.findIndex((m) => m.batch === batchId);
    return i < 0 ? msgs.length : i;
  }

  /**
   * The last model response with usage, as an input-token baseline: its input plus output
   * tokens, and the messages appended after it. Null when no response recorded usage.
   */
  sinceLastUsage(): { tokens: number; after: TranscriptMessage[] } | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i] as MsgRecord;
      if (r.role !== 'assistant' || !r.usage) continue;
      const u = r.usage;
      const k = this.derived.findIndex((d) => d.src === i);
      if (k < 0) return null;
      return {
        tokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens,
        after: this.derived.slice(k + 1).map((d) => d.msg),
      };
    }
    return null;
  }

  lastBatchId(): string | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const b = this.records[i]?.batch;
      if (b) return b;
    }
    return undefined;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

/** Read a transcript's messages without opening it for writing (nothing is repaired or recorded). */
export function readTranscript(file: string, missingText = MISSING_RESULT_TEXT): TranscriptMessage[] {
  if (!fs.existsSync(file)) return [];
  const records: MsgRecord[] = [];
  const repairs: RepairAction[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue; // an unterminated tail; the writer repairs it on open
    }
    if (rec.t === 'msg' && Array.isArray(rec.content)) records.push(rec);
    else if (rec.t === 'mark' && rec.kind === 'repair' && Array.isArray(rec['actions'])) {
      repairs.push(...(rec['actions'] as RepairAction[]));
    }
  }
  return deriveMessages(records, repairs, missingText).map((d) => d.msg);
}

/** Resolve the current main transcript file via the `main.current` pointer (handoff rotates it from M4). */
export function mainTranscriptPath(sessionsDir: string): string {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const pointer = path.join(sessionsDir, 'main.current');
  if (fs.existsSync(pointer)) {
    const name = fs.readFileSync(pointer, 'utf8').trim();
    if (name) return path.join(sessionsDir, name);
  }
  const name = 'main.0001.jsonl';
  fs.writeFileSync(pointer, `${name}\n`);
  return path.join(sessionsDir, name);
}
