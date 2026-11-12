import fs from 'node:fs';
import path from 'node:path';
import { isImageBlock, isToolResultBlock, type ContentBlock, type HandoffKind, type Level, type ModelRole, type TranscriptMessage } from '@protea/protocol';
import { stripThinking } from '../context/prefix.js';
import { isBoardText } from '../memory/board.js';
import { CORE_FILES, MAX_MEMORY_FILE_BYTES, MEMORY_ROOT, type MemoryStore } from '../memory/store.js';
import type { Logger } from '../observability/logger.js';
import type { HandoffPlan, PersonaHooks } from '../persona/persona.js';
import type { Provider, ProviderResponse } from '../providers/types.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import { isoInZone } from '../util/time.js';
import { estimateContentTokens, estimateTokens } from '../util/tokens.js';
import type { HandoffSettings } from './settings.js';
import { Transcript } from './transcript.js';

export interface ContextLimits {
  soft: number;
  hard: number;
  keep: number;
}

/** Thresholds for a model: hard = context window − max output − 5 % (at least 8k). */
export function contextLimits(s: HandoffSettings, contextWindow: number | undefined, maxOutputTokens: number): ContextLimits {
  const window = contextWindow ?? 200_000;
  const derived = window - maxOutputTokens - Math.max(8_000, Math.round(window * 0.05));
  const hard = s.hardTokens ?? Math.max(8_000, derived);
  const soft = Math.min(s.softTokens, hard);
  return { soft, hard, keep: Math.round(soft * s.keepRatio) };
}

/** A tail may start at a user message that answers no tool call (an events message). */
function canStartTail(m: TranscriptMessage): boolean {
  return m.role === 'user' && !m.content.some(isToolResultBlock);
}

/**
 * Where the carried-over tail starts: the earliest clean cut whose messages fit `keepTokens`,
 * never after `mustKeepFrom` (the running batch stays whole). 0 = nothing can be dropped.
 */
