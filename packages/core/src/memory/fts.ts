import type { MemorySearchHit } from '@protea/protocol';
import type { Db } from '../db/database.js';
import { globToRegExp } from '../util/glob.js';
import { chunkText } from './chunks.js';
import { parseNote } from './frontmatter.js';
import { MAX_MEMORY_FILE_BYTES, MEMORY_ROOT, type MemoryStore } from './store.js';

/** A file a search found, with up to three of its best pieces. */
export type MemoryHit = MemorySearchHit;

/** Which layer of memory to look in: stable notes, the record of what happened, or both. */
export type MemoryScope = 'notes' | 'raw' | 'all';

/** A note as the index lists it. */
export interface NoteEntry {
  path: string;
  summary: string;
  hasSummary: boolean;
  size: number;
  mtimeMs: number;
}

/** The record of what happened: kept for review and normally not recalled. */
const RAW_PREFIXES = ['journal/', 'handoff/', 'raw/'] as const;
/** bm25 column weights: path, start_line, end_line, meta (summary, keywords, heading), body, chars. */
const BM25_WEIGHTS = '0.0, 0.0, 0.0, 4.0, 1.0, 0.5';
const SNIPPET_RADIUS = 70;
const CHUNKS_PER_FILE = 3;
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

/** Every CJK character on its own, so a one-character query has something to match. */
function cjkChars(text: string): string {
  return Array.from(text.matchAll(CJK_RUN), (m) => Array.from(m[0]).join(' ')).join(' ');
}

export interface QueryTerm {
  text: string;
  /** Quoted, or written with a leading `+`: a file without it is not a result. */
  required: boolean;
}

/** Split a query into terms. "double quotes" keep a phrase together; quoted and `+term` must appear. */
export function queryTerms(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    if (m[1] !== undefined) {
      const t = m[1].trim();
      if (t) terms.push({ text: t, required: true });
      continue;
    }
    const raw = m[2] ?? '';
    const required = raw.startsWith('+') && raw.length > 1;
    const t = required ? raw.slice(1) : raw;
    if (t && !terms.some((x) => x.text === t)) terms.push({ text: t, required });
  }
  return terms;
}

/**
 * The FTS5 expression for a term, or null when it has nothing the index can match. A term is
 * split by script: Latin words stay a phrase (the last word may be a prefix), a CJK run becomes
 * its pairs, a lone CJK character matches the single-character column. All parts must appear.
 */
