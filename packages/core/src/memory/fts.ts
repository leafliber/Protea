import type { Db } from '../db/database.js';
import { globToRegExp } from '../util/glob.js';
import { parseNote } from './frontmatter.js';
import { MAX_MEMORY_FILE_BYTES, MEMORY_ROOT, type MemoryStore } from './store.js';

export interface MemoryHit {
  path: string;
  snippet: string;
  /** One line about the file, for notes. */
  summary?: string;
}

/** Which layer of memory to look in: stable notes, the record of what happened, or both. */
export type MemoryScope = 'notes' | 'raw' | 'all';

/** The record of what happened: kept for review and normally not recalled. */
const RAW_PREFIXES = ['journal/', 'handoff/', 'raw/'] as const;
/** bm25 column weights: path, summary, keywords, body, body_text. */
const BM25_WEIGHTS = '0.0, 4.0, 4.0, 1.0, 0.0';
const SNIPPET_RADIUS = 60;
const RECENCY_HALF_LIFE_DAYS = 180;
/** Ranking only leans on age and layer: text relevance decides. */
const RECENCY_WEIGHT = 0.15;
const RAW_LAYER_FACTOR = 0.7;

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export function isRawPath(rel: string): boolean {
  return RAW_PREFIXES.some((p) => rel.startsWith(p));
}

function isIndexable(rel: string): boolean {
  return !rel.startsWith('blobs/') && !rel.split('/').some((p) => p.startsWith('.'));
}

/**
 * Prepare text for the index: runs of CJK characters become overlapping pairs, because the
 * tokenizer would otherwise treat a whole run as one word. Common two-character words then
 * match as ordinary ranked terms, without an embedding model or a dictionary.
 */
export function segmentText(text: string): string {
  return text.replace(CJK_RUN, (run) => {
    const chars = Array.from(run);
    if (chars.length === 1) return ` ${run} `;
    const pairs: string[] = [];
    for (let i = 0; i + 1 < chars.length; i++) pairs.push(`${chars[i] as string}${chars[i + 1] as string}`);
    return ` ${pairs.join(' ')} `;
  });
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

/** The FTS5 expression for a term; null when the index cannot answer it (a lone CJK character). */
function ftsTerm(term: string): string | null {
  for (const run of term.matchAll(CJK_RUN)) if (Array.from(run[0]).length === 1) return null;
  const tokens = segmentText(term).trim().replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(tokens)) return null;
  const phrase = `"${tokens.replace(/"/g, '""')}"`;
  return /[A-Za-z0-9]$/.test(term) ? `${phrase} *` : phrase;
}

function scopeSql(scope: MemoryScope, column: string): string {
  if (scope === 'all') return '';
  const raw = RAW_PREFIXES.map((p) => `${column} LIKE '${p}%'`).join(' OR ');
  return scope === 'raw' ? ` AND (${raw})` : ` AND NOT (${raw})`;
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
 * Full-text index over the memory directory (SQLite FTS5). Text goes through `segmentText`
 * first, so CJK matches without word segmentation; the summary and keywords of a note count
 * for more than its body. Kept in step incrementally: the memory tool reports its writes,
 * the directory watcher reports the owner's edits, and `sync()` catches up at start.
 */
export class MemoryIndex {
  constructor(
    private readonly db: Db,
    private readonly store: MemoryStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly nowMs: () => number = () => Date.now(),
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
    const text = this.store.readText(rel);
    if (text === undefined || text.includes('\0')) return false;
    const note = parseNote(text);
    this.db
      .prepare('INSERT INTO memory_fts (path, summary, keywords, body, body_text) VALUES (?, ?, ?, ?, ?)')
      .run(rel, segmentText(note.summary), segmentText(note.keywords.join(' ')), segmentText(note.body), text);
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

  /** Matching files, best first. Without a `scope` every layer is searched. */
  search(query: string, opts: { paths?: readonly string[]; limit?: number; scope?: MemoryScope } = {}): MemoryHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const limit = opts.limit ?? 10;
    const scope = opts.scope ?? 'all';
    const ranked: string[] = [];
    const indexedTerms: string[] = [];
    const unindexedTerms: string[] = [];
    for (const t of terms) {
      const expr = ftsTerm(t);
      if (expr) {
        ranked.push(expr);
        indexedTerms.push(t);
      } else {
        unindexedTerms.push(t);
      }
    }
    const inPaths = pathFilter(opts.paths);
    let rows: Array<{ path: string; body: string; score: number }>;
    if (ranked.length > 0) {
      rows = this.db
        .prepare(`SELECT path, body_text AS body, bm25(memory_fts, ${BM25_WEIGHTS}) AS score FROM memory_fts WHERE memory_fts MATCH ?${scopeSql(scope, 'path')} ORDER BY score LIMIT 500`)
        .all(ranked.join(' AND ')) as Array<{ path: string; body: string; score: number }>;
    } else {
      rows = this.db
        .prepare(`SELECT f.path AS path, f.body_text AS body, 0 AS score FROM memory_fts f JOIN memory_files m ON m.path = f.path WHERE 1 = 1${scopeSql(scope, 'f.path')} ORDER BY m.mtime_ms DESC`)
        .all() as Array<{ path: string; body: string; score: number }>;
    }
    const matching = rows.filter((r) => {
      if (!inPaths(r.path)) return false;
      const lower = r.body.toLowerCase();
      return unindexedTerms.every((t) => lower.includes(t.toLowerCase()));
    });
    const snippetTerm = indexedTerms[0] ?? unindexedTerms[0] ?? '';
    return this.ranked(matching, ranked.length > 0)
      .slice(0, limit)
      .map((r) => {
        const summary = isRawPath(r.path) ? '' : parseNote(r.body).summary;
        return {
          path: `${MEMORY_ROOT}/${r.path}`,
          snippet: manualSnippet(r.body, snippetTerm).replace(/\s+/g, ' ').trim(),
          ...(summary ? { summary } : {}),
        };
      });
  }

  /** bm25 order, adjusted a little for layer and age. Rows without a score keep their order. */
  private ranked<R extends { path: string; score: number }>(rows: R[], scored: boolean): R[] {
    if (!scored || rows.length < 2) return rows;
    const mtimes = new Map((this.db.prepare('SELECT path, mtime_ms AS mtimeMs FROM memory_files').all() as Array<{ path: string; mtimeMs: number }>).map((m) => [m.path, m.mtimeMs]));
    const now = this.nowMs();
    const value = (r: R): number => {
      const ageDays = Math.max(0, now - (mtimes.get(r.path) ?? now)) / 86_400_000;
      const recency = 1 - RECENCY_WEIGHT + RECENCY_WEIGHT * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
      // bm25 is negative: larger magnitude is better.
      return -r.score * recency * (isRawPath(r.path) ? RAW_LAYER_FACTOR : 1);
    };
    return rows
      .map((r) => ({ r, v: value(r) }))
      .sort((a, b) => b.v - a.v)
      .map((x) => x.r);
  }
}
