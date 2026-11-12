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
  reply,
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
    expect(contextLimits(DEFAULT_HANDOFF, 1_000_000, 64_000)).toEqual({ soft: 80_000, hard: 886_000, keep: 26_667 });
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
    expect(provider.calls[0]).toMatchObject({ role: 'cheap', effort: 'low', maxOutputTokens: 16_000, tools: [] });
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain('we agree: tea on Friday');
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain('<memory_core>\\n(empty)\\n</memory_core>');
    expect(memory.readText('handoff/2026-11-03T08-00-00Z.md')).toBe(
      '# Handoff 2026-11-03T16:00:00+08:00\n\nConversation main.0001.jsonl: 2 message(s) handed off, 2 kept (test).\n\n## Commitments\n- tea on Friday\n',
    );
    // The system prefix is not touched by a handoff.
    expect(memory.listFiles().map((f) => f.path)).toEqual(['handoff/2026-11-03T08-00-00Z.md', 'raw/2026-11-03T08-00-00Z.md']);
    expect(memory.readText('raw/2026-11-03T08-00-00Z.md')).toContain('we agree: tea on Friday');
    expect(fs.readFileSync(path.join(sessionsDir, 'main.current'), 'utf8')).toBe('main.0002.jsonl\n');
    expect(fs.readdirSync(sessionsDir).some((f) => f.startsWith('main.0002.jsonl.abandoned-'))).toBe(true);
    const next = r?.transcript as Transcript;
    expect(next.messages).toEqual([u('NOTICE'), u('next'), a('fine')]);
    expect(next.previousNotes).toBe('handoff/2026-11-03T08-00-00Z.md');
    expect(next.deliveredCursors()).toEqual(new Set([2]));
    expect(next.batchStart('b2')).toBe(1);
    expect(fs.readFileSync(transcript.file, 'utf8')).toMatch(/"kind":"handoff","to":"main.0002.jsonl","notes":"handoff\/2026-11-03T08-00-00Z.md"/);

    // The next handoff passes the previous notes and the resident memory to the notes model, the one asked for.
    memory.writeText('core/rules.md', '- tea is on Fridays');
    next.appendMessage({ role: 'user', content: [{ type: 'text', text: 'third' }], batch: 'b3' });
    const r2 = await h.run(next, { mustKeepFrom: next.length, limits, estimatedTokens: 1, reason: 'test', signal: new AbortController().signal, notesRole: 'fork', notice: () => ({ content: [{ type: 'text', text: 'NOTICE' }] }) });
    expect(r2?.notesPath).toBe('handoff/2026-11-03T08-00-00Z-2.md');
    expect(provider.calls[1]?.role).toBe('fork');
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain('previous-notes path=\\"/memories/handoff/2026-11-03T08-00-00Z.md\\"');
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain('<file path=\\"/memories/core/rules.md\\">\\n- tea is on Fridays');
  });

  const conversation = (t: Transcript): void => {
    t.appendMessage({ role: 'user', content: [{ type: 'text', text: 'first' }], batch: 'b1', cursors: [1] });
    t.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], batch: 'b1' });
    t.appendMessage({ role: 'user', content: [{ type: 'text', text: 'second' }], batch: 'b2', cursors: [2] });
    t.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fine' }], batch: 'b2' });
  };
  const strictRun = (h: Handoff, t: Transcript, signal = new AbortController().signal) =>
    h.run(t, { mustKeepFrom: t.length, limits, estimatedTokens: 1, reason: 'idle', signal, kind: 'idle', level: 4, strict: true, seal: true, notice: () => ({ content: [{ type: 'text', text: 'NOTICE' }] }) });

  it.each([
    ['a failed request', (): Error => new ProviderError('retryable', 'overloaded')],
    ['a refusal', () => reply([{ type: 'text', text: 'no' }], 'refusal')],
    ['empty notes', () => textReply('  ')],
    ['notes cut off at max_tokens', () => reply([{ type: 'text', text: 'half of' }], 'max_tokens')],
  ])('abandons a strict handoff on %s and writes nothing', async (_name, step) => {
    const { dir, sessionsDir, transcript, memory, h } = setup(new ScriptedProvider([step]));
    conversation(transcript);
    expect(await strictRun(h, transcript)).toBeNull();
    expect(memory.listFiles()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'sessions', 'main.0002.jsonl'))).toBe(false);
    expect(fs.readFileSync(path.join(sessionsDir, 'main.current'), 'utf8')).toBe('main.0001.jsonl\n');
  });

  it('writes nothing once aborted, even after the notes came back', async () => {
    const ac = new AbortController();
    const provider = new ScriptedProvider([
      () => {
        ac.abort('urgent');
        return textReply('## Commitments\n- tea');
      },
    ]);
    const { memory, transcript, h } = setup(provider);
    conversation(transcript);
    await expect(strictRun(h, transcript, ac.signal)).rejects.toThrow();
    expect(memory.listFiles()).toEqual([]);
  });

  it('seals an idle handoff before moving the pointer, so a restart does not resume it', async () => {
    const { sessionsDir, transcript, h } = setup(new ScriptedProvider([() => textReply('notes')]));
    conversation(transcript);
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'third' }], batch: 'b3', cursors: [3] });
    const r = await strictRun(h, transcript);
    expect(r).toMatchObject({ kind: 'idle' });
    (r?.transcript as Transcript).close();
    const { transcript: reopened } = Transcript.open(path.join(sessionsDir, 'main.0002.jsonl'));
    expect(reopened.lastMessage()?.role).toBe('user');
    expect(reopened.needsResume()).toBe(false);
  });

  it('archives the dropped conversation readably: no reasoning, clipped tool traffic, no secrets', async () => {
    const { dir, sessionsDir, memory } = setup(new ScriptedProvider([() => textReply('notes')]));
    const { transcript } = Transcript.open(path.join(sessionsDir, 'main.0001.jsonl'));
    const h = new Handoff({
      provider: new ScriptedProvider([() => textReply('notes')]),
      memory,
      sessionsDir,
      dataDir: dir,
      log: silentLogger(),
      clock: { now: () => Date.parse('2026-11-03T08:00:00Z') },
      timezone: 'Asia/Shanghai',
      settings: () => DEFAULT_HANDOFF,
      hooks: () => null,
      redact: (t) => t.replaceAll('hunter2', '[REDACTED:PW]'),
    });
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'the password is hunter2' }], batch: 'b1', cursors: [1] });
    transcript.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret plan', signature: 's' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }], batch: 'b1' });
    transcript.appendMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(9_000) }], batch: 'b1' });
    transcript.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }], batch: 'b1' });
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: 'later' }], batch: 'b2', cursors: [2] });
    await run(h, transcript);
    const raw = memory.readText('raw/2026-11-03T08-00-00Z.md') as string;
    expect(raw).toContain('[REDACTED:PW]');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('secret plan');
    expect(raw).toContain(`${'r'.repeat(4_000)}… [5000 more characters]`);
    expect(raw).toContain('sessions/main.0001.jsonl has everything');
  });

  it('passes the notes to the first message and leaves old board blocks out of the tail', async () => {
    const { transcript, h } = setup(new ScriptedProvider([() => textReply('## Pending\n- reply to Bob')]));
    conversation(transcript);
    transcript.appendMessage({ role: 'user', content: [{ type: 'text', text: '<events/>' }, { type: 'text', text: '<board rev="3">\n## todo\n- t1 stale\n</board>' }], batch: 'b3', cursors: [3] });
    let seen: string | null = null;
    const r = await h.run(transcript, {
      mustKeepFrom: transcript.length,
      limits,
      estimatedTokens: 1,
      reason: 'test',
      signal: new AbortController().signal,
      notice: (info) => {
        seen = info.notes;
        return { content: [{ type: 'text', text: 'NOTICE' }], boardRev: 7 };
      },
    });
    expect(seen).toBe('## Pending\n- reply to Bob');
    const next = r?.transcript as Transcript;
    expect(next.boardRev).toBe(7);
    expect(JSON.stringify(next.messages)).not.toContain('stale');
  });

  it('reports what the notes request used, at the level it is attributed to', async () => {
    const used: Array<[string, number]> = [];
    const provider = new ScriptedProvider([() => textReply('notes')]);
    const { dir, sessionsDir, transcript, memory } = setup(provider);
    const h = new Handoff({
      provider,
      memory,
      sessionsDir,
      dataDir: dir,
      log: silentLogger(),
      clock: { now: () => 0 },
      timezone: 'UTC',
      settings: () => DEFAULT_HANDOFF,
      hooks: () => null,
      onNotesUsage: (res, level) => used.push([res.model, level]),
    });
    conversation(transcript);
    await strictRun(h, transcript);
    expect(used).toEqual([['scripted', 4]]);
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
