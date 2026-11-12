import type { ResidentSnapshot } from '../memory/resident.js';
import { CORE_FILES, MEMORY_ROOT } from '../memory/store.js';
import type { PersonaFiles, PersonaHooks } from '../persona/persona.js';
import type { EnvPromptSource } from '../plugins/host.js';
import type { SystemSegment } from '../providers/types.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import { escapeStructural } from '../util/escape.js';
import type { SegmentSource } from './assembler.js';
import { loadEnvPromptTemplate, renderEnvPrompt } from './env-prompts.js';
import { forkNotes, runtimeNotes } from './runtime-notes.js';

/** A resident memory file as a prefix segment. */
function residentSegment(id: string, rel: string, text: string): SystemSegment {
  return { id, text: `<memory_file path="${MEMORY_ROOT}/${rel}" chars="${text.length}" limit="${CORE_FILES[rel] ?? 0}">\n${escapeStructural(text)}\n</memory_file>` };
}

export interface SegmentSourceOptions {
  /** The persona files as they are now (reloaded when they change). */
  persona: () => PersonaFiles;
  /** Persona hooks; `systemSegments` may rewrite the main prefix. */
  hooks?: () => PersonaHooks | null;
  /** The published resident memory: owner profile, standing rules, index of notes (it changes only at chosen moments, to keep the prefix stable). */
  memory?: () => ResidentSnapshot;
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
 * System prefix: identity → runtime → operating → permissions → env:<plugin>… →
 * env:mcp:<server>… → skills-catalog → owner → rules → memory-index. The memory segments
 * come last: they are the ones that change most often.
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

  /** Prefix for forks: identity → fork runtime → owner profile. Shared by all forks so it caches. */
  forkSegments(): SystemSegment[] {
    if (!this.cachedFork) {
      const persona = this.o.persona();
      const segs: SystemSegment[] = [];
      if (persona.soul) segs.push({ id: 'identity', text: persona.soul });
      segs.push({ id: 'runtime', text: forkNotes({ timezone: this.o.timezone }) });
      const owner = this.o.memory?.().owner;
      if (owner) segs.push(residentSegment('owner', 'core/owner.md', owner));
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
    const memory = this.o.memory?.();
    if (memory?.owner) segs.push(residentSegment('owner', 'core/owner.md', memory.owner));
    if (memory?.rules) segs.push(residentSegment('rules', 'core/rules.md', memory.rules));
    if (memory?.index) segs.push({ id: 'memory-index', text: `<memory_index root="${MEMORY_ROOT}">\n${escapeStructural(memory.index)}\n</memory_index>` });
    return segs;
  }
}
