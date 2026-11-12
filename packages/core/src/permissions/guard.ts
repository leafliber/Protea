import type { Level, ToolResultBlock, ToolUseBlock } from '@protea/protocol';
import type { ToolDef } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import type { ApprovalService } from './approvals.js';
import type { AuditLog } from './audit.js';
import type { JudgeContextSource, JudgeVerdict, PermissionJudge } from './judge.js';
import type { PermissionModes } from './modes.js';
import { grantFamily, inputHash, type PermissionPolicy, type Policy } from './policy.js';

export interface GuardContext {
  sessionId: string;
  batchId: string;
  level?: Level;
  /** Ends a review in progress when the turn is cancelled or interrupted. */
  signal?: AbortSignal;
  /** What the call said for the owner (`_approval`): why, and where to ask. */
  approval?: { reason?: string; platforms?: string[] };
}

/** "in 10 minutes", for a receipt the model reads. */
export function inWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return h < 48 ? `in ${h} hours` : `in ${Math.round(h / 24)} days`;
}

/** Where a request was shown, for a receipt: "The owner was asked on qq." */
export function askedOn(a: { deliveredTo?: string[] }, wanted?: readonly string[]): string {
  const on = a.deliveredTo ?? [];
  if (on.length === 0) return 'No chat platform could show the request; the owner can still decide it in the console.';
  const missed = wanted?.filter((p) => !on.includes(p)) ?? [];
  return `The owner was asked on ${on.join(', ')}${missed.length > 0 ? ` (${missed.join(', ')} could not show it)` : ''}.`;
}

export type GuardDecision =
  | { action: 'run'; policy: Policy; rule: string; audit: boolean; approvalId?: string }
  | { action: 'block'; policy: Policy; rule: string; text: string; isError: boolean };

/** What the dispatcher asks before and after each call. */
export interface ToolGuard {
  check(def: ToolDef, use: ToolUseBlock, ctx: GuardContext): Promise<GuardDecision> | GuardDecision;
  after(def: ToolDef, use: ToolUseBlock, ctx: GuardContext, decision: GuardDecision, result: ToolResultBlock): void;
}

/** What auto mode needs. */
export interface AutoReview {
  judge: PermissionJudge;
  context: JudgeContextSource;
  timeoutMs: () => number;
  /** Why no model may be called at this level now (budget), or null. */
  refusal?: (level: Level) => string | null;
}

/**
 * Applies the permission policy, the mode and the approval flow to every tool call, and
 * audits every call with side effects or a non-`allow` policy (invariant I-8). Without
 * `modes` every `ask` goes to the owner.
 */
export class PermissionGuard implements ToolGuard {
  constructor(
    private readonly policy: PermissionPolicy,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditLog,
    private readonly modes?: PermissionModes,
    private readonly review?: AutoReview,
  ) {}

  async check(def: ToolDef, use: ToolUseBlock, ctx: GuardContext): Promise<GuardDecision> {
    const decision = await this.decide(def, use, ctx);
    this.review?.context.note(ctx.batchId, {
      name: def.name,
      input: use.input,
      outcome: decision.action === 'run' ? 'ran' : decision.isError ? 'blocked' : 'held',
    });
    return decision;
  }

