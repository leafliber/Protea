import { BOARD_SECTIONS, type BoardCommand } from '@protea/protocol';
import type { ToolSpec } from '../tools/types.js';
import type { MemoryAccess, MemoryAccessEntry } from './access.js';
import { BoardError, type Board } from './board.js';
import type { MemoryHit, MemoryIndex, MemoryScope } from './fts.js';
import { CORE_FILES, isCorePath, MEMORY_COMMANDS, MEMORY_ROOT, MemoryError, type MemoryCommand, type MemoryStore } from './store.js';

export interface MemoryToolDeps {
  store: MemoryStore;
  index: MemoryIndex;
  /** Where reads, searches and writes are recorded. */
  access?: MemoryAccess;
  /** The whiteboard; without it there is no `board` tool. */
  board?: Board;
  /**
   * Why a write to the resident files (core/) in this call needs the owner's approval, or
   * null when it does not (the batch holds only the owner's and the runtime's events).
   */
  coreWriteCheck?: (ctx: { sessionId: string; batchId: string }) => string | null;
}

const BOARD_COMMANDS = ['view', 'add', 'update', 'done', 'drop'] as const;
const MEMORY_SCOPES = ['notes', 'raw', 'all'] as const;
const SEARCH_LIMIT = 8;
/** The main session's id in tool contexts; any other id is a fork. */
const MAIN_SESSION_ID = 'main';

const coreLimits = Object.entries(CORE_FILES)
  .map(([p, n]) => `${MEMORY_ROOT}/${p} (at most ${n} characters)`)
  .join(' and ');

function formatHits(query: string, hits: readonly MemoryHit[]): string {
  const out = [`${hits.length} file(s) for ${JSON.stringify(query)}:`];
  for (const h of hits) {
    const partial = h.matched.length < h.terms ? ` (matches ${h.matched.length} of ${h.terms} terms: ${h.matched.join(', ')})` : '';
    out.push(`${h.path}${h.summary ? ` — ${h.summary}` : ''}${partial}`);
    for (const c of h.chunks) out.push(`  lines ${c.start}-${c.end}: ${c.snippet}`);
  }
  return out.join('\n');
}

