import type { ApprovalGrantInfo, ApprovalInfo, ApprovalView, EventInput } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { Db } from '../db/database.js';
import type { Logger } from '../observability/logger.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';
import type { AuditLog } from './audit.js';
import { grantFamily, inputHash } from './policy.js';
import { approvalView, inputText, oneLineValue, viewSummary } from './view.js';

export interface ApprovalServiceOptions {
  db: Db;
  bus: Bus;
  audit: AuditLog;
  clock: Clock;
  log: Logger;
  ttlMs: () => number;
  /** The longest grant the owner can give; 0 turns grants off. */
  grantMaxMs?: () => number;
  /**
   * Show the request to the owner: on `platforms` when given (falling back to the others when
   * none of them takes it), otherwise on every platform. Resolves to the platforms that showed it.
   */
  deliver: (a: ApprovalInfo, platforms?: readonly string[]) => Promise<string[]>;
  /** The request as a person reads it, without the reason. Without it only the tool's name is shown. */
  describe?: (r: { tool: string; owner: string; input: unknown }) => ApprovalView;
  /** A request stopped being open (decided or expired): tell the platforms that showed it. */
  resolved?: (a: ApprovalInfo) => void;
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
  view_json: string | null;
  input_json: string | null;
  delivered_to: string | null;
  note: string | null;
  grant_id?: string | null;
}

function parse<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

interface GrantRow {
  id: string;
  family: string;
  approval_id: string;
  decided_by: string;
  created_at: string;
  expires_at: string;
  expires_ms: number;
  revoked_at: string | null;
}

function toInfo(r: Row): ApprovalInfo {
  const view = parse<ApprovalView>(r.view_json);
  const delivered = parse<string[]>(r.delivered_to);
  return {
    id: r.id,
    tool: r.tool,
    state: r.state,
    summary: r.summary,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.reason !== null ? { reason: r.reason } : {}),
    ...(view ? { view } : {}),
    ...(r.input_json !== null ? { input: r.input_json } : {}),
    ...(delivered?.length ? { deliveredTo: delivered } : {}),
    ...(r.note !== null ? { note: r.note } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
    ...(r.grant_id ? { grantId: r.grant_id } : {}),
  };
}

