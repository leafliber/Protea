import type { ValidateFunction } from 'ajv';
import { createAjv } from '../events/validate.js';
import type { ToolDef, ToolSpec } from './types.js';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ProviderToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Not loaded up front; the model finds it through the provider's tool search. */
  deferLoading?: boolean;
  /** Provider-defined tool type (see ToolSpec.providerType). */
  providerType?: string;
}

/** Sort rank of a tool owner: kernel, then plugins, then MCP servers (owners "mcp" and "mcp:<id>"). */
function ownerRank(owner: string): string {
  if (owner === 'core') return '0';
  return owner === 'mcp' || owner.startsWith('mcp:') ? '2' : '1';
}

/**
 * All tools visible to the model. Ordering is deterministic (core, then plugins by id,
 * then MCP servers by id, each by name) so the serialized tool list is byte-stable for
 * prompt caching.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private readonly validators = new Map<string, ValidateFunction>();
  /** Why a tool that used to exist is gone, for the receipt of a late call. */
  private readonly tombstones = new Map<string, string>();
  private readonly ajv = createAjv();
  private version = 0;

  register<I>(owner: string, spec: ToolSpec<I>): void {
    if (!NAME_RE.test(spec.name)) throw new Error(`invalid tool name "${spec.name}"`);
    const existing = this.tools.get(spec.name);
    if (existing) throw new Error(`tool name "${spec.name}" is already declared by ${existing.owner}`);
    this.validators.set(spec.name, this.compile(spec));
    this.tools.set(spec.name, { ...(spec as ToolSpec), owner });
    this.tombstones.delete(spec.name);
    this.version++;
  }

  /** Replace every tool of one owner at once (all or none); returns the names that went away. */
  replaceOwner(owner: string, specs: readonly ToolSpec<never>[], reason: string): string[] {
    const before = new Map([...this.tools].filter(([, d]) => d.owner === owner));
    for (const name of before.keys()) {
      this.tools.delete(name);
      this.validators.delete(name);
    }
    try {
      this.registerAll(owner, specs);
    } catch (err) {
      for (const [name, def] of before) {
        this.tools.set(name, def);
        this.validators.set(name, this.compile(def));
      }
      throw err;
    }
    const kept = new Set(specs.map((s) => s.name));
    const gone = [...before.keys()].filter((n) => !kept.has(n));
    for (const n of gone) this.tombstones.set(n, reason);
    this.version++;
    return gone;
  }

  /** Register several tools of one owner, all or none. */
  registerAll(owner: string, specs: readonly ToolSpec<never>[]): void {
    const done: string[] = [];
    try {
      for (const s of specs) {
        this.register(owner, s);
        done.push(s.name);
      }
    } catch (err) {
      for (const name of done) {
        this.tools.delete(name);
        this.validators.delete(name);
      }
      throw err;
    }
  }

  unregisterOwner(owner: string, reason?: string): string[] {
    const removed: string[] = [];
    for (const [name, def] of this.tools) {
      if (def.owner === owner) {
        this.tools.delete(name);
        this.validators.delete(name);
        if (reason) this.tombstones.set(name, reason);
        removed.push(name);
      }
    }
    if (removed.length) this.version++;
    return removed;
  }

  private compile(spec: ToolSpec<never> | ToolSpec): ValidateFunction {
    try {
      return this.ajv.compile(spec.inputSchema);
    } catch (err) {
      if (!spec.externalSchema) throw err;
      const pass = (() => true) as unknown as ValidateFunction;
      return pass;
    }
  }

  /** Why `name` is not available, if it once was. */
  unavailableReason(name: string): string | undefined {
    return this.tombstones.get(name);
  }

  namesOf(owner: string): string[] {
    return this.list()
      .filter((d) => d.owner === owner)
      .map((d) => d.name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  validate(name: string, input: unknown): { ok: true } | { ok: false; errors: string[] } {
    const v = this.validators.get(name);
    if (!v) return { ok: false, errors: [`unknown tool ${name}`] };
    if (v(input)) return { ok: true };
    return {
      ok: false,
      errors: (v.errors ?? []).map((e) => {
        // Name the choices: the model can correct itself, and a value that just went away is explained.
        const choices = e.keyword === 'enum' ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}` : '';
        return `${e.instancePath || '/'} ${e.message ?? 'invalid'}${choices}`;
      }),
    };
  }

  /** Changes whenever the tool set changes; lets callers detect cache-affecting edits. */
  get revision(): number {
    return this.version;
  }

  list(): ToolDef[] {
    const rank = (d: ToolDef): string => `${ownerRank(d.owner)}:${d.owner}:${d.name}`;
    return [...this.tools.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  }

  forProvider(filter?: (d: ToolDef) => boolean): ProviderToolDef[] {
    // Without tool exposure nothing is held back, so the client-side search tools have no use.
    return this.list()
      .filter((d) => !d.clientSearch && (!filter || filter(d)))
      .map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, ...(d.providerType ? { providerType: d.providerType } : {}) }));
  }
}
