import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeAction, ChangeKind, ChangeRequestDetail, ChangeRequestInfo, ChangeState, EventInput } from '@protea/protocol';
import type { Bus } from '../bus.js';
import type { Db } from '../db/database.js';
import type { Logger } from '../observability/logger.js';
import type { AuditLog } from '../permissions/audit.js';
import { errorMessage } from '../util/errors.js';
import type { Clock } from '../util/time.js';

export const CHANGE_TTL_MS = 7 * 24 * 3600_000;
export const MAX_PENDING_CHANGES = 20;
/** What a request may stage (a plugin's files, a skill's files). */
export const MAX_STAGE_BYTES = 50 * 1024 * 1024;
export const MAX_STAGE_FILES = 2000;
/** The largest staged file the review shows as text. */
const MAX_VIEW_BYTES = 256 * 1024;
const MAX_REASON_CHARS = 1000;

/** What an adapter makes of a proposal: checked, described, and (when it installs files) staged. */
export interface PreparedChange {
  /** The canonical target (a plugin's id comes from its manifest). */
  target: string;
  /** One line saying what would change. */
  summary: string;
  /** The target as it is now, as text a reviewer can read; null when it does not exist. */
  before: string | null;
  /** The target as it would be; null when the change removes it or has no content of its own. */
  after: string | null;
  /** What `apply` needs, as JSON. */
  payload: Record<string, unknown>;
  /** Where the staged files came from (a repository, a workspace directory). */
  source?: string;
  warnings?: string[];
  /** Secret names the change refers to (`${secret:NAME}`). */
  secrets?: string[];
}

/** One kind of capability (MCP servers, skills, plugins): how a change to it is checked, compared and applied. */
export interface ChangeAdapter {
  /**
   * Validate a proposal and describe it. `stageDir` is an empty directory: whatever the change
   * installs is copied there now, so the reviewer sees the bytes that will be applied. Throws
   * with a message the model can act on.
   */
  prepare(p: { action: ChangeAction; target: string; input: Record<string, unknown>; stageDir: string; signal?: AbortSignal }): Promise<PreparedChange> | PreparedChange;
  /** The target's current state as text (null: absent). A request is stale when this no longer equals what it was proposed against. */
  snapshot(target: string, action: ChangeAction): string | null;
  /** Make the change. Returns one line on what is now true. */
  apply(c: { action: ChangeAction; target: string; payload: Record<string, unknown>; stageDir: string }): Promise<string> | string;
}

export interface ChangeRequestServiceOptions {
  db: Db;
  bus: Bus;
  audit: AuditLog;
  clock: Clock;
  log: Logger;
  /** `<data>/changes`: one directory of staged files per pending request. */
  dir: string;
  adapters: Record<ChangeKind, ChangeAdapter>;
  pushInternal: (input: Omit<EventInput, 'ts' | 'origin'> & { ts?: string }) => void;
  /** Redact secrets out of what is stored and shown. */
  redact: (text: string) => string;
  /** Whether a secret has a value (the review says which ones are missing). */
  secretSet?: (name: string) => boolean;
  ttlMs?: number;
  maxPending?: number;
}

interface Row {
  seq: number;
  id: string;
  kind: ChangeKind;
  action: ChangeAction;
  target: string;
  summary: string;
  reason: string;
  payload: string;
  before_text: string | null;
  after_text: string | null;
  meta: string;
  digest: string;
  base_hash: string;
  state: ChangeState;
  session_id: string | null;
  batch_id: string | null;
  created_at: string;
  expires_at: string;
  expires_ms: number;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
  result: string | null;
}

interface Meta {
  source?: string;
  warnings?: string[];
  secrets?: string[];
  files?: Array<{ path: string; size: number }>;
}

const KIND_WORDS: Record<ChangeKind, string> = { mcp: 'MCP server', skill: 'skill', plugin: 'plugin' };

function hashOf(text: string | null): string {
  return crypto
    .createHash('sha256')
    .update(text === null ? '\0absent' : text)
    .digest('hex');
}

