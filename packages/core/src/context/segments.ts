import { MEMORY_ROOT } from '../memory/store.js';
import type { PersonaFiles, PersonaHooks } from '../persona/persona.js';
import type { EnvPromptSource } from '../plugins/host.js';
import type { SystemSegment } from '../providers/types.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import type { SegmentSource } from './assembler.js';
import { loadEnvPromptTemplate, renderEnvPrompt } from './env-prompts.js';
import { forkNotes, runtimeNotes } from './runtime-notes.js';

/** Longest memory index that goes into the prefix as is. */
export const MAX_INDEX_CHARS = 32_000;

export interface SegmentSourceOptions {
  /** The persona files as they are now (reloaded when they change). */
  persona: () => PersonaFiles;
  /** Persona hooks; `systemSegments` may rewrite the main prefix. */
  hooks?: () => PersonaHooks | null;
  /** Text of memory/INDEX.md; null when there is none. */
  memoryIndex?: () => string | null;
  plugins: { envSources(): EnvPromptSource[] };
  /** The permission summary (P3: restrictions are stated in advance); null when nothing is restricted. */
  permissions?: () => string | null;
  /** Extra environment segments after the plugins' (MCP servers: `env:mcp:<id>`), already ordered. */
  extraEnv?: () => SystemSegment[];
  /** The Skills catalog; null when no skill is listed. */
  skills?: () => string | null;
  timezone: string;
  overridesDir: string;
  log: Logger;
}

/**
 * System prefix: identity → runtime → operating → permissions → owner → env:<plugin>… →
 * env:mcp:<server>… → skills-catalog → memory-index.
 * Built once and rebuilt only on explicit refresh (at a turn boundary), so the
 * prefix stays byte-identical between requests.
 */
export class SystemSegments implements SegmentSource {
  private cached: SystemSegment[] | null = null;
  private cachedFork: SystemSegment[] | null = null;

  constructor(private readonly o: SegmentSourceOptions) {}

  refresh(): void {
    this.cached = null;
    this.cachedFork = null;
  }

  segments(): SystemSegment[] {
    if (!this.cached) this.cached = this.build();
    return this.cached;
  }

  /** Prefix for forks: identity → fork runtime → owner. Shared by all forks so it caches. */
  forkSegments(): SystemSegment[] {
    if (!this.cachedFork) {
      const persona = this.o.persona();
      const segs: SystemSegment[] = [];
      if (persona.soul) segs.push({ id: 'identity', text: persona.soul });
      segs.push({ id: 'runtime', text: forkNotes({ timezone: this.o.timezone }) });
      if (persona.user) segs.push({ id: 'owner', text: persona.user });
      this.cachedFork = segs;
    }
    return this.cachedFork;
  }

  private build(): SystemSegment[] {
    const defaults = this.defaults();
    const custom = this.o.hooks?.()?.systemSegments;
    if (!custom) return defaults;
    try {
      const segs = custom({ defaults: defaults.map((s) => ({ ...s })) });
      if (!Array.isArray(segs) || segs.some((s) => !s || typeof s.id !== 'string' || typeof s.text !== 'string')) {
        throw new Error('systemSegments must return an array of { id, text }');
      }
      return segs.filter((s) => s.text.length > 0);
    } catch (err) {
      this.o.log.warn({ err: errorMessage(err) }, 'persona systemSegments hook failed; using the default segments');
      return defaults;
    }
  }

  private defaults(): SystemSegment[] {
    const persona = this.o.persona();
    const segs: SystemSegment[] = [];
    if (persona.soul) segs.push({ id: 'identity', text: persona.soul });
    segs.push({ id: 'runtime', text: runtimeNotes({ timezone: this.o.timezone }) });
    if (persona.operating) segs.push({ id: 'operating', text: persona.operating });
    const permissions = this.o.permissions?.();
    if (permissions) segs.push({ id: 'permissions', text: permissions });
    if (persona.user) segs.push({ id: 'owner', text: persona.user });
    for (const p of this.o.plugins.envSources()) {
      try {
        const tpl = loadEnvPromptTemplate(p.id, p.envPromptFile, {
          personaDir: persona.dir,
          overridesDir: this.o.overridesDir,
        });
        const vars = p.envPromptVars();
        const text = renderEnvPrompt(tpl, vars === null ? null : { timezone: this.o.timezone, ...vars });
        if (text) segs.push({ id: `env:${p.id}`, text });
      } catch (err) {
        this.o.log.warn({ plugin: p.id, err: errorMessage(err) }, 'environment prompt failed; omitted');
      }
    }
    for (const seg of this.o.extraEnv?.() ?? []) segs.push(seg);
    const catalog = this.o.skills?.();
    if (catalog) segs.push({ id: 'skills-catalog', text: catalog });
    const index = this.o.memoryIndex?.()?.trim();
    if (index) {
      const body = index.length > MAX_INDEX_CHARS ? `${index.slice(0, MAX_INDEX_CHARS)}\n… [truncated: shorten ${MEMORY_ROOT}/INDEX.md]` : index;
      segs.push({ id: 'memory-index', text: `<memory_index path="${MEMORY_ROOT}/INDEX.md">\n${body}\n</memory_index>` });
    }
    return segs;
  }
}
