import { BOARD_SECTIONS, type BoardCommand } from '@protea/protocol';
import type { ToolSpec } from '../tools/types.js';
import { isoInZone, type Clock } from '../util/time.js';
import { BoardError, type Board } from './board.js';
import type { MemoryIndex, MemoryScope } from './fts.js';
import { MEMORY_ROOT, MemoryError, type MemoryCommand, type MemoryStore } from './store.js';

export interface MemoryToolDeps {
  store: MemoryStore;
  index: MemoryIndex;
  /** The whiteboard; without it there is no `board` tool. */
  board?: Board;
  clock: Clock;
  timezone: string;
  /** Declare the provider's own memory tool type (Anthropic `memory_20250818`) instead of a schema. */
  nativeType?: boolean;
}

const MEMORY_COMMANDS = ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] as const;
const BOARD_COMMANDS = ['view', 'add', 'update', 'done', 'drop'] as const;
const MEMORY_SCOPES = ['notes', 'raw', 'all'] as const;
const SEARCH_LIMIT = 8;
/** The main session's id in tool contexts; any other id is a fork. */
const MAIN_SESSION_ID = 'main';

/** Memory tools for every session (docs/10-architecture/11-memory-and-persona.md §3). */
export function memoryTools(deps: MemoryToolDeps): ToolSpec<never>[] {
  const memory: ToolSpec<MemoryCommand> = {
    name: 'memory',
    description: [
      `Your long-term memory: a directory of text files mounted at ${MEMORY_ROOT} that persists across sessions, handoffs and restarts.`,
      'Commands: view {path, view_range?} lists a directory or shows a file with line numbers; create {path, file_text} makes a new file;',
      'str_replace {path, old_str, new_str} replaces one unique occurrence; insert {path, insert_line, insert_text} inserts after a line (0 = top);',
      'delete {path}; rename {old_path, new_path}. Never store secrets (passwords, keys, tokens) here.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', enum: [...MEMORY_COMMANDS] },
        path: { type: 'string', description: `A path under ${MEMORY_ROOT}, e.g. ${MEMORY_ROOT}/notes/projects.md` },
        view_range: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[first, last] line; last -1 = end of file' },
        file_text: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        insert_line: { type: 'integer', minimum: 0 },
        insert_text: { type: 'string' },
        old_path: { type: 'string' },
        new_path: { type: 'string' },
      },
    },
    ...(deps.nativeType ? { providerType: 'memory_20250818' } : {}),
    handler: (input) => {
      try {
        return deps.store.run(input);
      } catch (err) {
        if (err instanceof MemoryError) return { text: err.message, failed: true };
        throw err;
      }
    },
  };

  const memorySearch: ToolSpec<{ query: string; paths?: string[]; limit?: number; scope?: MemoryScope }> = {
    name: 'memory_search',
    description:
      `Full-text search over ${MEMORY_ROOT}. Every term must appear (quote a phrase to keep it together); returns matching files with a one-line summary and a snippet, best first. ` +
      'scope "notes" (the default) searches your stable notes; "raw" searches the record of what happened (journal, handoff notes, conversation archives under raw/), for when you need the original wording; "all" searches both. ' +
      'Narrow with paths, e.g. ["notes/people"] or ["journal/*.md"]; giving paths searches all layers unless you also set scope.',
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
    handler: (input) => {
      const scope = input.scope ?? (input.paths && input.paths.length > 0 ? 'all' : 'notes');
      const hits = deps.index.search(input.query, { ...(input.paths ? { paths: input.paths } : {}), limit: input.limit ?? SEARCH_LIMIT, scope });
      if (hits.length === 0) {
        const raw = scope === 'notes' ? deps.index.search(input.query, { scope: 'raw', limit: 50 }).length : 0;
        if (raw > 0) return `no note matches ${JSON.stringify(input.query)}; ${raw} file(s) in the record of what happened do. Search again with scope "raw" to see them.`;
        return `no memory file matches ${JSON.stringify(input.query)}`;
      }
      return [`${hits.length} file(s) match ${JSON.stringify(input.query)}:`, ...hits.map((h) => `${h.path}${h.summary ? ` — ${h.summary}` : ''}\n  ${h.snippet}`)].join('\n');
    },
  };

  const memoryRecent: ToolSpec<{ days?: number }> = {
    name: 'memory_recent',
    description: `List the journal files (${MEMORY_ROOT}/journal/YYYY-MM-DD.md) of the last N days, newest first, with their size.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } },
    },
    flags: { readOnly: true },
    handler: (input) => {
      const days = input.days ?? 7;
      const now = deps.clock.now();
      const wanted = new Set<string>();
      for (let i = 0; i < days; i++) wanted.add(isoInZone(now - i * 86_400_000, deps.timezone).slice(0, 10));
      const files = deps.store
        .listFiles()
        .filter((f) => /^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(f.path) && wanted.has(f.path.slice(8, 18)))
        .sort((a, b) => (a.path < b.path ? 1 : -1));
      if (files.length === 0) return `no journal entries in the last ${days} day(s)`;
      return files.map((f) => `${MEMORY_ROOT}/${f.path} (${f.size} bytes)`).join('\n');
    },
  };

  const tools: ToolSpec<never>[] = [memory, memorySearch, memoryRecent] as ToolSpec<never>[];
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
