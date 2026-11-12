import { useState } from 'react';
import type { ApprovalGrantInfo, PermissionMode, PermissionModeInfo } from '@protea/protocol';
import { api, post, qs, useAction, useApi } from '../api';
import { decidedVia } from '../components/ApprovalCard';
import { Badge, Button, Card, Countdown, Empty, ErrorText, Tabs, cx, dateTime, oneLine, timeAgo, useFeedback } from '../components/ui';
import { useReloadOn } from '../live';
import { go, useSession } from '../session';

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
  detail?: string;
}

const MODES: Array<{ id: PermissionMode; label: string; what: string }> = [
  { id: 'ask', label: '每次都问我', what: '需要确认的操作都发给你，由你决定。最稳妥。' },
  { id: 'auto', label: '自动判断', what: '由判断模型先看：它有把握的直接放行，拿不准的再问你。' },
  { id: 'bypass', label: '暂时不问', what: '一段时间内直接执行，照常留记录。必须选时限；你写明“要问”的工具仍然会问。' },
  { id: 'locked', label: '锁定', what: '需要确认的操作一律不执行，也不来打扰你。适合外出或休息时。' },
];

const DURATIONS: Array<[number, string]> = [
  [0, '一直生效'],
  [1_800_000, '30 分钟'],
  [3_600_000, '1 小时'],
  [7_200_000, '2 小时'],
  [28_800_000, '8 小时'],
];

const modeLabel = (m: PermissionMode): string => MODES.find((x) => x.id === m)?.label ?? m;

