import fs from 'node:fs';
import path from 'node:path';
import { CHAT_MESSAGE_EVENT, type BatchEndReason, type BlobImageRef, type ChatBatch, type ChatHistoryResponse, type ChatItem, type EventState } from '@protea/protocol';
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
  platform: string;
  blobs?: string | null;
}

/** Where the console and the conversation were separated: everything up to here came from the old console chat. */
interface ChatSplit {
  cursor: number;
  outputId: number;
}

const MODEL_ERROR_PREFIX = /^Model call failed for batch \S+ \([^)]*\): /;
/** Before the split the web chat was the console plugin. */
const LEGACY_PLATFORM = 'webchat';
const CONVERSATION_CHANNELS = ['chat', 'approvals'];

/** `before` tokens: `<at>|<0 message, 1 output>|<cursor or id>`. */
function parseBefore(token: string | undefined): [string, number, number] | null {
  if (!token) return null;
  const m = /^(.+)\|([01])\|(\d+)$/.exec(token);
  return m ? [m[1] as string, Number(m[2]), Number(m[3])] : null;
}

/**
 * What plugins and chat platforms sent out (`plugin.output`, e.g. `chat_send`), kept so a
 * conversation survives a reload (docs/30-specs/06-storage-schema.md, `outputs`).
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
   * Once per data volume: remember where the old console chat ends, so its messages keep showing
   * as the web chat without rewriting the event log. Returns the boundary.
   */
  ensureChatSplit(): ChatSplit {
    const found = this.split();
    if (found) return found;
    const cursor = (this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS n FROM events').get() as { n: number }).n;
    const outputId = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM outputs').get() as { n: number }).n;
    const value: ChatSplit = { cursor, outputId };
    this.db.prepare("INSERT OR REPLACE INTO kv (ns, key, value, updated_at) VALUES ('core', 'chat.split', ?, ?)").run(JSON.stringify(value), new Date().toISOString());
    return value;
  }

  private split(): ChatSplit | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE ns = 'core' AND key = 'chat.split'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as ChatSplit) : null;
  }

  /** The platform of the owner's most recent chat message. */
  lastChatPlatform(): string | null {
    const row = this.db.prepare(`SELECT source FROM events WHERE type = '${CHAT_MESSAGE_EVENT}' AND sender_role = 'owner' ORDER BY cursor DESC LIMIT 1`).get() as { source: string } | undefined;
    return row?.source ?? null;
  }

  /** What was sent out during a batch, oldest first. */
  forBatch(batchId: string): OutputRecord[] {
    const rows = this.db.prepare('SELECT id, at, plugin, channel, text, session_id, batch_id FROM outputs WHERE batch_id = ? ORDER BY at, id').all(batchId) as Array<{ id: number; at: string; plugin: string; channel: string | null; text: string; session_id: string | null; batch_id: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      plugin: r.plugin,
      text: r.text,
      ...(r.channel !== null ? { channel: r.channel } : {}),
      ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
      ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
    }));
  }

  /**
   * One conversation (a platform, or `all`), newest page first: the owner's `chat.message`
   * events and what `chat_send` sent there, merged by time. Items come back oldest first.
   * The old console chat counts as the web chat.
   */
  chat(q: { before?: string; limit?: number; platform?: string } = {}): ChatHistoryResponse {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const before = parseBefore(q.before);
    const platform = q.platform ?? LEGACY_PLATFORM;
    const all = platform === 'all';
    const split = all || platform === LEGACY_PLATFORM ? (this.split() ?? { cursor: 0, outputId: 0 }) : null;
    const channels = CONVERSATION_CHANNELS.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT received_at AS at, 0 AS k, cursor AS id, text, state, sender_key AS who, NULL AS channel, batch_id, source AS platform, blobs
             FROM events WHERE type = '${CHAT_MESSAGE_EVENT}' ${all ? '' : 'AND source = ?'}
           UNION ALL
           SELECT at, 1 AS k, id, text, NULL AS state, NULL AS who, channel, batch_id, plugin AS platform, NULL AS blobs
             FROM outputs WHERE channel IN (${channels}) ${all ? '' : 'AND plugin = ?'}
           ${split ? `UNION ALL
           SELECT received_at AS at, 0 AS k, cursor AS id, text, state, sender_key AS who, NULL AS channel, batch_id, '${LEGACY_PLATFORM}' AS platform, NULL AS blobs
             FROM events WHERE source = 'console' AND type = 'console.message' AND cursor <= ?
           UNION ALL
           SELECT at, 1 AS k, id, text, NULL AS state, NULL AS who, channel, batch_id, '${LEGACY_PLATFORM}' AS platform, NULL AS blobs
             FROM outputs WHERE plugin = 'console' AND id <= ?` : ''}
         ) ${before ? 'WHERE (at, k, id) < (?, ?, ?)' : ''}
         ORDER BY at DESC, k DESC, id DESC LIMIT ?`,
      )
      .all(
        ...(all ? [] : [platform]),
        ...CONVERSATION_CHANNELS,
        ...(all ? [] : [platform]),
        ...(split ? [split.cursor, split.outputId] : []),
        ...(before ?? []),
        limit + 1,
      ) as ChatRow[];
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
    const replied = this.db.prepare("SELECT 1 FROM outputs WHERE batch_id = ? AND (channel = 'chat' OR (plugin = 'console' AND channel = 'console')) LIMIT 1");
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

/** The images among an event's stored attachments. */
function eventImages(blobs: string | null | undefined): { images?: BlobImageRef[] } {
  if (!blobs) return {};
  const images = (JSON.parse(blobs) as BlobImageRef[]).filter((b) => b.mime.startsWith('image/')).map((b) => ({ handle: b.handle, mime: b.mime }));
  return images.length > 0 ? { images } : {};
}

function toItem(r: ChatRow): ChatItem {
  if (r.k === 0) {
    return {
      key: `e${r.id}`,
      kind: 'owner',
      platform: r.platform,
      at: r.at,
      text: r.text,
      cursor: r.id,
      state: r.state as EventState,
      ...(r.who !== null ? { sender: r.who } : {}),
      ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
      ...eventImages(r.blobs),
    };
  }
  return {
    key: `o${r.id}`,
    kind: r.channel === null || r.channel === 'console' || r.channel === 'chat' ? 'reply' : 'notice',
    platform: r.platform,
    at: r.at,
    text: r.text,
    ...(r.channel !== null ? { channel: r.channel } : {}),
    ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
  };
}
