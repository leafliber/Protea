import { useMemo, useState, type FormEvent } from 'react';
import type { AccountInfo, BudgetStatus, ConfigResponse, SecretInfo } from '@protea/protocol';
import { api, enc, post, useAction, useApi } from '../api';
import { Badge, Bar, Button, Card, ErrorText, Field, LevelBadge, Tabs, dateTime, usd } from '../components/ui';
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
  const r = useApi<{ settings: { dailyUsd: number | null; hardDailyUsd: number | null; shares: Record<string, number | null>; warnAt: number }; status: BudgetStatus }>('/api/budget', {
    refreshMs: 15000,
  });
  const [daily, setDaily] = useState('');
  const [hard, setHard] = useState('');
  const [hours, setHours] = useState('4');
  const [result, setResult] = useState<PatchResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();
  const s = r.data;
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const release = (body: Record<string, unknown>) =>
    void act.run(async () => {
      const res = await post<{ promoted: number[]; until: string }>('/api/budget/release', { ...body, hours: Number(hours) || 4 });
      setNote(`已放行到 ${new Date(res.until).toLocaleString()}，${res.promoted.length} 个被扣住的事件恢复投递`);
      r.reload();
    });
  const held = s ? Object.values(s.status.levels).reduce((n, b) => n + (b.held ?? 0), 0) : 0;
  return (
    <Card title="预算">
      <ErrorText error={r.error ?? act.error} />
      {s && (
        <>
          <div className="muted small">
            滚动 24 小时，共花费 {usd(s.status.spentUsd, 4)}。
            {s.status.enforced
              ? '已强制执行：L2 用尽后新事件只随其他批次捎带，L3/L4 用尽后新事件只入库不投递；L1 不受影响。'
              : '强制执行已关闭（budget.enforce: false），只统计和提醒。'}
          </div>
          {s.status.hardDailyUsd !== null && (
            <div className="row">
              全局硬上限 {usd(s.status.hardDailyUsd)}：
              {s.status.hardCapReached ? <Badge tone="bad">已到达，只投递 L0/L1</Badge> : <Badge tone="good">未到达</Badge>}
              {s.status.hardCapReleasedUntil && <Badge tone="warn">放行到 {new Date(s.status.hardCapReleasedUntil).toLocaleString()}</Badge>}
            </div>
          )}
          {Object.entries(s.status.levels).map(([l, b]) => (
            <div key={l} className="budget-row">
              <LevelBadge level={Number(l)} />
              <Bar ratio={b.usedRatio} />
              <span className="small">
                {usd(b.spentUsd, 4)}
                {b.limitUsd !== null ? ` / ${usd(b.limitUsd)}` : ' · 不限'} · 份额 {s.settings.shares[l] === null ? '不限' : `${Math.round((s.settings.shares[l] ?? 0) * 100)}%`}
                {b.held ? <> · <Badge tone="warn">扣住 {b.held} 个</Badge></> : null}
                {b.releasedUntil ? <> · <Badge tone="info">放行到 {new Date(b.releasedUntil).toLocaleString()}</Badge></> : null}
              </span>
            </div>
          ))}
          {canWrite && (
            <div className="row">
              临时放行
              <input type="number" min="1" max="168" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: '5em' }} /> 小时：
              {[2, 3, 4].map((l) => (
                <Button key={l} small onClick={() => release({ levels: [l], hardCap: false })}>
                  L{l}
                </Button>
              ))}
              {s.status.hardDailyUsd !== null && (
                <Button small onClick={() => release({ levels: [], hardCap: true })}>
                  硬上限
                </Button>
              )}
              <Button small kind="primary" disabled={held === 0 && !s.status.hardCapReached} onClick={() => release({})}>
                全部
              </Button>
              {note && <span className="muted small">{note}</span>}
            </div>
          )}
          {canWrite && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  const patch: Record<string, unknown> = {};
                  if (daily.trim() !== '') patch['dailyUsd'] = num(daily) === 0 ? null : num(daily);
                  if (hard.trim() !== '') patch['hardDailyUsd'] = num(hard) === 0 ? null : num(hard);
                  setResult(await api<PatchResult>('PATCH', '/api/budget', patch));
                  r.reload();
                });
              }}
            >
              <Field label="每日预算（美元，0 为不限）">
                <input type="number" step="0.5" min="0" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={s.settings.dailyUsd === null ? '不限' : String(s.settings.dailyUsd)} />
              </Field>
              <Field label="全局硬上限（美元，0 为不设）">
                <input type="number" step="0.5" min="0" value={hard} onChange={(e) => setHard(e.target.value)} placeholder={s.settings.hardDailyUsd === null ? '不设' : String(s.settings.hardDailyUsd)} />
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

