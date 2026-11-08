import fs from 'node:fs';
import path from 'node:path';
import type { BatchEndReason, ChatBatch, ChatHistoryResponse, ChatItem, EventState } from '@protea/protocol';
import type { Db } from '../db/database.js';

export interface OutputRecord {
  id: number;
  at: string;
  plugin: string;
  channel?: string;
  text: string;
  sessionId?: string;
  batchId?: string;
}

interface ChatRow {
  at: string;
  k: number;
  id: number;
  text: string;
  state: string | null;
  who: string | null;
  channel: string | null;
  batch_id: string | null;
}

const MODEL_ERROR_PREFIX = /^Model call failed for batch \S+ \([^)]*\): /;

/** `before` tokens: `<at>|<0 message, 1 output>|<cursor or id>`. */
function parseBefore(token: string | undefined): [string, number, number] | null {
  if (!token) return null;
  const m = /^(.+)\|([01])\|(\d+)$/.exec(token);
  return m ? [m[1] as string, Number(m[2]), Number(m[3])] : null;
}

/**
 * What plugins sent to the operator (`plugin.output`, e.g. `con_send` replies), kept so the
 * console conversation survives a reload (docs/30-specs/06-storage-schema.md, `outputs`).
 */
export class OutputLog {
  constructor(private readonly db: Db) {}

  record(o: Omit<OutputRecord, 'id'>): OutputRecord {
    const info = this.db
      .prepare('INSERT INTO outputs (at, plugin, channel, text, session_id, batch_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(o.at, o.plugin, o.channel ?? null, o.text, o.sessionId ?? null, o.batchId ?? null);
    return { id: Number(info.lastInsertRowid), ...o };
  }

  /**
   * The console conversation, newest page first: console messages (events of type
   * `console.message`) and console outputs, merged by time. Items come back oldest first.
   */
  chat(q: { before?: string; limit?: number } = {}): ChatHistoryResponse {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const before = parseBefore(q.before);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT received_at AS at, 0 AS k, cursor AS id, text, state, sender_key AS who, NULL AS channel, batch_id
             FROM events WHERE source = 'console' AND type = 'console.message'
           UNION ALL
           SELECT at, 1 AS k, id, text, NULL AS state, NULL AS who, channel, batch_id
             FROM outputs WHERE plugin = 'console'
         ) ${before ? 'WHERE (at, k, id) < (?, ?, ?)' : ''}
         ORDER BY at DESC, k DESC, id DESC LIMIT ?`,
      )
      .all(...(before ?? []), limit + 1) as ChatRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items = page.reverse().map(toItem);
    const ids = [...new Set(items.map((i) => i.batchId).filter((b): b is string => b !== undefined))];
    return { items, batches: this.batches(ids), before: more && last ? `${last.at}|${last.k}|${last.id}` : null };
  }

  /**
   * Once per data volume: replies sent before the `outputs` table existed (migration 6) are
   * recovered from the main transcripts (`con_send` calls whose result was not an error), so
   * the conversation shows them too. Returns how many were added; later calls return 0.
   */
  backfillFromTranscripts(sessionsDir: string): number {
    const done = this.db.prepare("SELECT 1 FROM kv WHERE ns = 'core' AND key = 'outputs.backfilled'").get();
    if (done) return 0;
    const applied = this.db.prepare('SELECT applied_at FROM schema_version WHERE version = 6').get() as { applied_at: string } | undefined;
    const cutoff = applied?.applied_at ?? new Date().toISOString();
    const found: Array<Omit<OutputRecord, 'id'>> = [];
    const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => /^main\.\d+\.jsonl$/.test(f)).sort() : [];
    for (const f of files) {
      const sent = new Map<string, Omit<OutputRecord, 'id'>>();
      const failed = new Set<string>();
      for (const line of fs.readFileSync(path.join(sessionsDir, f), 'utf8').split('\n')) {
        let rec: { t?: string; role?: string; at?: string; batch?: string; content?: Array<Record<string, unknown>> };
        try {
          rec = JSON.parse(line) as typeof rec;
        } catch {
          continue;
        }
        if (rec.t !== 'msg' || !Array.isArray(rec.content) || typeof rec.at !== 'string' || rec.at >= cutoff) continue;
        for (const b of rec.content) {
          if (rec.role === 'assistant' && b['type'] === 'tool_use' && b['name'] === 'con_send' && typeof b['id'] === 'string') {
            const text = (b['input'] as { text?: unknown } | undefined)?.text;
            if (typeof text === 'string' && text)
              sent.set(b['id'], { at: rec.at, plugin: 'console', channel: 'console', text, sessionId: 'main', ...(rec.batch ? { batchId: rec.batch } : {}) });
          } else if (rec.role === 'user' && b['type'] === 'tool_result' && b['is_error'] === true && typeof b['tool_use_id'] === 'string') {
            failed.add(b['tool_use_id']);
          }
        }
      }
      for (const [id, o] of sent) if (!failed.has(id)) found.push(o);
    }
    this.db.transaction(() => {
      for (const o of found) this.record(o);
      this.db.prepare("INSERT OR REPLACE INTO kv (ns, key, value, updated_at) VALUES ('core', 'outputs.backfilled', ?, ?)").run(JSON.stringify(found.length), new Date().toISOString());
    })();
    return found.length;
  }

  /** How these batches went, for the chat (unknown ids are left out). */
  batches(ids: readonly string[]): ChatBatch[] {
    if (ids.length === 0) return [];
    const getBatch = this.db.prepare('SELECT id, end_reason, ended_at FROM batches WHERE id = ?');
    const sources = this.db.prepare('SELECT DISTINCT source FROM events WHERE batch_id = ? ORDER BY source');
    const replied = this.db.prepare("SELECT 1 FROM outputs WHERE batch_id = ? AND plugin = 'console' AND channel = 'console' LIMIT 1");
    const error = this.db.prepare(
      `SELECT text FROM events WHERE type = 'model.error' AND (json_extract(meta, '$.batchId') = ? OR text LIKE ?) ORDER BY cursor DESC LIMIT 1`,
    );
    const out: ChatBatch[] = [];
    for (const id of ids) {
      const b = getBatch.get(id) as { id: string; end_reason: string | null; ended_at: string | null } | undefined;
      if (!b) continue;
      const c: ChatBatch = {
        id,
        endReason: (b.end_reason as BatchEndReason | null) ?? null,
        endedAt: b.ended_at ?? null,
        sources: (sources.all(id) as Array<{ source: string }>).map((r) => r.source),
        replied: replied.get(id) !== undefined,
      };
      if (b.end_reason === 'model_error') {
        const e = error.get(id, `Model call failed for batch ${id} %`) as { text: string } | undefined;
        if (e) c.error = e.text.replace(MODEL_ERROR_PREFIX, '');
      }
      out.push(c);
    }
    return out;
  }
}

function toItem(r: ChatRow): ChatItem {
  if (r.k === 0) {
    return {
      key: `e${r.id}`,
      kind: 'owner',
      at: r.at,
      text: r.text,
      cursor: r.id,
      state: r.state as EventState,
      ...(r.who !== null ? { sender: r.who } : {}),
      ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
    };
  }
  return {
    key: `o${r.id}`,
    kind: r.channel === null || r.channel === 'console' ? 'reply' : 'notice',
    at: r.at,
    text: r.text,
    ...(r.channel !== null ? { channel: r.channel } : {}),
    ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
  };
}
