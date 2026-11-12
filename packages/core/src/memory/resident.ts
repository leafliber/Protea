import type { MemoryCheck } from '@protea/protocol';
import type { MemoryIndex, NoteEntry } from './fts.js';
import { CORE_FILES, type MemoryStore } from './store.js';

/** Longest generated index of the notes; past it, directories are listed instead of files. */
export const INDEX_MAX_CHARS = 6_000;
/** A note past this size is reported to the consolidation as one to split or trim. */
export const NOTE_WARN_BYTES = 8 * 1024;
/** Finished notes: always one line in the index. */
const ARCHIVE_DIR = 'notes/archive/';

/** What the system prefix shows of memory. */
export interface ResidentSnapshot {
  /** core/owner.md, or null when empty. */
  owner: string | null;
  /** core/rules.md, or null when empty. */
  rules: string | null;
  /** The generated index of notes/, or null when there are none. */
  index: string | null;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : `${p.slice(0, i)}/`;
}

/**
 * The index of the notes, one line each from their summaries; Core writes no words of its
 * own (P1). Archived notes become one line; past `max`, each directory becomes one line.
 */
export function renderNotesIndex(notes: readonly NoteEntry[], max = INDEX_MAX_CHARS): string | null {
  if (notes.length === 0) return null;
  const live = notes.filter((n) => !n.path.startsWith(ARCHIVE_DIR));
  const archived = notes.length - live.length;
  const tail = archived > 0 ? [`- ${ARCHIVE_DIR} (${archived} files)`] : [];
  const lines = [...live.map((n) => `- ${n.path} — ${n.summary}`), ...tail];
  const fits = (ls: string[]): boolean => ls.join('\n').length <= max;
  if (fits(lines)) return lines.join('\n');
  // Too many notes: files directly under notes/ stay, deeper directories become one line each.
  const byDir = new Map<string, NoteEntry[]>();
  for (const n of live) {
    const top = n.path.split('/').length > 2 ? `notes/${n.path.split('/')[1] as string}/` : dirOf(n.path);
    byDir.set(top, [...(byDir.get(top) ?? []), n]);
  }
  const grouped: string[] = [];
  for (const [dir, ns] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (dir === 'notes/') grouped.push(...ns.map((n) => `- ${n.path} — ${n.summary}`));
    else grouped.push(`- ${dir} (${ns.length} files: ${ns.slice(0, 4).map((n) => n.path.slice(dir.length)).join(', ')}${ns.length > 4 ? ', …' : ''})`);
  }
  const all = [...grouped, ...tail];
  if (fits(all)) return all.join('\n');
  const out: string[] = [];
  for (const l of all) {
    if (!fits([...out, l, '- …'])) break;
    out.push(l);
  }
  return [...out, `- … (${all.length - out.length} more lines)`].join('\n');
}

/**
 * The resident layer: `core/owner.md`, `core/rules.md` and the generated index of notes. The
 * system prefix shows a published copy that changes only at chosen moments (start, handoff,
 * the end of a consolidation, the owner's edits), so the provider cache survives the
 * assistant's own writes; those are in the conversation already.
 */
export class ResidentMemory {
  private snapshot: ResidentSnapshot;

  constructor(
    private readonly store: Pick<MemoryStore, 'readText'>,
    private readonly index: Pick<MemoryIndex, 'notes'>,
  ) {
    this.snapshot = this.current();
  }

  /** As it is on disk now. */
  current(): ResidentSnapshot {
    const read = (rel: string): string | null => {
      const t = this.store.readText(rel)?.trim();
      return t ? t : null;
    };
    return { owner: read('core/owner.md'), rules: read('core/rules.md'), index: renderNotesIndex(this.index.notes()) };
  }

  /** As the system prefix shows it. */
  published(): ResidentSnapshot {
    return this.snapshot;
  }

  /** Take the current state as the published one; true when it changed. */
  publish(): boolean {
    const next = this.current();
    const changed = next.owner !== this.snapshot.owner || next.rules !== this.snapshot.rules || next.index !== this.snapshot.index;
    this.snapshot = next;
    return changed;
  }

  /** Whether what is on disk differs from what the prefix shows. */
  get stale(): boolean {
    const c = this.current();
    return c.owner !== this.snapshot.owner || c.rules !== this.snapshot.rules || c.index !== this.snapshot.index;
  }

  /** Things the consolidation should fix: resident files over their limit, notes without a summary or too long. */
  checks(): MemoryCheck[] {
    const out: MemoryCheck[] = [];
    for (const [rel, limit] of Object.entries(CORE_FILES)) {
      const n = this.store.readText(rel)?.length ?? 0;
      if (n > limit) out.push({ path: rel, problem: 'over_limit', detail: `${n}/${limit}` });
    }
    for (const n of this.index.notes()) {
      if (!n.hasSummary) out.push({ path: n.path, problem: 'no_summary' });
      if (n.size > NOTE_WARN_BYTES) out.push({ path: n.path, problem: 'too_long', detail: `${n.size} bytes` });
    }
    return out;
  }

  /** Characters used by each resident file, and its limit. */
  usage(): Array<{ path: string; chars: number; limit: number }> {
    return Object.entries(CORE_FILES).map(([path, limit]) => ({ path, chars: this.store.readText(path)?.length ?? 0, limit }));
  }
}
