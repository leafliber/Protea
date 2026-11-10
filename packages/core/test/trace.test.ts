import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelDeltaTrace, ModelRequestTrace, ModelResponseTrace, ToolCallTrace } from '@protea/protocol';
import { DeltaStream, batchSteps, describeRequest, publicContent, readBatchRecords, reply, sleep, textReply, toolCall } from '../src/index.js';
import { makeHarness, tmpDir, waitFor, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('DeltaStream', () => {
  it('coalesces fragments and keeps text and thinking in order', async () => {
    const out: Array<[string, string]> = [];
    const d = new DeltaStream((k, t) => out.push([k, t]), 10);
    d.push('thinking', 'a');
    d.push('thinking', 'b');
    d.push('text', 'c');
    expect(out).toEqual([['thinking', 'ab']]);
    await sleep(30);
    expect(out).toEqual([['thinking', 'ab'], ['text', 'c']]);
    d.push('text', 'd');
    d.flush();
    d.flush();
    expect(out.at(-1)).toEqual(['text', 'd']);
    expect(out).toHaveLength(3);
  });
});

describe('the run stream', () => {
  it('shows the request, the streamed reply and each tool call of a batch', async () => {
    h = makeHarness({
      steps: [
        (_r, _i, { onText, onThinking }) => {
          onThinking?.('let me think');
          onText?.('working');
          return reply([{ type: 'thinking', thinking: 'let me think', signature: 'SECRET-SIG' }, { type: 'text', text: 'working' }, toolCall('say', { text: 'hello' })]);
        },
        () => textReply('done'),
      ],
    });
    const requests: ModelRequestTrace[] = [];
    const deltas: ModelDeltaTrace[] = [];
    const responses: ModelResponseTrace[] = [];
    h.bus.on('model.request', (r) => requests.push(r));
    h.bus.on('model.delta', (d) => deltas.push(d));
    h.bus.on('model.response', (r) => responses.push(r));
    h.push({ text: 'go' });
    await waitFor(() => responses.length === 2);
    expect(requests.map((r) => [r.round, r.role, r.sessionId])).toEqual([[1, 'main', 'main'], [2, 'main', 'main']]);
    expect(requests[0]?.context).toMatchObject({ messages: 1, prefixChanged: expect.any(Boolean) });
    expect(requests[0]?.context?.estimatedTokens).toBeGreaterThan(0);
    expect(deltas.map((d) => [d.kind, d.text, d.round])).toEqual([['thinking', 'let me think', 1], ['text', 'working', 1]]);
    expect(responses[0]?.round).toBe(1);
    expect(JSON.stringify(responses)).not.toContain('SECRET-SIG');
    expect(responses[0]?.content[0]).toEqual({ type: 'thinking', thinking: 'let me think' });
  });

  it('watching a reply does not make the call count as external output', async () => {
    h = makeHarness({
      steps: [
        async (req, _i, { signal, onText }) => {
          if (JSON.stringify(req.messages).includes('quick question')) return textReply('answered');
          onText?.('Good morning');
          await sleep(5000, signal);
          return textReply('never');
        },
      ],
    });
    const deltas: ModelDeltaTrace[] = [];
    const actions: string[] = [];
    h.bus.on('model.delta', (d) => deltas.push(d));
    h.bus.on('scheduler.action', (a) => actions.push(a.kind));
    h.push({ text: 'schedule fired', level: 3, trigger: 'flush', type: 'cron.tick' }, 'cron', 3);
    await waitFor(() => deltas.length > 0);
    expect(h.main.runningTurn()?.externalOutput).toBe(false);
    h.push({ text: 'quick question', level: 1, trigger: 'preempt' });
    await waitFor(() => actions.includes('preempt'));
  });

  it('reports tool calls, including ones that were refused', async () => {
    h = makeHarness({ steps: [() => reply([toolCall('say', { text: 'x' }), toolCall('nope', {})]), () => textReply('done')] });
    const calls: ToolCallTrace[] = [];
    h.dispatcher.setTrace((t) => calls.push(t));
    h.push({ text: 'go' });
    await waitFor(() => calls.filter((c) => c.phase === 'end').length === 2);
    expect(calls.filter((c) => c.phase === 'start').map((c) => c.name).sort()).toEqual(['nope', 'say']);
    const ended = calls.filter((c): c is Extract<ToolCallTrace, { phase: 'end' }> => c.phase === 'end');
    expect(ended.find((c) => c.name === 'nope')).toMatchObject({ isError: true, result: expect.stringContaining('not available') });
    expect(ended.find((c) => c.name === 'say')).toMatchObject({ isError: false, batchId: expect.any(String), sessionId: 'main' });
  });

  it('previews the next request without moving the thinking floor', async () => {
    h = makeHarness({ steps: [() => textReply('ok')] });
    let ended = 0;
    h.bus.on('batch.ended', () => ended++);
    h.push({ text: 'hello' });
    await waitFor(() => ended === 1);
    const before = fs.readFileSync(h.transcript.file, 'utf8');
    const req = h.main.previewRequest();
    const view = describeRequest('main', req, { model: 'm', ownerOf: () => 'core', limit: 1, limits: { softTokens: 100, hardTokens: 200 }, cacheHitRatio: 0.5 });
    expect(fs.readFileSync(h.transcript.file, 'utf8')).toBe(before);
    expect(view).toMatchObject({ sessionId: 'main', role: 'main', totalMessages: 2, from: 1, limits: { softTokens: 100 }, cacheHitRatio: 0.5 });
    expect(view.messages).toHaveLength(1);
    expect(view.totals.estimatedTokens).toBe(view.totals.systemTokens + view.totals.toolTokens + view.totals.messageTokens);
  });
});

describe('a batch rebuilt from its transcripts', () => {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const user = { t: 'msg', role: 'user', at: '2026-11-10T08:00:00.000Z', batch: 'b1', cursors: [7], content: [{ type: 'text', text: '<events>' }] };
  const asked = { t: 'msg', role: 'assistant', at: '2026-11-10T08:00:01.000Z', batch: 'b1', model: 'm', stop: 'tool_use', content: [{ type: 'thinking', thinking: 't', signature: 'S' }, { type: 'tool_use', id: 'u1', name: 'chat_send', input: { platform: 'webchat', text: 'hi' } }] };
  const answered = { t: 'msg', role: 'user', at: '2026-11-10T08:00:02.000Z', batch: 'b1', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'sent' }] };
  const finished = { t: 'msg', role: 'assistant', at: '2026-11-10T08:00:03.000Z', batch: 'b1', content: [{ type: 'text', text: 'done' }] };
  const mark = { t: 'mark', kind: 'batch_ended', at: '2026-11-10T08:00:04.000Z', batch: 'b1', reason: 'end_turn', rounds: 2 };

  it('follows a batch across a handoff and drops the copied tail', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'main.0001.jsonl'), line({ t: 'msg', role: 'user', at: '2026-11-09T00:00:00.000Z', batch: 'b0', content: [] }));
    fs.writeFileSync(path.join(dir, 'main.0002.jsonl'), line(user) + line(asked) + 'not json b1\n');
    fs.writeFileSync(path.join(dir, 'main.0003.jsonl'), line(asked) + line(answered) + line(finished) + line(mark));
    fs.writeFileSync(path.join(dir, 'main.0004.jsonl'), line({ t: 'msg', role: 'user', at: '2026-11-11T00:00:00.000Z', batch: 'b2', content: [] }));
    const steps = batchSteps(readBatchRecords(dir, 'b1'), [{ id: 1, at: '2026-11-10T08:00:01.500Z', plugin: 'webchat', channel: 'chat', text: 'hi', batchId: 'b1' }]);
    expect(steps.map((s) => s.kind)).toEqual(['events', 'model', 'output', 'tool_result', 'model', 'mark']);
    expect(steps[0]).toMatchObject({ cursors: [7] });
    expect(steps[1]).toMatchObject({ round: 1, model: 'm', stopReason: 'tool_use' });
    expect(JSON.stringify(steps)).not.toContain('"signature"');
    expect(steps[3]).toMatchObject({ name: 'chat_send', text: 'sent', isError: false });
    expect(steps[4]).toMatchObject({ round: 2 });
    expect(steps[5]).toMatchObject({ mark: 'batch_ended', detail: { reason: 'end_turn', rounds: 2 } });
  });

  it('is empty for a batch without a transcript', () => {
    expect(readBatchRecords(tmpDir(), 'nope')).toEqual([]);
    expect(readBatchRecords('/no/such/dir', 'nope')).toEqual([]);
    expect(publicContent([{ type: 'redacted_thinking', data: 'x' }])).toEqual([{ type: 'redacted_thinking' }]);
  });
});