/** Every file under `dir` (sorted, relative, `/`-separated); symlinks are refused. */
export function listTree(dir: string): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const walk = (at: string, rel: string): void => {
    for (const ent of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(at, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new Error(`${r} is a symbolic link; a change may only carry plain files`);
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile()) out.push({ path: r, size: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

/** A digest of a staged tree: file names, sizes and contents. Empty string for an empty tree. */
export function digestTree(dir: string): string {
  const files = listTree(dir);
  if (files.length === 0) return '';
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(`${f.path}\0${f.size}\0`);
    h.update(fs.readFileSync(path.join(dir, f.path)));
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * Changes to the assistant's own capabilities — MCP servers, skills, plugins — that the assistant
 * proposes and a person decides (docs/20-decisions/ADR-0019). A request records exactly what
 * would change; nothing is applied until an administrator approves it in the console or the
 * CLI, and then Core applies it itself. No model, permission mode, grant or chat command can
 * decide one: the only way in is `decide`, which the control API calls for an authenticated
 * administrator.
 */
export class ChangeRequestService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: ChangeRequestServiceOptions) {
    fs.mkdirSync(o.dir, { recursive: true });
  }

  private now(): number {
    return this.o.clock.now();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private stageDir(id: string): string {
    return path.join(this.o.dir, id);
  }

  private info(r: Row): ChangeRequestInfo {
    return {
      id: r.id,
      kind: r.kind,
      action: r.action,
      target: r.target,
      state: r.state,
      summary: r.summary,
      reason: r.reason,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
      ...(r.batch_id !== null ? { batchId: r.batch_id } : {}),
      ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
      ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
      ...(r.note !== null ? { note: r.note } : {}),
      ...(r.result !== null ? { result: r.result } : {}),
    };
  }

  private row(id: string): Row | undefined {
    return this.o.db.prepare('SELECT * FROM change_requests WHERE id = ?').get(id) as Row | undefined;
  }

  /** One at a time: a decision must not race another one or a proposal for the same target. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** File a request. Throws with a model-readable message when the proposal is not acceptable. */
  propose(p: { kind: ChangeKind; action: ChangeAction; target: string; input: Record<string, unknown>; reason: string; sessionId?: string; batchId?: string; signal?: AbortSignal }): Promise<ChangeRequestInfo> {
    return this.serialize(async () => {
      this.expireDue();
      const reason = p.reason.trim();
      if (reason.length === 0) throw new Error('a reason is required: say why the owner should approve this');
      const adapter = this.o.adapters[p.kind];
      const pending = this.o.db.prepare("SELECT COUNT(*) AS n FROM change_requests WHERE state = 'pending'").get() as { n: number };
      if (pending.n >= (this.o.maxPending ?? MAX_PENDING_CHANGES)) {
        throw new Error(`${pending.n} change requests are already waiting for the owner; wait for a decision or withdraw one`);
      }
      const tmp = path.join(this.o.dir, `.stage-${crypto.randomBytes(6).toString('hex')}`);
      fs.mkdirSync(tmp, { recursive: true });
      try {
        const prepared = await adapter.prepare({ action: p.action, target: p.target, input: p.input, stageDir: tmp, ...(p.signal ? { signal: p.signal } : {}) });
        const same = this.o.db
          .prepare("SELECT id FROM change_requests WHERE state = 'pending' AND kind = ? AND target = ?")
          .get(p.kind, prepared.target) as { id: string } | undefined;
        if (same) throw new Error(`change request ${same.id} for this ${KIND_WORDS[p.kind]} is still waiting for the owner; withdraw it first to propose something else`);
        const files = listTree(tmp);
        const bytes = files.reduce((n, f) => n + f.size, 0);
        if (files.length > MAX_STAGE_FILES) throw new Error(`too many files (${files.length}; at most ${MAX_STAGE_FILES})`);
        if (bytes > MAX_STAGE_BYTES) throw new Error(`too large (${bytes} bytes; at most ${MAX_STAGE_BYTES})`);
        const meta: Meta = {
          ...(prepared.source !== undefined ? { source: prepared.source } : {}),
          ...(prepared.warnings && prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
          ...(prepared.secrets && prepared.secrets.length > 0 ? { secrets: prepared.secrets } : {}),
          ...(files.length > 0 ? { files } : {}),
        };
        const now = this.now();
        const expiresMs = now + (this.o.ttlMs ?? CHANGE_TTL_MS);
        const redact = this.o.redact;
        const id = this.o.db.transaction((): string => {
          const res = this.o.db
            .prepare(
              `INSERT INTO change_requests (id, kind, action, target, summary, reason, payload, before_text, after_text, meta, digest, base_hash, state, session_id, batch_id, created_at, expires_at, expires_ms)
               VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
            )
            .run(
              p.kind,
              p.action,
              prepared.target,
              redact(prepared.summary),
              redact(reason.slice(0, MAX_REASON_CHARS)),
              JSON.stringify(prepared.payload),
              prepared.before === null ? null : redact(prepared.before),
              prepared.after === null ? null : redact(prepared.after),
              JSON.stringify(meta),
              digestTree(tmp),
              hashOf(adapter.snapshot(prepared.target, p.action)),
              p.sessionId ?? null,
              p.batchId ?? null,
              this.iso(now),
              this.iso(expiresMs),
              expiresMs,
            );
          const rid = `c${res.lastInsertRowid}`;
          this.o.db.prepare('UPDATE change_requests SET id = ? WHERE seq = ?').run(rid, res.lastInsertRowid);
          return rid;
        })();
        if (files.length > 0) fs.renameSync(tmp, this.stageDir(id));
        const info = this.info(this.row(id) as Row);
        this.o.audit.record({
          kind: 'change_requested',
          tool: `${p.kind}.${p.action}`,
          summary: info.summary,
          detail: info.reason,
          approvalId: id,
          ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
          ...(p.batchId !== undefined ? { batchId: p.batchId } : {}),
        });
        this.o.bus.emit('change.changed', info);
        this.o.log.info({ change: id, kind: p.kind, action: p.action, target: prepared.target }, 'change request filed');
        return info;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  /**
   * An administrator's decision. Approving applies the change at once; the outcome (applied,
   * failed, stale) is the request's final state and goes to the assistant as an event.
   */
  decide(id: string, decision: 'approve' | 'reject', by: string, note?: string): Promise<{ ok: boolean; message?: string; change?: ChangeRequestInfo }> {
    return this.serialize(async () => {
      this.expireDue();
      const row = this.row(id);
      if (!row) return { ok: false, message: `no change request ${id}` };
      if (row.state !== 'pending') return { ok: false, message: `change request ${id} is already ${row.state}`, change: this.info(row) };
      const what = `Change request ${id} (${row.summary})`;
      const said = note?.trim() ? this.o.redact(note.trim().slice(0, MAX_REASON_CHARS)) : null;
      if (decision === 'reject') {
        const info = this.finish(row, 'rejected', by, said, null);
        this.tell(id, `${what} was rejected by the owner${said ? `: "${said}"` : ''}. Nothing changed. Do not propose it again unless the owner asks.`);
        return { ok: true, change: info };
      }
      const adapter = this.o.adapters[row.kind];
      const stage = this.stageDir(id);
      let snapshot: string | null;
      try {
        snapshot = adapter.snapshot(row.target, row.action);
      } catch (err) {
        snapshot = `\0unreadable: ${errorMessage(err)}`;
      }
      if (hashOf(snapshot) !== row.base_hash) {
        const info = this.finish(row, 'stale', by, said, `the ${KIND_WORDS[row.kind]} ${row.target} changed after this was proposed`);
        this.tell(id, `${what} was approved, but the ${KIND_WORDS[row.kind]} ${row.target} had changed since it was proposed, so nothing was applied. Propose it again if it is still wanted.`);
        return { ok: true, change: info };
      }
      if (digestTree(stage) !== row.digest) {
        const info = this.finish(row, 'failed', by, said, 'the staged files are not the ones that were proposed');
        this.tell(id, `${what} was approved but not applied: its staged files changed on disk. Propose it again.`);
        return { ok: true, change: info };
      }
      try {
        const result = this.o.redact(await adapter.apply({ action: row.action, target: row.target, payload: JSON.parse(row.payload) as Record<string, unknown>, stageDir: stage }));
        const info = this.finish(row, 'applied', by, said, result);
        this.tell(id, `${what} was approved by the owner and applied: ${result}${said ? ` The owner added: "${said}"` : ''}`);
        return { ok: true, change: info };
      } catch (err) {
        const why = this.o.redact(errorMessage(err));
        this.o.log.warn({ change: id, err: why }, 'approved change could not be applied');
        const info = this.finish(row, 'failed', by, said, why);
        this.tell(id, `${what} was approved by the owner but could not be applied: ${why}`);
        return { ok: true, change: info };
      }
    });
  }

  /** The assistant takes a pending request back. */
  withdraw(id: string): Promise<{ ok: boolean; message?: string; change?: ChangeRequestInfo }> {
    return this.serialize(async () => {
      const row = this.row(id);
      if (!row) return { ok: false, message: `no change request ${id}` };
      if (row.state !== 'pending') return { ok: false, message: `change request ${id} is already ${row.state}`, change: this.info(row) };
      return { ok: true, change: this.finish(row, 'withdrawn', 'assistant', null, null) };
    });
  }

  private finish(row: Row, state: ChangeState, by: string, note: string | null, result: string | null): ChangeRequestInfo {
    const at = this.iso();
    this.o.db.prepare("UPDATE change_requests SET state = ?, decided_at = ?, decided_by = ?, note = ?, result = ? WHERE id = ? AND state = 'pending'").run(state, at, by, note, result, row.id);
    fs.rmSync(this.stageDir(row.id), { recursive: true, force: true });
    const info = this.info(this.row(row.id) as Row);
    this.o.audit.record({ kind: 'change_decided', tool: `${row.kind}.${row.action}`, summary: row.summary, approvalId: row.id, outcome: state, detail: [by, result].filter(Boolean).join(': ') });
    this.o.bus.emit('change.changed', info);
    this.o.log.info({ change: row.id, state, by }, 'change request settled');
    return info;
  }

  private tell(id: string, text: string): void {
    this.o.pushInternal({ type: 'change.decided', level: 1, trigger: 'flush', correlation: id, text });
  }

  get(id: string): ChangeRequestInfo | undefined {
    const row = this.row(id);
    return row ? this.info(row) : undefined;
  }

  /** Everything a reviewer needs: both versions as text, the staged files, and whether it still applies. */
  detail(id: string): ChangeRequestDetail | undefined {
    this.expireDue();
    const row = this.row(id);
    if (!row) return undefined;
    const meta = JSON.parse(row.meta) as Meta;
    let stale = false;
    if (row.state === 'pending') {
      try {
        stale = hashOf(this.o.adapters[row.kind].snapshot(row.target, row.action)) !== row.base_hash;
      } catch {
        stale = true;
      }
    }
    return {
      ...this.info(row),
      before: row.before_text,
      after: row.after_text,
      warnings: meta.warnings ?? [],
      ...(meta.source !== undefined ? { source: meta.source } : {}),
      ...(meta.files ? { files: meta.files } : {}),
      ...(meta.secrets ? { secrets: meta.secrets.map((name) => ({ name, set: this.o.secretSet?.(name) ?? false })) } : {}),
      ...(stale ? { stale: true } : {}),
    };
  }

  /** A staged file as text, for the review. Only while the request is pending. */
  readFile(id: string, rel: string): { text: string } | { error: string } {
    const row = this.row(id);
    if (!row) return { error: `no change request ${id}` };
    if (row.state !== 'pending') return { error: 'the staged files are kept only while the request is pending' };
    const meta = JSON.parse(row.meta) as Meta;
    const known = meta.files?.find((f) => f.path === rel);
    if (!known) return { error: `no staged file ${rel}` };
    if (known.size > MAX_VIEW_BYTES) return { error: `${rel} is too large to show (${known.size} bytes)` };
    const buf = fs.readFileSync(path.join(this.stageDir(id), ...rel.split('/')));
    if (buf.includes(0)) return { error: `${rel} is not a text file (${known.size} bytes)` };
    return { text: this.o.redact(buf.toString('utf8')) };
  }

  list(state?: ChangeState, limit = 50): ChangeRequestInfo[] {
    this.expireDue();
    const rows = (
      state
        ? this.o.db.prepare('SELECT * FROM change_requests WHERE state = ? ORDER BY seq DESC LIMIT ?').all(state, limit)
        : this.o.db.prepare('SELECT * FROM change_requests ORDER BY seq DESC LIMIT ?').all(limit)
    ) as Row[];
    return rows.map((r) => this.info(r));
  }

  /** Pending requests past their expiry become `expired`; the assistant hears about it with its next batch. */
  expireDue(): number {
    const due = this.o.db.prepare("SELECT * FROM change_requests WHERE state = 'pending' AND expires_ms <= ?").all(this.now()) as Row[];
    for (const r of due) {
      this.finish(r, 'expired', 'expiry', null, null);
      this.o.pushInternal({ type: 'change.expired', level: 4, trigger: 'piggyback', correlation: r.id, text: `Change request ${r.id} (${r.summary}) expired without a decision. Nothing changed.` });
    }
    return due.length;
  }
}
