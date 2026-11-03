import type { ApprovalInfo, EventInput } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { Db } from '../db/database.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import type { AuditLog } from './audit.js';
import { inputHash } from './policy.js';

export interface ApprovalServiceOptions {
  db: Db;
  bus: Bus;
  audit: AuditLog;
  clock: Clock;
  log: Logger;
  ttlMs: () => number;
  /** Send the request to the owner (the channel plugins). Resolves to the plugins that delivered it. */
  deliver: (a: ApprovalInfo) => Promise<string[]>;
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
  /** Redact secrets out of summaries. */
  redact: (text: string) => string;
}

interface Row {
  id: string;
  tool: string;
  owner: string;
  input_hash: string;
  summary: string;
  reason: string | null;
  state: ApprovalInfo['state'];
  session_id: string | null;
  batch_id: string | null;
  created_at: string;
  expires_at: string;
  expires_ms: number;
  decided_at: string | null;
  decided_by: string | null;
}

function toInfo(r: Row): ApprovalInfo {
  return {
    id: r.id,
    tool: r.tool,
    state: r.state,
    summary: r.summary,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.reason !== null ? { reason: r.reason } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
  };
}

const SUMMARY_CHARS = 400;

/**
 * Approval requests for `ask` tools (docs/10-architecture/05-sessions-and-agent-loop.md §7):
 * the call returns at once with "pending approval <id>", the owner decides through a
 * channel, the decision arrives as an L1 `approval.decided` event, and an approval runs
 * the same tool with the same input exactly once before it expires.
 */
export class ApprovalService {
  constructor(private readonly o: ApprovalServiceOptions) {}

  private now(): number {
    return this.o.clock.now();
  }

  summarize(tool: string, input: unknown): string {
    const json = JSON.stringify(input) ?? 'null';
    const clipped = json.length > SUMMARY_CHARS ? `${json.slice(0, SUMMARY_CHARS)}…` : json;
    return this.o.redact(`${tool} ${clipped}`);
  }

