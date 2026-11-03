import crypto from 'node:crypto';
import type { ToolDef } from '../tools/types.js';

export type Policy = 'allow' | 'ask' | 'deny';

export interface PermissionSettings {
  /** Policy for tools no other rule covers. */
  default: Policy;
  /** Exact names or globs (`*`, `?`), e.g. `{ tg_send_chat: ask, "mcp__github__*": ask }`. */
  tools: Record<string, Policy>;
  /** How long an approval request (and an approval) stays valid. */
  approvalTtlMs: number;
}

export interface PolicyDecision {
  policy: Policy;
  /** Which rule decided, for audit records and receipts. */
  rule: string;
}

export interface PolicyDeps {
  /** The plugin manifest lists the tool in `sideEffectTools`. */
  askByDefault: (def: ToolDef) => boolean;
  /** At least one owner identity is configured; otherwise side effects are denied. */
  ownerConfigured: () => boolean;
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** Tool permission policy (docs/10-architecture/14-security-and-permissions.md §2). */
export class PermissionPolicy {
  private globs: Array<{ pattern: string; re: RegExp; policy: Policy }> = [];

  constructor(
    private settings: PermissionSettings,
    private readonly deps: PolicyDeps,
  ) {
    this.update(settings);
  }

  update(settings: PermissionSettings): void {
    this.settings = settings;
    // More specific (longer) patterns first.
    this.globs = Object.entries(settings.tools)
      .filter(([k]) => /[*?]/.test(k))
      .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
      .map(([pattern, policy]) => ({ pattern, re: globToRegExp(pattern), policy }));
  }

  get ttlMs(): number {
    return this.settings.approvalTtlMs;
  }

  decide(def: ToolDef): PolicyDecision {
    if (def.flags?.sideEffect && !this.deps.ownerConfigured()) {
      return { policy: 'deny', rule: 'no owner identity is configured (read-only mode)' };
    }
    const exact = this.settings.tools[def.name];
    if (exact) return { policy: exact, rule: `permissions.tools.${def.name}` };
    const glob = this.globs.find((g) => g.re.test(def.name));
    if (glob) return { policy: glob.policy, rule: `permissions.tools."${glob.pattern}"` };
    if (this.deps.askByDefault(def)) return { policy: 'ask', rule: `sideEffectTools of plugin ${def.owner}` };
    return { policy: this.settings.default, rule: 'permissions.default' };
  }

  /** The policy, stated in advance for the system prompt (P3); null when nothing is restricted. */
  summary(tools: readonly ToolDef[]): string | null {
    const ask: string[] = [];
    const deny: string[] = [];
    for (const t of tools) {
      const d = this.decide(t).policy;
      if (d === 'ask') ask.push(t.name);
      if (d === 'deny') deny.push(t.name);
    }
    if (ask.length === 0 && deny.length === 0) return null;
    const lines = [
      '# Permissions',
      '',
      'Some tools are restricted. Calling a tool that needs approval does not run it: the result says "pending approval <id>" and the owner is asked. An approval.decided event reports the decision; if approved, call the tool again with exactly the same input (the approval is valid once). You can ask ahead of time with approval_request.',
    ];
    if (ask.length > 0) lines.push(`- Needs the owner's approval: ${ask.join(', ')}`);
    if (deny.length > 0) lines.push(`- Not allowed: ${deny.join(', ')}`);
    return lines.join('\n');
  }
}

/** Canonical JSON (sorted keys) so equal inputs hash equally. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function inputHash(tool: string, input: unknown): string {
  return crypto.createHash('sha256').update(`${tool}\n${stableStringify(input)}`).digest('hex');
}
