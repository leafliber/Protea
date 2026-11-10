import fs from 'node:fs';
import path from 'node:path';
import { isToolResultBlock, isToolUseBlock, isTextBlock, type BatchTraceStep } from '@protea/protocol';
import type { OutputRecord } from '../events/outputs.js';
import { publicContent } from './trace.js';
import type { MarkRecord, MsgRecord, TranscriptRecord } from './transcript.js';

const MAIN_FILE = /^main\.(\d+)\.jsonl$/;

function recordsOf(file: string, batchId: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(batchId)) continue;
    try {
      const rec = JSON.parse(line) as TranscriptRecord;
      if (rec.t === 'msg' ? rec.batch === batchId : (rec as MarkRecord)['batch'] === batchId) out.push(rec);
    } catch {
      // A torn last line (a crash while writing).
    }
  }
  return out;
}

/**
 * The transcript records of one batch of the main session, oldest first. A handoff can split a
 * batch over two files and copies the kept tail into the new one, so files are read from the
 * newest back until the batch is passed, and copies are dropped.
 */
export function readBatchRecords(sessionsDir: string, batchId: string): TranscriptRecord[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const files = fs
    .readdirSync(sessionsDir)
    .map((f) => ({ f, n: Number(MAIN_FILE.exec(f)?.[1] ?? NaN) }))
    .filter((x) => !Number.isNaN(x.n))
    .sort((a, b) => b.n - a.n);
  const groups: TranscriptRecord[][] = [];
  for (const { f } of files) {
    const found = recordsOf(path.join(sessionsDir, f), batchId);
    if (found.length === 0 && groups.length > 0) break;
    if (found.length > 0) groups.unshift(found);
  }
  const seen = new Set<string>();
  const out: TranscriptRecord[] = [];
  for (const rec of groups.flat()) {
    const key = rec.t === 'msg' ? `m:${rec.role}:${JSON.stringify(rec.content)}` : `k:${rec.kind}:${rec.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

function msgSteps(rec: MsgRecord, names: Map<string, string>, round: { n: number }): BatchTraceStep[] {
  if (rec.role === 'assistant') {
    for (const b of rec.content) if (isToolUseBlock(b)) names.set(b.id, b.name);
    round.n++;
    return [
      {
        kind: 'model',
        at: rec.at,
        round: round.n,
        content: publicContent(rec.content),
        ...(rec.model !== undefined ? { model: rec.model } : {}),
        ...(rec.stop !== undefined ? { stopReason: rec.stop } : {}),
        ...(rec.usage ? { usage: rec.usage } : {}),
      },
    ];
  }
  const steps: BatchTraceStep[] = [];
  if (rec.cursors && rec.cursors.length > 0) steps.push({ kind: 'events', at: rec.at, cursors: rec.cursors });
  for (const b of rec.content) {
    if (!isToolResultBlock(b)) continue;
    const text = typeof b.content === 'string' ? b.content : b.content.map((c) => (isTextBlock(c) ? c.text : JSON.stringify(c))).join('\n');
    steps.push({ kind: 'tool_result', at: rec.at, callId: b.tool_use_id, name: names.get(b.tool_use_id) ?? '?', text, isError: b.is_error === true });
  }
  return steps;
}

/** What happened in a batch, merged by time from its transcript records and its outputs. */
export function batchSteps(records: readonly TranscriptRecord[], outputs: readonly OutputRecord[]): BatchTraceStep[] {
  const names = new Map<string, string>();
  const round = { n: 0 };
  const steps: BatchTraceStep[] = [];
  for (const rec of records) {
    if (rec.t === 'msg') {
      steps.push(...msgSteps(rec, names, round));
    } else {
      const { t: _t, kind, at, batch: _batch, ...detail } = rec;
      steps.push({ kind: 'mark', at, mark: kind, detail });
    }
  }
  for (const o of outputs) steps.push({ kind: 'output', at: o.at, plugin: o.plugin, text: o.text, ...(o.channel !== undefined ? { channel: o.channel } : {}) });
  // Stable: within one millisecond the transcript order stands.
  return steps.map((s, i) => ({ s, i })).sort((a, b) => (a.s.at < b.s.at ? -1 : a.s.at > b.s.at ? 1 : a.i - b.i)).map((x) => x.s);
}
