import fs from 'node:fs';
import path from 'node:path';
import { isToolResultBlock, type ContentBlock, type Effort, type TranscriptMessage } from '@protea/protocol';
import { stripThinking } from '../context/prefix.js';
import { MEMORY_ROOT, type MemoryStore } from '../memory/store.js';
import type { Logger } from '../observability/logger.js';
import type { HandoffPlan, PersonaHooks } from '../persona/persona.js';
import type { Provider, ProviderRequest } from '../providers/types.js';
import { estimateTokens } from '../skills/parse.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import { isoInZone } from '../util/time.js';
import { Transcript } from './transcript.js';

export interface HandoffSettings {
  /** At the start of a batch, hand off when the next request would exceed this many input tokens. */
  softTokens: number;
  /** Before any request, hand off above this; null = the model's context window − max output − a margin. */
  hardTokens: number | null;
  /** Share of softTokens carried into the new conversation verbatim (the most recent messages). */
  keepRatio: number;
  /** Output budget of the notes request. */
  notesMaxTokens: number;
  /** Largest rendered history sent to the notes model; older parts are cut first. */
  notesInputTokens: number;
  /** Entries kept in the "Recent handoffs" list of memory/INDEX.md. */
  recentInIndex: number;
}

export const DEFAULT_HANDOFF: HandoffSettings = {
  softTokens: 200_000,
  hardTokens: null,
  keepRatio: 1 / 3,
  notesMaxTokens: 8_000,
  notesInputTokens: 150_000,
  recentInIndex: 5,
};

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

export function estimateRequestTokens(req: ProviderRequest): number {
  const sys = req.system.reduce((n, s) => n + estimateTokens(s.text) + 4, 0);
  const tools = req.tools.filter((t) => !t.deferLoading).reduce((n, t) => n + estimateTokens(JSON.stringify(t)), 0);
  return sys + tools + estimateMessagesTokens(req.messages);
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

/** The dropped part of the conversation as plain text for the notes model; oldest parts go first when it is too long. */
export function renderForNotes(messages: readonly TranscriptMessage[], maxTokens: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    const lines: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text') lines.push(clip(String(b['text'] ?? ''), 6_000));
      else if (b.type === 'tool_use') lines.push(`[tool call ${String(b['name'])}] ${clip(JSON.stringify(b['input'] ?? {}), 800)}`);
      else if (b.type === 'tool_result') {
        const c = b['content'];
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as ContentBlock[]).map((x) => (x.type === 'text' ? String(x['text']) : `[${x.type}]`)).join(' ') : '';
        lines.push(`[tool result${b['is_error'] ? ' (error)' : ''}] ${clip(text, 1_500)}`);
      } else if (b.type === 'compaction') lines.push(`[earlier summary] ${clip(String(b['content'] ?? ''), 20_000)}`);
      else if (b.type !== 'thinking' && b.type !== 'redacted_thinking' && b.type !== 'fallback') lines.push(`[${b.type}]`);
    }
    if (lines.length > 0) parts.push(`--- ${m.role === 'user' ? 'runtime → assistant' : 'assistant'} ---\n${lines.join('\n')}`);
  }
  let total = parts.reduce((n, p) => n + estimateTokens(p), 0);
  let cut = 0;
  while (total > maxTokens && cut < parts.length - 1) {
    total -= estimateTokens(parts[cut] as string);
    cut++;
  }
  return `${cut > 0 ? `[${cut} earlier message(s) omitted for length]\n\n` : ''}${parts.slice(cut).join('\n\n')}`;
}

export const HANDOFF_NOTES_SYSTEM = `You write handoff notes for an always-on personal assistant. Its conversation is about to be reset: afterwards it has only these notes, its memory files and its most recent messages, so whatever is not in the notes is lost.

Write Markdown with these sections, in this order, and keep every concrete detail (names, dates, times, amounts, exact wording of promises):

## In progress
What the assistant was working on and how far it got.
## Commitments
Promises and agreements made with the owner or others, with deadlines.
## Owner's recent instructions
Requests, preferences and corrections the owner gave.
## Pending
Approvals, background forks, follow-ups or replies still awaited.
## Facts worth keeping
Anything else the assistant will need.

Carry over every item from the previous notes that still applies. Do not invent anything. Leave out a section only when it would be empty. Be concise: at most about 1500 words. Write in the language the owner uses.`;

/** Fallback notes when the notes model is unavailable: the latest texts, verbatim. */
export function mechanicalNotes(dropped: readonly TranscriptMessage[], reason: string): string {
  const texts: string[] = [];
  for (const m of dropped) for (const b of m.content) if (b.type === 'text') texts.push(`${m.role}: ${clip(String(b['text'] ?? ''), 1_500)}`);
  return `Automatic summary unavailable (${reason}). The last messages before the handoff, verbatim:\n\n${texts.slice(-20).join('\n\n')}`;
}

