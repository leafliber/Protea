import { useState } from 'react';
import type { ApprovalInfo } from '@protea/protocol';
import { post, qs, useAction, useApi } from '../api';
import { Button, Card, Empty, ErrorText, StateBadge, Tabs, dateTime, oneLine, timeAgo } from '../components/ui';
import { useReloadOn } from '../live';
import { useSession } from '../session';

interface AuditRow {
  id: number;
  at: string;
  kind: string;
  tool?: string;
  owner?: string;
  summary?: string;
  outcome?: string;
  policy?: string;
  approvalId?: string;
}

function Audit() {
  const [kind, setKind] = useState('');
  const r = useApi<{ audit: AuditRow[] }>(`/api/audit${qs({ kind, limit: 200 })}`, { refreshMs: 10_000 });
  return (
    <Card
      title="审计记录"
      actions={
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部</option>
          {['tool_call', 'tool_blocked', 'approval_requested', 'approval_decided', 'approval_expired', 'memory_write', 'control_write'].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      }
    >
      <ErrorText error={r.error} />
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>工具</th>
            <th>摘要</th>
            <th>主体</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {r.data?.audit.map((a) => (
            <tr key={a.id}>
              <td className="nowrap" title={dateTime(a.at)}>{timeAgo(a.at)}</td>
              <td className="nowrap small">{a.kind}</td>
              <td className="mono small">{a.tool}</td>
              <td>{oneLine(a.summary ?? '', 100)}</td>
              <td className="small">{a.owner}</td>
              <td className="small">{[a.policy, a.outcome].filter(Boolean).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function Approvals() {
  const { canWrite } = useSession();
  const [tab, setTab] = useState<'pending' | 'history' | 'audit'>('pending');
  const r = useApi<{ approvals: ApprovalInfo[] }>(`/api/approvals${tab === 'pending' ? '?state=pending' : ''}`);
  useReloadOn('approval', r.reload, 200);
  const act = useAction();
  const decide = (id: string, decision: 'approve' | 'deny') => void act.run(() => post(`/api/approvals/${id}/decide`, { decision })).then(r.reload);
  return (
    <div className="page">
      <Tabs
        tabs={[
          ['pending', '待审批'],
          ['history', '全部'],
          ['audit', '审计'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'audit' ? (
        <Audit />
      ) : (
        <Card title={tab === 'pending' ? '待审批' : '审批记录'}>
          <ErrorText error={r.error ?? act.error} />
          {r.data?.approvals.length === 0 && <Empty>{tab === 'pending' ? '没有等待审批的请求' : '没有记录'}</Empty>}
          <ul className="list">
            {r.data?.approvals.map((a) => (
              <li key={a.id} className="approval">
                <div className="row">
                  <strong>#{a.id}</strong> <StateBadge state={a.state} /> <code>{a.tool}</code>
                  <span className="grow">{a.summary}</span>
                  {canWrite && a.state === 'pending' && (
                    <>
                      <Button kind="primary" small busy={act.busy} onClick={() => decide(a.id, 'approve')}>
                        同意
                      </Button>
                      <Button kind="danger" small busy={act.busy} onClick={() => decide(a.id, 'deny')}>
                        拒绝
                      </Button>
                    </>
                  )}
                </div>
                {a.reason && <div className="muted small">理由：{a.reason}</div>}
                <div className="muted small">
                  请求于 {dateTime(a.createdAt)} · 到期 {dateTime(a.expiresAt)}
                  {a.decidedBy ? ` · ${a.decidedBy} 于 ${dateTime(a.decidedAt)} 决定` : ''}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
