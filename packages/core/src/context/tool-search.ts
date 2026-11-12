import type { ModelRole, TranscriptMessage } from '@protea/protocol';
import type { ProviderToolDef, ToolRegistry } from '../tools/registry.js';
import type { ToolDef, ToolSpec } from '../tools/types.js';
import { estimateTokens } from '../util/tokens.js';
import type { ToolSearchSettings } from './settings.js';

/** Name of the provider's search tool as it appears in server_tool_use blocks. */
export const TOOL_SEARCH_NAMES = new Set(['tool_search_tool_regex', 'tool_search_tool_bm25']);

/** The client-side search: for providers that cannot search deferred tools themselves. */
export const TOOL_SEARCH = 'tool_search';
export const TOOL_CALL = 'tool_call';

const SEARCH_DEFAULT = 5;
const SEARCH_MAX = 20;
/** A tool's description in a search result; its schema is never cut. */
const RESULT_DESCRIPTION_CHARS = 2000;
const CATALOG_NOTE_CHARS = 400;

/**
 * How deferred tools reach the model.
 * - `native`: the provider searches them (`defer_loading` + its tool search tool).
 * - `client`: they are left out of the request; the model finds them with `tool_search` and
 *   runs them through `tool_call`. The tool list stays the same for the whole conversation.
 */
export type ToolSearchMode = 'native' | 'client';

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
  /** What a tool owner says about itself (an MCP server's `instructions`); shown in the catalog. */
  ownerNote?: (owner: string) => string | undefined;
}

