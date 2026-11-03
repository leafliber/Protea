import type { BatchEndReason, BatchReason, Level, ModelRole, UsageTotals } from '@protea/protocol';
import type { Db } from './database.js';

export interface BatchRow {
  id: string;
  level: Level;
  reason: BatchReason;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  rounds: number;
  endReason: BatchEndReason | null;
}

export class BatchRepo {
  constructor(private readonly db: Db) {}

  start(b: { id: string; level: Level; reason: BatchReason; sessionId: string; startedAt: string }): void {
    this.db
      .prepare('INSERT INTO batches (id, level, reason, session_id, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(b.id, b.level, b.reason, b.sessionId, b.startedAt);
  }

  setLevel(id: string, level: Level): void {
    this.db.prepare('UPDATE batches SET level = ? WHERE id = ?').run(level, id);
  }

  addRound(id: string): void {
    this.db.prepare('UPDATE batches SET rounds = rounds + 1 WHERE id = ?').run(id);
  }

  end(id: string, endReason: BatchEndReason, endedAt: string): void {
    this.db.prepare('UPDATE batches SET end_reason = ?, ended_at = ? WHERE id = ?').run(endReason, endedAt, id);
  }

  get(id: string): BatchRow | undefined {
    const r = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r['id']),
      level: Number(r['level']) as Level,
      reason: r['reason'] as BatchReason,
      sessionId: String(r['session_id']),
      startedAt: String(r['started_at']),
      endedAt: (r['ended_at'] as string | null) ?? null,
      rounds: Number(r['rounds']),
      endReason: (r['end_reason'] as BatchEndReason | null) ?? null,
    };
  }
}

export interface UsageRecord {
  at: string;
  atMs: number;
  provider: string;
  model: string;
  role: ModelRole;
  sessionId: string;
  batchId?: string;
  level?: Level;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  stopReason?: string;
  fallbackModel?: string;
}

export class UsageRepo {
  constructor(private readonly db: Db) {}

  /** Usage grouped by the level it is attributed to (the batch level, or a fork's level). */
  byLevelSince(sinceMs: number): Map<Level, LevelUsage> {
    const rows = this.db
      .prepare(
        `SELECT level AS l, COALESCE(SUM(cost_usd),0) AS cost,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) AS tokens
         FROM usage WHERE at_ms >= ? AND level IS NOT NULL GROUP BY level`,
      )
      .all(sinceMs) as Array<{ l: Level; cost: number; tokens: number }>;
    return new Map(rows.map((r) => [r.l, { costUsd: r.cost, tokens: r.tokens }]));
  }

  record(u: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage (at, at_ms, provider, model, role, session_id, batch_id, level, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, stop_reason, fallback_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.at,
        u.atMs,
        u.provider,
        u.model,
        u.role,
        u.sessionId,
        u.batchId ?? null,
        u.level ?? null,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.costUsd ?? null,
        u.stopReason ?? null,
        u.fallbackModel ?? null,
      );
  }

