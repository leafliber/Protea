import type { ChangeAction, ChangeKind, ChangeRequestInfo } from '@protea/protocol';
import type { ToolContext, ToolOutcome, ToolSpec } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import type { ChangeRequestService } from './service.js';

const REASON = { type: 'string', minLength: 1, maxLength: 1000, description: 'Why the owner should approve this, in a sentence or two. They read it when they review.' } as const;

function line(c: ChangeRequestInfo): string {
  const tail = [c.result ? `result: ${c.result}` : '', c.note ? `owner's note: ${c.note}` : ''].filter(Boolean).join('; ');
  return `${c.id} [${c.state}] ${c.summary} (proposed ${c.createdAt}${c.state === 'pending' ? `, expires ${c.expiresAt}` : ''})${tail ? ` — ${tail}` : ''}`;
}

/**
 * `mcp_propose`, `skill_propose`, `plugin_propose`, `change_status`, `change_withdraw`
 * (docs/20-decisions/ADR-0019): the assistant's only way to change its own capabilities. A
 * proposal files a request and changes nothing; an administrator decides it in the console.
 */
export function changeTools(changes: ChangeRequestService): ToolSpec<never>[] {
  const propose = async (kind: ChangeKind, action: ChangeAction, target: string, input: Record<string, unknown>, reason: string, ctx: ToolContext): Promise<ToolOutcome> => {
    try {
      const c = await changes.propose({ kind, action, target, input, reason, sessionId: ctx.sessionId, batchId: ctx.batchId, signal: ctx.signal });
      return {
        text: `Change request ${c.id} is filed: ${c.summary}. Nothing has changed yet. The owner reviews it in the console (审批 → 能力变更), where it can only be approved by hand; tell them it is waiting. The decision arrives as a change.decided event (the request expires ${c.expiresAt}).`,
      };
    } catch (err) {
      return { text: `not filed: ${errorMessage(err)}`, failed: true };
    }
  };

  const mcp: ToolSpec<{ action: ChangeAction; id: string; server?: Record<string, unknown>; reason: string }> = {
    name: 'mcp_propose',
    description:
      'Propose a change to the MCP servers: add one, replace its settings, remove, enable or disable it. This only files a request; the owner must approve it by hand in the console before anything changes. ' +
      'A token is never written here: name a stored secret as ${secret:NAME} and ask the owner to store it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'id', 'reason'],
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'enable', 'disable'] },
        id: { type: 'string', minLength: 1, maxLength: 32, description: 'Server id: lowercase letters, digits and hyphens.' },
        server: {
          type: 'object',
          description:
            'For add and update: the whole entry (update replaces the old one). A local server: { command, args?, env? }. A remote one: { url, auth?: { type: "bearer", token: "${secret:NAME}" } | { type: "oauth" }, headers? }. ' +
            'Optional: trust (low | normal | high), tools: { allow?, deny? }, toolTimeoutMs, envPrompt (when to use it), alwaysLoad.',
        },
        reason: REASON,
      },
    },
    flags: { forkOptIn: true },
    handler: (i, ctx) => propose('mcp', i.action, i.id, i.server !== undefined ? { server: i.server } : {}, i.reason, ctx),
  };

  const skill: ToolSpec<{ action: ChangeAction; name: string; content?: string; files?: Array<{ path: string; content: string }>; from?: string; reason: string }> = {
    name: 'skill_propose',
    description:
      'Propose a change to the skills: add one, replace its files, remove, enable or disable it. This only files a request; the owner must approve it by hand in the console before anything changes. ' +
      'A skill is a directory with a SKILL.md (YAML front matter with name and description, then the instructions) and optional files it refers to.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'name', 'reason'],
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'enable', 'disable'] },
        name: { type: 'string', minLength: 1, maxLength: 64, description: 'Skill name: lowercase letters, digits and hyphens; the same as name in the front matter.' },
        content: { type: 'string', maxLength: 262_144, description: 'For add and update: the whole SKILL.md.' },
        files: {
          type: 'array',
          maxItems: 39,
          description: 'Other files of the skill, next to SKILL.md.',
          items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, content: { type: 'string', maxLength: 262_144 } } },
        },
        from: { type: 'string', maxLength: 1024, description: 'Instead of content: a directory in the workspace that holds the skill.' },
        reason: REASON,
      },
    },
    flags: { forkOptIn: true },
    handler: (i, ctx) =>
      propose('skill', i.action, i.name, { ...(i.content !== undefined ? { content: i.content } : {}), ...(i.files !== undefined ? { files: i.files } : {}), ...(i.from !== undefined ? { from: i.from } : {}) }, i.reason, ctx),
  };

  const plugin: ToolSpec<{ action: 'install' | 'update' | 'remove' | 'enable' | 'disable' | 'configure'; id?: string; source?: Record<string, unknown>; config?: Record<string, unknown>; reason: string }> = {
    name: 'plugin_propose',
    description:
      'Propose a change to the plugins: install one, update it from a new copy, remove, enable, disable or configure it. This only files a request; the owner must approve it by hand in the console before anything changes. ' +
      'The files of an install or update are fetched now and shown to the owner as they are.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'reason'],
      properties: {
        action: { type: 'string', enum: ['install', 'update', 'remove', 'enable', 'disable', 'configure'] },
        id: { type: 'string', minLength: 1, maxLength: 32, description: 'Plugin id. Required except for install, where the manifest names it.' },
        source: {
          type: 'object',
          additionalProperties: false,
          description: 'For install and update: where the plugin directory (with protea.plugin.json) is. Exactly one of path, git, tarball.',
          properties: {
            path: { type: 'string', maxLength: 1024, description: 'A directory in the workspace.' },
            git: { type: 'string', maxLength: 1024, description: 'An https:// repository URL.' },
            ref: { type: 'string', maxLength: 128, description: 'Branch or tag of the repository.' },
            tarball: { type: 'string', maxLength: 1024, description: 'An https:// URL of a .tgz.' },
            subdir: { type: 'string', maxLength: 512, description: 'The plugin directory inside the source.' },
          },
        },
        config: { type: 'object', description: 'For configure: the whole configuration of the plugin (it replaces the old one). Secrets are named, not written.' },
        reason: REASON,
      },
    },
    flags: { forkOptIn: true },
    timeoutMs: 180_000,
    handler: (i, ctx) => {
      if (i.action !== 'install' && !i.id) return { text: 'not filed: id is required', failed: true };
      const input = { ...(i.source !== undefined ? { source: i.source } : {}), ...(i.config !== undefined ? { config: i.config } : {}) };
      return propose('plugin', i.action === 'install' ? 'add' : i.action, i.id ?? '', input, i.reason, ctx);
    },
  };

  const status: ToolSpec<{ id?: string }> = {
    name: 'change_status',
    description: 'Show one change request, or the ones waiting for the owner and the most recent decisions.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
    flags: { readOnly: true, forkOptIn: true },
    handler: (i) => {
      if (i.id !== undefined) {
        const c = changes.get(i.id);
        return c ? line(c) : { text: `no change request ${i.id}`, failed: true };
      }
      const all = changes.list(undefined, 15);
      return all.length === 0 ? 'no change requests' : all.map(line).join('\n');
    },
  };

  const withdraw: ToolSpec<{ id: string }> = {
    name: 'change_withdraw',
    description: 'Take back a change request that is still waiting for the owner.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    flags: { forkOptIn: true },
    handler: async (i) => {
      const r = await changes.withdraw(i.id);
      return r.ok ? `change request ${i.id} is withdrawn` : { text: r.message ?? 'not withdrawn', failed: true };
    },
  };

  return [mcp, skill, plugin, status, withdraw] as unknown as ToolSpec<never>[];
}
