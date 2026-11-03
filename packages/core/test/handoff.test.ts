import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@protea/protocol';
import {
  DEFAULT_HANDOFF,
  Handoff,
  MemoryStore,
  ProviderError,
  ScriptedProvider,
  Transcript,
  contextLimits,
  nextTranscriptName,
  renderForNotes,
  selectTailStart,
  silentLogger,
  textReply,
} from '../src/index.js';
import { tmpDir } from './helpers.js';

const u = (text: string): TranscriptMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (text: string): TranscriptMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (id: string): TranscriptMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] });
const result = (id: string): TranscriptMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });

describe('handoff planning', () => {
  it('derives limits from the context window unless configured', () => {
    expect(contextLimits(DEFAULT_HANDOFF, 1_000_000, 64_000)).toEqual({ soft: 200_000, hard: 886_000, keep: 66_667 });
    expect(contextLimits({ ...DEFAULT_HANDOFF, softTokens: 5_000, hardTokens: 9_000 }, 1_000_000, 64_000)).toEqual({ soft: 5_000, hard: 9_000, keep: 1_667 });
    expect(contextLimits(DEFAULT_HANDOFF, undefined, 64_000).hard).toBe(126_000);
  });

  it('cuts only before an events message, keeps the running batch whole and fits the budget', () => {
    const big = 'x'.repeat(4_000); // about 1000 tokens
    const msgs = [u(big), a(big), u(big), call('t1'), result('t1'), a(big), u('new batch'), call('t2'), result('t2')];
    // Plenty of budget: everything but the first exchange fits; never start at a tool result.
    expect(selectTailStart(msgs, 6, 2_600)).toBe(2);
    // Tight budget: the latest clean cut at or before the running batch, even if over budget.
    expect(selectTailStart(msgs, 6, 10)).toBe(6);
    // The running batch started at 2: the cut cannot move past it.
    expect(selectTailStart(msgs, 2, 10)).toBe(2);
    // Nothing older than the running batch: nothing to drop.
    expect(selectTailStart(msgs, 0, 10)).toBe(0);
  });

  it('renders the dropped part as text and cuts the oldest first', () => {
    const text = renderForNotes([u('<events>hello</events>'), call('t1'), result('t1'), a('done')], 1_000);
    expect(text).toBe('--- runtime → assistant ---\n<events>hello</events>\n\n--- assistant ---\n[tool call x] {}\n\n--- runtime → assistant ---\n[tool result] ok\n\n--- assistant ---\ndone');
    const long = renderForNotes([u('a'.repeat(8_000)), u('b'.repeat(8_000)), u('last')], 1_000);
    expect(long.startsWith('[2 earlier message(s) omitted for length]')).toBe(true);
    expect(long.endsWith('last')).toBe(true);
  });

  it('names transcripts in sequence', () => {
    expect(nextTranscriptName('/x/main.0001.jsonl')).toBe('main.0002.jsonl');
    expect(nextTranscriptName('/x/main.0999.jsonl')).toBe('main.1000.jsonl');
  });
});

