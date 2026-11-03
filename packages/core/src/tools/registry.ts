import type { ValidateFunction } from 'ajv';
import { createAjv } from '../events/validate.js';
import type { ToolDef, ToolSpec } from './types.js';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ProviderToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * All tools visible to the model. Ordering is deterministic (core, then plugins by id,
 * then by name) so the serialized tool list is byte-stable for prompt caching.
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
    this.validators.set(spec.name, this.ajv.compile(spec.inputSchema));
    this.tools.set(spec.name, { ...(spec as ToolSpec), owner });
    this.tombstones.delete(spec.name);
    this.version++;
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
    return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`) };
  }

  /** Changes whenever the tool set changes; lets callers detect cache-affecting edits. */
  get revision(): number {
    return this.version;
  }

  list(): ToolDef[] {
    const rank = (d: ToolDef): string => `${d.owner === 'core' ? '0' : '1'}:${d.owner}:${d.name}`;
    return [...this.tools.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  }

  forProvider(filter?: (d: ToolDef) => boolean): ProviderToolDef[] {
    return this.list()
      .filter((d) => !filter || filter(d))
      .map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
  }
}
