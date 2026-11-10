import { MODEL_ROLES, type Effort, type Level, type ModelRole } from '@protea/protocol';
import type { ProviderProfile, ProvidersSettings } from '../config/types.js';
import { profileIdFor, profileProblem } from './profiles.js';
import { ProviderError, type Provider, type ProviderHealth, type ProviderRequest, type ProviderResponse } from './types.js';

const NOT_CONFIGURED = 'no model provider is configured: add one in the console (模型), with "protea providers set", or under providers.profiles';

export interface ProfileState {
  id: string;
  profile: ProviderProfile;
  /** Roles this profile serves now. */
  roles: ModelRole[];
  health: ProviderHealth;
}

/**
 * The provider the daemon uses: routes each request to the profile of its role
 * (providers.roles, else providers.default). Profiles are built lazily and rebuilt when their
 * settings change; `refresh()` drops them all (after a key was stored or removed), so provider
 * changes apply from the next request without a restart. A request in flight finishes on the
 * instance it started with.
 */
export class ProviderRouter implements Provider {
  private readonly built = new Map<string, { sig: string; provider: Provider }>();

  constructor(
    private readonly settings: () => ProvidersSettings,
    private readonly build: (id: string, profile: ProviderProfile) => Provider,
  ) {}

  /** The default profile's id ("none" before one is configured). */
  get id(): string {
    return this.settings().default ?? 'none';
  }

  refresh(): void {
    this.built.clear();
  }

  private instance(id: string): Provider | null {
    const profile = this.settings().profiles[id];
    if (!profile) return null;
    const sig = JSON.stringify(profile);
    const cur = this.built.get(id);
    if (cur && cur.sig === sig) return cur.provider;
    const provider = this.build(id, profile);
    this.built.set(id, { sig, provider });
    return provider;
  }

  private route(role: ModelRole): { id: string; profile: ProviderProfile; provider: Provider } | null {
    const id = profileIdFor(this.settings(), role);
    if (id === null) return null;
    const profile = this.settings().profiles[id];
    const provider = this.instance(id);
    return profile && provider ? { id, profile, provider } : null;
  }

  /** The profile id serving a role, or null. */
  profileFor(role: ModelRole): string | null {
    return profileIdFor(this.settings(), role);
  }

  modelFor(role: ModelRole): string {
    return this.route(role)?.provider.modelFor(role) || 'none';
  }

  private healthOf(id: string): ProviderHealth {
    const profile = this.settings().profiles[id];
    const provider = this.instance(id);
    if (!profile || !provider) return { ready: false, problem: `no profile "${id}"` };
    const problem = profileProblem(profile);
    if (problem) return { ready: false, problem };
    return provider.health();
  }

  health(): ProviderHealth {
    const ids = [...new Set(MODEL_ROLES.map((r) => this.profileFor(r)))];
    if (ids.includes(null)) return { ready: false, problem: NOT_CONFIGURED };
    const problems: string[] = [];
    for (const id of ids as string[]) {
      const h = this.healthOf(id);
      if (!h.ready) problems.push(ids.length > 1 ? `${id}: ${h.problem ?? 'not ready'}` : (h.problem ?? 'not ready'));
    }
    return problems.length > 0 ? { ready: false, problem: problems.join('; ') } : { ready: true };
  }

  /** Every configured profile with the roles it serves and its health. */
  states(): ProfileState[] {
    const s = this.settings();
    return Object.entries(s.profiles).map(([id, profile]) => ({
      id,
      profile,
      roles: MODEL_ROLES.filter((r) => profileIdFor(s, r) === id),
      health: this.healthOf(id),
    }));
  }

  supportsToolSearch(role: ModelRole): boolean {
    return this.route(role)?.provider.supportsToolSearch?.(role) ?? false;
  }

  contextWindow(role: ModelRole): number | undefined {
    return this.route(role)?.provider.contextWindow?.(role);
  }

  cacheHorizonMs(role: ModelRole): number | undefined {
    return this.route(role)?.provider.cacheHorizonMs?.(role);
  }

  async countTokens(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<number | undefined> {
    const r = this.route(req.role);
    return r?.provider.countTokens ? r.provider.countTokens(req, opts) : undefined;
  }

  /** The effort for a role (and the batch level, for main) from its profile. */
  effort(role: ModelRole, level: Level = 2): Effort {
    const e = this.route(role)?.profile.effort;
    if (!e) return role === 'cheap' ? 'low' : 'high';
    return role === 'main' ? e.main[level] : e[role];
  }

  /** The output limit of the role's profile (context limits leave room for it). */
  maxOutputTokens(role: ModelRole): number {
    return this.route(role)?.profile.maxOutputTokens ?? 64_000;
  }

  async generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse> {
    const r = this.route(req.role);
    if (!r) throw new ProviderError('config', NOT_CONFIGURED);
    const problem = profileProblem(r.profile);
    if (problem) throw new ProviderError('config', `provider ${r.id}: ${problem}`);
    const res = await r.provider.generate(req, opts);
    res.provider = r.id;
    return res;
  }
}