export interface ToolSearchHit {
  name: string;
  owner: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function definitionTokens(d: ToolDef): number {
  return estimateTokens(JSON.stringify({ name: d.name, description: d.description, input_schema: d.inputSchema }));
}

/** What the model calls a tool owner: `browser` for the MCP server `mcp:browser`, a plugin's id for a plugin. */
function sourceOf(owner: string): string {
  return owner.startsWith('mcp:') ? owner.slice(4) : owner;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/**
 * Decides which tool definitions load up front (docs/10-architecture/12-model-providers.md §5).
 * Kernel tools always load, and so do the tools of owners set to always load (by default
 * connectors and in-process plugins). The other plugins' and the MCP servers' tools are
 * deferred once there are many tools or their definitions are large, except each owner's
 * most-used few. The plan only changes when the tool set or the settings change, so the loaded
 * set — part of the cached prefix — stays byte-stable.
 */
export class ToolExposure {
  private planKey = '';
  private deferred = new Set<string>();
  /** Per owner: the loaded subset, kept while that owner's tool list is unchanged. */
  private readonly pinnedByOwner = new Map<string, { key: string; pinned: Set<string> }>();

  constructor(private readonly o: ToolExposureOptions) {}

  modeFor(role: ModelRole): ToolSearchMode {
    return this.o.supported(role) ? 'native' : 'client';
  }

  /** The tools of one request: `allowed` restricts them (forks); history keeps tool search on once used. */
  forRequest(messages: readonly TranscriptMessage[], opts: { role: ModelRole; allowed?: ReadonlySet<string> }): ToolSet {
    const all = this.o.tools.list();
    const deferred = this.plan(all);
    const mine = (d: ToolDef): boolean => d.clientSearch === true || !opts.allowed || opts.allowed.has(d.name);
    const def = (d: ToolDef): ProviderToolDef => ({
      name: d.name,
      description: d.description,
      inputSchema: this.o.tools.schemaFor(d),
    });

    if (this.modeFor(opts.role) === 'client') {
      const held = all.some((d) => deferred.has(d.name) && mine(d));
      // The search tools are part of the list only while something is held back: it changes when the plan does.
      const tools = all.filter((d) => mine(d) && !deferred.has(d.name) && (d.clientSearch ? held : true)).map(def);
      return { tools, toolSearch: false };
    }

    const referenced = referencedTools(messages);
    const tools: ProviderToolDef[] = all
      .filter((d) => mine(d) && !d.clientSearch)
      .map((d) => ({ ...def(d), ...(deferred.has(d.name) ? { deferLoading: true } : {}) }));
    let toolSearch = tools.some((t) => t.deferLoading);
    if (referenced.searched || referenced.names.size > 0) {
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

  /** A tool the model has to find before it can call it. */
  isDeferred(name: string): boolean {
    return this.plan(this.o.tools.list()).has(name);
  }

  /** Deferred tools, by owner, that a session may use. */
  private held(allowed?: ReadonlySet<string>): Map<string, ToolDef[]> {
    const all = this.o.tools.list();
    const deferred = this.plan(all);
    const out = new Map<string, ToolDef[]>();
    for (const d of all) {
      if (!deferred.has(d.name) || (allowed && !allowed.has(d.name))) continue;
      out.set(d.owner, [...(out.get(d.owner) ?? []), d]);
    }
    return out;
  }

  /**
   * What a client-mode session is told about the tools held back: per MCP server or plugin,
   * what it is for and the names it offers. Null when nothing is held back for this role.
   */
  catalog(role: ModelRole, allowed?: ReadonlySet<string>): string | null {
    if (this.modeFor(role) !== 'client') return null;
    const held = this.held(allowed);
    if (held.size === 0) return null;
    const lines = [
      '# Tools on demand',
      '',
      `The tools below are not in your tool list, to keep it short. ${TOOL_SEARCH} returns the description and input schema of the ones that match; ${TOOL_CALL} runs one by its full name. Look a tool up before you first call it in a conversation.`,
      '',
    ];
    for (const [owner, defs] of held) {
      const source = sourceOf(owner);
      const note = this.o.ownerNote?.(owner)?.replace(/\s+/g, ' ').trim();
      const count = `${defs.length} tool${defs.length === 1 ? '' : 's'}`;
      // An MCP tool's full name carries its server; a plugin's tools are listed by their full names.
      const prefix = owner.startsWith('mcp:') ? `mcp__${source}__` : '';
      const names = defs.map((d) => (prefix && d.name.startsWith(prefix) ? d.name.slice(prefix.length) : d.name));
      const what = prefix ? `MCP server, ${count}, full name ${prefix}<tool>` : `plugin, ${count}`;
      lines.push(`- ${source} (${what})${note ? `: ${note.length > CATALOG_NOTE_CHARS ? `${note.slice(0, CATALOG_NOTE_CHARS)}…` : note}` : ''}`);
      lines.push(`  ${names.join(', ')}`);
    }
    return lines.join('\n');
  }

  /** Deferred tools matching the words of `query` (best first), or all of one source's (an MCP server or a plugin). */
  search(q: { query?: string; source?: string; limit?: number; allowed?: ReadonlySet<string> }): { hits: ToolSearchHit[]; more: string[]; sources: string[] } {
    const held = this.held(q.allowed);
    const sources = [...new Set([...held.keys()].map(sourceOf))].sort();
    let pool = [...held.entries()].flatMap(([owner, defs]) => (q.source === undefined || sourceOf(owner) === q.source ? defs : []));
    const terms = words(q.query ?? '');
    if (terms.length > 0) {
      const scored = pool
        .map((d) => {
          const name = d.name.toLowerCase();
          const text = d.description.toLowerCase();
          let score = 0;
          for (const t of terms) score += (name.includes(t) ? 3 : 0) + (text.includes(t) ? 1 : 0);
          return { d, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.d.name < b.d.name ? -1 : 1));
      pool = scored.map((x) => x.d);
    }
    const limit = Math.min(SEARCH_MAX, Math.max(1, q.limit ?? SEARCH_DEFAULT));
    return {
      hits: pool.slice(0, limit).map((d) => ({ name: d.name, owner: d.owner, description: d.description, inputSchema: this.o.tools.schemaFor(d) })),
      more: pool.slice(limit).map((d) => d.name),
      sources,
    };
  }

  private plan(all: readonly ToolDef[]): Set<string> {
    const s = this.o.settings();
    const key = `${this.o.tools.revision}|${s.mode}|${s.threshold}|${s.thresholdTokens}|${s.keepPerOwner}`;
    if (key === this.planKey) return this.deferred;
    this.planKey = key;
    const deferred = new Set<string>();
    const deferrable = all.filter((d) => d.deferrable);
    // The search tools exist for the deferred ones: they do not count towards the threshold.
    const count = all.filter((d) => !d.clientSearch).length;
    const heavy = (): boolean => s.thresholdTokens > 0 && deferrable.reduce((n, d) => n + definitionTokens(d), 0) > s.thresholdTokens;
    const active = s.mode === 'always' || (s.mode === 'auto' && (count > s.threshold || heavy()));
    if (s.mode !== 'never' && active && deferrable.length > 0) {
      const byOwner = new Map<string, ToolDef[]>();
      for (const d of deferrable) byOwner.set(d.owner, [...(byOwner.get(d.owner) ?? []), d]);
      for (const [owner, group] of byOwner) {
        const pinned = this.pinned(owner, group, s.keepPerOwner);
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

/**
 * `tool_search` and `tool_call`: how a model on a provider without tool search reaches the tools
 * held back (MCP servers' and plugins'). Nothing about them changes during a conversation, so
 * the cached prefix holds; what a search returns is appended to the history like any tool result.
 */
export function clientSearchTools(exposure: ToolExposure, tools: ToolRegistry): ToolSpec<never>[] {
  const search: ToolSpec<{ query?: string; source?: string; limit?: number }> = {
    name: TOOL_SEARCH,
    description:
      'Find tools that are not in your tool list. Returns the full name, description and input schema of the tools matching the query ' +
      `(words from a tool's name or what it does), or of one source's tools (an MCP server or a plugin). Run a result with ${TOOL_CALL}.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 300, description: 'Words to match against tool names and descriptions.' },
        source: { type: 'string', maxLength: 64, description: 'Only this MCP server or plugin. Without a query, lists its tools.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX, default: SEARCH_DEFAULT, description: 'How many tools to return with their schema.' },
      },
    },
    flags: { readOnly: true },
    clientSearch: true,
    handler: (input, ctx) => {
      if (!input.query?.trim() && input.source === undefined) return { text: 'give a query, a source, or both', failed: true };
      const r = exposure.search({ ...input, ...(ctx.allowed ? { allowed: ctx.allowed } : {}) });
      if (input.source !== undefined && !r.sources.includes(input.source)) {
        return { text: `no tools are held back for ${input.source}; sources with such tools: ${r.sources.join(', ') || 'none'}`, failed: true };
      }
      if (r.hits.length === 0) return `no tool matches. Sources with tools on demand: ${r.sources.join(', ') || 'none'}. Try other words, or list one source's tools.`;
      const blocks = r.hits.map((h) => {
        const description = h.description.length > RESULT_DESCRIPTION_CHARS ? `${h.description.slice(0, RESULT_DESCRIPTION_CHARS)}…` : h.description;
        return `## ${h.name}\n${description}\ninput schema: ${JSON.stringify(h.inputSchema)}`;
      });
      const more = r.more.length > 0 ? `\n\nAlso matching, without schema (search again to get it): ${r.more.join(', ')}` : '';
      return `${r.hits.length} tool${r.hits.length === 1 ? '' : 's'}. Run one with ${TOOL_CALL} { name, arguments }.\n\n${blocks.join('\n\n')}${more}`;
    },
  };

  const call: ToolSpec<{ name: string; arguments?: Record<string, unknown> }> = {
    name: TOOL_CALL,
    description: `Run a tool that is not in your tool list, by the full name ${TOOL_SEARCH} gave. The same permissions apply as if you had called the tool directly.`,
    inputSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64, description: 'Full tool name, as the search gave it.' },
        arguments: { type: 'object', description: "The tool's input, following its input schema." },
      },
    },
    clientSearch: true,
    redirect: (input) => {
      const target = tools.get(input.name);
      if (!target) {
        const why = tools.unavailableReason(input.name);
        return { error: `there is no tool ${input.name}${why ? ` (${why})` : ''}; use ${TOOL_SEARCH} to find the name` };
      }
      if (!target.deferrable) return { error: `${input.name} is in your tool list: call it directly` };
      return { name: target.name, input: input.arguments ?? {} };
    },
    // Never reached: the dispatcher runs the tool the call redirects to.
    handler: () => ({ text: `${TOOL_CALL} was not redirected`, failed: true }),
  };

  return [search, call] as unknown as ToolSpec<never>[];
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
