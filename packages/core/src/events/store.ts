import {
  LEVELS,
  type EventEnvelope,
  type EventState,
  type Level,
  type Origin,
  type SenderRole,
  type TerminalOutcome,
  type Trigger,
} from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { Db } from '../db/database.js';
import type { Clock } from '../util/time.js';
import type { GatedEvent } from './gate.js';

interface EventRow {
  cursor: number;
  run: string;
  received_at: string;
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
  dedupe_key: string | null;
  correlation: string | null;
  ephemeral: number;
  expires_at: string | null;
  text: string;
  meta: string | null;
  tags: string | null;
  blobs: string | null;
  batch_id: string | null;
}

function toEnvelope(r: EventRow): EventEnvelope {
  const e: EventEnvelope = {
    cursor: r.cursor,
    run: r.run,
    receivedAt: r.received_at,
    ts: r.ts,
    type: r.type,
    source: r.source,
    origin: r.origin as Origin,
    level: r.level as Level,
    trigger: r.trigger as Trigger,
    effLevel: r.eff_level as Level,
    effTrigger: r.eff_trigger as Trigger,
    state: r.state as EventState,
    text: r.text,
  };
  if (r.sender_key !== null) e.senderKey = r.sender_key;
  if (r.sender_role !== null) e.senderRole = r.sender_role as SenderRole;
  if (r.dedupe_key !== null) e.dedupeKey = r.dedupe_key;
  if (r.correlation !== null) e.correlation = r.correlation;
  if (r.ephemeral) e.ephemeral = true;
  if (r.expires_at !== null) e.expiresAt = r.expires_at;
  if (r.meta !== null) e.meta = JSON.parse(r.meta) as Record<string, unknown>;
  if (r.tags !== null) e.tags = JSON.parse(r.tags) as string[];
  if (r.blobs !== null) e.blobs = JSON.parse(r.blobs) as EventEnvelope['blobs'] & object;
  if (r.batch_id !== null) e.batchId = r.batch_id;
  return e;
}

export interface AppendResult {
  envelope: EventEnvelope;
  deduped: boolean;
}

export interface EventQuery {
  sinceCursor?: number;
  untilCursor?: number;
  source?: string;
  type?: string;
  states?: EventState[];
  maxLevel?: Level;
  limit?: number;
  order?: 'asc' | 'desc';
}

const NON_TERMINAL: EventState[] = ['pending', 'archived', 'delivering'];

/**
 * The event log: the single source of truth for inputs and their delivery state
 * (docs/10-architecture/03-event-store-and-bus.md). Emits `event.stored` and
 * `event.settled` on the bus after the corresponding write commits.
 */
