import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import type { Level, Origin, SenderRole, Trigger } from '@protea/protocol';
import type { GatedEvent } from '../events/gate.js';

/**
 * What an offline replay reads from a production data directory
 * (docs/10-architecture/03-event-store-and-bus.md §7): events with their original batches,
 * the recorded tool results, and a config with everything that reaches out turned off.
 */

interface EventRow {
  cursor: number;
  ts: string;
  type: string;
  source: string;
  origin: string;
  level: number;
  trigger: string;
  eff_level: number;
  eff_trigger: string;
  state: string;
  sender_key: string | null;
  sender_role: string | null;
  correlation: string | null;
  text: string;
  meta: string | null;
  tags: string | null;
  batch_id: string | null;
}

export interface ReplayBatch {
  /** The original batch id. */
  id: string;
  level: Level | null;
  events: Array<GatedEvent & { cursor: number }>;
}

function toGated(r: EventRow): GatedEvent & { cursor: number } {
  return {
    cursor: r.cursor,
    ts: r.ts,
    type: r.type,
    source: r.source,
    origin: r.origin as Origin,
    level: r.level as Level,
    trigger: r.trigger as Trigger,
    effLevel: r.eff_level as Level,
    effTrigger: r.eff_trigger as Trigger,
    text: r.text,
    ...(r.sender_key !== null ? { senderKey: r.sender_key } : {}),
    ...(r.sender_role !== null ? { senderRole: r.sender_role as SenderRole } : {}),
    ...(r.correlation !== null ? { correlation: r.correlation } : {}),
    ...(r.meta !== null ? { meta: JSON.parse(r.meta) as Record<string, unknown> } : {}),
    ...(r.tags !== null ? { tags: JSON.parse(r.tags) as string[] } : {}),
  };
}

/** Events in [from, to] grouped by the batch that delivered them, in order; the rest is counted as skipped. */
export function readReplayBatches(dbFile: string, from = 0, to = Number.MAX_SAFE_INTEGER): { batches: ReplayBatch[]; skipped: number } {
  const db = new Database(dbFile, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const rows = db.prepare('SELECT * FROM events WHERE cursor >= ? AND cursor <= ? ORDER BY cursor').all(from, to) as EventRow[];
    const levels = new Map<string, Level>();
    for (const b of db.prepare('SELECT id, level FROM batches').all() as Array<{ id: string; level: number }>) levels.set(b.id, b.level as Level);
    const batches: ReplayBatch[] = [];
    const byId = new Map<string, ReplayBatch>();
    let skipped = 0;
    for (const r of rows) {
      if (r.batch_id === null || r.state === 'pending' || r.state === 'archived') {
        skipped++;
        continue;
      }
      let b = byId.get(r.batch_id);
      if (!b) {
        b = { id: r.batch_id, level: levels.get(r.batch_id) ?? null, events: [] };
        byId.set(r.batch_id, b);
        batches.push(b);
      }
      b.events.push(toGated(r));
    }
    return { batches, skipped };
  } finally {
    db.close();
  }
}

export interface RecordedResult {
  text: string;
  isError: boolean;
}

/** Canonical JSON (sorted keys) for matching a call's input. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('');
  return JSON.stringify(content ?? '');
}

/** tool_use id → its recorded result, and `name:input` → results in order, from the main transcripts. */
export function recordedToolResults(sessionsDir: string): { byId: Map<string, RecordedResult>; byInput: Map<string, RecordedResult[]> } {
  const uses = new Map<string, string>();
  const byId = new Map<string, RecordedResult>();
  const byInput = new Map<string, RecordedResult[]>();
  const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => /^main\.\d+\.jsonl$/.test(f)).sort() : [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(sessionsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec: { t?: string; content?: unknown };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      if (rec.t !== 'msg' || !Array.isArray(rec.content)) continue;
      for (const raw of rec.content as Array<Record<string, unknown>>) {
        if (raw['type'] === 'tool_use') uses.set(String(raw['id']), `${String(raw['name'])}:${stableJson(raw['input'])}`);
        if (raw['type'] === 'tool_result') {
          const id = String(raw['tool_use_id']);
          const r = { text: resultText(raw['content']), isError: raw['is_error'] === true };
          byId.set(id, r);
          const key = uses.get(id);
          if (key) byInput.set(key, [...(byInput.get(key) ?? []), r]);
        }
      }
    }
  }
  return { byId, byInput };
}

/** The newest <runs>/<id>/provider.jsonl, if any run recorded one. */
export function latestRecording(runsDir: string): string | undefined {
  if (!fs.existsSync(runsDir)) return undefined;
  for (const id of fs.readdirSync(runsDir).sort().reverse()) {
    const f = path.join(runsDir, id, 'provider.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/**
 * The replay's config.yaml: the production file with every plugin but console off, no MCP
 * servers, no recording, no budget enforcement, a silent terminal (comments are kept).
 */
export function offlineConfigYaml(prodConfig: string | null, opts: { echo: boolean }): string {
  const doc = prodConfig ? YAML.parseDocument(prodConfig) : new YAML.Document({});
  if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as typeof doc.contents;
  const plugins = (doc.toJS() as { plugins?: Record<string, unknown> } | null)?.plugins ?? {};
  for (const id of new Set([...Object.keys(plugins), 'cron'])) doc.setIn(['plugins', id, 'enabled'], false);
  doc.setIn(['plugins', 'console', 'enabled'], true);
  doc.setIn(['mcp', 'servers'], doc.createNode({}));
  doc.setIn(['observability', 'recordProvider'], 'off');
  doc.setIn(['observability', 'logLevel'], 'silent');
  doc.setIn(['budget', 'enforce'], false);
  if (opts.echo) doc.setIn(['providers', 'default'], 'echo');
  return doc.toString();
}
