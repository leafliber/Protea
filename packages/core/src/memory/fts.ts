import type { Db } from '../db/database.js';
import { globToRegExp } from '../util/glob.js';
import { MAX_MEMORY_FILE_BYTES, MEMORY_ROOT, type MemoryStore } from './store.js';

export interface MemoryHit {
  path: string;
  snippet: string;
}

/** Shortest term the trigram index can match; shorter ones are filtered by substring. */
const MIN_FTS_CHARS = 3;
const SNIPPET_RADIUS = 60;

function isIndexable(rel: string): boolean {
  return !rel.startsWith('blobs/') && !rel.split('/').some((p) => p.startsWith('.'));
}

/** Split a query into terms; "double quotes" keep a phrase together. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of query.matchAll(re)) {
    const t = (m[1] ?? m[2] ?? '').trim();
    if (t) terms.push(t);
  }
  return terms;
}

function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function manualSnippet(body: string, term: string): string {
  const flat = body.replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(flat.length, at + term.length + SNIPPET_RADIUS);
  return `${from > 0 ? '…' : ''}${flat.slice(from, at)}[${flat.slice(at, at + term.length)}]${flat.slice(at + term.length, to)}${to < flat.length ? '…' : ''}`;
}

/** Turn `paths` filters (`notes`, `/memories/journal/`, `notes/*.md`) into a predicate on relative paths. */
function pathFilter(paths: readonly string[] | undefined): (rel: string) => boolean {
  if (!paths || paths.length === 0) return () => true;
  const tests = paths.map((raw) => {
    let p = raw.trim();
    if (p === MEMORY_ROOT || p.startsWith(`${MEMORY_ROOT}/`)) p = p.slice(MEMORY_ROOT.length);
    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (p === '') return () => true;
    if (/[*?]/.test(p)) {
      const re = globToRegExp(p);
      return (rel: string) => re.test(rel);
    }
    return (rel: string) => rel === p || rel.startsWith(`${p}/`);
  });
  return (rel) => tests.some((t) => t(rel));
}

/**
 * Full-text index over the memory directory (SQLite FTS5, trigram tokenizer so CJK text
 * matches without word segmentation). Kept in step incrementally: the memory tool reports
 * its writes, the directory watcher reports the owner's edits, and `sync()` catches up at start.
 */
export class MemoryIndex {
  constructor(
    private readonly db: Db,
    private readonly store: MemoryStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Bring the index in line with the directory; returns how many files changed. */
  sync(): { indexed: number; removed: number } {
    const files = new Map(this.store.listFiles().filter((f) => isIndexable(f.path)).map((f) => [f.path, f]));
    const rows = this.db.prepare('SELECT path, mtime_ms AS mtimeMs, size FROM memory_files').all() as Array<{ path: string; mtimeMs: number; size: number }>;
    const known = new Map(rows.map((r) => [r.path, r]));
    let indexed = 0;
    let removed = 0;
    this.db.transaction(() => {
      for (const [p, f] of files) {
        const k = known.get(p);
        if (k && k.mtimeMs === f.mtimeMs && k.size === f.size) continue;
        if (this.indexOne(p, f.mtimeMs, f.size)) indexed++;
      }
      for (const p of known.keys()) {
        if (files.has(p)) continue;
        this.removeOne(p);
        removed++;
      }
    })();
    return { indexed, removed };
  }

  /** Re-read the given relative paths (written, deleted or renamed). */
  update(paths: readonly string[]): void {
    const listed = new Map(this.store.listFiles().map((f) => [f.path, f]));
    this.db.transaction(() => {
      for (const p of new Set(paths)) {
        const f = listed.get(p);
        if (f && isIndexable(p)) this.indexOne(p, f.mtimeMs, f.size);
        else this.removeOne(p);
      }
    })();
  }

  private indexOne(rel: string, mtimeMs: number, size: number): boolean {
    this.removeOne(rel);
    if (size > MAX_MEMORY_FILE_BYTES) return false;
    const body = this.store.readText(rel);
    if (body === undefined || body.includes('\0')) return false;
    this.db.prepare('INSERT INTO memory_fts (path, body) VALUES (?, ?)').run(rel, body);
    this.db.prepare('INSERT INTO memory_files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)').run(rel, mtimeMs, size, this.now());
    return true;
  }

  private removeOne(rel: string): void {
    this.db.prepare('DELETE FROM memory_fts WHERE path = ?').run(rel);
    this.db.prepare('DELETE FROM memory_files WHERE path = ?').run(rel);
  }

  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_files').get() as { n: number }).n;
  }

  search(query: string, opts: { paths?: readonly string[]; limit?: number } = {}): MemoryHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const limit = opts.limit ?? 10;
    const long = terms.filter((t) => [...t].length >= MIN_FTS_CHARS);
    const short = terms.filter((t) => [...t].length < MIN_FTS_CHARS);
    const inScope = pathFilter(opts.paths);
    let rows: Array<{ path: string; body: string; snip?: string }>;
    if (long.length > 0) {
      rows = this.db
        .prepare(
          `SELECT path, body, snippet(memory_fts, 1, '[', ']', '…', 16) AS snip
           FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT 500`,
        )
        .all(long.map(ftsPhrase).join(' AND ')) as Array<{ path: string; body: string; snip: string }>;
    } else {
      rows = this.db
        .prepare('SELECT f.path AS path, f.body AS body FROM memory_fts f JOIN memory_files m ON m.path = f.path ORDER BY m.mtime_ms DESC')
        .all() as Array<{ path: string; body: string }>;
    }
    const hits: MemoryHit[] = [];
    for (const r of rows) {
      if (!inScope(r.path)) continue;
      const lower = r.body.toLowerCase();
      if (!short.every((t) => lower.includes(t.toLowerCase()))) continue;
      const snippet = r.snip ?? manualSnippet(r.body, short[0] ?? long[0] ?? '');
      hits.push({ path: `${MEMORY_ROOT}/${r.path}`, snippet: snippet.replace(/\s+/g, ' ').trim() });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