export class EventStore {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly opts: { runId: string; clock: Clock },
  ) {}

  append(ev: GatedEvent): AppendResult {
    const result = this.db.transaction((): AppendResult => {
      if (ev.dedupeKey !== undefined) {
        const existing = this.db
          .prepare('SELECT * FROM events WHERE source = ? AND dedupe_key = ?')
          .get(ev.source, ev.dedupeKey) as EventRow | undefined;
        if (existing) return { envelope: toEnvelope(existing), deduped: true };
      }
      const state: EventState = ev.effTrigger === 'store' ? 'archived' : 'pending';
      const info = this.db
        .prepare(
          `INSERT INTO events (run, received_at, ts, type, source, origin, level, trigger, eff_level, eff_trigger, state,
             sender_key, sender_role, dedupe_key, correlation, ephemeral, expires_at, text, meta, tags, blobs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.opts.runId,
          new Date(this.opts.clock.now()).toISOString(),
          ev.ts,
          ev.type,
          ev.source,
          ev.origin,
          ev.level,
          ev.trigger,
          ev.effLevel,
          ev.effTrigger,
          state,
          ev.senderKey ?? null,
          ev.senderRole ?? null,
          ev.dedupeKey ?? null,
          ev.correlation ?? null,
          ev.ephemeral ? 1 : 0,
          ev.expiresAt ?? null,
          ev.text,
          ev.meta === undefined ? null : JSON.stringify(ev.meta),
          ev.tags === undefined ? null : JSON.stringify(ev.tags),
          ev.blobs === undefined ? null : JSON.stringify(ev.blobs),
        );
      const row = this.db.prepare('SELECT * FROM events WHERE cursor = ?').get(info.lastInsertRowid) as EventRow;
      return { envelope: toEnvelope(row), deduped: false };
    })();
    if (!result.deduped) this.bus.emit('event.stored', result.envelope);
    return result;
  }

  get(cursor: number): EventEnvelope | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE cursor = ?').get(cursor) as EventRow | undefined;
    return r ? toEnvelope(r) : undefined;
  }

  query(q: EventQuery = {}): EventEnvelope[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.sinceCursor !== undefined) (where.push('cursor > ?'), args.push(q.sinceCursor));
    if (q.untilCursor !== undefined) (where.push('cursor <= ?'), args.push(q.untilCursor));
    if (q.source !== undefined) (where.push('source = ?'), args.push(q.source));
    if (q.type !== undefined) (where.push('type = ?'), args.push(q.type));
    if (q.maxLevel !== undefined) (where.push('eff_level <= ?'), args.push(q.maxLevel));
    if (q.states && q.states.length > 0) {
      where.push(`state IN (${q.states.map(() => '?').join(',')})`);
      args.push(...q.states);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY cursor ${q.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    args.push(Math.min(Math.max(q.limit ?? 100, 1), 1000));
    return (this.db.prepare(sql).all(...args) as EventRow[]).map(toEnvelope);
  }

  /** Pending events in cursor order. */
  pending(): EventEnvelope[] {
    return (this.db.prepare("SELECT * FROM events WHERE state = 'pending' ORDER BY cursor").all() as EventRow[]).map(
      toEnvelope,
    );
  }

  inState(state: EventState): EventEnvelope[] {
    return (this.db.prepare('SELECT * FROM events WHERE state = ? ORDER BY cursor').all(state) as EventRow[]).map(
      toEnvelope,
    );
  }

  pendingCounts(): Record<Level, number> {
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
    const rows = this.db
      .prepare("SELECT eff_level AS l, COUNT(*) AS n FROM events WHERE state = 'pending' GROUP BY eff_level")
      .all() as Array<{ l: Level; n: number }>;
    for (const r of rows) counts[r.l] = r.n;
    return counts;
  }

  markDelivering(cursors: readonly number[], batchId: string): void {
    const stmt = this.db.prepare("UPDATE events SET state = 'delivering', batch_id = ? WHERE cursor = ? AND state = 'pending'");
    this.db.transaction(() => {
      for (const c of cursors) stmt.run(batchId, c);
    })();
  }

  /**
   * Change how a not-yet-delivered event is scheduled (aging, `events_promote`). An archived
   * event becomes pending. The level never changes. Returns the updated envelope, or
   * undefined if the event is gone or already in flight/terminal.
   */
  promote(cursor: number, trigger: Trigger): EventEnvelope | undefined {
    const info = this.db
      .prepare("UPDATE events SET eff_trigger = ?, state = 'pending' WHERE cursor = ? AND state IN ('pending','archived')")
      .run(trigger, cursor);
    if (info.changes === 0) return undefined;
    const e = this.get(cursor);
    if (e) this.bus.emit('event.promoted', e);
    return e;
  }

  /**
   * Withdraw an event that has not reached the model yet (control API). Returns the settled
   * envelope, or undefined when it is in flight, already settled or unknown.
   */
  withdraw(cursor: number): EventEnvelope | undefined {
    const e = this.get(cursor);
    if (!e || (e.state !== 'pending' && e.state !== 'archived')) return undefined;
    if (this.settle([cursor], 'withdrawn').length === 0) return undefined;
    return this.get(cursor);
  }

  revertToPending(cursors: readonly number[]): void {
    const stmt = this.db.prepare("UPDATE events SET state = 'pending', batch_id = NULL WHERE cursor = ? AND state = 'delivering'");
    this.db.transaction(() => {
      for (const c of cursors) stmt.run(c);
    })();
  }

  /**
   * Record a terminal outcome for non-terminal events (invariant I-2: exactly one per event).
   * Returns the cursors that were actually settled.
   */
  settle(
    cursors: readonly number[],
    outcome: TerminalOutcome,
    ctx: { batchId?: string; sessionId?: string } = {},
  ): number[] {
    const at = new Date(this.opts.clock.now()).toISOString();
    const settled: Array<{ cursor: number; source: string }> = [];
    const select = this.db.prepare(
      `SELECT cursor, source FROM events WHERE cursor = ? AND state IN (${NON_TERMINAL.map(() => '?').join(',')})`,
    );
    const update = this.db.prepare('UPDATE events SET state = ?, batch_id = COALESCE(?, batch_id) WHERE cursor = ?');
    const insert = this.db.prepare('INSERT INTO deliveries (cursor, outcome, batch_id, session_id, at) VALUES (?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const c of cursors) {
        const row = select.get(c, ...NON_TERMINAL) as { cursor: number; source: string } | undefined;
        if (!row) continue;
        update.run(outcome, ctx.batchId ?? null, c);
        insert.run(c, outcome, ctx.batchId ?? null, ctx.sessionId ?? null, at);
        settled.push(row);
      }
    })();
    if (settled.length > 0) {
      const data: { cursors: number[]; outcome: TerminalOutcome; events: typeof settled; batchId?: string } = {
        cursors: settled.map((s) => s.cursor),
        outcome,
        events: settled,
      };
      if (ctx.batchId !== undefined) data.batchId = ctx.batchId;
      this.bus.emit('event.settled', data);
    }
    return settled.map((s) => s.cursor);
  }

  deliveryOf(cursor: number): { outcome: TerminalOutcome; batchId: string | null; at: string } | undefined {
    const r = this.db.prepare('SELECT outcome, batch_id, at FROM deliveries WHERE cursor = ?').get(cursor) as
      | { outcome: TerminalOutcome; batch_id: string | null; at: string }
      | undefined;
    return r ? { outcome: r.outcome, batchId: r.batch_id, at: r.at } : undefined;
  }
}
