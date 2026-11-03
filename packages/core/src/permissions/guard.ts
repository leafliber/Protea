import type { ToolResultBlock, ToolUseBlock } from '@protea/protocol';
import type { ToolDef } from '../tools/types.js';
import type { ApprovalService } from './approvals.js';
import type { AuditLog } from './audit.js';
import { inputHash, type PermissionPolicy, type Policy } from './policy.js';

export interface GuardContext {
  sessionId: string;
  batchId: string;
}

export type GuardDecision =
  | { action: 'run'; policy: Policy; rule: string; audit: boolean; approvalId?: string }
  | { action: 'block'; policy: Policy; rule: string; text: string; isError: boolean };

/** What the dispatcher asks before and after each call. */
export interface ToolGuard {
  check(def: ToolDef, use: ToolUseBlock, ctx: GuardContext): Promise<GuardDecision> | GuardDecision;
  after(def: ToolDef, use: ToolUseBlock, ctx: GuardContext, decision: GuardDecision, result: ToolResultBlock): void;
}

/**
 * Applies the permission policy and the approval flow to every tool call, and audits
 * every call with side effects or a non-`allow` policy (invariant I-8).
 */
export class PermissionGuard implements ToolGuard {
  constructor(
    private readonly policy: PermissionPolicy,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditLog,
  ) {}

  async check(def: ToolDef, use: ToolUseBlock, ctx: GuardContext): Promise<GuardDecision> {
    const { policy, rule } = this.policy.decide(def);
    const audit = policy !== 'allow' || !!def.flags?.sideEffect;
    if (policy === 'allow') return { action: 'run', policy, rule, audit };
    if (policy === 'deny') {
      this.record(def, use, ctx, policy, 'denied', rule);
      return { action: 'block', policy, rule, text: `not run: ${def.name} is denied by policy (${rule})`, isError: true };
    }
    const approved = this.approvals.consume(def.name, use.input);
    if (approved) return { action: 'run', policy, rule, audit: true, approvalId: approved };
    const a = await this.approvals.request({ tool: def.name, owner: def.owner, input: use.input, sessionId: ctx.sessionId, batchId: ctx.batchId });
    this.record(def, use, ctx, policy, 'pending_approval', rule, a.id);
    return {
      action: 'block',
      policy,
      rule,
      isError: false,
      text: `pending approval ${a.id}: ${def.name} needs the owner's approval and did not run. The owner has been asked; an approval.decided event will report the decision (the request expires at ${a.expiresAt}).`,
    };
  }

  after(def: ToolDef, use: ToolUseBlock, ctx: GuardContext, decision: GuardDecision, result: ToolResultBlock): void {
    if (decision.action !== 'run' || !decision.audit) return;
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    this.record(def, use, ctx, decision.policy, result.is_error ? 'failed' : 'ok', decision.rule, decision.approvalId, text.slice(0, 200));
  }

  private record(
    def: ToolDef,
    use: ToolUseBlock,
    ctx: GuardContext,
    policy: Policy,
    outcome: string,
    rule: string,
    approvalId?: string,
    detail?: string,
  ): void {
    this.audit.record({
      kind: outcome === 'denied' || outcome === 'pending_approval' ? 'tool_blocked' : 'tool_call',
      tool: def.name,
      owner: def.owner,
      sessionId: ctx.sessionId,
      batchId: ctx.batchId,
      callId: use.id,
      inputHash: inputHash(def.name, use.input),
      summary: this.approvals.summarize(def.name, use.input),
      policy: `${policy} (${rule})`,
      outcome,
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}
