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
  private readonly ajv = createAjv();
  private version = 0;

  register<I>(owner: string, spec: ToolSpec<I>): void {
    if (!NAME_RE.test(spec.name)) throw new Error(`invalid tool name "${spec.name}"`);
    const existing = this.tools.get(spec.name);
    if (existing) throw new Error(`tool name "${spec.name}" is already declared by ${existing.owner}`);
    this.validators.set(spec.name, this.ajv.compile(spec.inputSchema));
    this.tools.set(spec.name, { ...(spec as ToolSpec), owner });
    this.version++;
  }

  unregisterOwner(owner: string): string[] {
    const removed: string[] = [];
    for (const [name, def] of this.tools) {
      if (def.owner === owner) {
        this.tools.delete(name);
        this.validators.delete(name);
        removed.push(name);
      }
    }
    if (removed.length) this.version++;
    return removed;
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