describe('Handoff.run', () => {
  function setup(provider: ScriptedProvider) {
    const dir = tmpDir('protea-handoff-');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'main.current'), 'main.0001.jsonl\n');
    const { transcript } = Transcript.open(path.join(sessionsDir, 'main.0001.jsonl'));
    const memory = new MemoryStore(path.join(dir, 'memory'));
    const h = new Handoff({
      provider,
      memory,
      sessionsDir,
      dataDir: dir,
      log: silentLogger(),
      clock: { now: () => Date.parse('2026-11-03T08:00:00Z') },
      timezone: 'Asia/Shanghai',
      settings: () => DEFAULT_HANDOFF,
      hooks: () => null,
      cheapEffort: () => 'low',
    });
    return { dir, sessionsDir, transcript, memory, h };
  }
  const limits = { soft: 1_000, hard: 5_000, keep: 10 };
  const run = (h: Handoff, t: Transcript) =>
    h.run(t, { mustKeepFrom: t.length, limits, estimatedTokens: 1_234, reason: 'test', signal: new AbortController().signal, notice: () => ({ content: [{ type: 'text', text: 'NOTICE' }] }) });

  it('writes notes, seals the old transcript, carries the tail without thinking and moves the pointer', async () => {
    const provider = new ScriptedProvider([() => textReply('## Commitments\n- tea on Friday')]);
    const { sessionsDir, transcript, memory, h } = setup(provider);
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'we agree: tea on Friday' }], batch: 'b1', cursors: [1] });
    transcript.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'ok' }], batch: 'b1' });
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'next' }], batch: 'b2', cursors: [2] });
    transcript.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 't2', signature: 's2' }, { type: 'text', text: 'fine' }], batch: 'b2' });
    // A leftover from a handoff that crashed before switching the pointer.
    fs.writeFileSync(path.join(sessionsDir, 'main.0002.jsonl'), '{"t":"msg","role":"user","content":[{"type":"text","text":"stale"}],"at":"x"}\n');

    const r = await run(h, transcript);
    expect(r).toMatchObject({ notesPath: 'handoff/2026-11-03T08-00-00Z.md', dropped: 2, kept: 2, via: 'default' });
    expect(provider.calls[0]).toMatchObject({ role: 'cheap', effort: 'low', maxOutputTokens: 8_000, tools: [] });
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain('we agree: tea on Friday');
    expect(memory.readText('handoff/2026-11-03T08-00-00Z.md')).toBe(
      '# Handoff 2026-11-03T16:00:00+08:00\n\nConversation main.0001.jsonl: 2 message(s) handed off, 2 kept (test).\n\n## Commitments\n- tea on Friday\n',
    );
    expect(memory.readText('INDEX.md')).toBe('# Memory index\n\n## Recent handoffs\n\n- /memories/handoff/2026-11-03T08-00-00Z.md\n');
    expect(fs.readFileSync(path.join(sessionsDir, 'main.current'), 'utf8')).toBe('main.0002.jsonl\n');
    expect(fs.readdirSync(sessionsDir).some((f) => f.startsWith('main.0002.jsonl.abandoned-'))).toBe(true);
    const next = r?.transcript as Transcript;
    expect(next.messages).toEqual([u('NOTICE'), u('next'), a('fine')]);
    expect(next.previousNotes).toBe('handoff/2026-11-03T08-00-00Z.md');
    expect(next.deliveredCursors()).toEqual(new Set([2]));
    expect(next.batchStart('b2')).toBe(1);
    expect(fs.readFileSync(transcript.file, 'utf8')).toMatch(/"kind":"handoff","to":"main.0002.jsonl","notes":"handoff\/2026-11-03T08-00-00Z.md"/);

    // The next handoff passes the previous notes to the notes model and keeps a list in INDEX.md.
    next.appendMessage({ role: 'user', content: [{ type: 'text', text: 'third' }], batch: 'b3' });
    const r2 = await run(h, next);
    expect(r2?.notesPath).toBe('handoff/2026-11-03T08-00-00Z-2.md');
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain('previous-notes path=\\"/memories/handoff/2026-11-03T08-00-00Z.md\\"');
    expect(memory.readText('INDEX.md')).toContain('- /memories/handoff/2026-11-03T08-00-00Z-2.md\n- /memories/handoff/2026-11-03T08-00-00Z.md\n');
  });

  it('falls back to mechanical notes when the notes model fails, and does nothing when nothing can be dropped', async () => {
    const provider = new ScriptedProvider([() => new ProviderError('retryable', 'overloaded')]);
    const { transcript, memory, h } = setup(provider);
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'only batch' }], batch: 'b1' });
    expect(await run(h, transcript)).toBeNull();
    transcript.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer one' }], batch: 'b1' });
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'second batch' }], batch: 'b2' });
    const r = await run(h, transcript);
    expect(memory.readText(r?.notesPath as string)).toContain('Automatic summary unavailable (overloaded). The last messages before the handoff, verbatim:\n\nuser: only batch\n\nassistant: answer one');
  });
});