/** Memory tools for every session (docs/10-architecture/11-memory-and-persona.md §3). */
export function memoryTools(deps: MemoryToolDeps): ToolSpec<never>[] {
  const { store, access } = deps;
  const note = (e: MemoryAccessEntry): void => {
    try {
      access?.record(e);
    } catch {
      // The record of use is a convenience; it never fails a call.
    }
  };

  const memory: ToolSpec<MemoryCommand> = {
    name: 'memory',
    description: [
      `Your long-term memory: text files under ${MEMORY_ROOT} that outlast this conversation, compactions and restarts.`,
      'Commands: read {path, range?} lists a directory or shows a file with line numbers, 200 lines at a time (range [first, last]; last -1 = end of file);',
      'write {path, text} creates or replaces a file; append {path, text} adds lines at the end and creates the file if needed;',
      'edit {path, old, new} replaces one exact, unique piece of text; move {from, to}; delete {path}.',
      `Paths may be written ${MEMORY_ROOT}/x, memories/x or x.`,
      `${coreLimits} are part of every request: a write that would exceed the limit is refused. Writes to them need the owner's approval when the batch holds messages from anyone else.`,
      `Notes under ${MEMORY_ROOT}/notes need a frontmatter summary. journal/ is yours to append to; handoff/ and raw/ are a read-only record.`,
      'Never store secrets (passwords, keys, tokens).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', enum: [...MEMORY_COMMANDS] },
        path: { type: 'string', description: `e.g. ${MEMORY_ROOT}/journal/2026-11-12.md` },
        range: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: 'read: [first, last] line; last -1 = end of file' },
        text: { type: 'string', description: 'write, append' },
        old: { type: 'string', description: 'edit: the exact text to replace' },
        new: { type: 'string', description: 'edit: what replaces it' },
        from: { type: 'string', description: 'move' },
        to: { type: 'string', description: 'move' },
      },
    },
    approval: {
      title: { zh: '修改常驻记忆', en: 'Change the resident memory' },
      target: 'path',
      fields: { command: { zh: '操作', en: 'Command' }, text: { zh: '内容', en: 'Text' }, old: { zh: '原文', en: 'Replace' }, new: { zh: '改为', en: 'With' }, to: { zh: '移到', en: 'To' } },
    },
    askWhen: (input, ctx) => {
      if (!deps.coreWriteCheck || input.command === 'read') return null;
      let targets: string[];
      try {
        targets = store.targets(input);
      } catch {
        return null;
      }
      return targets.some(isCorePath) ? deps.coreWriteCheck(ctx) : null;
    },
    handler: (input, ctx) => {
      try {
        const out = store.run(input);
        if (input.command === 'read') {
          const rel = store.relative(input.path ?? '');
          if (store.kind(rel) === 'file') note({ session: ctx.sessionId, kind: 'read', path: rel });
        } else {
          for (const rel of store.targets(input)) note({ session: ctx.sessionId, kind: 'write', path: rel });
        }
        return out;
      } catch (err) {
        if (err instanceof MemoryError) return { text: err.message, failed: true };
        throw err;
      }
    },
  };

  const memorySearch: ToolSpec<{ query: string; paths?: string[]; limit?: number; scope?: MemoryScope }> = {
    name: 'memory_search',
    description:
      `Full-text search over ${MEMORY_ROOT}. Files containing more of the terms rank first; quote a phrase or write +term for what must appear. ` +
      'Each result is a file with its summary and up to three places in it (line ranges to read). ' +
      'scope "notes" (the default) searches your stable notes; "raw" searches the record of what happened (journal, handoff notes, conversation archives under raw/), for when you need the original wording; "all" searches both. ' +
      'Narrow with paths, e.g. ["notes/people"] or ["journal/*.md"]; giving paths searches all layers unless you also set scope. Try other words (synonyms, Chinese and English) when nothing matches.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        scope: { type: 'string', enum: [...MEMORY_SCOPES] },
        paths: { type: 'array', items: { type: 'string' }, description: `Directories, files or globs relative to ${MEMORY_ROOT}` },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: SEARCH_LIMIT },
      },
    },
    flags: { readOnly: true },
    handler: (input, ctx) => {
      const scope = input.scope ?? (input.paths && input.paths.length > 0 ? 'all' : 'notes');
      const hits = deps.index.search(input.query, { ...(input.paths ? { paths: input.paths } : {}), limit: input.limit ?? SEARCH_LIMIT, scope });
      note({ session: ctx.sessionId, kind: 'search', query: input.query, hits: hits.length });
      for (const h of hits) note({ session: ctx.sessionId, kind: 'hit', query: input.query, path: h.path.slice(MEMORY_ROOT.length + 1) });
      if (hits.length === 0) {
        const raw = scope === 'notes' ? deps.index.search(input.query, { scope: 'raw', limit: 50 }).length : 0;
        if (raw > 0) return `no note matches ${JSON.stringify(input.query)}; ${raw} file(s) in the record of what happened do. Search again with scope "raw" to see them.`;
        return `no memory file matches ${JSON.stringify(input.query)}`;
      }
      return formatHits(input.query, hits);
    },
  };

  const tools: ToolSpec<never>[] = [memory, memorySearch] as ToolSpec<never>[];
  const board = deps.board;
  if (board) {
    const boardTool: ToolSpec<{ command: (typeof BOARD_COMMANDS)[number]; section?: string; id?: string; text?: string; due?: string; outcome?: string }> = {
      name: 'board',
      description: [
        'Your whiteboard: what you are working towards and what must not be forgotten. It stays with you across compactions, so keep it current.',
        'Sections: goals (few, lasting), todo (concrete things to do, including things you are waiting on), notes (reminders to yourself).',
        'Commands: view shows the whole board; add {section, text, due?}; update {id, section?, text?, due?} (due "" clears the date); done {id, outcome?}; drop {id, outcome?}.',
        'One short line per item. Details belong in memory files.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', enum: [...BOARD_COMMANDS] },
          section: { type: 'string', enum: [...BOARD_SECTIONS] },
          id: { type: 'string', description: 'Item id, e.g. t12' },
          text: { type: 'string' },
          due: { type: 'string', description: 'YYYY-MM-DD or an ISO time' },
          outcome: { type: 'string', description: 'How it ended (done, drop)' },
        },
      },
      flags: { forkOptIn: true },
      handler: (input, ctx) => {
        if (input.command === 'view') return board.render();
        try {
          return board.apply(input as unknown as BoardCommand, ctx.sessionId === MAIN_SESSION_ID ? 'main' : 'external', ctx.batchId);
        } catch (err) {
          if (err instanceof BoardError) return { text: err.message, failed: true };
          throw err;
        }
      },
    };
    tools.push(boardTool as ToolSpec<never>);
  }
  return tools;
}
