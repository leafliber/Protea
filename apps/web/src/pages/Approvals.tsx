import { useState } from 'react';
import type { ApprovalInfo, PermissionModeInfo } from '@protea/protocol';
import { useApi } from '../api';
import { ApprovalCard, approvalTitle, decidedVia, platformNames } from '../components/ApprovalCard';
import { IconCheckShield } from '../components/icons';
import { Card, EmptyState, ErrorText, Skeleton, StateBadge, Tabs, cx, dateTime, oneLine, timeAgo } from '../components/ui';
import { useReloadOn } from '../live';
import { consoleHref, go, useSession } from '../session';
import { ChangeRequests, usePendingChanges } from './Changes';

/** The longest "do not ask again" the owner may give; 0 when it is switched off. */
export function useGrantMax(): number {
  const r = useApi<PermissionModeInfo>('/api/permissions/mode');
  useReloadOn('permission', r.reload, 500);
  return r.data?.bypassMaxMs ?? 0;
}

const STATES: Array<[string, string]> = [
  ['', '全部结果'],
  ['approved', '已同意，等助理执行'],
  ['used', '已同意并执行'],
  ['denied', '已拒绝'],
  ['expired', '已过期'],
];

/** One settled request: what it was, how it ended, and the rest on demand. */
function HistoryRow({ a }: { a: ApprovalInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cx('approval hist', open && 'hist-open')}>
      <button type="button" className="hist-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StateBadge state={a.state} />
        <span className="hist-title">{approvalTitle(a)}</span>
        <span className="hist-target">{oneLine(a.view?.target ?? (a.view ? '' : a.summary), 90)}</span>
        <span className="muted small nowrap" title={dateTime(a.decidedAt ?? a.createdAt)}>
          {timeAgo(a.decidedAt ?? a.createdAt)}
        </span>
      </button>
      {open && (
        <div className="hist-body">
          {a.view?.target && <pre className="ap-target">{a.view.target}</pre>}
          <dl className="ap-fields">
            {a.view?.fields.map((f) => (
              <div key={f.label} className="ap-field">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
            {(a.view?.reason ?? a.reason) && (
              <div className="ap-field">
                <dt>原因</dt>
                <dd>{a.view?.reason ?? a.reason}</dd>
              </div>
            )}
            {a.note && (
              <div className="ap-field">
                <dt>你说的话</dt>
                <dd>{a.note}</dd>
              </div>
            )}
          </dl>
          <div className="muted small">
            {dateTime(a.createdAt)} 提出
            {a.deliveredTo?.length ? `，发到 ${platformNames(a.deliveredTo)}` : ''}
            {a.decidedBy ? ` · ${dateTime(a.decidedAt)} 在${decidedVia(a.decidedBy)}决定` : ''}
            {a.grantId ? (
              <>
                {' · '}
                <a href={consoleHref('permissions', { tab: 'grants' })}>同时设了暂时不再询问</a>
              </>
            ) : null}
            {' · '}
            工具 <code>{a.tool}</code> · 编号 {a.id}
          </div>
          {a.input && <pre className="ap-input">{a.input}</pre>}
        </div>
      )}
    </li>
  );
}

function History() {
  const [state, setState] = useState('');
  const r = useApi<{ approvals: ApprovalInfo[] }>(`/api/approvals${state ? `?state=${state}` : ''}`);
  useReloadOn('approval', r.reload, 300);
  const rows = r.data?.approvals.filter((a) => a.state !== 'pending') ?? [];
  return (
    <Card
      title="处理过的请求"
      actions={
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="按结果筛选">
          {STATES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      }
    >
      <ErrorText error={r.error} />
      {!r.data && !r.error && <Skeleton />}
      {r.data && rows.length === 0 && <div className="empty">没有记录</div>}
      <ul className="list">
        {rows.map((a) => (
          <HistoryRow key={a.id} a={a} />
        ))}
      </ul>
    </Card>
  );
}

type Tab = 'pending' | 'changes' | 'history';
const TABS: readonly Tab[] = ['pending', 'changes', 'history'];

/** The inbox: what is waiting for the owner's decision, and what was decided. */
export function Approvals({ params }: { params: URLSearchParams }) {
  const { canWrite } = useSession();
  const asked = params.get('tab');
  const tab: Tab = asked !== null && (TABS as readonly string[]).includes(asked) ? (asked as Tab) : 'pending';
  const pendingChanges = usePendingChanges();
  const grantMax = useGrantMax();
  const r = useApi<{ approvals: ApprovalInfo[] }>('/api/approvals?state=pending');
  useReloadOn('approval', r.reload, 200);
  const pending = r.data?.approvals.filter((a) => a.state === 'pending') ?? [];
  return (
    <div className="page">
      <Tabs
        tabs={[
          [
            'pending',
            <>
              等你确认
              {pending.length > 0 && <span className="tab-count">{pending.length}</span>}
            </>,
          ],
          [
            'changes',
            <>
              能力变更
              {pendingChanges.length > 0 && <span className="tab-count">{pendingChanges.length}</span>}
            </>,
          ],
          ['history', '处理记录'],
        ]}
        value={tab}
        onChange={(t) => go('approvals', t === 'pending' ? {} : { tab: t })}
      />
      {tab === 'history' ? (
        <History />
      ) : tab === 'changes' ? (
        <ChangeRequests selected={params.get('id')} />
      ) : (
        <>
          <ErrorText error={r.error} />
          {!r.data && !r.error && <Skeleton />}
          {pendingChanges.length > 0 && (
            <a className="banner banner-info banner-link" href={consoleHref('approvals', { tab: 'changes' })}>
              助理提议了 {pendingChanges.length} 项对自己能力的改动（MCP、Skills 或插件），等你审核 →
            </a>
          )}
          {r.data && pending.length === 0 && (
            <EmptyState icon={<IconCheckShield size={28} />} title="没有等你确认的操作">
              助理要做需要你点头的事（运行命令、给别人发消息等）时，请求会出现在这里，也会发到你的聊天平台。
              <br />
              想调整哪些事要问你，去 <a href={consoleHref('permissions')}>权限</a>。
            </EmptyState>
          )}
          <div className="ap-list">
            {pending.map((a) => (
              <ApprovalCard key={a.id} a={a} canWrite={canWrite} grantMaxMs={grantMax} onDecided={r.reload} />
            ))}
          </div>
          {!canWrite && pending.length > 0 && <div className="muted small">只读账号不能决定请求。</div>}
        </>
      )}
    </div>
  );
}
