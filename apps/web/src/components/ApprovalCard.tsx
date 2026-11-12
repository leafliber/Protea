import { useState } from 'react';
import type { ApprovalInfo } from '@protea/protocol';
import { post } from '../api';
import { Button, Countdown, cx, dateTime, useFeedback } from './ui';
import { IconCheckShield } from './icons';

const HOUR = 3_600_000;

/** Who decided, as a person reads it: "网页控制台", "QQ". */
export function decidedVia(by: string | undefined): string {
  if (!by) return '';
  const plugin = by.split(':')[0] ?? by;
  return PLATFORM_LABEL[plugin] ?? plugin;
}

export const PLATFORM_LABEL: Record<string, string> = { console: '控制台', webchat: '网页对话', telegram: 'Telegram', wechat: '微信', qq: 'QQ', api: 'API', cli: '命令行' };

export const platformNames = (ids: readonly string[] | undefined): string => (ids ?? []).map((p) => PLATFORM_LABEL[p] ?? p).join('、');

/** What a request is about, on one line: for lists and history. */
export function approvalTitle(a: ApprovalInfo): string {
  return a.view?.title ?? a.tool;
}

/**
 * A request waiting for the owner: what is about to happen, the value that matters set apart,
 * the reason, and the three answers. Used in the conversation and on the approvals page.
 */
export function ApprovalCard({ a, canWrite, grantMaxMs, onDecided, compact }: { a: ApprovalInfo; canWrite: boolean; grantMaxMs: number; onDecided?: () => void; compact?: boolean }) {
  const { toast } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [denying, setDenying] = useState(false);
  const [granting, setGranting] = useState(false);
  const [note, setNote] = useState('');
  const v = a.view;
  const decide = async (decision: 'approve' | 'deny', grantMs?: number) => {
    setBusy(true);
    try {
      await post(`/api/approvals/${encodeURIComponent(a.id)}/decide`, { decision, ...(grantMs !== undefined ? { grantMs } : {}), ...(decision === 'deny' && note.trim() ? { note: note.trim() } : {}) });
      toast(decision === 'approve' ? `已同意：${approvalTitle(a)}` : `已拒绝：${approvalTitle(a)}`);
      onDecided?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const grants = [HOUR, 8 * HOUR].filter((ms) => ms <= grantMaxMs);
  return (
    <article className={cx('ap-card', compact && 'ap-compact')} role="alert" aria-label={`需要你确认：${approvalTitle(a)}`}>
      <header className="ap-head">
        <span className="ap-tag">
          <IconCheckShield size={14} /> 需要你确认
        </span>
        <span className="ap-left" title={`到期 ${dateTime(a.expiresAt)}`}>
          还剩 <Countdown until={a.expiresAt} />
        </span>
      </header>
      <h3 className="ap-title">{approvalTitle(a)}</h3>
      {v?.target ? <pre className="ap-target">{v.target}</pre> : !v && <div className="ap-summary">{a.summary}</div>}
      {(v?.fields.length || v?.reason || v?.held || (!v && a.reason)) && (
        <dl className="ap-fields">
          {v?.fields.map((f) => (
            <div key={f.label} className="ap-field">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
          {(v?.reason ?? (!v ? a.reason : undefined)) && (
            <div className="ap-field ap-reason">
              <dt>原因</dt>
              <dd>{v?.reason ?? a.reason}</dd>
            </div>
          )}
          {v?.held && (
            <div className="ap-field">
              <dt>自动审核</dt>
              <dd>{v.held}</dd>
            </div>
          )}
        </dl>
      )}
      {a.input && (
        <div className="ap-more">
          <button type="button" className="link" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? '收起完整参数' : '完整参数'}
          </button>
          <span className="muted small">
            工具 <code>{a.tool}</code>
            {a.deliveredTo?.length ? ` · 已发到 ${platformNames(a.deliveredTo)}` : ''}
          </span>
          {more && <pre className="ap-input">{a.input}</pre>}
        </div>
      )}
      {canWrite && denying && (
        <div className="ap-deny">
          <input autoFocus value={note} maxLength={300} placeholder="可以告诉助理为什么（可选）" aria-label="拒绝的原因" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void decide('deny')} />
          <Button small onClick={() => setDenying(false)}>
            取消
          </Button>
          <Button small kind="danger" busy={busy} onClick={() => void decide('deny')}>
            拒绝
          </Button>
        </div>
      )}
      {canWrite && !denying && (
        <footer className="ap-actions">
          <Button small disabled={busy} onClick={() => setDenying(true)}>
            拒绝…
          </Button>
          {grants.length > 0 && (
            <div className="ap-grant">
              <Button small disabled={busy} title={`同意这一次，并在一段时间内不再为${v?.family.label ?? '同一组工具'}询问（照常记录）`} onClick={() => setGranting(!granting)}>
                同意并暂时不再问 ▾
              </Button>
              {granting && (
                <div className="menu-pop ap-grant-pop" role="menu">
                  <div className="menu-note">不再询问：{v?.family.label ?? '同一组工具'}</div>
                  {grants.map((ms) => (
                    <button key={ms} type="button" role="menuitem" className="menu-item" onClick={() => void decide('approve', ms)}>
                      {ms / HOUR} 小时内
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <Button small kind="primary" busy={busy} onClick={() => void decide('approve')}>
            同意
          </Button>
        </footer>
      )}
    </article>
  );
}