  totalsSince(sinceMs: number): UsageTotals {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
                COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
                COALESCE(SUM(cost_usd),0) AS cost
         FROM usage WHERE at_ms >= ?`,
      )
      .get(sinceMs) as { calls: number; i: number; o: number; cr: number; cw: number; cost: number };
    const denom = r.i + r.cr + r.cw;
    return {
      calls: r.calls,
      inputTokens: r.i,
      outputTokens: r.o,
      cacheReadTokens: r.cr,
      cacheWriteTokens: r.cw,
      costUsd: Math.round(r.cost * 1e6) / 1e6,
      cacheHitRatio: r.calls === 0 || denom === 0 ? null : r.cr / denom,
    };
  }
}

export interface LevelUsage {
  costUsd: number;
  tokens: number;
}

/** Small namespaced key-value store for component state (JSON values). */
export interface ToolStat {
  name: string;
  calls: number;
  failures: number;
  totalMs: number;
  lastAt: string;
}

/** Per-tool call counts: rank MCP tools for tool search and report latency. */
export class ToolStatsRepo {
  private cache: Map<string, ToolStat> | null = null;

  constructor(private readonly db: Db) {}

  record(name: string, ms: number, failed: boolean, at: string): void {
    this.db
      .prepare(
        `INSERT INTO tool_stats (name, calls, failures, total_ms, last_at) VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures,
           total_ms = total_ms + excluded.total_ms, last_at = excluded.last_at`,
      )
      .run(name, failed ? 1 : 0, Math.round(ms), at);
    this.cache = null;
  }

  get(name: string): ToolStat | undefined {
    if (!this.cache) {
      const rows = this.db.prepare('SELECT name, calls, failures, total_ms AS totalMs, last_at AS lastAt FROM tool_stats').all() as ToolStat[];
      this.cache = new Map(rows.map((r) => [r.name, r]));
    }
    return this.cache.get(name);
  }

  calls(name: string): number {
    return this.get(name)?.calls ?? 0;
  }
}

export class KvRepo {
  constructor(private readonly db: Db) {}

  get<T = unknown>(ns: string, key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE ns = ? AND key = ?').get(ns, key) as
      | { value: string | null }
      | undefined;
    return r?.value == null ? undefined : (JSON.parse(r.value) as T);
  }

  set(ns: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(ns, key, JSON.stringify(value), new Date().toISOString());
  }

  delete(ns: string, key: string): void {
    this.db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key);
  }

  entries<T = unknown>(ns: string): Array<[string, T]> {
    const rows = this.db.prepare('SELECT key, value FROM kv WHERE ns = ? ORDER BY key').all(ns) as Array<{
      key: string;
      value: string | null;
    }>;
    return rows.filter((r) => r.value != null).map((r) => [r.key, JSON.parse(r.value as string) as T]);
  }
}

export interface KvNamespace {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  entries<T = unknown>(): Array<[string, T]>;
}

export function kvNamespace(repo: KvRepo, ns: string): KvNamespace {
  return {
    get: <T>(key: string) => repo.get<T>(ns, key),
    set: (key, value) => repo.set(ns, key, value),
    delete: (key) => repo.delete(ns, key),
    entries: <T>() => repo.entries<T>(ns),
  };
}

export interface SessionRow {
  id: string;
  kind: string;
  state: string;
  level: Level | null;
  parentId: string | null;
  transcriptPath: string;
  checkpointPath: string | null;
  model: string | null;
  createdAt: string;
  endedAt: string | null;
  summary: string | null;
}

function toSessionRow(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r['id']),
    kind: String(r['kind']),
    state: String(r['state']),
    level: r['level'] == null ? null : (Number(r['level']) as Level),
    parentId: (r['parent_id'] as string | null) ?? null,
    transcriptPath: String(r['transcript_path']),
    checkpointPath: (r['checkpoint_path'] as string | null) ?? null,
    model: (r['model'] as string | null) ?? null,
    createdAt: String(r['created_at']),
    endedAt: (r['ended_at'] as string | null) ?? null,
    summary: (r['summary'] as string | null) ?? null,
  };
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  upsert(s: {
    id: string;
    kind: string;
    state: string;
    transcriptPath: string;
    model?: string;
    createdAt: string;
    level?: Level;
    parentId?: string;
    checkpointPath?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, kind, state, level, parent_id, transcript_path, checkpoint_path, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, transcript_path = excluded.transcript_path, model = excluded.model`,
      )
      .run(
        s.id,
        s.kind,
        s.state,
        s.level ?? null,
        s.parentId ?? null,
        s.transcriptPath,
        s.checkpointPath ?? null,
        s.model ?? null,
        s.createdAt,
      );
  }

  setState(id: string, state: string, end?: { endedAt: string; summary?: string }): void {
    if (end) {
      this.db
        .prepare('UPDATE sessions SET state = ?, ended_at = ?, summary = ? WHERE id = ?')
        .run(state, end.endedAt, end.summary ?? null, id);
    } else {
      this.db.prepare('UPDATE sessions SET state = ? WHERE id = ?').run(state, id);
    }
  }

  get(id: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toSessionRow(r) : undefined;
  }

  /** Sessions of one kind, oldest first, optionally limited to some states. */
  list(kind: string, states?: readonly string[]): SessionRow[] {
    const where = states && states.length > 0 ? ` AND state IN (${states.map(() => '?').join(',')})` : '';
    return (
      this.db
        .prepare(`SELECT * FROM sessions WHERE kind = ?${where} ORDER BY created_at, id`)
        .all(kind, ...(states ?? [])) as Array<Record<string, unknown>>
    ).map(toSessionRow);
  }
}