export function selectTailStart(messages: readonly TranscriptMessage[], mustKeepFrom: number, keepTokens: number): number {
  const limit = Math.min(mustKeepFrom, messages.length);
  let best = -1;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as TranscriptMessage;
    tokens += 4 + estimateContentTokens(m.content);
    if (i > limit || !canStartTail(m)) continue;
    // The latest clean cut is taken even when it is over budget: the running batch stays whole.
    if (best < 0 || tokens <= keepTokens) best = i;
    else break;
  }
  return Math.max(0, best);
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}… [${text.length - n} more characters]` : text;
}

interface RenderClips {
  text: number;
  toolInput: number;
  toolResult: number;
}

const NOTES_CLIPS: RenderClips = { text: 6_000, toolInput: 800, toolResult: 1_500 };
/** The archive keeps every word of the conversation; tool traffic is cut here and stays whole in the transcript. */
const RAW_TOOL_CHARS = 4_000;
const RAW_CLIPS: RenderClips = { text: Number.POSITIVE_INFINITY, toolInput: RAW_TOOL_CHARS, toolResult: RAW_TOOL_CHARS };
/** Longest notes text carried into the new conversation. */
const MAX_NOTES_IN_CONTEXT = 8_000;

/** A block without text, as a line; a stored image keeps its handle so `view_image` can bring it back. */
function imageLine(b: ContentBlock): string {
  if (isImageBlock(b) && b.source.type === 'blob') return `[image ${b.source.media_type}, ${b.source.handle}]`;
  return `[${b.type}]`;
}

function renderParts(messages: readonly TranscriptMessage[], clips: RenderClips): string[] {
  const parts: string[] = [];
  for (const m of messages) {
    const lines: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text') lines.push(clip(String(b['text'] ?? ''), clips.text));
      else if (b.type === 'tool_use') lines.push(`[tool call ${String(b['name'])}] ${clip(JSON.stringify(b['input'] ?? {}), clips.toolInput)}`);
      else if (b.type === 'tool_result') {
        const c = b['content'];
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as ContentBlock[]).map((x) => (x.type === 'text' ? String(x['text']) : imageLine(x))).join(' ') : '';
        lines.push(`[tool result${b['is_error'] ? ' (error)' : ''}] ${clip(text, clips.toolResult)}`);
      } else if (b.type === 'compaction') lines.push(`[earlier summary] ${clip(String(b['content'] ?? ''), 20_000)}`);
      else if (b.type !== 'thinking' && b.type !== 'redacted_thinking' && b.type !== 'fallback') lines.push(imageLine(b));
    }
    if (lines.length > 0) parts.push(`--- ${m.role === 'user' ? 'runtime → assistant' : 'assistant'} ---\n${lines.join('\n')}`);
  }
  return parts;
}

/** The dropped part of the conversation as plain text for the notes model; oldest parts go first when it is too long. */
export function renderForNotes(messages: readonly TranscriptMessage[], maxTokens: number): string {
  const parts = renderParts(messages, NOTES_CLIPS);
  let total = parts.reduce((n, p) => n + estimateTokens(p), 0);
  let cut = 0;
  while (total > maxTokens && cut < parts.length - 1) {
    total -= estimateTokens(parts[cut] as string);
    cut++;
  }
  return `${cut > 0 ? `[${cut} earlier message(s) omitted for length]\n\n` : ''}${parts.slice(cut).join('\n\n')}`;
}

/** At most `maxBytes` of UTF-8 text, cut at a character boundary. */
function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // A character cut in half decodes to U+FFFD.
  while (out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return out;
}

/** The block of a batch message that shows the board; a copy from before a handoff would contradict the current one. */
function withoutBoard(msg: TranscriptMessage): TranscriptMessage {
  const content = msg.content.filter((b) => !(b.type === 'text' && isBoardText(String(b['text'] ?? ''))));
  return content.length === msg.content.length ? msg : { role: msg.role, content };
}

export const HANDOFF_NOTES_SYSTEM = `You write handoff notes for an always-on personal assistant. Its conversation is about to be compacted: afterwards it has these notes, its whiteboard, its memory files and its most recent messages, so whatever is not in the notes is gone from the conversation.

Its resident memory (<memory_core>) is part of every request: the owner profile and the standing rules. Do not repeat what it already says.

Write Markdown with these sections, in this order, and keep every concrete detail (names, dates, times, amounts, ids, exact wording of promises):

## In progress
What the assistant was working on and how far it got.
## Commitments
Promises with a time or deadline: reminders, follow-ups, things owed to someone.
## Owner's recent instructions
One-off requests and answers the owner gave in this stretch.
## Pending
Approvals, background forks, follow-ups or replies still awaited.
## Durable, not yet saved
Standing rules, preferences, corrections and lessons that should hold from now on and are not yet in <memory_core>. Each item one line, phrased as a rule. The memory consolidation moves them into the resident memory.
## Facts worth keeping
Anything else the assistant will need.