export function ftsTerm(term: string): string | null {
  const parts: string[] = [];
  let rest = term;
  const quote = (tokens: string): string => `"${tokens.replace(/"/g, '""')}"`;
  const latin = (s: string): void => {
    const words = s.match(/[\p{L}\p{N}]+/gu);
    if (words && words.length > 0) parts.push(`${quote(words.join(' '))} *`);
  };
  for (const m of term.matchAll(CJK_RUN)) {
    const at = rest.indexOf(m[0]);
    latin(rest.slice(0, at));
    rest = rest.slice(at + m[0].length);
    const chars = Array.from(m[0]);
    parts.push(chars.length === 1 ? `chars : ${quote(m[0])}` : quote(segmentText(m[0]).trim().replace(/\s+/g, ' ')));
  }
  latin(rest);
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' AND ')})`;
}

function scopeSql(scope: MemoryScope, column: string): string {
  if (scope === 'all') return '';
  const raw = RAW_PREFIXES.map((p) => `${column} LIKE '${p}%'`).join(' OR ');
  return scope === 'raw' ? ` AND (${raw})` : ` AND NOT (${raw})`;
}

/** The pieces of a term to look for in text when cutting a snippet. */
function needles(term: string): string[] {
  const out: string[] = [];
  for (const m of term.matchAll(CJK_RUN)) out.push(m[0]);
  for (const w of term.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}]+/gu) ?? []) out.push(w);
  return out.length > 0 ? out : [term];
}

function snippetOf(text: string, wanted: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  let len = 0;
  for (const w of wanted) {
    const i = lower.indexOf(w.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = w.length;
    }
  }
  if (at < 0) return flat.length > SNIPPET_RADIUS * 2 ? `${flat.slice(0, SNIPPET_RADIUS * 2)}…` : flat;
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(flat.length, at + len + SNIPPET_RADIUS);
  return `${from > 0 ? '…' : ''}${flat.slice(from, at)}[${flat.slice(at, at + len)}]${flat.slice(at + len, to)}${to < flat.length ? '…' : ''}`;
}

/** Turn `paths` filters (`notes`, `/memories/journal/`, `notes/*.md`) into a predicate on relative paths. */
function pathFilter(paths: readonly string[] | undefined): (rel: string) => boolean {
  if (!paths || paths.length === 0) return () => true;
  const tests = paths.map((raw) => {
    let p = raw.trim();
    if (p === MEMORY_ROOT || p.startsWith(`${MEMORY_ROOT}/`)) p = p.slice(MEMORY_ROOT.length);
    else if (p === 'memories' || p.startsWith('memories/')) p = p.slice('memories'.length);
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

interface ChunkRow {
  id: number;
  path: string;
  start: number;
  end: number;
  score: number;
}

/**
 * Full-text index over the memory directory (SQLite FTS5), one row per piece of a file
 * (chunks.ts). Text goes through `segmentText` first, so CJK matches without word
 * segmentation; a note's summary and keywords count for more than its body. Kept in step
 * incrementally: the store reports its writes, the directory watcher the owner's edits, and
 * `sync()` catches up at start.
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

  /** Re-read the given relative paths (written, deleted or moved). */
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
    const chunks = chunkText(text);
    if (chunks.length === 0) chunks.push({ start: 1, end: Math.max(1, note.headerLines), heading: '', text: '' });
    const insert = this.db.prepare('INSERT INTO memory_chunks (path, start_line, end_line, meta, body, chars) VALUES (?, ?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => {
      // The file's summary and keywords belong to its first piece, so they count once.
      const meta = i === 0 ? `${note.hasSummary ? note.summary : ''} ${note.keywords.join(' ')} ${c.heading}` : c.heading;
      insert.run(rel, c.start, c.end, segmentText(meta), segmentText(c.text), cjkChars(`${meta} ${c.text}`));
    });
    this.db
      .prepare('INSERT INTO memory_files (path, mtime_ms, size, summary, has_summary, indexed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rel, mtimeMs, size, note.summary, note.hasSummary ? 1 : 0, this.now());
    return true;
  }

  private removeOne(rel: string): void {
    this.db.prepare('DELETE FROM memory_chunks WHERE path = ?').run(rel);
    this.db.prepare('DELETE FROM memory_files WHERE path = ?').run(rel);
  }

  get size(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_files').get() as { n: number }).n;
  }

  /** The notes, by path: what the generated index lists. */
  notes(): NoteEntry[] {
    const rows = this.db
      .prepare("SELECT path, summary, has_summary AS hasSummary, size, mtime_ms AS mtimeMs FROM memory_files WHERE path LIKE 'notes/%' AND path LIKE '%.md' ORDER BY path")
      .all() as Array<{ path: string; summary: string; hasSummary: number; size: number; mtimeMs: number }>;
    return rows.map((r) => ({ ...r, hasSummary: r.hasSummary === 1 }));
  }

  /**
   * Matching files, best first. Ranking: how many of the query's terms a file contains,
   * then bm25 adjusted a little for layer and age. Without a `scope` every layer is searched.
   */
  search(query: string, opts: { paths?: readonly string[]; limit?: number; scope?: MemoryScope } = {}): MemoryHit[] {
    const terms = queryTerms(query)
      .map((t) => ({ ...t, expr: ftsTerm(t.text) }))
      .filter((t): t is QueryTerm & { expr: string } => t.expr !== null);
    if (terms.length === 0) return [];
    const limit = opts.limit ?? 10;
    const scope = opts.scope ?? 'all';
    const inPaths = pathFilter(opts.paths);
    const scoped = scopeSql(scope, 'path');

    const rows = this.db
      .prepare(
        `SELECT rowid AS id, path, start_line AS start, end_line AS "end", bm25(memory_chunks, ${BM25_WEIGHTS}) AS score FROM memory_chunks WHERE memory_chunks MATCH ?${scoped} ORDER BY score LIMIT 2000`,
      )
      .all(terms.map((t) => t.expr).join(' OR ')) as ChunkRow[];
    const candidates = rows.filter((r) => inPaths(r.path));
    if (candidates.length === 0) return [];
    // Which terms each piece contains.
    const ids = JSON.stringify(candidates.map((r) => r.id));
    const has = terms.map(
      (t) =>
        new Set(
          (this.db.prepare('SELECT rowid AS id FROM memory_chunks WHERE memory_chunks MATCH ? AND rowid IN (SELECT value FROM json_each(?))').all(t.expr, ids) as Array<{ id: number }>).map(
            (r) => r.id,
          ),
        ),
    );
    const mtimes = new Map((this.db.prepare('SELECT path, mtime_ms AS mtimeMs FROM memory_files').all() as Array<{ path: string; mtimeMs: number }>).map((m) => [m.path, m.mtimeMs]));
    const now = this.nowMs();
    const value = (r: ChunkRow): number => {
      const ageDays = Math.max(0, now - (mtimes.get(r.path) ?? now)) / 86_400_000;
      const recency = 1 - RECENCY_WEIGHT + RECENCY_WEIGHT * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
      // bm25 is negative: larger magnitude is better.
      return -r.score * recency * (isRawPath(r.path) ? RAW_LAYER_FACTOR : 1);
    };

    interface FileAcc {
      path: string;
      matched: Set<number>;
      best: number;
      chunks: Array<{ row: ChunkRow; matched: number[]; value: number }>;
    }
    const files = new Map<string, FileAcc>();
    for (const r of candidates) {
      const matched = terms.map((_, i) => i).filter((i) => has[i]?.has(r.id));
      const v = value(r);
      let f = files.get(r.path);
      if (!f) {
        f = { path: r.path, matched: new Set(), best: v, chunks: [] };
        files.set(r.path, f);
      }
      for (const i of matched) f.matched.add(i);
      f.best = Math.max(f.best, v);
      f.chunks.push({ row: r, matched, value: v });
    }
    const required = terms.map((t, i) => (t.required ? i : -1)).filter((i) => i >= 0);
    const ranked = [...files.values()]
      .filter((f) => required.every((i) => f.matched.has(i)))
      .sort((a, b) => b.matched.size - a.matched.size || b.best - a.best)
      .slice(0, limit);

    return ranked.map((f) => {
      const text = this.store.readText(f.path) ?? '';
      const lines = text.split('\n');
      const best = f.chunks.sort((a, b) => b.matched.length - a.matched.length || b.value - a.value).slice(0, CHUNKS_PER_FILE);
      const note = isRawPath(f.path) ? null : parseNote(text);
      return {
        path: `${MEMORY_ROOT}/${f.path}`,
        ...(note?.hasSummary ? { summary: note.summary } : {}),
        matched: [...f.matched].sort((a, b) => a - b).map((i) => (terms[i] as QueryTerm).text),
        terms: terms.length,
        chunks: best.map((c) => ({
          start: c.row.start,
          end: c.row.end,
          snippet: snippetOf(lines.slice(c.row.start - 1, c.row.end).join('\n'), c.matched.flatMap((i) => needles((terms[i] as QueryTerm).text))),
        })),
      };
    });
  }
}
