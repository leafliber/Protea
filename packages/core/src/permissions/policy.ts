import crypto from 'node:crypto';
import type { PermissionMode } from '@protea/protocol';
import type { ToolDef } from '../tools/types.js';
import { globToRegExp } from '../util/glob.js';

export type Policy = 'allow' | 'ask' | 'deny';

/** The modes config.yaml can hold; bypass only exists with a time limit. */
export type BaselineMode = Exclude<PermissionMode, 'bypass'>;

/** Auto mode (docs/30-specs/04-config-reference.md). The three texts are the owner's standing rules for the judge. */
export interface AutoModeSettings {
  /** What this assistant is and what it works with. */
  environment: string;
  /** What the judge may let through. */
  allow: string;
  /** What must always reach the owner; wins over `allow`. */
  ask: string;
  timeoutMs: number;
  /** Auto mode pauses after this many holds in a row. */
  pauseAfterConsecutive: number;
  /** Auto mode pauses after this many holds in an hour. */
  pauseAfterPerHour: number;
}

export interface PermissionSettings {
  /** Policy for tools no other rule covers. */
  default: Policy;
  /** Exact names or globs (`*`, `?`), e.g. `{ tg_send_chat: ask, "mcp__github__*": ask }`. */
  tools: Record<string, Policy>;
  /** How long an approval request (and an approval) stays valid. */
  approvalTtlMs: number;
  /** The longest time-limited grant the owner can give with an approval; 0 turns grants off. */
  grantMaxMs: number;
  /** Who clears `ask` calls when no temporary mode is set. */
  mode: BaselineMode;
  auto: AutoModeSettings;
}

export interface PolicyDecision {
  policy: Policy;
  /** Which rule decided, for audit records and receipts. */
  rule: string;
  /** An `ask` the owner wrote in `permissions.tools`: only the owner can clear it, in every mode but locked. */
  pinned?: boolean;
}

export interface PolicyDeps {
  /** The plugin manifest lists the tool in `sideEffectTools`. */
  askByDefault: (def: ToolDef) => boolean;
  /** At least one owner identity is configured; otherwise side effects are denied. */
  ownerConfigured: () => boolean;
  /** Defaults from tool annotations and server trust (MCP), after the manifest rule. */
  annotations?: (def: ToolDef) => PolicyDecision | null;
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
    if (exact) return { policy: exact, rule: `permissions.tools.${def.name}`, ...(exact === 'ask' ? { pinned: true } : {}) };
    const glob = this.globs.find((g) => g.re.test(def.name));
    if (glob) return { policy: glob.policy, rule: `permissions.tools."${glob.pattern}"`, ...(glob.policy === 'ask' ? { pinned: true } : {}) };
    if (this.deps.askByDefault(def)) return { policy: 'ask', rule: `sideEffectTools of plugin ${def.owner}` };
    const annotated = this.deps.annotations?.(def);
    if (annotated) return annotated;
    return { policy: this.settings.default, rule: 'permissions.default' };
  }

  /** The policy and the mode, stated in advance for the system prompt (P3); null when nothing is restricted. */
  summary(tools: readonly ToolDef[], mode: PermissionMode = 'ask'): string | null {
    const ask: string[] = [];
    const reviewable: string[] = [];
    const pinned: string[] = [];
    const deny: string[] = [];
    for (const t of tools) {
      const d = this.decide(t);
      if (d.policy === 'ask') {
        ask.push(t.name);
        (d.pinned ? pinned : reviewable).push(t.name);
      }
      if (d.policy === 'deny') deny.push(t.name);
    }
    if (ask.length === 0 && deny.length === 0) return null;
    const flow = 'Calling a tool that needs approval does not run it: the result says "pending approval <id>" and the owner is asked. An approval.decided event reports the decision; if approved, call the tool again with exactly the same input (the approval is valid once). You can ask ahead of time with approval_request.';
    const lines = ['# Permissions', ''];
    const needs = "- Needs the owner's approval: ";
    if (mode === 'locked') {
      lines.push('Some tools are restricted. Permission mode: locked. Tools that need approval do not run and the owner is not asked; do not call them, and tell the owner if you need one.');
      if (ask.length > 0) lines.push(`- Locked: ${ask.join(', ')}`);
    } else if (mode === 'bypass') {
      lines.push(`Some tools are restricted. Permission mode: bypass, for a limited time. Tools that normally need approval run without asking, and every call is recorded.${pinned.length > 0 ? ` ${flow}` : ''}`);
      if (pinned.length > 0) lines.push(`${needs}${pinned.join(', ')}`);
    } else if (mode === 'auto') {
      lines.push(`Some tools are restricted. Permission mode: auto. An automatic review decides each call of a reviewed tool: it either runs at once, or comes back held for the owner. ${flow} After a call was held, do not try to reach the same result another way.`);
      if (reviewable.length > 0) lines.push(`- Reviewed automatically: ${reviewable.join(', ')}`);
      if (pinned.length > 0) lines.push(`${needs}${pinned.join(', ')}`);
    } else {
      lines.push(`Some tools are restricted. ${flow}`);
      if (ask.length > 0) lines.push(`${needs}${ask.join(', ')}`);
    }
    if (deny.length > 0) lines.push(`- Not allowed: ${deny.join(', ')}`);
    return lines.join('\n');
  }
}

/**
 * What a time-limited grant covers: one plugin's tools or one MCP server's, or a single tool
 * of Core, whose tools have nothing to do with each other.
 */
export function grantFamily(def: Pick<ToolDef, 'name' | 'owner'>): string {
  return def.owner === 'core' || def.owner === 'mcp' ? def.name : def.owner;
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
