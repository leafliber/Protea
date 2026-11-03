import type { ToolSpec } from '../tools/types.js';
import { isoInZone, type Clock } from '../util/time.js';
import type { MemoryIndex } from './fts.js';
import { MEMORY_ROOT, MemoryError, type MemoryCommand, type MemoryStore } from './store.js';

export interface MemoryToolDeps {
  store: MemoryStore;
  index: MemoryIndex;
  clock: Clock;
  timezone: string;
  /** Declare the provider's own memory tool type (Anthropic `memory_20250818`) instead of a schema. */
  nativeType?: boolean;
}

const MEMORY_COMMANDS = ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] as const;

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

  const memorySearch: ToolSpec<{ query: string; paths?: string[]; limit?: number }> = {
    name: 'memory_search',
    description:
      `Full-text search over ${MEMORY_ROOT}. Every term must appear (quote a phrase to keep it together); returns matching files with a snippet, best first. ` +
      'Narrow with paths, e.g. ["journal"] or ["notes/*.md"].',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        paths: { type: 'array', items: { type: 'string' }, description: `Directories, files or globs relative to ${MEMORY_ROOT}` },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    },
    flags: { readOnly: true },
    handler: (input) => {
      const hits = deps.index.search(input.query, { ...(input.paths ? { paths: input.paths } : {}), limit: input.limit ?? 10 });
      if (hits.length === 0) return `no memory file matches ${JSON.stringify(input.query)}`;
      return [`${hits.length} file(s) match ${JSON.stringify(input.query)}:`, ...hits.map((h) => `${h.path}\n  ${h.snippet}`)].join('\n');
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

  return [memory, memorySearch, memoryRecent] as ToolSpec<never>[];
}