/** Who clears the calls that need a confirmation, and for how long. */
function ModeCard({ canWrite }: { canWrite: boolean }) {
  const r = useApi<PermissionModeInfo>('/api/permissions/mode', { refreshMs: 30_000 });
  useReloadOn('permission', r.reload, 200);
  const { confirm, toast } = useFeedback();
  const [forMs, setForMs] = useState(0);
  const act = useAction();
  const info = r.data;
  const choose = async (mode: PermissionMode) => {
    const span = DURATIONS.find(([ms]) => ms === forMs)?.[1] ?? '';
    if (mode === 'bypass' && !(await confirm({ title: `接下来 ${span}内不再询问？`, body: '这段时间里，需要确认的操作会直接执行（你在规则里写明“要问”的除外），每一次都照常留记录。', confirm: '不再询问', danger: true }))) return;
    void act
      .run(() => post('/api/permissions/mode', { mode, ...(forMs > 0 ? { forMs } : {}) }))
      .then((ok) => {
        if (ok) toast(`权限模式：${modeLabel(mode)}${forMs > 0 ? `（${span}）` : ''}`);
        r.reload();
      });
  };
  return (
    <Card title="谁来放行需要确认的操作">
      <ErrorText error={r.error ?? act.error} />
      {info?.paused && <div className="banner banner-warn">自动判断已暂停：{info.paused.reason}。重新选择“自动判断”可恢复。</div>}
      {info && !info.auto.judge.ready && (info.mode === 'auto' || info.baseline === 'auto') && <div className="banner banner-warn">判断模型未就绪：{info.auto.judge.problem ?? '未知原因'}。需要确认的操作会转给你。</div>}
      <div className="mode-grid" role="radiogroup" aria-label="权限模式">
        {MODES.map((m) => {
          const on = info?.mode === m.id;
          const needsTime = m.id === 'bypass' && forMs === 0;
          return (
            <button key={m.id} type="button" role="radio" aria-checked={on} disabled={!canWrite || act.busy || needsTime || (m.id === 'bypass' && info?.bypassMaxMs === 0)} className={cx('mode-card', on && 'mode-on', m.id === 'bypass' && 'mode-risk')} onClick={() => void choose(m.id)}>
              <span className="mode-name">
                {m.label}
                {on && <Badge tone={m.id === 'bypass' ? 'warn' : 'good'}>当前</Badge>}
              </span>
              <span className="mode-what">{m.what}</span>
              {needsTime && canWrite && <span className="mode-hint">先在下面选一个时限</span>}
            </button>
          );
        })}
      </div>
      <div className="row mode-foot">
        {canWrite && (
          <label className="row small">
            切换后生效
            <select value={forMs} onChange={(e) => setForMs(Number(e.target.value))}>
              {DURATIONS.map(([ms, label]) => (
                <option key={ms} value={ms}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="muted small grow">
          {info?.override ? (
            <>
              临时模式，还剩 <Countdown until={info.override.until} done="即将恢复" />，之后回到“{modeLabel(info.baseline)}”
            </>
          ) : (
            '长期模式，写在 config.yaml 里'
          )}
          {info && (info.mode === 'auto' || info.paused) ? ` · 判断模型 ${info.auto.judge.model}，自 ${timeAgo(info.auto.since)}放行 ${info.auto.allowed} 次、转给你 ${info.auto.held} 次` : ''}
        </span>
      </div>
    </Card>
  );
}

interface PermissionView {
  settings: { default: string; tools: Record<string, string>; approvalTtlMs: number };
  tools: Array<{ name: string; owner: string; policy: string; rule: string }>;
}

const POLICY: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = { allow: { label: '直接执行', tone: 'good' }, ask: { label: '先问我', tone: 'warn' }, deny: { label: '禁止', tone: 'bad' } };

/** What each tool may do without asking. */
function Rules({ canWrite }: { canWrite: boolean }) {
  const r = useApi<PermissionView>('/api/permissions');
  const [filter, setFilter] = useState('');
  const [only, setOnly] = useState('');
  const act = useAction();
  const { toast } = useFeedback();
  const setPolicy = (tool: string, policy: string | null) =>
    void act
      .run(() => api('PATCH', '/api/permissions', { tools: { [tool]: policy } }))
      .then((ok) => {
        if (ok) toast(policy ? `${tool}：${POLICY[policy]?.label ?? policy}` : `${tool}：恢复默认规则`);
        r.reload();
      });
  const tools = r.data?.tools.filter((t) => (!filter || t.name.includes(filter) || t.owner.includes(filter)) && (!only || t.policy === only)) ?? [];
  const count = (p: string): number => r.data?.tools.filter((t) => t.policy === p).length ?? 0;
  return (
    <Card
      title="每个工具的规则"
      actions={
        <>
          <select value={only} onChange={(e) => setOnly(e.target.value)} aria-label="按规则筛选">
            <option value="">全部</option>
            <option value="ask">先问我（{count('ask')}）</option>
            <option value="allow">直接执行（{count('allow')}）</option>
            <option value="deny">禁止（{count('deny')}）</option>
          </select>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜索工具或来源" aria-label="搜索工具" />
        </>
      }
    >
      <ErrorText error={r.error ?? act.error} />
      {r.data && (
        <div className="muted small">
          没有单独设置的工具：{POLICY[r.data.settings.default]?.label ?? r.data.settings.default}。一次确认请求的有效期是 {Math.round(r.data.settings.approvalTtlMs / 60_000)} 分钟。
        </div>
      )}
      <table className="table table-cards">
        <thead>
          <tr>
            <th>工具</th>
            <th>来自</th>
            <th>现在的规则</th>
            <th>依据</th>
            {canWrite && <th>改为</th>}
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.name}>
              <td data-label="工具" className="mono small">
                {t.name}
              </td>
              <td data-label="来自" className="small">
                {t.owner}
              </td>
              <td data-label="规则">
                <Badge tone={POLICY[t.policy]?.tone ?? 'neutral'} title={t.policy}>
                  {POLICY[t.policy]?.label ?? t.policy}
                </Badge>
              </td>
              <td data-label="依据" className="small muted">
                {t.rule}
              </td>
              {canWrite && (
                <td data-label="改为">
                  <select value={r.data?.settings.tools[t.name] ?? ''} aria-label={`${t.name} 的规则`} onChange={(e) => setPolicy(t.name, e.target.value || null)}>
                    <option value="">按默认规则</option>
                    <option value="allow">直接执行</option>
                    <option value="ask">先问我</option>
                    <option value="deny">禁止</option>
                  </select>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {r.data && tools.length === 0 && <Empty>没有符合条件的工具</Empty>}
    </Card>
  );
}

function Grants({ canWrite }: { canWrite: boolean }) {
  const r = useApi<{ grants: ApprovalGrantInfo[] }>('/api/approvals/grants', { refreshMs: 30_000 });
  useReloadOn('approval', r.reload, 200);
  const act = useAction();
  const { toast } = useFeedback();
  const revoke = (id: string) =>
    void act
      .run(() => post(`/api/approvals/grants/${id}/revoke`))
      .then((ok) => {
        if (ok) toast('已撤销');
        r.reload();
      });
  const grants = [...(r.data?.grants ?? [])].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <Card title="暂时不再询问的范围">
      <div className="muted small">你在同意某个请求时选了“暂时不再问”，就会在这里出现一条。到期自动失效，也可以提前撤销。</div>
      <ErrorText error={r.error ?? act.error} />
      {r.data?.grants.length === 0 && <Empty>现在没有</Empty>}
      <ul className="list">
        {grants.map((g) => (
          <li key={g.id} className={cx('approval', !g.active && 'row-off')}>
            <div className="row">
              <code>{g.family}</code>
              {g.active ? (
                <Badge tone="warn">
                  还剩 <Countdown until={g.expiresAt} />
                </Badge>
              ) : (
                <Badge tone="muted">{g.revokedAt ? '已撤销' : '已到期'}</Badge>
              )}
              <span className="grow" />
              {canWrite && g.active && (
                <Button kind="danger" small busy={act.busy} onClick={() => revoke(g.id)}>
                  撤销
                </Button>
              )}
            </div>
            <div className="muted small">
              {dateTime(g.createdAt)} 在{decidedVia(g.decidedBy)}同意 · {g.active ? `到 ${dateTime(g.expiresAt)}` : g.revokedAt ? `撤销于 ${dateTime(g.revokedAt)}` : `到期于 ${dateTime(g.expiresAt)}`}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const AUDIT_KIND: Record<string, string> = {
  tool_call: '执行了工具',
  tool_blocked: '拦下了工具',
  approval_requested: '发出确认请求',
  approval_decided: '请求有了决定',
  approval_expired: '请求过期',
  approval_grant: '暂时不再询问',
  permission_mode: '切换权限模式',
  permission_judge: '自动判断',
  memory_write: '写入记忆',
  control_write: '控制台操作',
};

function Audit() {
  const [kind, setKind] = useState('');
  const r = useApi<{ audit: AuditRow[] }>(`/api/audit${qs({ kind, limit: 200 })}`, { refreshMs: 10_000 });
  return (
    <Card
      title="审计记录"
      actions={
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="按类型筛选">
          <option value="">全部类型</option>
          {Object.entries(AUDIT_KIND).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      }
    >
      <ErrorText error={r.error} />
      <table className="table table-cards">
        <thead>
          <tr>
            <th>时间</th>
            <th>发生了什么</th>
            <th>工具</th>
            <th>内容</th>
            <th>谁</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {r.data?.audit.map((a) => (
            <tr key={a.id}>
              <td data-label="时间" className="nowrap" title={dateTime(a.at)}>
                {timeAgo(a.at)}
              </td>
              <td data-label="事件" className="nowrap small" title={a.kind}>
                {AUDIT_KIND[a.kind] ?? a.kind}
              </td>
              <td data-label="工具" className="mono small">
                {a.tool}
              </td>
              <td data-label="内容" title={a.summary}>
                {oneLine(a.summary ?? a.detail ?? '', 100)}
              </td>
              <td data-label="谁" className="small">
                {a.owner}
              </td>
              <td data-label="结果" className="small">
                {[a.policy, a.outcome].filter(Boolean).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.data?.audit.length === 0 && <Empty>没有记录</Empty>}
    </Card>
  );
}

type Tab = 'mode' | 'rules' | 'grants' | 'audit';
const TABS: readonly Tab[] = ['mode', 'rules', 'grants', 'audit'];

/** Everything that decides what the assistant may do without asking, in one place. */
export function Permissions({ params }: { params: URLSearchParams }) {
  const { canWrite } = useSession();
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked !== null && TABS.includes(asked) ? asked : 'mode';
  return (
    <div className="page">
      <Tabs
        tabs={[
          ['mode', '模式'],
          ['rules', '工具规则'],
          ['grants', '暂时不再询问'],
          ['audit', '审计记录'],
        ]}
        value={tab}
        onChange={(t) => go('permissions', t === 'mode' ? {} : { tab: t })}
      />
      {tab === 'mode' && <ModeCard canWrite={canWrite} />}
      {tab === 'rules' && <Rules canWrite={canWrite} />}
      {tab === 'grants' && <Grants canWrite={canWrite} />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
