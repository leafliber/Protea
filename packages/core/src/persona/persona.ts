import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Level, TranscriptMessage } from '@protea/protocol';
import type { SystemSegment } from '../providers/types.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';

export const PERSONA_FILES = ['SOUL.md', 'OPERATING.md', 'USER.md'] as const;
/** Hook module names, first match wins. TypeScript needs a Node.js that strips types (22.18+). */
export const HOOK_FILES = ['hooks.ts', 'hooks.mts', 'hooks.mjs', 'hooks.js'] as const;

export interface PersonaFiles {
  dir: string;
  soul?: string;
  operating?: string;
  user?: string;
}

/** What a custom handoff strategy sees. */
export interface HandoffSnapshot {
  /** The whole current conversation (thinking blocks included). */
  messages: TranscriptMessage[];
  /** Estimated input tokens of the next request. */
  estimatedTokens: number;
  /** Transcript file being retired (relative to the data directory). */
  transcript: string;
  /** The memory directory on disk. */
  memoryDir: string;
}

export interface HandoffPlan {
  /** Messages carried into the new conversation verbatim (Core strips their thinking blocks). Must start with a user message. */
  tail: TranscriptMessage[];
  /** Notes to write to memory/handoff/<ts>.md; omit when the hook wrote `notesPath` itself. */
  notes?: string;
  /** Relative to the memory directory, e.g. "handoff/2026-11-03T08-00-00Z.md". */
  notesPath?: string;
}

/**
 * Optional persona code (docs/10-architecture/11-memory-and-persona.md §6), loaded in-process
 * from `persona/hooks.{ts,mts,mjs,js}` and reloaded when the file changes. Every hook is
 * optional; one that throws falls back to the default behaviour.
 */
export interface PersonaHooks {
  /** Replace or reorder the system segments of the main session. */
  systemSegments?(ctx: { defaults: SystemSegment[] }): SystemSegment[];
  /** Custom handoff: choose the tail and write the notes. */
  onHandoff?(snapshot: HandoffSnapshot, ctx: { hardTokens: number; keepTokens: number }): HandoffPlan | Promise<HandoffPlan>;
  /** Called after each batch of the main session. */
  onBatchEnd?(stats: { batchId: string; level: Level; endReason: string; rounds: number }): void | Promise<void>;
  /** Model rounds per batch (default from `session.rounds`). */
  rounds?(): { soft: number; hard: number };
}

/** Typing helper for hooks modules: `export default definePersona({ ... })`. */
export function definePersona(hooks: PersonaHooks): PersonaHooks {
  return hooks;
}

/** Copy the default persona into the data volume on first start; never overwrite afterwards. */
export function ensurePersona(personaDir: string, defaultDir: string): { created: boolean } {
  if (fs.existsSync(personaDir)) return { created: false };
  fs.mkdirSync(personaDir, { recursive: true });
  for (const f of PERSONA_FILES) {
    const src = path.join(defaultDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(personaDir, f));
  }
  return { created: true };
}

export function loadPersona(personaDir: string): PersonaFiles {
  const read = (f: string): string | undefined => {
    const p = path.join(personaDir, f);
    if (!fs.existsSync(p)) return undefined;
    const text = fs.readFileSync(p, 'utf8').trim();
    return text.length > 0 ? text : undefined;
  };
  const out: PersonaFiles = { dir: personaDir };
  const soul = read('SOUL.md');
  const operating = read('OPERATING.md');
  const user = read('USER.md');
  if (soul !== undefined) out.soul = soul;
  if (operating !== undefined) out.operating = operating;
  if (user !== undefined) out.user = user;
  return out;
}

/** The persona files and hooks as currently on disk; `reload()` picks up edits. */
export class Persona {
  private files: PersonaFiles;
  private hooksValue: PersonaHooks | null = null;
  private hooksKey: string | null = null;
  private hooksError: string | null = null;

  constructor(
    readonly dir: string,
    private readonly log: Logger,
  ) {
    this.files = loadPersona(dir);
  }

  get current(): PersonaFiles {
    return this.files;
  }

  get hooks(): PersonaHooks | null {
    return this.hooksValue;
  }

  /** Why the hooks module did not load, if it did not. */
  get hooksProblem(): string | null {
    return this.hooksError;
  }

  /** Re-read the Markdown files and, if it changed, the hooks module. Returns true when anything changed. */
  async reload(): Promise<boolean> {
    const next = loadPersona(this.dir);
    const filesChanged = JSON.stringify(next) !== JSON.stringify(this.files);
    this.files = next;
    const hooksChanged = await this.loadHooks();
    return filesChanged || hooksChanged;
  }

  /** (Re)load the hooks module when its file or mtime changed. Returns true when the hooks changed. */
  async loadHooks(): Promise<boolean> {
    const file = HOOK_FILES.map((f) => path.join(this.dir, f)).find((f) => fs.existsSync(f));
    const key = file ? `${file}:${fs.statSync(file).mtimeMs}` : null;
    if (key === this.hooksKey) return false;
    this.hooksKey = key;
    if (!file) {
      const had = this.hooksValue !== null;
      this.hooksValue = null;
      this.hooksError = null;
      return had;
    }
    try {
      const mod = (await import(`${pathToFileURL(file).href}?v=${encodeURIComponent(key ?? '')}`)) as { default?: unknown };
      const hooks = (mod.default ?? mod) as PersonaHooks;
      if (!hooks || typeof hooks !== 'object') throw new Error('the module has no default export object');
      this.hooksValue = hooks;
      this.hooksError = null;
      this.log.info({ file: path.basename(file), hooks: Object.keys(hooks).filter((k) => typeof (hooks as Record<string, unknown>)[k] === 'function') }, 'persona hooks loaded');
    } catch (err) {
      this.hooksValue = null;
      this.hooksError = errorMessage(err);
      this.log.warn({ file: path.basename(file), err: this.hooksError }, 'persona hooks failed to load; using the defaults');
    }
    return true;
  }
}
