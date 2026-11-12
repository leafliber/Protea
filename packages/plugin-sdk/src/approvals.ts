import type { ApprovalRequestParams, ApprovalResolvedParams } from '@protea/protocol';
import type { Host } from './plugin.js';

/**
 * Approval requests on a chat platform: the text the owner reads, the buttons or reply words
 * that decide it, and which request a reply is about. Every connector uses this, so a request
 * looks and works the same everywhere.
 */

export type ApprovalChoice = 'approve' | 'grant' | 'deny';

export interface ApprovalButton {
  choice: ApprovalChoice;
  label: string;
  /** What the button says once it was pressed. */
  done: string;
  /** Opaque payload for the platform's button; `parseApprovalButton` reads it back. */
  data: string;
}

export interface ApprovalMessage {
  /** The request, as plain text. */
  text: string;
  /** Approve, approve and stop asking for a while (when grants are on), deny. */
  buttons: ApprovalButton[];
  /** How to answer in words, for a platform (or a moment) without buttons. */
  hint: string;
}

const zh = (language: string): boolean => language.toLowerCase().startsWith('zh');

/** "1 小时" / "1 hour", "30 分钟" / "30 minutes". */
export function durationWords(ms: number, language: string): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min % 60 === 0) {
    const h = min / 60;
    return zh(language) ? `${h} 小时` : `${h} hour${h === 1 ? '' : 's'}`;
  }
  return zh(language) ? `${min} 分钟` : `${min} minute${min === 1 ? '' : 's'}`;
}

/** The grant a button or the reply word offers: an hour, or less when the owner's limit is lower. */
export function offeredGrantMs(req: Pick<ApprovalRequestParams, 'grantMaxMs'>): number {
  return req.grantMaxMs !== undefined && req.grantMaxMs > 0 ? Math.min(3_600_000, req.grantMaxMs) : 0;
}

const CHOICE_CODE: Record<ApprovalChoice, string> = { approve: 'y', grant: 'h', deny: 'n' };

export function approvalButtonData(id: string, choice: ApprovalChoice): string {
  return `ap:${id}:${CHOICE_CODE[choice]}`;
}

export function parseApprovalButton(data: string): { id: string; choice: ApprovalChoice } | null {
  const m = /^ap:(a\d+):([yhn])$/.exec(data);
  if (!m) return null;
  return { id: m[1] as string, choice: m[2] === 'y' ? 'approve' : m[2] === 'h' ? 'grant' : 'deny' };
}

/**
 * What the owner reads. `number` marks the request when others are open on the same platform,
 * so a reply in words can name it.
 */
export function approvalMessage(req: ApprovalRequestParams, o: { language: string; number?: number; now?: number }): ApprovalMessage {
  const cn = zh(o.language);
  const v = req.view;
  const n = o.number !== undefined && o.number > 1 ? o.number : undefined;
  const lines = [`${cn ? '【需要你确认】' : '[Needs your OK] '}${v?.title ?? req.tool}${n !== undefined ? (cn ? `（${n}）` : ` (${n})`) : ''}`];
  if (v) {
    if (v.target) lines.push(v.target);
    for (const f of v.fields) lines.push(`${f.label}${cn ? '：' : ': '}${f.value}`);
    if (v.reason) lines.push(`${cn ? '原因：' : 'Why: '}${v.reason}`);
    if (v.held) lines.push(`${cn ? '自动审核：' : 'Automatic review: '}${v.held}`);
  } else {
    lines.push(req.summary);
    if (req.reason) lines.push(`${cn ? '原因：' : 'Why: '}${req.reason}`);
  }
  const left = Date.parse(req.expiresAt) - (o.now ?? Date.now());
  if (Number.isFinite(left) && left > 0) lines.push(cn ? `${durationWords(left, o.language)}内有效` : `Valid for ${durationWords(left, o.language)}`);

  const grantMs = offeredGrantMs(req);
  const span = grantMs > 0 ? durationWords(grantMs, o.language) : '';
  const buttons: ApprovalButton[] = [{ choice: 'approve', label: cn ? '同意' : 'Approve', done: cn ? '已同意' : 'Approved', data: approvalButtonData(req.id, 'approve') }];
  if (grantMs > 0) buttons.push({ choice: 'grant', label: cn ? `同意，${span}内不再问` : `Approve, don't ask for ${span}`, done: cn ? `已同意（${span}内不再问）` : `Approved for ${span}`, data: approvalButtonData(req.id, 'grant') });
  buttons.push({ choice: 'deny', label: cn ? '拒绝' : 'Deny', done: cn ? '已拒绝' : 'Denied', data: approvalButtonData(req.id, 'deny') });

  const tag = n !== undefined ? ` ${n}` : '';
  const hint = cn
    ? `回复：同意${tag} / 拒绝${tag}${grantMs > 0 ? ` / 同意${tag} ${span}` : ''}`
    : `Reply: approve${tag} / deny${tag}${grantMs > 0 ? ` / approve${tag} ${span.replace(/ (hour|minute)s?/, (_, u: string) => u[0] as string)}` : ''}`;
  return { text: lines.join('\n'), buttons, hint };
}