/** Selects an approval with the grant it created, if any. */
const WITH_GRANT = 'SELECT a.*, g.id AS grant_id FROM approvals a LEFT JOIN approval_grants g ON g.approval_id = a.id';

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

  /** The request as the owner reads it. `reason` is the assistant's; `held` is the automatic review's. */
  private view(r: { tool: string; owner: string; input: unknown; reason?: string; held?: string }): ApprovalView {
    const base: ApprovalView = this.o.describe?.(r) ?? approvalView({ name: r.tool, owner: r.owner, inputSchema: {} }, r.input, { language: 'en', redact: this.o.redact });
    return {
      ...base,
      ...(r.reason ? { reason: oneLineValue(this.o.redact(r.reason), 500) } : {}),
      ...(r.held ? { held: oneLineValue(this.o.redact(r.held), 500) } : {}),
    };
  }

  /**
   * Create (or reuse) a pending request for this exact call and show it to the owner.
   * `reason` is what the assistant says it is for, `held` why the automatic review passed it
   * on, `platforms` where to ask (everywhere when absent). An identical pending request is
   * reused, so retries do not spam the owner: it is shown again only on platforms that have
   * not shown it yet.
   */
  async request(r: { tool: string; owner: string; input: unknown; reason?: string; held?: string; platforms?: readonly string[]; sessionId?: string; batchId?: string }): Promise<ApprovalInfo> {
    this.expireDue();
    const hash = inputHash(r.tool, r.input);
    const existing = this.o.db
      .prepare("SELECT * FROM approvals WHERE tool = ? AND input_hash = ? AND state = 'pending' ORDER BY seq DESC LIMIT 1")
      .get(r.tool, hash) as Row | undefined;
    if (existing) return this.again(existing, r);

    const now = this.now();
    const expiresMs = now + this.o.ttlMs();
    const view = this.view(r);
    const summary = this.o.redact(viewSummary(view)).slice(0, SUMMARY_CHARS);
    // The column keeps one text: the assistant's reason, or else why the review held the call.
    const reason = r.reason !== undefined ? this.o.redact(r.reason) : r.held !== undefined ? this.o.redact(`Held by the automatic review: ${r.held}`) : null;
    const info = this.o.db.transaction((): ApprovalInfo => {
      const res = this.o.db
        .prepare(
          `INSERT INTO approvals (id, tool, owner, input_hash, summary, reason, state, session_id, batch_id, created_at, expires_at, expires_ms, view_json, input_json)
           VALUES ('', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.tool,
          r.owner,
          hash,
          summary,
          reason,
          r.sessionId ?? null,
          r.batchId ?? null,
          new Date(now).toISOString(),
          new Date(expiresMs).toISOString(),
          expiresMs,
          JSON.stringify(view),
          inputText(r.input, this.o.redact),
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
      summary: this.summarize(r.tool, r.input),
      approvalId: info.id,
      ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
      ...(r.batchId !== undefined ? { batchId: r.batchId } : {}),
      ...(reason !== null ? { detail: reason } : {}),
    });
    this.o.bus.emit('approval.changed', info);
    return this.show(info, r.platforms);
  }

  /** Show a request and record where it was shown. */
  private async show(info: ApprovalInfo, platforms?: readonly string[]): Promise<ApprovalInfo> {
    let via: string[] = [];
    try {
      via = await this.o.deliver(info, platforms);
      if (via.length === 0 && !info.deliveredTo?.length) this.o.log.warn({ approval: info.id }, 'no channel delivered the approval request; it is visible in the control API');
    } catch (err) {
      this.o.log.warn({ approval: info.id, err: errorMessage(err) }, 'approval request delivery failed');
    }
    const all = [...new Set([...(info.deliveredTo ?? []), ...via])];
    if (all.length === (info.deliveredTo?.length ?? 0)) return info;
    this.o.db.prepare('UPDATE approvals SET delivered_to = ? WHERE id = ?').run(JSON.stringify(all), info.id);
    const shown = { ...info, deliveredTo: all };
    this.o.bus.emit('approval.changed', shown);
    return shown;
  }

  /** The same call asked again while its request is open: add what is new, and nothing else. */
  private async again(row: Row, r: { tool: string; owner: string; input: unknown; reason?: string; held?: string; platforms?: readonly string[] }): Promise<ApprovalInfo> {
    let info = toInfo(row);
    if (r.reason !== undefined && info.view?.reason === undefined) {
      const reason = this.o.redact(r.reason);
      const view = { ...this.view({ ...r, ...(info.view?.held !== undefined ? { held: info.view.held } : {}) }) };
      this.o.db.prepare('UPDATE approvals SET reason = ?, view_json = ? WHERE id = ?').run(reason, JSON.stringify(view), row.id);
      info = { ...info, reason, view };
      this.o.bus.emit('approval.changed', info);
    }
    const fresh = r.platforms?.filter((p) => !info.deliveredTo?.includes(p)) ?? [];
    return fresh.length > 0 ? this.show(info, fresh) : info;
  }

  /** The longest grant an approval can carry now; 0 when grants are off. */
  grantMax(): number {
    return Math.max(0, this.o.grantMaxMs?.() ?? 0);
  }

  /** Remove secret values from text that is stored or shown. */
  redact(text: string): string {
    return this.o.redact(text);
  }

  /** The request already waiting for the owner for this exact call, if there is one. */
  pending(tool: string, input: unknown): ApprovalInfo | null {
    this.expireDue();
    const row = this.o.db.prepare("SELECT * FROM approvals WHERE tool = ? AND input_hash = ? AND state = 'pending' ORDER BY seq DESC LIMIT 1").get(tool, inputHash(tool, input)) as Row | undefined;
    return row ? toInfo(row) : null;
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

  /**
   * Record the owner's decision. `by` identifies the channel and sender. With `grantMs` an
   * approval also allows the call's whole tool family for that long.
   */
  decide(id: string, decision: 'approve' | 'deny', by: string, opts: { grantMs?: number; note?: string } = {}): { ok: boolean; state?: ApprovalInfo['state']; message?: string; grant?: ApprovalGrantInfo } {
    this.expireDue();
    const row = this.o.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    if (!row) return { ok: false, message: `no approval ${id}` };
    if (row.state !== 'pending') return { ok: false, state: row.state, message: `approval ${id} is already ${row.state}` };
    const state = decision === 'approve' ? 'approved' : 'denied';
    const at = new Date(this.now()).toISOString();
    const said = opts.note?.trim() ? oneLineValue(this.o.redact(opts.note), 500) : null;
    this.o.db.prepare("UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND state = 'pending'").run(state, at, by, said, id);
    const grant = state === 'approved' && opts.grantMs !== undefined ? this.createGrant(row, by, opts.grantMs) : null;
    const info: ApprovalInfo = { ...toInfo(row), state, decidedAt: at, decidedBy: by, ...(said !== null ? { note: said } : {}), ...(grant ? { grantId: grant.id } : {}) };
    const words = said !== null ? ` The owner said: ${JSON.stringify(said)}.` : '';
    this.o.audit.record({ kind: 'approval_decided', tool: row.tool, owner: row.owner, inputHash: row.input_hash, approvalId: id, outcome: state, detail: by });
    this.o.bus.emit('approval.changed', info);
    this.o.pushInternal({
      type: 'approval.decided',
      level: 1,
      trigger: 'flush',
      correlation: id,
      text:
        state === 'approved'
          ? `Approval ${id} was approved by the owner: ${row.summary}.${words} It has not run yet: call ${row.tool} now with exactly the same input. The approval is valid once, until ${row.expires_at}.${
              grant ? ` The owner also allowed the tools of ${grant.family} without asking until ${grant.expiresAt}.` : ''
            }`
          : `Approval ${id} was denied by the owner: ${row.summary}.${words} It did not run. Do not run it and do not reach the same result another way.`,
    });
    this.tell(info);
    return { ok: true, state, ...(grant ? { grant } : {}) };
  }

  private tell(a: ApprovalInfo): void {
    try {
      this.o.resolved?.(a);
    } catch (err) {
      this.o.log.warn({ approval: a.id, err: errorMessage(err) }, 'could not tell the platforms that a request was settled');
    }
  }

  private createGrant(row: Row, by: string, requestedMs: number): ApprovalGrantInfo | null {
    const ms = Math.min(requestedMs, this.o.grantMaxMs?.() ?? 0);
    if (!(ms > 0)) return null;
    const family = grantFamily({ name: row.tool, owner: row.owner });
    const now = this.now();
    const res = this.o.db
      .prepare("INSERT INTO approval_grants (id, family, approval_id, decided_by, created_at, expires_at, expires_ms) VALUES ('', ?, ?, ?, ?, ?, ?)")
      .run(family, row.id, by, new Date(now).toISOString(), new Date(now + ms).toISOString(), now + ms);
    const id = `g${res.lastInsertRowid}`;
    this.o.db.prepare('UPDATE approval_grants SET id = ? WHERE seq = ?').run(id, res.lastInsertRowid);
    const grant = this.grantInfo(this.o.db.prepare('SELECT * FROM approval_grants WHERE id = ?').get(id) as GrantRow);
    this.o.audit.record({ kind: 'approval_grant', tool: row.tool, owner: row.owner, inputHash: row.input_hash, approvalId: row.id, outcome: 'granted', detail: `${id} ${family} until ${grant.expiresAt} by ${by}` });
    return grant;
  }

  private grantInfo(r: GrantRow): ApprovalGrantInfo {
    return {
      id: r.id,
      family: r.family,
      approvalId: r.approval_id,
      decidedBy: r.decided_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
      active: r.revoked_at === null && r.expires_ms > this.now(),
    };
  }

  /** The grant that currently covers a tool family, if any. */
  activeGrant(family: string): ApprovalGrantInfo | null {
    const r = this.o.db
      .prepare('SELECT * FROM approval_grants WHERE family = ? AND revoked_at IS NULL AND expires_ms > ? ORDER BY expires_ms DESC LIMIT 1')
      .get(family, this.now()) as GrantRow | undefined;
    return r ? this.grantInfo(r) : null;
  }

  listGrants(limit = 50): ApprovalGrantInfo[] {
    return (this.o.db.prepare('SELECT * FROM approval_grants ORDER BY seq DESC LIMIT ?').all(limit) as GrantRow[]).map((r) => this.grantInfo(r));
  }

  /** End a grant early. */
  revokeGrant(id: string, by: string): { ok: boolean; message?: string; grant?: ApprovalGrantInfo } {
    const r = this.o.db.prepare('SELECT * FROM approval_grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!r) return { ok: false, message: `no grant ${id}` };
    if (r.revoked_at !== null) return { ok: false, message: `grant ${id} is already revoked` };
    this.o.db.prepare('UPDATE approval_grants SET revoked_at = ? WHERE id = ?').run(new Date(this.now()).toISOString(), id);
    this.o.audit.record({ kind: 'approval_grant', tool: r.family, approvalId: r.approval_id, outcome: 'revoked', detail: `${id} by ${by}` });
    return { ok: true, grant: this.grantInfo(this.o.db.prepare('SELECT * FROM approval_grants WHERE id = ?').get(id) as GrantRow) };
  }

  get(id: string): ApprovalInfo | undefined {
    const row = this.o.db.prepare(`${WITH_GRANT} WHERE a.id = ?`).get(id) as Row | undefined;
    return row ? toInfo(row) : undefined;
  }

  list(state?: ApprovalInfo['state'], limit = 50): ApprovalInfo[] {
    this.expireDue();
    const rows = (
      state
        ? this.o.db.prepare(`${WITH_GRANT} WHERE a.state = ? ORDER BY a.seq DESC LIMIT ?`).all(state, limit)
        : this.o.db.prepare(`${WITH_GRANT} ORDER BY a.seq DESC LIMIT ?`).all(limit)
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
      const info: ApprovalInfo = { ...toInfo(r), state: 'expired' };
      this.o.audit.record({ kind: 'approval_expired', tool: r.tool, owner: r.owner, inputHash: r.input_hash, approvalId: r.id, outcome: 'expired' });
      this.o.bus.emit('approval.changed', info);
      // Only a request nobody answered: the assistant is still waiting for that one.
      if (r.state !== 'pending') continue;
      this.tell(info);
      this.o.pushInternal({
        type: 'approval.expired',
        level: 3,
        trigger: 'debounce',
        correlation: r.id,
        text: `Approval ${r.id} expired without an answer: ${r.summary}. It did not run. Ask again only if it is still needed.`,
      });
    }
    return due.length;
  }
}
