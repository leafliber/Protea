import fs from 'node:fs';
import path from 'node:path';
import {
  isToolResultBlock,
  isToolUseBlock,
  type ContentBlock,
  type ToolResultBlock,
  type TranscriptMessage,
} from '@protea/protocol';

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

export class TranscriptCorruptError extends Error {
  override readonly name = 'TranscriptCorruptError';
}

function placeholder(toolUseId: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: MISSING_RESULT_TEXT, is_error: true };
}

interface Derived {
  msg: TranscriptMessage;
  /** Index into the raw msg records, or null for a message synthesised by a repair action. */
  src: number | null;
}

/** Rebuild the message list from raw records and recorded repair actions. Deterministic. */
export function deriveMessages(records: readonly MsgRecord[], repairs: readonly RepairAction[]): Derived[] {
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
      const blocks = ins.map(placeholder);
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
  private fd: number;

  private constructor(
    readonly file: string,
    private readonly now: () => string,
  ) {
    this.fd = fs.openSync(file, 'a');
  }

  static open(
    file: string,
    opts: { now?: () => string; onDiscarded?: (record: Record<string, unknown>) => void } = {},
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

    const t = new Transcript(file, now);
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
      t.derived = deriveMessages(t.records, t.repairs);
      report.actions = plan.actions;
    }
    if (plan.appendPlaceholders.length > 0) {
      t.appendMessage({ role: 'user', content: plan.appendPlaceholders.map(placeholder), repair: true });
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
        this.trailingBatchEnd = null;
      } else if (rec.t === 'mark') {
        if (rec.kind === 'repair' && Array.isArray(rec['actions'])) this.repairs.push(...(rec['actions'] as RepairAction[]));
        if (rec.kind === 'batch_ended') this.trailingBatchEnd = { resumable: rec['resumable'] === true };
      } else {
        onDiscarded?.({ kind: 'unknown-record', file: this.file, line: i + 1 });
      }
    });
    this.derived = deriveMessages(this.records, this.repairs);
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
    this.trailingBatchEnd = null;
  }

  appendMark(kind: string, data: Record<string, unknown> = {}): void {
    const { t: _t, kind: _k, at: _a, ...rest } = data;
    this.writeLine({ t: 'mark', kind, ...rest, at: this.now() });
    if (kind === 'batch_ended') this.trailingBatchEnd = { resumable: data['resumable'] === true };
  }

  get messages(): TranscriptMessage[] {
    return this.derived.map((d) => d.msg);
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
