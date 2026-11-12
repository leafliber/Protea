import type { MemoryRecall } from '@protea/protocol';
import type { Db } from '../db/database.js';

export type MemoryAccessKind = 'search' | 'hit' | 'read' | 'write';

export interface MemoryAccessEntry {
  /** `main` or a fork id. */
  session: string;
  kind: MemoryAccessKind;
  /** Relative path (hit, read, write). */
  path?: string;
  /** The query (search, hit). */
  query?: string;
  /** Files found (search). */
  hits?: number;
}

/** How long the record of memory use is kept. */
const KEEP_DAYS = 90;

/**
 * What the assistant did with its memory: searches and what they found, files read and
 * written. The consolidation uses it to see which notes are never read and which questions
 * found nothing (its keywords are missing); the console shows it.
 */
export class MemoryAccess {
  constructor(
    private readonly db: Db,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  record(e: MemoryAccessEntry): void {
    this.db
      .prepare('INSERT INTO memory_access (at_ms, session, kind, path, query, hits) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.nowMs(), e.session, e.kind, e.path ?? null, e.query ?? null, e.hits ?? null);
  }

  /** Writes a session made since a moment (the consolidation must have written something). */
  writesBy(session: string, sinceMs = 0): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM memory_access WHERE session = ? AND kind = 'write' AND at_ms >= ?").get(session, sinceMs) as { n: number }).n;
  }

  /**
   * The main session's use of memory over the last `days`: each file it read or found, and the
   * searches that found nothing. Forks are left out: the consolidation reads everything.
   */
  recall(days: number, notes: readonly string[]): MemoryRecall {
    const since = this.nowMs() - days * 86_400_000;
    const used = this.db
      .prepare(
        `SELECT path, SUM(kind = 'read') AS reads, SUM(kind = 'hit') AS hits, MAX(at_ms) AS lastMs
         FROM memory_access WHERE session = 'main' AND at_ms >= ? AND path IS NOT NULL AND kind IN ('read', 'hit')
         GROUP BY path ORDER BY lastMs DESC`,
      )
      .all(since) as Array<{ path: string; reads: number; hits: number; lastMs: number }>;
    const misses = this.db
      .prepare("SELECT query, MAX(at_ms) AS lastMs, COUNT(*) AS times FROM memory_access WHERE session = 'main' AND kind = 'search' AND hits = 0 AND at_ms >= ? GROUP BY query ORDER BY lastMs DESC LIMIT 30")
      .all(since) as Array<{ query: string; lastMs: number; times: number }>;
    const searches = (this.db.prepare("SELECT COUNT(*) AS n FROM memory_access WHERE session = 'main' AND kind = 'search' AND at_ms >= ?").get(since) as { n: number }).n;
    const touched = new Set(used.map((u) => u.path));
    return {
      days,
      searches,
      used: used.map((u) => ({ path: u.path, reads: u.reads, hits: u.hits, last: new Date(u.lastMs).toISOString() })),
      unused: notes.filter((n) => !touched.has(n)),
      misses: misses.map((m) => ({ query: m.query, times: m.times, last: new Date(m.lastMs).toISOString() })),
    };
  }

  /** Forget entries older than the retention. */
  prune(): number {
    return this.db.prepare('DELETE FROM memory_access WHERE at_ms < ?').run(this.nowMs() - KEEP_DAYS * 86_400_000).changes;
  }
}
