import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isToolResultBlock } from '@protea/protocol';
import { MISSING_RESULT_TEXT, Transcript, TranscriptCorruptError } from '../src/index.js';
import { tmpDir } from './helpers.js';

const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text', text }] });
const toolUse = (...ids: string[]) => ({
  role: 'assistant' as const,
  content: ids.map((id) => ({ type: 'tool_use', id, name: 'say', input: {} })),
});
const results = (...ids: string[]) => ({
  role: 'user' as const,
  content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
});
const line = (o: object) => `${JSON.stringify({ t: 'msg', at: 'x', ...o })}\n`;

function file(): string {
  return path.join(tmpDir(), 'main.jsonl');
}

describe('Transcript', () => {
  it('starts a new file and reloads the same messages', () => {
    const f = file();
    const { transcript } = Transcript.open(f);
    transcript.appendMessage({ ...user('hi'), cursors: [1] });
    transcript.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'yo' }] });
    transcript.close();
    const again = Transcript.open(f).transcript;
    expect(again.messages).toEqual(transcript.messages);
    expect(again.deliveredCursors()).toEqual(new Set([1]));
    expect(fs.readFileSync(f, 'utf8').split('\n')[0]).toContain('session_start');
  });

  it('terminates a parseable unterminated last line', () => {
    const f = file();
    fs.writeFileSync(f, line(user('a')) + JSON.stringify({ t: 'msg', role: 'assistant', content: [{ type: 'text', text: 'b' }], at: 'x' }));
    const { transcript, report } = Transcript.open(f);
    expect(report.terminatedLastLine).toBe(true);
    expect(transcript.messages).toHaveLength(2);
    expect(fs.readFileSync(f, 'utf8').endsWith('\n')).toBe(true);
  });

  it('drops a torn last line and keeps the committed prefix byte-for-byte', () => {
    const f = file();
    const committed = line(user('a'));
    fs.writeFileSync(f, `${committed}{"t":"msg","role":"assi`);
    const discarded: Record<string, unknown>[] = [];
    const { transcript, report } = Transcript.open(f, { onDiscarded: (r) => discarded.push(r) });
    expect(report.truncatedBytes).toBeGreaterThan(0);
    expect(discarded[0]?.['kind']).toBe('truncated-tail');
    expect(fs.readFileSync(f, 'utf8').startsWith(committed)).toBe(true);
    expect(transcript.messages).toHaveLength(1);
  });

  it('refuses to guess about a corrupt committed line', () => {
    const f = file();
    fs.writeFileSync(f, `${line(user('a'))}not json\n${line(user('b'))}`);
    expect(() => Transcript.open(f)).toThrow(TranscriptCorruptError);
  });

  it('answers tool calls left without results by appending placeholders, once', () => {
    const f = file();
    fs.writeFileSync(f, line(user('a')) + line(toolUse('t1', 't2')));
    const first = Transcript.open(f);
    expect(first.report.placeholderResults).toEqual(['t1', 't2']);
    const last = first.transcript.lastMessage();
    expect(last?.role).toBe('user');
    expect(last?.content.every((b) => isToolResultBlock(b) && b.content === MISSING_RESULT_TEXT && b.is_error)).toBe(true);
    first.transcript.close();
    const second = Transcript.open(f);
    expect(second.report.placeholderResults).toEqual([]);
    expect(second.report.actions).toEqual([]);
    expect(second.transcript.messages).toEqual(first.transcript.messages);
  });

  it('drops orphan tool results through a recorded repair mark', () => {
    const f = file();
    fs.writeFileSync(f, line(user('a')) + line(toolUse('t1')) + line(results('t1', 'ghost')) + line(user('b')));
    const discarded: Record<string, unknown>[] = [];
    const first = Transcript.open(f, { onDiscarded: (r) => discarded.push(r) });
    expect(first.report.actions).toEqual([{ action: 'drop-result', msgIndex: 2, toolUseId: 'ghost' }]);
    expect(discarded.some((d) => d['kind'] === 'orphan-result-drop')).toBe(true);
    const ids = first.transcript.messages[2]?.content.filter(isToolResultBlock).map((b) => b.tool_use_id);
    expect(ids).toEqual(['t1']);
    first.transcript.close();
    const second = Transcript.open(f);
    expect(second.report.actions).toEqual([]);
    expect(second.transcript.messages).toEqual(first.transcript.messages);
  });

  it('injects placeholders for results missing in the middle of the history', () => {
    const f = file();
    fs.writeFileSync(f, line(user('a')) + line(toolUse('t1', 't2')) + line(results('t2')) + line(toolUse('t3')) + line(toolUse('t4')) + line(results('t4')));
    const { transcript, report } = Transcript.open(f);
    expect(report.actions).toEqual([
      { action: 'insert-results', afterMsgIndex: 1, toolUseIds: ['t1'] },
      { action: 'insert-results', afterMsgIndex: 3, toolUseIds: ['t3'] },
    ]);
    const m = transcript.messages;
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(m[2]?.content.filter(isToolResultBlock).map((b) => b.tool_use_id)).toEqual(['t1', 't2']);
    expect(m[4]?.content.filter(isToolResultBlock).map((b) => b.tool_use_id)).toEqual(['t3']);
  });

  it('rejects a transcript that does not start with a user message', () => {
    const f = file();
    fs.writeFileSync(f, line({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }));
    expect(() => Transcript.open(f)).toThrow(/does not start with a user message/);
  });

  it('knows when the last batch needs resuming', () => {
    const f = file();
    const { transcript } = Transcript.open(f);
    expect(transcript.needsResume()).toBe(false);
    transcript.appendMessage(user('a'));
    expect(transcript.needsResume()).toBe(true);
    transcript.appendMark('batch_ended', { reason: 'model_error', resumable: false });
    expect(transcript.needsResume()).toBe(false);
    transcript.appendMark('batch_ended', { reason: 'aborted', resumable: true });
    expect(transcript.needsResume()).toBe(true);
    transcript.close();
    expect(Transcript.open(f).transcript.needsResume()).toBe(true);
  });

  it('never rewrites committed bytes (I-4)', () => {
    const f = file();
    const { transcript } = Transcript.open(f);
    transcript.appendMessage(user('a'));
    transcript.appendMessage(toolUse('t1'));
    transcript.close();
    const before = fs.readFileSync(f);
    Transcript.open(f).transcript.close();
    const after = fs.readFileSync(f);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });
});