/** One line for a request that is no longer open: "已同意 · 14:02". */
export function approvalOutcome(p: Pick<ApprovalResolvedParams, 'state'>, o: { language: string; timezone?: string; now?: number }): string {
  const cn = zh(o.language);
  const word = p.state === 'approved' ? (cn ? '已同意' : 'Approved') : p.state === 'denied' ? (cn ? '已拒绝' : 'Denied') : cn ? '已过期' : 'Expired';
  let at = '';
  try {
    at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(o.timezone ? { timeZone: o.timezone } : {}) }).format(new Date(o.now ?? Date.now()));
  } catch {
    // An unknown time zone only costs the time.
  }
  return at ? `${word} · ${at}` : word;
}

interface Open {
  req: ApprovalRequestParams;
  number: number;
  /** The platform's id of the message that carries the request. */
  messageId?: string;
}

type Parsed = { decision: 'approve'; number?: number; grantMs?: number } | { decision: 'deny'; number?: number; note?: string };

const UNIT = '(小时|h|hr|hrs|hours?|分钟|m|min|mins|minutes?)';
const APPROVE_RE = new RegExp(`^(?:同意|批准|approve|yes)(?:\\s*#?(\\d+)(?!\\s*${UNIT}))?(?:\\s*(\\d+)\\s*${UNIT})?$`, 'i');
/** A note may follow only the unambiguous words: "no problem" is not a refusal. */
const DENY_RE = /^(?:(?:拒绝|deny)(?:\s*#?(\d+)(?=\s|$))?(?:\s+([\s\S]+))?|(?:不行|no)(?:\s*#?(\d+))?)$/i;

function parseReply(text: string): Parsed | null {
  const t = text.trim().replace(/[.!。！]+$/u, '').trim();
  const a = APPROVE_RE.exec(t);
  if (a) {
    const grantMs = a[3] ? Number(a[3]) * (/^(小时|h)/i.test(a[4] as string) ? 3_600_000 : 60_000) : undefined;
    return { decision: 'approve', ...(a[1] ? { number: Number(a[1]) } : {}), ...(grantMs !== undefined ? { grantMs } : {}) };
  }
  const d = DENY_RE.exec(t);
  if (d) {
    const number = d[1] ?? d[3];
    return { decision: 'deny', ...(number ? { number: Number(number) } : {}), ...(d[2]?.trim() ? { note: d[2].trim() } : {}) };
  }
  return null;
}

/**
 * The requests a connector is showing, and what the owner's words or button presses mean.
 * It lives in memory: after a restart a plain "同意" is an ordinary message again, and the
 * console, the buttons of another platform or `/approve <id>` still decide.
 */
export class ApprovalInbox<C = Record<string, unknown>> {
  private readonly open = new Map<string, Open>();
  /** The request that was the last thing this connector sent to the owner, if it was one. */
  private last: string | null = null;

  constructor(private readonly host: Pick<Host<C>, 'approvals' | 'language'>) {}

  /** The text and buttons for a request, numbered among the open ones. Call `shown` once it was sent. */
  message(req: ApprovalRequestParams): ApprovalMessage & { number: number } {
    const used = new Set([...this.open.values()].map((o) => o.number));
    let number = this.open.get(req.id)?.number ?? 1;
    if (!this.open.has(req.id)) while (used.has(number)) number++;
    this.open.set(req.id, { req, number });
    return { ...approvalMessage(req, { language: this.host.language, number }), number };
  }

  /** The request went out; `messageId` lets a quoted reply or an edit find it. */
  shown(id: string, messageId?: string): void {
    const o = this.open.get(id);
    if (!o) return;
    if (messageId !== undefined) o.messageId = messageId;
    this.last = id;
  }

  /** The request could not be shown here. */
  dropped(id: string): void {
    this.open.delete(id);
    if (this.last === id) this.last = null;
  }

  /** The connector sent the owner something else: a bare "同意" is no longer about a request. */
  sentOther(): void {
    this.last = null;
  }

  /** A request was settled (here or elsewhere). Returns what was shown, so the message can be updated. */
  resolved(id: string): { messageId?: string; req: ApprovalRequestParams } | undefined {
    const o = this.open.get(id);
    this.dropped(id);
    return o ? { req: o.req, ...(o.messageId !== undefined ? { messageId: o.messageId } : {}) } : undefined;
  }

  get size(): number {
    return this.open.size;
  }

  private byMessage(messageId: string): Open | undefined {
    return [...this.open.values()].find((o) => o.messageId === messageId);
  }

  private async decide(id: string, decision: 'approve' | 'deny', senderKey: string, o: { grantMs?: number; note?: string }, title: string): Promise<string> {
    const cn = zh(this.host.language);
    const r = await this.host.approvals.decide(id, decision, senderKey, o).catch((err: Error) => ({ ok: false, message: err.message }));
    if (!r.ok) {
      const state = (r as { state?: string }).state;
      if (state && state !== 'pending') return cn ? `这个请求已经处理过了（${title}）。` : `That request was already settled (${title}).`;
      return cn ? `没能处理：${r.message ?? '未知错误'}` : `Could not do that: ${r.message ?? 'unknown error'}`;
    }
    if (decision === 'deny') return cn ? `已拒绝：${title}` : `Denied: ${title}`;
    const span = o.grantMs !== undefined ? durationWords(o.grantMs, this.host.language) : '';
    return cn ? `已同意：${title}${span ? `（${span}内不再问这一类）` : ''}` : `Approved: ${title}${span ? ` (not asking again for ${span})` : ''}`;
  }

  /**
   * The owner's message, when it decides a request: the answer to send back. Null when the
   * message is ordinary conversation.
   *
   * Words count only when they cannot be about anything else: the message quotes the request
   * (`quoted`), or names it by number, or it is exactly a reply word while one request is open
   * and that request is the last thing this connector sent. `/approve <id>` always works.
   */
  async reply(senderKey: string, text: string, o: { quoted?: string } = {}): Promise<string | null> {
    const cn = zh(this.host.language);
    const cmd = /^\/(approve|deny)\s+(a\d+)(?:\s+(\d+)\s*(m|min|h|hr)?)?\s*$/i.exec(text.trim());
    if (cmd) {
      const decision = (cmd[1] as string).toLowerCase() === 'approve' ? 'approve' : 'deny';
      // A bare number means minutes.
      const grantMs = cmd[3] && decision === 'approve' ? Number(cmd[3]) * (/^h/i.test(cmd[4] ?? '') ? 3_600_000 : 60_000) : undefined;
      const id = cmd[2] as string;
      return this.decide(id, decision, senderKey, grantMs !== undefined ? { grantMs } : {}, this.open.get(id)?.req.view?.title ?? this.open.get(id)?.req.tool ?? id);
    }
    if (this.open.size === 0) return null;
    const parsed = parseReply(text);
    if (!parsed) return null;

    const quoted = o.quoted !== undefined ? this.byMessage(o.quoted) : undefined;
    let target: Open | undefined = quoted;
    if (!target && parsed.number !== undefined) {
      target = [...this.open.values()].find((x) => x.number === parsed.number);
      // A number that names nothing is not a decision: let the assistant read the message.
      if (!target) return null;
    }
    if (!target) {
      if (this.last === null || !this.open.has(this.last)) return null;
      if (this.open.size > 1) {
        const list = [...this.open.values()].sort((a, b) => a.number - b.number).map((x) => `${x.number}. ${x.req.view?.title ?? x.req.tool}${x.req.view?.target ? `${cn ? '：' : ': '}${x.req.view.target.slice(0, 60)}` : ''}`);
        return cn ? `有 ${this.open.size} 个请求在等你确认：\n${list.join('\n')}\n回复"同意 2"或"拒绝 2"来指定。` : `${this.open.size} requests are waiting:\n${list.join('\n')}\nReply "approve 2" or "deny 2" to pick one.`;
      }
      target = this.open.get(this.last);
    }
    if (!target) return null;
    const title = target.req.view?.title ?? target.req.tool;
    if (parsed.decision === 'deny') return this.decide(target.req.id, 'deny', senderKey, parsed.note !== undefined ? { note: parsed.note } : {}, title);
    const max = target.req.grantMaxMs ?? 0;
    const grantMs = parsed.grantMs !== undefined && max > 0 ? Math.min(parsed.grantMs, max) : undefined;
    return this.decide(target.req.id, 'approve', senderKey, grantMs !== undefined ? { grantMs } : {}, title);
  }

  /**
   * A button was pressed. The caller has already checked that the owner pressed it. `ok` is
   * false when the request is no longer open; `text` says what happened either way.
   */
  async press(senderKey: string, data: string): Promise<{ ok: boolean; text: string } | null> {
    const b = parseApprovalButton(data);
    if (!b) return null;
    const cn = zh(this.host.language);
    const o = this.open.get(b.id);
    const title = o?.req.view?.title ?? b.id;
    const grantMs = b.choice === 'grant' && o ? offeredGrantMs(o.req) : 0;
    const r = await this.host.approvals.decide(b.id, b.choice === 'deny' ? 'deny' : 'approve', senderKey, grantMs > 0 ? { grantMs } : {}).catch((err: Error) => ({ ok: false, message: err.message }));
    if (!r.ok) return { ok: false, text: cn ? '这个请求已经处理过了' : 'That request was already settled' };
    return { ok: true, text: b.choice === 'deny' ? (cn ? `已拒绝：${title}` : `Denied: ${title}`) : cn ? `已同意：${title}` : `Approved: ${title}` };
  }
}