interface BackupEntry {
  name: string;
  createdAt?: string;
  bytes?: number;
  archive: boolean;
}

function Backups() {
  const { canWrite } = useSession();
  const r = useApi<{ backups: BackupEntry[]; dir: string }>('/api/backups');
  const [archive, setArchive] = useState(true);
  const [git, setGit] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();
  return (
    <Card title="备份">
      <ErrorText error={r.error ?? act.error} />
      <div className="muted small">
        在线备份（守护进程运行中也可以）：SQLite 快照加 config.yaml、sessions、memory、persona、skills、plugins、plugin-data 等；不含 secrets/ 与 cache/。恢复要先停掉守护进程，再运行 protea restore。
      </div>
      {canWrite && (
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} /> 打包成 .tar.gz
          </label>
          <Button
            kind="primary"
            busy={act.busy}
            onClick={() =>
              void act.run(async () => {
                const res = await post<{ path: string; manifest: { files: number; bytes: number } }>('/api/backups', { archive });
                setNote(`已写入 ${res.path}（${res.manifest.files} 个文件）`);
                r.reload();
              })
            }
          >
            立即备份
          </Button>
          {note && <span className="muted small">{note}</span>}
        </div>
      )}
      {canWrite && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              const res = await post<{ commit: string | null; changed: number }>('/api/backups', { to: git.trim() });
              setNote(res.commit ? `推送了 ${res.changed} 处变化（${res.commit.slice(0, 10)}）` : '与上次推送相比没有变化');
            });
          }}
        >
          <Field label="推送人格与记忆到 Git（私有仓库地址）" hint="只推送 config.yaml、persona/、memory/、skills/；数据库用上面的目录备份。">
            <input value={git} onChange={(e) => setGit(e.target.value)} placeholder="git@github.com:me/protea-memory.git" />
          </Field>
          <Button type="submit" disabled={git.trim() === ''} busy={act.busy}>
            推送
          </Button>
        </form>
      )}
      {r.data && (
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>时间</th>
              <th>大小</th>
            </tr>
          </thead>
          <tbody>
            {r.data.backups.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  {r.data.dir} 里还没有备份
                </td>
              </tr>
            )}
            {r.data.backups.map((b) => (
              <tr key={b.name}>
                <td className="mono small">{b.name}</td>
                <td className="nowrap small">{b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}</td>
                <td className="nowrap small">{b.bytes === undefined ? '—' : b.bytes >= 1048576 ? `${(b.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b.bytes / 1024))} KB`}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

/** The signed-in account's own password (every account may change it). */
function MyPassword() {
  const { username } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const act = useAction();
  if (!username) return <Card title="我的密码"><p className="muted small">你是用 API 令牌登录的，没有账号密码可改。</p></Card>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    void act.run(async () => {
      if (next !== again) throw new Error('两次输入的新密码不一样');
      await post('/api/auth/password', { current, password: next });
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    });
  };
  return (
    <Card title={`我的密码（${username}）`}>
      <form className="form-grid" onSubmit={submit}>
        <input type="password" autoComplete="current-password" placeholder="当前密码" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="新密码（至少 8 个字符）" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="再输一次新密码" minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} required />
        <div className="row">
          <Button kind="primary" type="submit" busy={act.busy}>
            修改密码
          </Button>
          {done && <Badge tone="good">已修改；其他设备上的登录已退出</Badge>}
        </div>
        <ErrorText error={act.error} />
      </form>
    </Card>
  );
}

function Accounts() {
  const { username: me } = useSession();
  const r = useApi<{ accounts: AccountInfo[] }>('/api/accounts');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'readonly'>('readonly');
  const act = useAction();
  const add = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await post('/api/accounts', { username, password, role });
      setUsername('');
      setPassword('');
      r.reload();
    });
  };
  const reset = (u: string) => {
    const pw = prompt(`给 ${u} 设一个新密码（至少 8 个字符）。它的登录会全部退出。`);
    if (pw) void act.run(async () => api('PATCH', `/api/accounts/${enc(u)}`, { password: pw }));
  };
  return (
    <div className="grid">
      <Card title="账号">
        <table className="table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>上次登录</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(r.data?.accounts ?? []).map((a) => (
              <tr key={a.id}>
                <td>
                  {a.username} {a.username === me && <Badge tone="info">我</Badge>}
                </td>
                <td>{a.role === 'admin' ? '管理员' : '只读'}</td>
                <td className="muted small">{a.lastLoginAt ? dateTime(a.lastLoginAt) : '从未'}</td>
                <td className="row-actions">
                  <Button small onClick={() => reset(a.username)}>
                    重设密码
                  </Button>
                  <Button
                    small
                    onClick={() => void act.run(async () => {
                      await api('PATCH', `/api/accounts/${enc(a.username)}`, { role: a.role === 'admin' ? 'readonly' : 'admin' });
                      r.reload();
                    })}
                  >
                    改为{a.role === 'admin' ? '只读' : '管理员'}
                  </Button>
                  {a.username !== me && (
                    <Button
                      small
                      kind="danger"
                      onClick={() => {
                        if (confirm(`删除账号 ${a.username}？`))
                          void act.run(async () => {
                            await api('DELETE', `/api/accounts/${enc(a.username)}`);
                            r.reload();
                          });
                      }}
                    >
                      删除
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorText error={r.error ?? act.error} />
      </Card>
      <Card title="添加账号">
        <form className="form-grid" onSubmit={add}>
          <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
          <input type="password" placeholder="初始密码（至少 8 个字符）" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'readonly')}>
            <option value="readonly">只读（只能看）</option>
            <option value="admin">管理员</option>
          </select>
          <Button kind="primary" type="submit" busy={act.busy}>
            添加
          </Button>
        </form>
      </Card>
      <MyPassword />
    </div>
  );
}