Carry over every item from the previous notes that still applies, unless <memory_core> now says it. Do not invent anything. Leave out a section only when it would be empty. Be concise: at most about 800 words. Write in the language the owner uses. Do not think at length: write the notes.`;

/** Fallback notes when the notes model is unavailable: the latest texts, verbatim. */
export function mechanicalNotes(dropped: readonly TranscriptMessage[], reason: string): string {
  const texts: string[] = [];
  for (const m of dropped) for (const b of m.content) if (b.type === 'text') texts.push(`${m.role}: ${clip(String(b['text'] ?? ''), 1_500)}`);
  return `Automatic summary unavailable (${reason}). The last messages before the handoff, verbatim:\n\n${texts.slice(-20).join('\n\n')}`;
}

export interface HandoffResult {
  transcript: Transcript;
  notesPath: string;
  /** Where the dropped conversation was archived; null when writing it failed. */
  rawPath: string | null;
  dropped: number;
  kept: number;
  via: 'default' | 'hook';
  kind: HandoffKind;
}

export interface HandoffDeps {
  provider: Provider;
  memory: MemoryStore;
  sessionsDir: string;
  dataDir: string;
  log: Logger;
  clock: Clock;
  timezone: string;
  settings: () => HandoffSettings;
  hooks: () => PersonaHooks | null;
  /** Remove known secret values from text written to disk: the archive comes from the unredacted transcript. */
  redact?: (text: string) => string;
  /** What the notes request cost, attributed to `level`. */
  onNotesUsage?: (response: ProviderResponse, level: Level, role: ModelRole) => void;
}

/** Next main transcript name: main.0001.jsonl → main.0002.jsonl. */
export function nextTranscriptName(current: string): string {
  const m = /^main\.(\d+)\.jsonl$/.exec(path.basename(current));
  const seq = m ? Number(m[1]) + 1 : 2;
  return `main.${String(seq).padStart(4, '0')}.jsonl`;
}

export function transcriptSeq(file: string): number {
  const m = /^main\.(\d+)\.jsonl$/.exec(path.basename(file));
  return m ? Number(m[1]) : 1;
}

/**
 * Capacity handoff (docs/10-architecture/05-sessions-and-agent-loop.md §8): notes for the
 * dropped part, a new transcript holding the tail without its thinking blocks (they are
 * bound to the old conversation), and the old file sealed with a mark. The notes come from
 * the persona's onHandoff hook when it has one, otherwise from the `cheap` model.
 */
export class Handoff {
  constructor(private readonly d: HandoffDeps) {}

  async run(
    transcript: Transcript,
    opts: {
      mustKeepFrom: number;
      limits: ContextLimits;
      estimatedTokens: number;
      reason: string;
      signal: AbortSignal;
      /** Why this handoff happens (default: capacity). */
      kind?: HandoffKind;
      /** Level the notes request is attributed to (default: 2). */
      level?: Level;
      /** A failed notes request abandons the handoff instead of writing mechanical notes: nothing forces it to happen now. */
      strict?: boolean;
      /** No batch is running: mark the new conversation so a restart does not resume it. */
      seal?: boolean;
      /** Model role that writes the notes (default: cheap). */
      notesRole?: ModelRole;
      /** The first message of the new conversation (the handoff notice). */
      notice?: (info: { notesPath: string; notes: string | null; dropped: number; kept: number }) => { content: ContentBlock[]; cursors?: number[]; batch?: string; boardRev?: number } | null;
    },
  ): Promise<HandoffResult | null> {
    const d = this.d;
    const messages = transcript.messages;
    let plan: { start: number; tail: TranscriptMessage[]; notes: string | null; notesPath: string | null; via: 'default' | 'hook' } | null = null;

    const hook = d.hooks()?.onHandoff;
    if (hook) {
      try {
        const p: HandoffPlan = await hook(
          { messages, estimatedTokens: opts.estimatedTokens, transcript: path.relative(d.dataDir, transcript.file), memoryDir: d.memory.dir },
          { hardTokens: opts.limits.hard, keepTokens: opts.limits.keep, signal: opts.signal },
        );
        if (!Array.isArray(p?.tail) || (p.tail.length > 0 && p.tail[0]?.role !== 'user')) throw new Error('tail must be an array starting with a user message');
        if (p.notes === undefined && p.notesPath === undefined) throw new Error('return notes or notesPath');
        plan = { start: messages.length - p.tail.length, tail: p.tail, notes: p.notes ?? null, notesPath: p.notesPath ?? null, via: 'hook' };
      } catch (err) {
        d.log.warn({ err: errorMessage(err) }, 'persona onHandoff hook failed; using the default handoff');
      }
    }
    if (!plan) {
      const start = selectTailStart(messages, opts.mustKeepFrom, opts.limits.keep);
      if (start === 0) return null;
      const dropped = messages.slice(0, start);
      const notes = await this.notes(dropped, transcript.previousNotes, opts.signal, opts.strict === true, opts.level ?? 2, opts.notesRole ?? 'cheap');
      if (notes === null) return null;
      plan = { start, tail: messages.slice(start), notes, notesPath: null, via: 'default' };
    }
    // Everything before this point is free of side effects, so it can still be abandoned.
    opts.signal.throwIfAborted();
    const kind = opts.kind ?? 'capacity';
    const redact = d.redact ?? ((t: string) => t);

    const stamp = isoInZone(d.clock.now(), 'UTC').slice(0, 19).replace(/:/g, '-');
    let notesPath = plan.notesPath ?? `handoff/${stamp}Z.md`;
    for (let n = 2; plan.notesPath === null && d.memory.readText(notesPath) !== undefined; n++) notesPath = `handoff/${stamp}Z-${n}.md`;
    const oldName = path.basename(transcript.file);
    if (plan.notes !== null) {
      plan.notes = redact(plan.notes);
      const header = [
        `# Handoff ${isoInZone(d.clock.now(), d.timezone)}`,
        '',
        `Conversation ${oldName}: ${plan.start} message(s) handed off, ${plan.tail.length} kept (${opts.reason}).` +
          (transcript.previousNotes ? ` Previous notes: ${MEMORY_ROOT}/${transcript.previousNotes}` : ''),
        '',
      ].join('\n');
      d.memory.writeText(notesPath, `${header}\n${plan.notes.trim()}\n`);
    }
    const rawPath = this.writeRaw(stamp, oldName, messages.slice(0, plan.start), opts.reason, redact);

    // New transcript: the handoff mark, then the tail as it was (without thinking), then the caller appends the notice.
    const newName = nextTranscriptName(transcript.file);
    const newFile = path.join(d.sessionsDir, newName);
    // Left over by a handoff that crashed before switching the pointer: set it aside.
    if (fs.existsSync(newFile)) fs.renameSync(newFile, `${newFile}.abandoned-${d.clock.now()}`);
    const { transcript: next } = Transcript.open(newFile);
    next.appendMark('handoff_from', { file: oldName, notes: notesPath, reason: opts.reason, dropped: plan.start, kept: plan.tail.length });
    const notesText = plan.notes ?? (plan.notesPath ? (d.memory.readText(plan.notesPath) ?? null) : null);
    const notice = opts.notice?.({ notesPath, notes: notesText === null ? null : clip(notesText.trim(), MAX_NOTES_IN_CONTEXT), dropped: plan.start, kept: plan.tail.length });
    if (notice) {
      next.appendMessage({
        role: 'user',
        content: notice.content,
        ...(notice.batch ? { batch: notice.batch } : {}),
        ...(notice.cursors ? { cursors: notice.cursors } : {}),
        ...(notice.boardRev !== undefined ? { boardRev: notice.boardRev } : {}),
      });
    }
    const sourced: Array<{ msg: TranscriptMessage; batch?: string; cursors?: number[] }> =
      plan.via === 'default' ? transcript.recordsFrom(plan.start) : plan.tail.map((msg) => ({ msg }));
    for (const r of sourced) {
      const msg = withoutBoard(stripThinking(r.msg));
      if (msg.content.length === 0) continue;
      next.appendMessage({ role: msg.role, content: msg.content, ...(r.batch ? { batch: r.batch } : {}), ...(r.cursors ? { cursors: r.cursors } : {}) });
    }
    // Before the pointer moves: a crash right after it must not make this conversation look interrupted.
    if (opts.seal && next.lastMessage()?.role === 'user') next.appendMark('batch_ended', { reason: 'handoff', rounds: 0, resumable: false });
    transcript.appendMark('handoff', { to: newName, notes: notesPath, reason: opts.reason });
    const pointer = path.join(d.sessionsDir, 'main.current');
    const fd = fs.openSync(`${pointer}.tmp`, 'w');
    try {
      fs.writeSync(fd, `${newName}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(`${pointer}.tmp`, pointer);
    d.log.info({ from: oldName, to: newName, notes: notesPath, raw: rawPath, kind, dropped: plan.start, kept: plan.tail.length, via: plan.via, reason: opts.reason, estimatedTokens: opts.estimatedTokens }, 'handed off');
    return { transcript: next, notesPath, rawPath, dropped: plan.start, kept: plan.tail.length, via: plan.via, kind };
  }

  /** Keep the dropped conversation as a readable file for review; a failure here does not stop the handoff. */
  private writeRaw(stamp: string, transcriptName: string, dropped: TranscriptMessage[], reason: string, redact: (t: string) => string): string | null {
    const d = this.d;
    if (dropped.length === 0) return null;
    try {
      let rawPath = `raw/${stamp}Z.md`;
      for (let n = 2; d.memory.readText(rawPath) !== undefined; n++) rawPath = `raw/${stamp}Z-${n}.md`;
      const header = [
        `# Conversation archive ${isoInZone(d.clock.now(), d.timezone)}`,
        '',
        `${dropped.length} message(s) from ${transcriptName} (${reason}). Reasoning is left out and tool inputs and results are cut at ${RAW_TOOL_CHARS} characters; sessions/${transcriptName} has everything.`,
        '',
        '',
      ].join('\n');
      const cutNote = `\n\n[cut at the size limit of a memory file; sessions/${transcriptName} has the rest]\n`;
      const body = redact(renderParts(dropped, RAW_CLIPS).join('\n\n'));
      const room = MAX_MEMORY_FILE_BYTES - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(cutNote, 'utf8');
      const kept = clipBytes(body, room);
      d.memory.writeText(rawPath, `${header}${kept}${kept.length < body.length ? cutNote : '\n'}`);
      return rawPath;
    } catch (err) {
      d.log.warn({ err: errorMessage(err) }, 'could not archive the dropped conversation');
      return null;
    }
  }

  /** Notes from a model (the cheap one unless said otherwise). When it fails: mechanical notes, or null when `strict`. */
  private async notes(dropped: TranscriptMessage[], previous: string | null, signal: AbortSignal, strict: boolean, level: Level, role: ModelRole): Promise<string | null> {
    const d = this.d;
    const s = d.settings();
    const prev = previous ? d.memory.readText(previous) : undefined;
    const core = Object.keys(CORE_FILES)
      .map((rel) => {
        const text = d.memory.readText(rel)?.trim();
        return text ? `<file path="${MEMORY_ROOT}/${rel}">\n${text}\n</file>` : '';
      })
      .filter(Boolean)
      .join('\n');
    const input = [
      `<memory_core>\n${core || '(empty)'}\n</memory_core>\n`,
      prev ? `<previous-notes path="${MEMORY_ROOT}/${previous}">\n${prev}\n</previous-notes>\n` : '',
      `<conversation>\n${renderForNotes(dropped, s.notesInputTokens)}\n</conversation>`,
      '\nWrite the handoff notes now.',
    ].join('');
    const failed = (reason: string): string | null => {
      if (strict) {
        d.log.info({ reason }, 'compaction abandoned: no usable notes');
        return null;
      }
      return mechanicalNotes(dropped, reason);
    };
    try {
      const res = await d.provider.generate(
        {
          role,
          system: [{ id: 'handoff-notes', text: HANDOFF_NOTES_SYSTEM }],
          messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
          tools: [],
          // Notes need no deliberation; thinking that filled the output budget left no notes at all.
          effort: 'low',
          maxOutputTokens: s.notesMaxTokens,
        },
        { signal },
      );
      d.onNotesUsage?.(res, level, role);
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => String(b['text'] ?? ''))
        .join('\n')
        .trim();
      if (res.stopReason === 'refusal') return failed('the notes model declined');
      if (text.length === 0) return failed('the notes model returned no text');
      if (strict && res.stopReason === 'max_tokens') return failed('the notes were cut off at max_tokens');
      return text;
    } catch (err) {
      if (signal.aborted) throw err;
      d.log.warn({ err: errorMessage(err) }, strict ? 'handoff notes model failed' : 'handoff notes model failed; writing mechanical notes');
      return failed(errorMessage(err));
    }
  }
}
