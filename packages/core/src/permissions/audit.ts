import type { Db } from '../db/database.js';
import type { Clock } from '../util/time.js';

export interface AuditRecord {
  /** `control_write`: a state-changing control API request (M5), summary "METHOD /path". */
  kind: 'tool_call' | 'tool_blocked' | 'approval_requested' | 'approval_decided' | 'approval_expired' | 'approval_grant' | 'permission_mode' | 'permission_judge' | 'memory_write' | 'control_write';
  tool?: string;
  owner?: string;
  sessionId?: string;
  batchId?: string;
  callId?: string;
  inputHash?: string;
  summary?: string;
  policy?: string;
  outcome?: string;
  approvalId?: string;
  detail?: string;
}

export interface AuditRow extends AuditRecord {
  id: number;
  at: string;
}

/** Append-only record of side effects and approvals (invariant I-8). */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(r: AuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit (at, kind, tool, owner, session_id, batch_id, call_id, input_hash, summary, policy, outcome, approval_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(this.clock.now()).toISOString(),
        r.kind,
        r.tool ?? null,
        r.owner ?? null,
        r.sessionId ?? null,
        r.batchId ?? null,
        r.callId ?? null,
        r.inputHash ?? null,
        r.summary ?? null,
        r.policy ?? null,
        r.outcome ?? null,
        r.approvalId ?? null,
        r.detail ?? null,
      );
  }

  list(opts: { limit?: number; tool?: string; kind?: AuditRecord['kind'] } = {}): AuditRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.tool) (where.push('tool = ?'), args.push(opts.tool));
    if (opts.kind) (where.push('kind = ?'), args.push(opts.kind));
    const rows = this.db
      .prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(Math.max(opts.limit ?? 100, 1), 1000)) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const out: AuditRow = { id: Number(r['id']), at: String(r['at']), kind: r['kind'] as AuditRecord['kind'] };
      const map: Array<[keyof AuditRecord, string]> = [
        ['tool', 'tool'],
        ['owner', 'owner'],
        ['sessionId', 'session_id'],
        ['batchId', 'batch_id'],
        ['callId', 'call_id'],
        ['inputHash', 'input_hash'],
        ['summary', 'summary'],
        ['policy', 'policy'],
        ['outcome', 'outcome'],
        ['approvalId', 'approval_id'],
        ['detail', 'detail'],
      ];
      for (const [k, col] of map) if (r[col] != null) (out as unknown as Record<string, unknown>)[k] = r[col];
      return out;
    });
  }
}