export interface HandoffResult {
  transcript: Transcript;
  notesPath: string;
  dropped: number;
  kept: number;
  via: 'default' | 'hook';
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
  cheapEffort: () => Effort;
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
      /** The first message of the new conversation (the handoff notice). */
      notice?: (info: { notesPath: string; dropped: number; kept: number }) => { content: ContentBlock[]; cursors?: number[]; batch?: string } | null;
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
          { hardTokens: opts.limits.hard, keepTokens: opts.limits.keep },
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
      const notes = await this.notes(dropped, transcript.previousNotes, opts.signal);
      plan = { start, tail: messages.slice(start), notes, notesPath: null, via: 'default' };
    }

    const stamp = isoInZone(d.clock.now(), 'UTC').slice(0, 19).replace(/:/g, '-');
    let notesPath = plan.notesPath ?? `handoff/${stamp}Z.md`;
    for (let n = 2; plan.notesPath === null && d.memory.readText(notesPath) !== undefined; n++) notesPath = `handoff/${stamp}Z-${n}.md`;
    const oldName = path.basename(transcript.file);
    if (plan.notes !== null) {
      const header = [
        `# Handoff ${isoInZone(d.clock.now(), d.timezone)}`,
        '',
        `Conversation ${oldName}: ${plan.start} message(s) handed off, ${plan.tail.length} kept (${opts.reason}).` +
          (transcript.previousNotes ? ` Previous notes: ${MEMORY_ROOT}/${transcript.previousNotes}` : ''),
        '',
      ].join('\n');
      d.memory.writeText(notesPath, `${header}\n${plan.notes.trim()}\n`);
    }
    this.noteInIndex(notesPath);

    // New transcript: the handoff mark, then the tail as it was (without thinking), then the caller appends the notice.
    const newName = nextTranscriptName(transcript.file);
    const newFile = path.join(d.sessionsDir, newName);
    // Left over by a handoff that crashed before switching the pointer: set it aside.
    if (fs.existsSync(newFile)) fs.renameSync(newFile, `${newFile}.abandoned-${d.clock.now()}`);
    const { transcript: next } = Transcript.open(newFile);
    next.appendMark('handoff_from', { file: oldName, notes: notesPath, reason: opts.reason, dropped: plan.start, kept: plan.tail.length });
    const notice = opts.notice?.({ notesPath, dropped: plan.start, kept: plan.tail.length });
    if (notice) next.appendMessage({ role: 'user', content: notice.content, ...(notice.batch ? { batch: notice.batch } : {}), ...(notice.cursors ? { cursors: notice.cursors } : {}) });
    const sourced: Array<{ msg: TranscriptMessage; batch?: string; cursors?: number[] }> =
      plan.via === 'default' ? transcript.recordsFrom(plan.start) : plan.tail.map((msg) => ({ msg }));
    for (const r of sourced) {
      const msg = stripThinking(r.msg);
      if (msg.content.length === 0) continue;
      next.appendMessage({ role: msg.role, content: msg.content, ...(r.batch ? { batch: r.batch } : {}), ...(r.cursors ? { cursors: r.cursors } : {}) });
    }
    transcript.appendMark('handoff', { to: newName, notes: notesPath, reason: opts.reason });
    const pointer = path.join(d.sessionsDir, 'main.current');
    fs.writeFileSync(`${pointer}.tmp`, `${newName}\n`);
    fs.renameSync(`${pointer}.tmp`, pointer);
    d.log.info({ from: oldName, to: newName, notes: notesPath, dropped: plan.start, kept: plan.tail.length, via: plan.via, reason: opts.reason, estimatedTokens: opts.estimatedTokens }, 'handed off');
    return { transcript: next, notesPath, dropped: plan.start, kept: plan.tail.length, via: plan.via };
  }

  /** Notes from the cheap model; mechanical notes when it fails. */
  private async notes(dropped: TranscriptMessage[], previous: string | null, signal: AbortSignal): Promise<string> {
    const d = this.d;
    const s = d.settings();
    const prev = previous ? d.memory.readText(previous) : undefined;
    const input = [
      prev ? `<previous-notes path="${MEMORY_ROOT}/${previous}">\n${prev}\n</previous-notes>\n` : '',
      `<conversation>\n${renderForNotes(dropped, s.notesInputTokens)}\n</conversation>`,
      '\nWrite the handoff notes now.',
    ].join('');
    try {
      const res = await d.provider.generate(
        {
          role: 'cheap',
          system: [{ id: 'handoff-notes', text: HANDOFF_NOTES_SYSTEM }],
          messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
          tools: [],
          effort: d.cheapEffort(),
          maxOutputTokens: s.notesMaxTokens,
        },
        { signal },
      );
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => String(b['text'] ?? ''))
        .join('\n')
        .trim();
      if (res.stopReason === 'refusal' || text.length === 0) return mechanicalNotes(dropped, res.stopReason === 'refusal' ? 'the notes model declined' : 'the notes model returned no text');
      return text;
    } catch (err) {
      if (signal.aborted) throw err;
      d.log.warn({ err: errorMessage(err) }, 'handoff notes model failed; writing mechanical notes');
      return mechanicalNotes(dropped, errorMessage(err));
    }
  }

  /** Keep a short "Recent handoffs" list at the end of memory/INDEX.md. */
  private noteInIndex(notesPath: string): void {
    const d = this.d;
    const heading = '## Recent handoffs';
    const current = d.memory.readText('INDEX.md') ?? '# Memory index\n';
    const lines = current.split('\n');
    const at = lines.findIndex((l) => l.trim() === heading);
    let before = lines;
    let entries: string[] = [];
    let after: string[] = [];
    if (at >= 0) {
      before = lines.slice(0, at);
      const rest = lines.slice(at + 1);
      const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
      const section = end < 0 ? rest : rest.slice(0, end);
      after = end < 0 ? [] : rest.slice(end);
      entries = section.filter((l) => l.startsWith('- '));
    }
    entries = [`- ${MEMORY_ROOT}/${notesPath}`, ...entries].slice(0, Math.max(1, d.settings().recentInIndex));
    const head = before.join('\n').replace(/\s+$/, '');
    const tail = after.length > 0 ? `\n\n${after.join('\n').replace(/\s+$/, '')}` : '';
    d.memory.writeText('INDEX.md', `${head}\n\n${heading}\n\n${entries.join('\n')}${tail}\n`);
  }
}
