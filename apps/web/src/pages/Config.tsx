import { useMemo, useState, type FormEvent } from 'react';
import type { BudgetStatus, ConfigResponse, SecretInfo } from '@protea/protocol';
import { api, enc, post, useAction, useApi } from '../api';
import { Badge, Bar, Button, Card, ErrorText, Field, LevelBadge, Tabs, usd } from '../components/ui';
import { go, useSession } from '../session';

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function patchFor(dotted: string, value: unknown): Record<string, unknown> {
  return dotted
    .split('.')
    .filter(Boolean)
    .reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>;
}

function flatten(node: unknown, prefix = ''): Array<[string, unknown]> {
  if (typeof node === 'object' && node !== null && !Array.isArray(node) && Object.keys(node).length > 0) {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}

type PatchResult = { changed: string[]; restartRequired: string[] };

function PatchNotice({ result }: { result: PatchResult | null }) {
  if (!result) return null;
  if (result.changed.length === 0) return <span className="muted small">没有变化</span>;
  return (
    <span className="small">
      已保存 {result.changed.join(', ')}
      {result.restartRequired.length ? <Badge tone="warn">重启后生效：{result.restartRequired.join(', ')}</Badge> : <Badge tone="good">已生效</Badge>}
    </span>
  );
}

function Effective() {
  const { canWrite } = useSession();
  const r = useApi<ConfigResponse>('/api/config');
  const [filter, setFilter] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [patch, setPatch] = useState('{\n  \n}');
  const [result, setResult] = useState<PatchResult | null>(null);
  const act = useAction();
  const rows = useMemo(() => (r.data ? flatten(r.data.config) : []), [r.data]);
  const apply = (p: Record<string, unknown>) =>
    void act.run(async () => {
      setResult(await api<PatchResult>('PATCH', '/api/config', p));
      r.reload();
    });
  const submitKey = (e: FormEvent) => {
    e.preventDefault();
    apply(patchFor(key, value.trim() === '' ? null : parseValue(value)));
  };
  return (
    <>
      {canWrite && (
        <Card title="修改配置">
          <form className="row" onSubmit={submitKey}>
            <input className="grow" list="config-keys" value={key} onChange={(e) => setKey(e.target.value)} placeholder="路径，如 scheduler.levels.2.debounceMs" />
            <datalist id="config-keys">
              {rows.map(([k]) => (
                <option key={k} value={k} />
              ))}
            </datalist>
            <input className="grow" value={value} onChange={(e) => setValue(e.target.value)} placeholder="值（JSON：500、true、[1,2]；留空删除）" />
            <Button kind="primary" type="submit" busy={act.busy} disabled={!key.trim()}>
              保存
            </Button>
          </form>
          <details>
            <summary className="small">按 JSON Merge Patch 一次改多个</summary>
            <textarea className="mono" rows={8} value={patch} onChange={(e) => setPatch(e.target.value)} spellCheck={false} />
            <Button
              busy={act.busy}
              onClick={() => {
                try {
                  apply(JSON.parse(patch) as Record<string, unknown>);
                } catch {
                  act.clear();
                  setResult(null);
                  alert('JSON 无效');
                }
              }}
            >
              应用补丁
            </Button>
          </details>
          <div className="row">
            <PatchNotice result={result} />
            <ErrorText error={act.error} />
          </div>
          <div className="muted small">修改写回 config.yaml（保留注释），整体校验通过才写入。热更新的部分：{r.data?.hot.join('、')}；其他部分重启后生效。</div>
        </Card>
      )}
      <Card
        title="生效配置"
        actions={
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤" />
            <label className="check">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> 只看非默认值
            </label>
          </>
        }
      >
        <ErrorText error={r.error} />
        {r.data && <div className="muted small">来源层：{r.data.layers.join(' → ')}</div>}
        <table className="table">
          <tbody>
            {rows
              .filter(([k]) => !filter || k.includes(filter))
              .filter(([k]) => !onlyChanged || (r.data?.sources[k] ?? 'defaults') !== 'defaults')
              .map(([k, v]) => {
                const src = r.data?.sources[k] ?? 'defaults';
                return (
                  <tr key={k} className="clickable" onClick={() => (setKey(k), setValue(typeof v === 'string' ? v : JSON.stringify(v)))}>
                    <td className="mono small">{k}</td>
                    <td className="mono small">{typeof v === 'string' ? v : JSON.stringify(v)}</td>
                    <td>
                      <Badge tone={src === 'environment' ? 'warn' : src === 'file' ? 'info' : 'muted'}>{src === 'environment' ? '环境变量' : src === 'file' ? 'config.yaml' : '默认'}</Badge>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Secrets() {
  const { canWrite } = useSession();
  const r = useApi<{ secrets: SecretInfo[] }>('/api/secrets');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const act = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api('PUT', `/api/secrets/${enc(name)}`, value, { text: true }))) {
      setValue('');
      setName('');
      r.reload();
    }
  };
  return (
    <Card title="秘密">
      <div className="muted small">只能写入和列出名字，永远读不到值。插件与 MCP 服务器用 ${'{secret:NAME}'} 引用；修改后它们重启时生效。环境变量 PROTEA_SECRET_&lt;NAME&gt; 优先于这里存的文件。</div>
      <ErrorText error={r.error ?? act.error} />
      <table className="table">
        <tbody>
          {r.data?.secrets.map((s) => (
            <tr key={s.name}>
              <td className="mono">{s.name}</td>
              <td>
                <Badge tone={s.source === 'env' ? 'warn' : 'info'}>{s.source === 'env' ? '环境变量' : '文件'}</Badge>
                {s.shadowedFile && <span className="muted small"> 文件被环境变量覆盖</span>}
              </td>
              <td>
                {canWrite && s.source === 'file' && (
                  <Button small kind="danger" onClick={() => confirm(`删除秘密 ${s.name}？`) && void act.run(() => api('DELETE', `/api/secrets/${enc(s.name)}`)).then(r.reload)}>
                    删除
                  </Button>
                )}
                {canWrite && (
                  <Button small onClick={() => setName(s.name)}>
                    替换
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <form className="row" onSubmit={(e) => void submit(e)} autoComplete="off">
          <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="名字，如 TELEGRAM_BOT_TOKEN" />
          <input className="grow" type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="值" />
          <Button kind="primary" type="submit" busy={act.busy} disabled={!name.trim() || !value.trim()}>
            保存
          </Button>
        </form>
      )}
    </Card>
  );
}

interface PermissionView {
  settings: { default: string; tools: Record<string, string>; approvalTtlMs: number };
  tools: Array<{ name: string; owner: string; policy: string; rule: string }>;
}

function Permissions() {
  const { canWrite } = useSession();
  const r = useApi<PermissionView>('/api/permissions');
  const [filter, setFilter] = useState('');
  const [result, setResult] = useState<PatchResult | null>(null);
  const act = useAction();
  const setPolicy = (tool: string, policy: string | null) =>
    void act.run(async () => {
      setResult(await api<PatchResult>('PATCH', '/api/permissions', { tools: { [tool]: policy } }));
      r.reload();
    });
  return (
    <Card title="权限" actions={<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤工具" />}>
      <ErrorText error={r.error ?? act.error} />
      <PatchNotice result={result} />
      {r.data && <div className="muted small">默认：{r.data.settings.default} · 审批有效期 {Math.round(r.data.settings.approvalTtlMs / 3_600_000)} 小时</div>}
      <table className="table">
        <thead>
          <tr>
            <th>工具</th>
            <th>来自</th>
            <th>决定</th>
            <th>规则</th>
            {canWrite && <th>设置</th>}
          </tr>
        </thead>
        <tbody>
          {r.data?.tools
            .filter((t) => !filter || t.name.includes(filter))
            .map((t) => (
              <tr key={t.name}>
                <td className="mono small">{t.name}</td>
                <td className="small">{t.owner}</td>
                <td>
                  <Badge tone={t.policy === 'allow' ? 'good' : t.policy === 'ask' ? 'warn' : 'bad'}>{t.policy}</Badge>
                </td>
                <td className="small muted">{t.rule}</td>
                {canWrite && (
                  <td>
                    <select value={r.data?.settings.tools[t.name] ?? ''} onChange={(e) => setPolicy(t.name, e.target.value || null)}>
                      <option value="">（按规则）</option>
                      <option value="allow">allow</option>
                      <option value="ask">ask</option>
                      <option value="deny">deny</option>
                    </select>
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </table>
    </Card>
  );
}

function Budget() {
  const { canWrite } = useSession();
  const r = useApi<{ settings: { dailyUsd: number | null; shares: Record<string, number | null>; warnAt: number }; status: BudgetStatus }>('/api/budget');
  const [daily, setDaily] = useState('');
  const [result, setResult] = useState<PatchResult | null>(null);
  const act = useAction();
  const s = r.data;
  return (
    <Card title="预算">
      <ErrorText error={r.error ?? act.error} />
      {s && (
        <>
          <div className="muted small">滚动 24 小时。{s.status.enforced ? '已强制执行。' : '目前只统计和提醒，不限制调度（M6 起强制执行）。'}</div>
          {Object.entries(s.status.levels).map(([l, b]) => (
            <div key={l} className="budget-row">
              <LevelBadge level={Number(l)} />
              <Bar ratio={b.usedRatio} />
              <span className="small">
                {usd(b.spentUsd, 4)}
                {b.limitUsd !== null ? ` / ${usd(b.limitUsd)}` : ' · 不限'} · 份额 {s.settings.shares[l] === null ? '不限' : `${Math.round((s.settings.shares[l] ?? 0) * 100)}%`}
              </span>
            </div>
          ))}
          {canWrite && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  setResult(await api<PatchResult>('PATCH', '/api/budget', { dailyUsd: daily.trim() === '' ? null : Number(daily) }));
                  r.reload();
                });
              }}
            >
              <Field label="每日上限（美元，留空为不限）">
                <input type="number" step="0.5" min="0" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={s.settings.dailyUsd === null ? '不限' : String(s.settings.dailyUsd)} />
              </Field>
              <Button kind="primary" type="submit" busy={act.busy}>
                保存
              </Button>
              <PatchNotice result={result} />
            </form>
          )}
        </>
      )}
    </Card>
  );
}

function Scheduler() {
  const { canWrite } = useSession();
  const r = useApi<{ paused: string | null; cooldowns: Array<{ source: string; untilMs: number }>; pending: Record<string, number> }>('/api/scheduler', { refreshMs: 5000 });
  const [levels, setLevels] = useState<number[]>([4]);
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();
  const s = r.data;
  return (
    <Card title="调度">
      <ErrorText error={r.error ?? act.error} />
      {s && (
        <>
          <div className="row">
            投递：{s.paused ? <Badge tone="bad">已被 {s.paused} 暂停</Badge> : <Badge tone="good">运行中</Badge>}
            {canWrite &&
              (s.paused ? (
                <Button small onClick={() => void act.run(() => post('/api/scheduler/resume')).then(r.reload)}>
                  恢复
                </Button>
              ) : (
                <Button small onClick={() => void act.run(() => post('/api/scheduler/pause')).then(r.reload)}>
                  暂停
                </Button>
              ))}
          </div>
          <div className="levels">
            {Object.entries(s.pending).map(([l, n]) => (
              <div key={l} className="level-cell">
                <LevelBadge level={Number(l)} /> <strong>{n}</strong>
              </div>
            ))}
          </div>
          {canWrite && (
            <div className="row">
              清空待处理：
              {[2, 3, 4].map((l) => (
                <label key={l} className="check">
                  <input type="checkbox" checked={levels.includes(l)} onChange={(e) => setLevels((x) => (e.target.checked ? [...x, l] : x.filter((y) => y !== l)))} /> L{l}
                </label>
              ))}
              <Button
                kind="danger"
                small
                disabled={levels.length === 0}
                onClick={() =>
                  confirm(`丢弃 L${levels.join(',')} 的全部待处理事件？`) &&
                  void act.run(async () => {
                    const res = await post<{ discarded: number }>('/api/scheduler/discard', { levels });
                    setNote(`丢弃了 ${res.discarded} 个事件`);
                    r.reload();
                  })
                }
              >
                丢弃
              </Button>
              {note && <span className="muted small">{note}</span>}
            </div>
          )}
          <div className="muted small">等级参数（防抖、最长等待）在"生效配置"里改 scheduler.levels，重启后生效。</div>
        </>
      )}
    </Card>
  );
}

export function Config() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const tab = (params.get('tab') ?? 'config') as 'config' | 'secrets' | 'permissions' | 'budget' | 'scheduler';
  const { canWrite } = useSession();
  // Secrets are managed only over TLS or from this machine (docs/10-architecture/14-security-and-permissions.md §8).
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  const tabs: Array<[typeof tab, string]> = [
    ['config', '生效配置'],
    ...(canWrite && secure ? ([['secrets', '秘密']] as Array<[typeof tab, string]>) : []),
    ['permissions', '权限'],
    ['budget', '预算'],
    ['scheduler', '调度'],
  ];
  return (
    <div className="page">
      <Tabs tabs={tabs} value={tab} onChange={(t) => go('config', { tab: t })} />
      {tab === 'config' && <Effective />}
      {tab === 'secrets' && (secure ? <Secrets /> : <div className="banner banner-warn">秘密只能在 HTTPS 或本机访问时管理（也可以用 protea secrets set）。</div>)}
      {tab === 'permissions' && <Permissions />}
      {tab === 'budget' && <Budget />}
      {tab === 'scheduler' && <Scheduler />}
    </div>
  );
}
