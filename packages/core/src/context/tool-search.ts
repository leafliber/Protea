import type { ModelRole, TranscriptMessage } from '@protea/protocol';
import type { ProviderToolDef, ToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';

export interface ToolSearchSettings {
  /** auto: defer MCP tools once the tool count passes `threshold`; always: defer whenever possible; never. */
  mode: 'auto' | 'always' | 'never';
  threshold: number;
  /** The most-called tools of each MCP server stay loaded. */
  keepPerServer: number;
}

export const DEFAULT_TOOL_SEARCH: ToolSearchSettings = { mode: 'auto', threshold: 40, keepPerServer: 3 };

/** Name of the provider's search tool as it appears in server_tool_use blocks. */
export const TOOL_SEARCH_NAMES = new Set(['tool_search_tool_regex', 'tool_search_tool_bm25']);

export interface ToolSet {
  tools: ProviderToolDef[];
  /** Declare the provider's tool search tool (some tools carry deferLoading). */
  toolSearch: boolean;
}

export interface ToolExposureOptions {
  tools: ToolRegistry;
  settings: () => ToolSearchSettings;
  /** How often a tool was called (all time); ranks the tools that stay loaded. */
  usage: (name: string) => number;
  /** The provider can search deferred tools for this role. */
  supported: (role: ModelRole) => boolean;
}

/**
 * Decides which tool definitions load up front (docs/10-architecture/12-model-providers.md §4).
 * Kernel and plugin tools always load; MCP tools are deferred once there are many tools,
 * except each server's most-used few. The plan only changes when the tool set or the
 * settings change, so the loaded set — part of the cached prefix — stays byte-stable.
 */
export class ToolExposure {
  private planKey = '';
  private deferred = new Set<string>();
  /** Per owner: the loaded subset, kept while that owner's tool list is unchanged. */
  private readonly pinnedByOwner = new Map<string, { key: string; pinned: Set<string> }>();

  constructor(private readonly o: ToolExposureOptions) {}

  /** The tools of one request: `allowed` restricts them (forks); history keeps tool search on once used. */
  forRequest(messages: readonly TranscriptMessage[], opts: { role: ModelRole; allowed?: ReadonlySet<string> }): ToolSet {
    const all = this.o.tools.list();
    const defs = opts.allowed ? all.filter((d) => opts.allowed?.has(d.name)) : all;
    const referenced = referencedTools(messages);
    const supported = this.o.supported(opts.role);
    const deferred = supported ? this.plan(all) : new Set<string>();
    const tools: ProviderToolDef[] = defs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      ...(deferred.has(d.name) ? { deferLoading: true } : {}),
    }));
    let toolSearch = tools.some((t) => t.deferLoading);
    if (supported && (referenced.searched || referenced.names.size > 0)) {
      // Earlier search results refer to tools by name: every one needs a definition, or the request is rejected.
      toolSearch = true;
      const have = new Set(tools.map((t) => t.name));
      for (const name of [...referenced.names].sort()) {
        if (have.has(name)) continue;
        const why = this.o.tools.unavailableReason(name);
        tools.push({
          name,
          description: `No longer available${why ? `: ${why}` : ''}. Do not call it.`,
          inputSchema: { type: 'object', properties: {} },
          deferLoading: true,
        });
      }
    }
    return { tools, toolSearch };
  }

  /** Names deferred under the current plan (for status and tests). */
  deferredNames(): string[] {
    return [...this.plan(this.o.tools.list())].sort();
  }

  private plan(all: readonly ToolDef[]): Set<string> {
    const s = this.o.settings();
    const key = `${this.o.tools.revision}|${s.mode}|${s.threshold}|${s.keepPerServer}`;
    if (key === this.planKey) return this.deferred;
    this.planKey = key;
    const deferred = new Set<string>();
    const deferrable = all.filter((d) => d.deferrable);
    const active = s.mode === 'always' || (s.mode === 'auto' && all.length > s.threshold);
    if (s.mode !== 'never' && active && deferrable.length > 0) {
      const byOwner = new Map<string, ToolDef[]>();
      for (const d of deferrable) byOwner.set(d.owner, [...(byOwner.get(d.owner) ?? []), d]);
      for (const [owner, group] of byOwner) {
        const pinned = this.pinned(owner, group, s.keepPerServer);
        for (const d of group) if (!pinned.has(d.name)) deferred.add(d.name);
      }
    }
    this.deferred = deferred;
    return deferred;
  }

  private pinned(owner: string, group: readonly ToolDef[], keep: number): Set<string> {
    const key = `${keep}|${group.map((d) => d.name).join(',')}`;
    const memo = this.pinnedByOwner.get(owner);
    if (memo?.key === key) return memo.pinned;
    const ranked = [...group].sort((a, b) => this.o.usage(b.name) - this.o.usage(a.name) || (a.name < b.name ? -1 : 1));
    const pinned = new Set(ranked.slice(0, keep).map((d) => d.name));
    this.pinnedByOwner.set(owner, { key, pinned });
    return pinned;
  }
}

/** Tool names that earlier tool search results in the history refer to. */
export function referencedTools(messages: readonly TranscriptMessage[]): { names: Set<string>; searched: boolean } {
  const names = new Set<string>();
  let searched = false;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b['type'] === 'server_tool_use' && TOOL_SEARCH_NAMES.has(String(b['name']))) searched = true;
      if (b['type'] !== 'tool_search_tool_result') continue;
      searched = true;
      const content = b['content'] as { tool_references?: Array<{ tool_name?: unknown }> } | undefined;
      for (const r of content?.tool_references ?? []) if (typeof r.tool_name === 'string') names.add(r.tool_name);
    }
  }
  return { names, searched };
}
