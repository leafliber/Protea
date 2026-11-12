import { useState } from 'react';
import type { ApprovalGrantInfo, ApprovalInfo, PermissionMode, PermissionModeInfo } from '@protea/protocol';
import { post, qs, useAction, useApi } from '../api';
import { Badge, Button, Card, Empty, ErrorText, StateBadge, Tabs, dateTime, oneLine, timeAgo } from '../components/ui';
import { useReloadOn } from '../live';
import { go, useSession } from '../session';
import { ChangeRequests, usePendingChanges } from './Changes';

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

const MODES: Array<[PermissionMode, string, string]> = [
  ['ask', '逐次审批', '需要审批的调用都问你'],
  ['auto', '自动判断', '判断模型放行；没放行的转给你'],
  ['bypass', '暂时免审批', '直接执行，照常审计；必须带时限'],
  ['locked', '锁定', '需要审批的调用一律不执行，也不打扰你'],
];

const DURATIONS: Array<[number, string]> = [
  [0, '一直'],
  [1_800_000, '30 分钟'],
  [3_600_000, '1 小时'],
  [7_200_000, '2 小时'],
  [28_800_000, '8 小时'],
];

const modeLabel = (m: PermissionMode): string => MODES.find(([id]) => id === m)?.[1] ?? m;

/** Who clears calls that need approval, and for how long. */
function ModeCard({ canWrite }: { canWrite: boolean }) {
  const r = useApi<PermissionModeInfo>('/api/permissions/mode', { refreshMs: 30_000 });
  useReloadOn('permission', r.reload, 200);
  const [forMs, setForMs] = useState(0);
  const act = useAction();
  const info = r.data;
  const choose = (mode: PermissionMode) => {
    if (mode === 'bypass' && !confirm(`接下来 ${DURATIONS.find(([ms]) => ms === forMs)?.[1]} 内，需要审批的工具将直接执行（你在权限规则里写明要询问的除外）。确定？`)) return;
    void act.run(() => post('/api/permissions/mode', { mode, ...(forMs > 0 ? { forMs } : {}) })).then(r.reload);
  };
  return (
    <Card
      title={
        <span>
          权限模式 {info && <Badge tone={info.mode === 'bypass' ? 'warn' : info.mode === 'ask' ? 'neutral' : 'info'}>{modeLabel(info.mode)}</Badge>}
        </span>
      }
    >
      <ErrorText error={r.error ?? act.error} />
      {info?.paused && <div className="banner banner-warn">自动判断已暂停：{info.paused.reason}。重新选择"自动判断"可恢复。</div>}
      {info && !info.auto.judge.ready && (info.mode === 'auto' || info.baseline === 'auto') && <div className="banner banner-warn">判断模型未就绪：{info.auto.judge.problem ?? '未知原因'}。需要审批的调用会转给你。</div>}
      <p className="muted small">
        {info?.override ? `临时模式，到 ${dateTime(info.override.until)} 回到"${modeLabel(info.baseline)}"（${info.override.by} 设置）` : '长期模式，写在 config.yaml 里'}
        {info && (info.mode === 'auto' || info.paused) ? ` · 判断模型 ${info.auto.judge.model} · 自 ${timeAgo(info.auto.since)}：放行 ${info.auto.allowed} 次，转交 ${info.auto.held} 次` : ''}
      </p>
      {canWrite && (
        <div className="row">
          {MODES.map(([id, label, hint]) => (
            <Button key={id} small kind={info?.mode === id ? 'primary' : undefined} busy={act.busy} title={hint} disabled={id === 'bypass' && forMs === 0} onClick={() => choose(id)}>
              {label}
            </Button>
          ))}
          <select value={forMs} onChange={(e) => setForMs(Number(e.target.value))} title="选择时限后，切换只在这段时间内有效">
            {DURATIONS.map(([ms, label]) => (
              <option key={ms} value={ms}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
    </Card>
  );
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
          {['tool_call', 'tool_blocked', 'approval_requested', 'approval_decided', 'approval_expired', 'approval_grant', 'permission_mode', 'permission_judge', 'memory_write', 'control_write'].map((k) => (
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

function Grants({ canWrite }: { canWrite: boolean }) {
  const r = useApi<{ grants: ApprovalGrantInfo[] }>('/api/approvals/grants', { refreshMs: 30_000 });
  useReloadOn('approval', r.reload, 200);
  const act = useAction();
  const revoke = (id: string) => void act.run(() => post(`/api/approvals/grants/${id}/revoke`)).then(r.reload);
  return (
    <Card title="时限授权">
      <ErrorText error={r.error ?? act.error} />
      {r.data?.grants.length === 0 && <Empty>没有授权记录</Empty>}
      <ul className="list">
        {r.data?.grants.map((g) => (
          <li key={g.id} className="approval">
            <div className="row">
              <strong>#{g.id}</strong> <code>{g.family}</code>
              <span className="grow muted small">{g.active ? `有效，到 ${dateTime(g.expiresAt)}` : g.revokedAt ? `已撤销（${dateTime(g.revokedAt)}）` : `已到期（${dateTime(g.expiresAt)}）`}</span>
              {canWrite && g.active && (
                <Button kind="danger" small busy={act.busy} onClick={() => revoke(g.id)}>
                  撤销
                </Button>
              )}
            </div>
            <div className="muted small">
              来自审批 #{g.approvalId} · {g.decidedBy} · {dateTime(g.createdAt)}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type ApprovalTab = 'pending' | 'changes' | 'history' | 'grants' | 'audit';
const APPROVAL_TABS: readonly ApprovalTab[] = ['pending', 'changes', 'history', 'grants', 'audit'];

export function Approvals({ params }: { params: URLSearchParams }) {
  const { canWrite } = useSession();
  const asked = params.get('tab') as ApprovalTab | null;
  const tab: ApprovalTab = asked !== null && APPROVAL_TABS.includes(asked) ? asked : 'pending';
  const setTab = (t: ApprovalTab) => go('approvals', t === 'pending' ? {} : { tab: t });
  const pendingChanges = usePendingChanges().length;
  const r = useApi<{ approvals: ApprovalInfo[] }>(`/api/approvals${tab === 'pending' ? '?state=pending' : ''}`);
  useReloadOn('approval', r.reload, 200);
  const act = useAction();
  const decide = (id: string, decision: 'approve' | 'deny', grantMs?: number) => void act.run(() => post(`/api/approvals/${id}/decide`, { decision, ...(grantMs !== undefined ? { grantMs } : {}) })).then(r.reload);
  return (
    <div className="page">
      <ModeCard canWrite={canWrite} />
      <Tabs
        tabs={[
          ['pending', '待审批'],
          [
            'changes',
            <>
              能力变更
              {pendingChanges > 0 && <span className="tab-count">{pendingChanges}</span>}
            </>,
          ],
          ['history', '全部'],
          ['grants', '时限授权'],
          ['audit', '审计'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'audit' ? (
        <Audit />
      ) : tab === 'changes' ? (
        <ChangeRequests selected={params.get('id')} />
      ) : tab === 'grants' ? (
        <Grants canWrite={canWrite} />
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
                      <Button small busy={act.busy} title="同意这次调用，并在 1 小时内放行同一组工具（照常审计）" onClick={() => decide(a.id, 'approve', 3_600_000)}>
                        同意并放行 1 小时
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