  private async decide(def: ToolDef, use: ToolUseBlock, ctx: GuardContext): Promise<GuardDecision> {
    const decided = this.policy.decide(def);
    let { policy, rule } = decided;
    let pinned = decided.pinned;
    // A call that needs the owner because of what it does here (askWhen), whatever the policy says.
    if (policy !== 'deny') {
      const why = def.askWhen?.(use.input as never, { sessionId: ctx.sessionId, batchId: ctx.batchId }) ?? null;
      if (why) {
        policy = 'ask';
        rule = why;
        pinned = true;
      }
    }
    const audit = policy !== 'allow' || !!def.flags?.sideEffect;
    if (policy === 'allow') return { action: 'run', policy, rule, audit };
    if (policy === 'deny') {
      this.record(def, use, ctx, policy, 'denied', rule);
      return { action: 'block', policy, rule, text: `not run: ${def.name} is denied by policy (${rule})`, isError: true };
    }
    const mode = this.modes?.current() ?? 'ask';
    if (mode === 'locked') {
      this.record(def, use, ctx, policy, 'denied', `${rule}; mode locked`);
      return { action: 'block', policy, rule, text: `not run: ${def.name} needs approval and the owner has locked permissions, so it cannot run for now`, isError: true };
    }
    const approved = this.approvals.consume(def.name, use.input);
    if (approved) return { action: 'run', policy, rule, audit: true, approvalId: approved };
    const grant = this.approvals.activeGrant(grantFamily(def));
    if (grant) return { action: 'run', policy, rule: `${rule}; grant ${grant.id}`, audit: true, approvalId: grant.approvalId };
    if (pinned || mode === 'ask' || (mode === 'auto' && !this.review)) return this.hold(def, use, ctx, policy, rule);
    if (mode === 'bypass') return { action: 'run', policy, rule: `${rule}; mode bypass`, audit: true };

    // Auto. A retry of a call the owner already has in front of them is not reviewed again.
    if (this.approvals.pending(def.name, use.input)) return this.hold(def, use, ctx, policy, rule);
    const verdict = await this.reviewCall(def, use, ctx);
    if (ctx.signal?.aborted) return { action: 'block', policy, rule, text: 'not run: the turn was cancelled', isError: true };
    if (verdict.decision === 'allow') return { action: 'run', policy, rule: `${rule}; auto review`, audit: true };
    return this.hold(def, use, ctx, policy, rule, verdict.reason);
  }

  /** Ask the owner. `held` is why the automatic review did not let the call through. */
  private async hold(def: ToolDef, use: ToolUseBlock, ctx: GuardContext, policy: Policy, rule: string, held?: string): Promise<GuardDecision> {
    const a = await this.approvals.request({
      tool: def.name,
      owner: def.owner,
      input: use.input,
      sessionId: ctx.sessionId,
      batchId: ctx.batchId,
      ...(ctx.approval?.reason !== undefined ? { reason: ctx.approval.reason } : {}),
      ...(ctx.approval?.platforms !== undefined ? { platforms: ctx.approval.platforms } : {}),
      ...(held !== undefined ? { held } : {}),
    });
    this.record(def, use, ctx, policy, 'pending_approval', rule, a.id);
    const review = held !== undefined ? ` The automatic review held it (${held}); do not try to reach the same result another way.` : '';
    return {
      action: 'block',
      policy,
      rule,
      isError: false,
      text: `pending approval ${a.id}: ${def.name} did not run.${review} ${askedOn(a, ctx.approval?.platforms)} The request expires ${inWords(Date.parse(a.expiresAt) - Date.parse(a.createdAt))}. Carry on with what does not depend on it, or end the turn; do not call it again until an approval.decided event reports the decision.`,
    };
  }

  /** Whatever goes wrong here ends in `ask`: a failed review never lets a call through. */
  private async reviewCall(def: ToolDef, use: ToolUseBlock, ctx: GuardContext): Promise<JudgeVerdict> {
    const review = this.review as AutoReview;
    const level = ctx.level ?? 2;
    let verdict: JudgeVerdict;
    let outcome: string;
    const refused = review.refusal?.(level) ?? null;
    if (refused !== null) {
      verdict = { decision: 'ask', reason: `the review was skipped: ${refused}` };
      outcome = 'skipped';
    } else {
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(review.timeoutMs()), ...(ctx.signal ? [ctx.signal] : [])]);
        verdict = await review.judge.review({ tool: def.name, owner: def.owner, input: use.input, context: review.context.gather(ctx.batchId), sessionId: ctx.sessionId, batchId: ctx.batchId, level, signal });
        outcome = verdict.decision;
      } catch (err) {
        verdict = { decision: 'ask', reason: `the review failed: ${errorMessage(err)}` };
        outcome = 'failed';
      }
      if (verdict.decision !== 'allow' && verdict.decision !== 'ask') {
        verdict = { decision: 'ask', reason: 'the review gave no clear answer' };
        outcome = 'failed';
      }
    }
    if (ctx.signal?.aborted) return verdict;
    this.audit.record({
      kind: 'permission_judge',
      tool: def.name,
      owner: def.owner,
      sessionId: ctx.sessionId,
      batchId: ctx.batchId,
      callId: use.id,
      inputHash: inputHash(def.name, use.input),
      summary: this.approvals.summarize(def.name, use.input),
      policy: 'auto',
      outcome,
      detail: this.approvals.redact(verdict.reason),
    });
    this.modes?.noteReview(verdict.decision === 'allow');
    return verdict;
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
