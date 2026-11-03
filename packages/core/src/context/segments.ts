import type { PersonaFiles } from '../persona/persona.js';
import type { EnvPromptSource } from '../plugins/host.js';
import type { SystemSegment } from '../providers/types.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import type { SegmentSource } from './assembler.js';
import { loadEnvPromptTemplate, renderEnvPrompt } from './env-prompts.js';
import { forkNotes, runtimeNotes } from './runtime-notes.js';

export interface SegmentSourceOptions {
  persona: PersonaFiles;
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
 * env:mcp:<server>… → skills-catalog.
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
      const { persona } = this.o;
      const segs: SystemSegment[] = [];
      if (persona.soul) segs.push({ id: 'identity', text: persona.soul });
      segs.push({ id: 'runtime', text: forkNotes({ timezone: this.o.timezone }) });
      if (persona.user) segs.push({ id: 'owner', text: persona.user });
      this.cachedFork = segs;
    }
    return this.cachedFork;
  }

  private build(): SystemSegment[] {
    const { persona } = this.o;
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
    return segs;
  }
}