  /**
   * Create (or reuse) a pending request for this exact call and send it to the owner.
   * An identical pending request is reused so retries do not spam the owner.
   */
  async request(r: { tool: string; owner: string; input: unknown; reason?: string; sessionId?: string; batchId?: string }): Promise<ApprovalInfo> {
    this.expireDue();
    const hash = inputHash(r.tool, r.input);
    const existing = this.o.db
      .prepare("SELECT * FROM approvals WHERE tool = ? AND input_hash = ? AND state = 'pending' ORDER BY seq DESC LIMIT 1")
      .get(r.tool, hash) as Row | undefined;
    if (existing) return toInfo(existing);

    const now = this.now();
    const expiresMs = now + this.o.ttlMs();
    const summary = this.summarize(r.tool, r.input);
    const info = this.o.db.transaction((): ApprovalInfo => {
      const res = this.o.db
        .prepare(
          `INSERT INTO approvals (id, tool, owner, input_hash, summary, reason, state, session_id, batch_id, created_at, expires_at, expires_ms)
           VALUES ('', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          r.tool,
          r.owner,
          hash,
          summary,
          r.reason !== undefined ? this.o.redact(r.reason) : null,
          r.sessionId ?? null,
          r.batchId ?? null,
          new Date(now).toISOString(),
          new Date(expiresMs).toISOString(),
          expiresMs,
        );
      const id = `a${res.lastInsertRowid}`;
      this.o.db.prepare('UPDATE approvals SET id = ? WHERE seq = ?').run(id, res.lastInsertRowid);
      return toInfo(this.o.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row);
    })();
    this.o.audit.record({
      kind: 'approval_requested',
      tool: r.tool,
      owner: r.owner,
      inputHash: hash,
      summary,
      approvalId: info.id,
      ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
      ...(r.batchId !== undefined ? { batchId: r.batchId } : {}),
      ...(r.reason !== undefined ? { detail: this.o.redact(r.reason) } : {}),
    });
    this.o.bus.emit('approval.changed', info);
    try {
      const via = await this.o.deliver(info);
      if (via.length === 0) this.o.log.warn({ approval: info.id }, 'no channel delivered the approval request; it is visible in the control API');
    } catch (err) {
      this.o.log.warn({ approval: info.id, err: errorMessage(err) }, 'approval request delivery failed');
    }
    return info;
  }

  /** Use an approval for this exact call, if there is one. Returns its id. */
  consume(tool: string, input: unknown): string | null {
    this.expireDue();
    const hash = inputHash(tool, input);
    const row = this.o.db
      .prepare("SELECT * FROM approvals WHERE tool = ? AND input_hash = ? AND state = 'approved' AND expires_ms > ? ORDER BY seq LIMIT 1")
      .get(tool, hash, this.now()) as Row | undefined;
    if (!row) return null;
    this.o.db.prepare("UPDATE approvals SET state = 'used', used_at = ? WHERE id = ? AND state = 'approved'").run(new Date(this.now()).toISOString(), row.id);
    this.o.bus.emit('approval.changed', { ...toInfo(row), state: 'used' });
    return row.id;
  }

  /** Record the owner's decision. `by` identifies the channel and sender. */
  decide(id: string, decision: 'approve' | 'deny', by: string): { ok: boolean; state?: ApprovalInfo['state']; message?: string } {
    this.expireDue();
    const row = this.o.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    if (!row) return { ok: false, message: `no approval ${id}` };
    if (row.state !== 'pending') return { ok: false, state: row.state, message: `approval ${id} is already ${row.state}` };
    const state = decision === 'approve' ? 'approved' : 'denied';
    const at = new Date(this.now()).toISOString();
    this.o.db.prepare("UPDATE approvals SET state = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'").run(state, at, by, id);
    const info: ApprovalInfo = { ...toInfo(row), state, decidedAt: at, decidedBy: by };
    this.o.audit.record({ kind: 'approval_decided', tool: row.tool, owner: row.owner, inputHash: row.input_hash, approvalId: id, outcome: state, detail: by });
    this.o.bus.emit('approval.changed', info);
    this.o.pushInternal({
      type: 'approval.decided',
      level: 1,
      trigger: 'flush',
      correlation: id,
      text:
        state === 'approved'
          ? `Approval ${id} was approved by the owner: ${row.summary}. Call ${row.tool} again with exactly the same input to run it; the approval is valid once, until ${row.expires_at}.`
          : `Approval ${id} was denied by the owner: ${row.summary}. Do not run it.`,
    });
    return { ok: true, state };
  }

  get(id: string): ApprovalInfo | undefined {
    const row = this.o.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? toInfo(row) : undefined;
  }

  list(state?: ApprovalInfo['state'], limit = 50): ApprovalInfo[] {
    this.expireDue();
    const rows = (
      state
        ? this.o.db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY seq DESC LIMIT ?').all(state, limit)
        : this.o.db.prepare('SELECT * FROM approvals ORDER BY seq DESC LIMIT ?').all(limit)
    ) as Row[];
    return rows.map(toInfo);
  }

  /** Pending requests and unused approvals past their expiry become `expired`. */
  expireDue(): number {
    const now = this.now();
    const due = this.o.db
      .prepare("SELECT * FROM approvals WHERE state IN ('pending','approved') AND expires_ms <= ?")
      .all(now) as Row[];
    if (due.length === 0) return 0;
    const update = this.o.db.prepare("UPDATE approvals SET state = 'expired' WHERE id = ? AND state IN ('pending','approved')");
    this.o.db.transaction(() => {
      for (const r of due) update.run(r.id);
    })();
    for (const r of due) {
      this.o.audit.record({ kind: 'approval_expired', tool: r.tool, owner: r.owner, inputHash: r.input_hash, approvalId: r.id, outcome: 'expired' });
      this.o.bus.emit('approval.changed', { ...toInfo(r), state: 'expired' });
    }
    return due.length;
  }
}