export function Config() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const tab = (params.get('tab') ?? 'config') as 'config' | 'accounts' | 'password' | 'secrets' | 'permissions' | 'budget' | 'scheduler' | 'backups';
  const { canWrite } = useSession();
  // Secrets are managed only over TLS or from this machine (docs/10-architecture/14-security-and-permissions.md §8).
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  const tabs: Array<[typeof tab, string]> = [
    ['config', '生效配置'],
    ...(canWrite ? ([['accounts', '账号']] as Array<[typeof tab, string]>) : ([['password', '我的密码']] as Array<[typeof tab, string]>)),
    ...(canWrite && secure ? ([['secrets', '秘密']] as Array<[typeof tab, string]>) : []),
    ['permissions', '权限'],
    ['budget', '预算'],
    ['scheduler', '调度'],
    ['backups', '备份'],
  ];
  return (
    <div className="page">
      <Tabs tabs={tabs} value={tab} onChange={(t) => go('config', { tab: t })} />
      {tab === 'config' && <Effective />}
      {tab === 'accounts' && <Accounts />}
      {tab === 'password' && <MyPassword />}
      {tab === 'secrets' && (secure ? <Secrets /> : <div className="banner banner-warn">秘密只能在 HTTPS 或本机访问时管理（也可以用 protea secrets set）。</div>)}
      {tab === 'permissions' && <Permissions />}
      {tab === 'budget' && <Budget />}
      {tab === 'scheduler' && <Scheduler />}
      {tab === 'backups' && <Backups />}
    </div>
  );
}
