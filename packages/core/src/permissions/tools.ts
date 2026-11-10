import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import type { ApprovalService } from './approvals.js';
import type { PermissionModes } from './modes.js';
import type { PermissionPolicy } from './policy.js';

/** `approval_request`: ask the owner ahead of a call that needs approval (docs/10-architecture/05-sessions-and-agent-loop.md §9). */
export function approvalTools(deps: { approvals: ApprovalService; policy: PermissionPolicy; tools: ToolRegistry; modes?: PermissionModes }): ToolSpec<never>[] {
  const request: ToolSpec<{ tool: string; input: unknown; reason: string }> = {
    name: 'approval_request',
    description:
      'Ask the owner in advance to approve one specific call of a tool that needs approval. Give the exact input you will use and a short reason. ' +
      'The decision arrives as an approval.decided event; then call the tool with that same input.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tool', 'input', 'reason'],
      properties: {
        tool: { type: 'string' },
        input: { description: 'The exact input of the planned call.' },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    handler: async (i, ctx) => {
      const def = deps.tools.get(i.tool);
      if (!def) return { text: `no tool ${i.tool}`, failed: true };
      const d = deps.policy.decide(def);
      if (d.policy === 'allow') return `${i.tool} does not need approval; call it directly`;
      if (d.policy === 'deny') return { text: `${i.tool} is denied by policy (${d.rule}); approval cannot change that`, failed: true };
      const mode = deps.modes?.current() ?? 'ask';
      if (mode === 'locked') return { text: `${i.tool} cannot run: the owner has locked permissions, and is not being asked for now`, failed: true };
      if (mode === 'bypass' && !d.pinned) return `${i.tool} does not need approval right now; call it directly`;
      const a = await deps.approvals.request({ tool: def.name, owner: def.owner, input: i.input, reason: i.reason, sessionId: ctx.sessionId, batchId: ctx.batchId });
      return `approval ${a.id} is ${a.state}; the owner has been asked (expires ${a.expiresAt})`;
    },
  };
  return [request as unknown as ToolSpec<never>];
}
