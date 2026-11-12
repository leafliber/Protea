import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import type { ApprovalService } from './approvals.js';
import { askedOn, inWords } from './guard.js';
import type { PermissionModes } from './modes.js';
import type { PermissionPolicy } from './policy.js';

/** `approval_request`: ask the owner ahead of a call that needs approval (docs/10-architecture/05-sessions-and-agent-loop.md §9). */
export function approvalTools(deps: {
  approvals: ApprovalService;
  policy: PermissionPolicy;
  tools: ToolRegistry;
  modes?: PermissionModes;
  /** The platforms that can show a request now; without it any name is taken. */
  platforms?: () => string[];
}): ToolSpec<never>[] {
  const request: ToolSpec<{ tool: string; input: unknown; reason: string; platforms?: string[] }> = {
    name: 'approval_request',
    description:
      'Ask the owner to approve one specific call of a tool that needs approval, without calling the tool. Use it when you know ahead that you will need the tool, ' +
      'or to show a request that is still waiting on another platform (same tool and input: nobody answered where it was first shown). ' +
      'Give the exact input you will use. The decision arrives as an approval.decided event; then call the tool with that same input.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tool', 'input', 'reason'],
      properties: {
        tool: { type: 'string' },
        input: { description: 'The exact input of the planned call.' },
        reason: { type: 'string', minLength: 1, maxLength: 500, description: "One sentence in the owner's language: what this is for. The owner already sees the call itself." },
        platforms: { type: 'array', items: { type: 'string' }, description: 'Where to ask, e.g. the platform of the message you are answering. Leave it out to ask on every platform.' },
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
      const running = deps.platforms?.();
      const unknown = running ? (i.platforms ?? []).filter((p) => !running.includes(p)) : [];
      if (unknown.length > 0) return { text: `cannot ask on ${unknown.join(', ')}: ${running?.length ? `the platforms that can show a request now are ${running.join(', ')}` : 'no platform can show a request now'}. Leave platforms out to ask everywhere.`, failed: true };
      const a = await deps.approvals.request({ tool: def.name, owner: def.owner, input: i.input, reason: i.reason, ...(i.platforms?.length ? { platforms: i.platforms } : {}), sessionId: ctx.sessionId, batchId: ctx.batchId });
      return `approval ${a.id} is ${a.state}. ${askedOn(a, i.platforms)} The request expires ${inWords(Date.parse(a.expiresAt) - Date.parse(a.createdAt))}; an approval.decided event will report the decision.`;
    },
  };
  return [request as unknown as ToolSpec<never>];
}
