import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ScheduleInfo, ScheduleInput, SchedulePreview, ScheduleRun } from '@protea/protocol';
import { api, post, useAction, useApi } from '../api';
import { IconClock, IconPlus } from '../components/icons';
import { Badge, Button, Card, Drawer, EmptyState, ErrorText, Field, KV, Menu, PageActions, RelTime, Segmented, Skeleton, StateBadge, Switch, cx, dateTime, oneLine, timeUntil, useFeedback, useTick } from '../components/ui';
import { useReloadOn } from '../live';
import { consoleHref, go, useSession } from '../session';

const CREATOR: Record<ScheduleInfo['createdBy'], string> = { assistant: '助理', operator: '我', config: '配置文件' };
type Filter = 'all' | 'recurring' | 'once' | 'paused';
type Repeat = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'minutes' | 'hours' | 'custom';
const DAYS: Array<[number, string]> = [
  [1, '一'],
  [2, '二'],
  [3, '三'],
  [4, '四'],
  [5, '五'],
  [6, '六'],
  [0, '日'],
];

interface Draft {
  name: string;
  kind: 'once' | 'recurring';
  at: string;
  repeat: Repeat;
  time: string;
  days: number[];
  dom: number;
  every: number;
  cron: string;
  note: string;
  level: 3 | 4;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DDTHH:MM` in the browser's zone, an hour from now by default. */
function localInput(ms = Date.now() + 3_600_000): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value with the browser's UTC offset, so the server reads the instant the person picked. */
function withOffset(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  const off = -d.getTimezoneOffset();
  return `${local}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** The cron expression a form describes. */
export function cronOf(d: Pick<Draft, 'repeat' | 'time' | 'days' | 'dom' | 'every' | 'cron'>): string {
  const [h = '8', m = '0'] = d.time.split(':');
  const hm = `${Number(m)} ${Number(h)}`;
  switch (d.repeat) {
    case 'daily':
      return `${hm} * * *`;
    case 'weekdays':
      return `${hm} * * 1-5`;
    case 'weekly':
      return `${hm} * * ${[...d.days].sort((a, b) => a - b).join(',') || '1'}`;
    case 'monthly':
      return `${hm} ${d.dom} * *`;
    case 'minutes':
      return `*/${d.every} * * * *`;
    case 'hours':
      return `0 */${d.every} * * *`;
    default:
      return d.cron.trim();
  }
}

/** The form that would produce this cron expression; `custom` when no preset does. */
export function draftOfCron(cron: string): Pick<Draft, 'repeat' | 'time' | 'days' | 'dom' | 'every' | 'cron'> {
  const base = { repeat: 'custom' as Repeat, time: '08:00', days: [1], dom: 1, every: 30, cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (mon !== '*') return base;
  const everyMin = /^\*\/(\d+)$/.exec(m);
  if (everyMin && h === '*' && dom === '*' && dow === '*') return { ...base, repeat: 'minutes', every: Number(everyMin[1]) };
  const everyHour = /^\*\/(\d+)$/.exec(h);
  if (m === '0' && everyHour && dom === '*' && dow === '*') return { ...base, repeat: 'hours', every: Number(everyHour[1]) };
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return base;
  const time = `${pad(Number(h))}:${pad(Number(m))}`;
  if (dom === '*' && dow === '*') return { ...base, repeat: 'daily', time };
  if (dom === '*' && dow === '1-5') return { ...base, repeat: 'weekdays', time };
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) return { ...base, repeat: 'weekly', time, days: dow.split(',').map((d) => Number(d) % 7) };
  if (/^\d+$/.test(dom) && dow === '*') return { ...base, repeat: 'monthly', time, dom: Number(dom) };
  return base;
}

function draftOf(s?: ScheduleInfo): Draft {
  const base: Draft = { name: '', kind: 'recurring', at: localInput(), repeat: 'daily', time: '08:00', days: [1], dom: 1, every: 30, cron: '0 8 * * *', note: '', level: 3 };
  if (!s) return base;
  return {
    ...base,
    name: s.name,
    note: s.note ?? '',
    level: s.level,
    ...(s.at !== undefined ? { kind: 'once' as const, at: localInput(Date.parse(s.at)) } : {}),
    ...(s.cron !== undefined ? { kind: 'recurring' as const, ...draftOfCron(s.cron) } : {}),
  };
}

/** Create or edit. The rule is checked by the server as it is typed, and read back in words. */
function ScheduleForm({ editing, onClose, onSaved }: { editing: ScheduleInfo | null; onClose: () => void; onSaved: (s: ScheduleInfo) => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(editing ?? undefined));
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const act = useAction();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((old) => ({ ...old, [k]: v }));
  const rule = useMemo(() => (d.kind === 'once' ? { at: withOffset(d.at) } : { cron: cronOf(d) }), [d]);
  const ruleKey = JSON.stringify(rule);
  useEffect(() => {
    const t = setTimeout(() => {
      post<SchedulePreview>('/api/schedules/preview', rule).then(
        (p) => {
          setPreview(p);
          setProblem(null);
        },
        (e: Error) => {
          setPreview(null);
          setProblem(e.message);
        },
      );
    }, 250);
    return () => clearTimeout(t);
  }, [ruleKey]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ScheduleInput = { name: d.name.trim(), ...rule, note: d.note, level: d.level };
    void act.run(async () => {
      const saved = editing ? await api<ScheduleInfo>('PATCH', `/api/schedules/${encodeURIComponent(editing.id)}`, body) : await post<ScheduleInfo>('/api/schedules', body);
      onSaved(saved);
    });
  };
  return (
    <Drawer title={editing ? `编辑：${editing.name}` : '新建定时任务'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="名称">
          <input autoFocus required maxLength={80} value={d.name} placeholder="例如：早间简报" onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="什么时候">
          <Segmented
            label="类型"
            value={d.kind}
            onChange={(k) => set('kind', k)}
            options={[
              ['recurring', '重复'],
              ['once', '只一次'],
            ]}
          />
        </Field>
        {d.kind === 'once' ? (
          <Field label="时间">
            <input type="datetime-local" required value={d.at} onChange={(e) => set('at', e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="频率">
              <select value={d.repeat} onChange={(e) => set('repeat', e.target.value as Repeat)}>
                <option value="daily">每天</option>
                <option value="weekdays">每个工作日（周一到周五）</option>
                <option value="weekly">每周的某几天</option>
                <option value="monthly">每月的某一天</option>
                <option value="hours">每隔几小时</option>
                <option value="minutes">每隔几分钟</option>
                <option value="custom">自定义 cron 表达式</option>
              </select>
            </Field>
            {d.repeat === 'weekly' && (
              <Field label="星期">
                <div className="day-picks">
                  {DAYS.map(([n, label]) => (
                    <button key={n} type="button" aria-pressed={d.days.includes(n)} className={cx('day-pick', d.days.includes(n) && 'day-on')} onClick={() => set('days', d.days.includes(n) ? d.days.filter((x) => x !== n) : [...d.days, n])}>
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {d.repeat === 'monthly' && (
              <Field label="几号" hint="没有这一天的月份不会触发。">
                <input type="number" min={1} max={31} value={d.dom} onChange={(e) => set('dom', Math.min(31, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
            )}
            {(d.repeat === 'minutes' || d.repeat === 'hours') && (
              <Field label={d.repeat === 'minutes' ? '每隔多少分钟' : '每隔多少小时'}>
                <input type="number" min={1} max={d.repeat === 'minutes' ? 59 : 23} value={d.every} onChange={(e) => set('every', Math.max(1, Number(e.target.value) || 1))} />
              </Field>
            )}
            {['daily', 'weekdays', 'weekly', 'monthly'].includes(d.repeat) && (
              <Field label="时间">
                <input type="time" required value={d.time} onChange={(e) => set('time', e.target.value)} />
              </Field>
            )}
            {d.repeat === 'custom' && (
              <Field label="cron 表达式" hint="五段：分 时 日 月 星期。例如 0 9 * * 1-5 是工作日 9 点。">
                <input className="mono" required value={d.cron} spellCheck={false} onChange={(e) => set('cron', e.target.value)} />
              </Field>
            )}
          </>
        )}
        <div className={cx('rule-preview', problem && 'rule-bad')} aria-live="polite">
          {problem ? (
            `这个时间规则不对：${problem}`
          ) : preview ? (
            <>
              <strong>{preview.human}</strong>
              <span className="muted small"> · 接下来：{preview.next.slice(0, 3).map((t) => dateTime(t)).join('，') || '不会再触发'}</span>
            </>
          ) : (
            '…'
          )}
        </div>
        <Field label="到时交给助理的话" hint="到点时助理只读到这段话和任务名称，所以把它需要知道的都写在这里。">
          <textarea rows={5} maxLength={2000} value={d.note} placeholder="例如：整理今天的日程和未读邮件，发一份简报给我。" onChange={(e) => set('note', e.target.value)} />
        </Field>
        <details className="advanced">
          <summary>高级</summary>
          <Field label="优先级" hint="“顺带处理”的任务不会单独唤醒助理，只在它正好有别的事要处理时一起看。">
            <Segmented
              label="优先级"
              value={String(d.level) as '3' | '4'}
              onChange={(v) => set('level', v === '4' ? 4 : 3)}
              options={[
                ['3', '到点就处理'],
                ['4', '有别的事时顺带处理'],
              ]}
            />
          </Field>
        </details>
        <ErrorText error={act.error} />
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button kind="primary" type="submit" busy={act.busy} disabled={!d.name.trim() || problem !== null}>
            {editing ? '保存' : '创建'}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

const RUN_STATE: Record<string, string> = { delivered: '已处理', pending: '排队中', merged: '已合并处理', dropped: '已丢弃', expired: '已过期', withdrawn: '已撤回' };

function ScheduleDetail({ id, canWrite, onClose, onEdit }: { id: string; canWrite: boolean; onClose: () => void; onEdit: (s: ScheduleInfo) => void }) {
  const r = useApi<{ schedule?: ScheduleInfo; runs: ScheduleRun[] }>(`/api/schedules/${encodeURIComponent(id)}/runs`);
  useReloadOn(['schedule', 'settled'], r.reload, 400);
  const s = r.data?.schedule;
  const [upcoming, setUpcoming] = useState<string[]>([]);
  const ruleKey = s ? `${s.cron ?? ''}|${s.at ?? ''}|${s.enabled}` : '';
  useEffect(() => {
    if (!s || !s.enabled) return setUpcoming([]);
    post<SchedulePreview>('/api/schedules/preview', s.cron !== undefined ? { cron: s.cron } : { at: s.at }).then(
      (p) => setUpcoming(p.next),
      () => setUpcoming([]),
    );
  }, [ruleKey]);
  return (
    <Drawer title={s?.name ?? '定时任务'} onClose={onClose}>
      <ErrorText error={r.error} />
      {!r.data && !r.error && <Skeleton lines={6} />}
      {r.data && !s && <EmptyState title="这个任务已经不在了">一次性的任务触发后会自动移除。下面是它留下的运行记录。</EmptyState>}
      {s && (
        <>
          <KV
            rows={[
              ['时间规则', <span key="h">{s.human}{s.cron ? <span className="muted small mono"> · {s.cron}</span> : null}</span>],
              ['状态', s.enabled ? <Badge key="s" tone="good">启用</Badge> : <Badge key="s" tone="warn">已暂停</Badge>],
              ['下次运行', s.nextAt ? `${dateTime(s.nextAt)}（${timeUntil(s.nextAt)}）` : s.enabled ? '不会再触发' : '暂停中'],
              ['创建', `${CREATOR[s.createdBy]} · ${dateTime(s.createdAt)}`],
              ['优先级', s.level === 4 ? '有别的事时顺带处理（L4）' : '到点就处理（L3）'],
              ['已运行', `${s.fires} 次${s.lastFiredAt ? `，最近 ${dateTime(s.lastFiredAt)}` : ''}`],
            ]}
          />
          <h3>到时交给助理的话</h3>
          {s.note ? <div className="note-box">{s.note}</div> : <div className="muted small">没有写。到点时助理只知道任务名称。</div>}
          {upcoming.length > 1 && (
            <>
              <h3>接下来</h3>
              <ul className="plain-list small">
                {upcoming.map((t) => (
                  <li key={t}>{dateTime(t)}</li>
                ))}
              </ul>
            </>
          )}
          {canWrite && !s.readOnly && (
            <div className="row">
              <Button small onClick={() => onEdit(s)}>
                编辑
              </Button>
            </div>
          )}
          {s.readOnly && <div className="muted small">这个任务写在 config.yaml 的 plugins.cron.config.schedules 里，要在那里修改。</div>}
        </>
      )}
      <h3>最近的运行</h3>
      {r.data?.runs.length === 0 && <div className="muted small">还没有运行过。</div>}
      <ul className="list">
        {r.data?.runs.map((run) => (
          <li key={run.cursor} className="clickable" onClick={() => (run.batchId ? go('events', { batch: run.batchId }) : go('events', { cursor: String(run.cursor) }))}>
            <span className="nowrap">{dateTime(run.at)}</span> <StateBadge state={run.state} title={RUN_STATE[run.state] ?? run.state} />
            {run.manual && <Badge tone="info">手动</Badge>} <span className="muted small">{run.batchId ? '查看处理过程' : `事件 #${run.cursor}`}</span>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

export function Schedules({ params }: { params: URLSearchParams }) {
  const { canWrite } = useSession();
  const { confirm, toast } = useFeedback();
  useTick();
  const r = useApi<{ schedules: ScheduleInfo[] }>('/api/schedules', { refreshMs: 60_000 });
  useReloadOn('schedule', r.reload, 200);
  const [filter, setFilter] = useState<Filter>('all');
  const [wakes, setWakes] = useState(false);
  const [form, setForm] = useState<ScheduleInfo | 'new' | null>(null);
  const act = useAction();
  const selected = params.get('id');
  const all = r.data?.schedules ?? [];
  const tasks = all.filter((s) => s.kind !== 'wake');
  const wakeUps = all.filter((s) => s.kind === 'wake');
  const shown = tasks.filter((s) => (filter === 'all' ? true : filter === 'paused' ? !s.enabled : s.kind === filter));
  const next = all.filter((s) => s.enabled && s.nextAt).sort((a, b) => (a.nextAt as string).localeCompare(b.nextAt as string))[0];
  const run = (label: string, fn: () => Promise<unknown>) =>
    void act
      .run(async () => {
        await fn();
        toast(label);
        r.reload();
      })
      .catch(() => undefined);
  const remove = async (s: ScheduleInfo) => {
    if (!(await confirm({ title: `删除“${s.name}”？`, body: s.createdBy === 'assistant' ? '这是助理自己建的任务。删除后会告诉它，它不会再等这个任务。' : '删除后不会再触发，也不能恢复。', confirm: '删除', danger: true }))) return;
    run('已删除', () => api('DELETE', `/api/schedules/${encodeURIComponent(s.id)}`));
    if (selected === s.id) go('schedules');
  };
  const row = (s: ScheduleInfo) => (
    <tr key={s.id} className={cx(selected === s.id && 'selected', !s.enabled && 'row-off')} onClick={() => go('schedules', { id: s.id })}>
      <td className="cell-tight">
        <Switch checked={s.enabled} disabled={!canWrite || s.readOnly || act.busy} label={s.readOnly ? '在配置文件里定义，不能在这里暂停' : s.enabled ? '暂停' : '恢复'} onChange={(on) => run(on ? '已恢复' : '已暂停', () => api('PATCH', `/api/schedules/${encodeURIComponent(s.id)}`, { enabled: on }))} />
      </td>
      <td>
        <div className="cell-main">{s.name}</div>
        {s.note && <div className="muted small">{oneLine(s.note, 90)}</div>}
      </td>
      <td data-label="时间" title={s.cron ? `cron ${s.cron}` : undefined}>
        {s.human}
      </td>
      <td data-label="下次">{s.enabled ? s.nextAt ? <RelTime at={s.nextAt} future /> : <span className="muted">不再触发</span> : <span className="muted">已暂停</span>}</td>
      <td data-label="上次">{s.lastFiredAt ? <RelTime at={s.lastFiredAt} /> : <span className="muted">还没有</span>}</td>
      <td data-label="创建者">
        <Badge tone={s.createdBy === 'assistant' ? 'info' : 'neutral'}>{CREATOR[s.createdBy]}</Badge>
      </td>
      <td className="cell-tight">
        {canWrite && (
          <Menu
            items={[
              { label: '立即运行一次', onSelect: () => run('已触发，助理马上处理', () => post(`/api/schedules/${encodeURIComponent(s.id)}/run`)) },
              !s.readOnly && { label: '编辑', onSelect: () => setForm(s) },
              !s.readOnly && { label: '删除', danger: true, onSelect: () => void remove(s) },
            ]}
          />
        )}
      </td>
    </tr>
  );
  return (
    <div className="page">
      {canWrite && (
        <PageActions>
          <Button kind="primary" onClick={() => setForm('new')}>
            <IconPlus size={15} /> 新建定时任务
          </Button>
        </PageActions>
      )}
      <ErrorText error={r.error ?? act.error} />
      {!r.data && !r.error && <Skeleton lines={5} />}
      {r.data && all.length === 0 && (
        <EmptyState
          icon={<IconClock size={28} />}
          title="还没有定时任务"
          action={
            canWrite && (
              <Button kind="primary" onClick={() => setForm('new')}>
                新建定时任务
              </Button>
            )
          }
        >
          定时任务到点时把一段话交给助理，让它去做事，比如每天早上发一份简报、每周五提醒交周报。
          <br />
          也可以直接在对话里说“每天早上 7 点提醒我……”，助理会自己建好，并出现在这里。
        </EmptyState>
      )}
      {all.length > 0 && (
        <>
          <div className="toolbar">
            <Segmented
              label="筛选"
              value={filter}
              onChange={setFilter}
              options={[
                ['all', `全部 ${tasks.length}`],
                ['recurring', '重复'],
                ['once', '一次性'],
                ['paused', `已暂停 ${tasks.filter((s) => !s.enabled).length}`],
              ]}
            />
            <span className="grow" />
            <span className="muted small">
              {next ? (
                <>
                  下一个：<a href={consoleHref('schedules', { id: next.id })}>{next.name}</a>，{timeUntil(next.nextAt)}（{dateTime(next.nextAt)}）
                </>
              ) : (
                '没有即将运行的任务'
              )}
            </span>
          </div>
          <Card>
            {shown.length === 0 ? (
              <div className="empty">这个筛选下没有任务</div>
            ) : (
              <table className="table table-cards clickable-rows">
                <thead>
                  <tr>
                    <th aria-label="启用" />
                    <th>任务</th>
                    <th>时间</th>
                    <th>下次运行</th>
                    <th>上次运行</th>
                    <th>创建者</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>{shown.map(row)}</tbody>
              </table>
            )}
          </Card>
          {wakeUps.length > 0 && (
            <Card
              title={`助理的唤醒（${wakeUps.length}）`}
              actions={
                <Button small kind="ghost" onClick={() => setWakes(!wakes)}>
                  {wakes ? '收起' : '展开'}
                </Button>
              }
            >
              <div className="muted small">助理给自己定的一次性提醒（“过一会儿再看看”），到点后自动消失。</div>
              {wakes && (
                <table className="table table-cards clickable-rows">
                  <tbody>{wakeUps.map(row)}</tbody>
                </table>
              )}
            </Card>
          )}
        </>
      )}
      {selected && form === null && <ScheduleDetail key={selected} id={selected} canWrite={canWrite} onClose={() => go('schedules')} onEdit={(s) => setForm(s)} />}
      {form !== null && (
        <ScheduleForm
          key={form === 'new' ? 'new' : form.id}
          editing={form === 'new' ? null : form}
          onClose={() => setForm(null)}
          onSaved={(s) => {
            setForm(null);
            toast(form === 'new' ? `已创建：${s.name}` : `已保存：${s.name}`);
            r.reload();
          }}
        />
      )}
    </div>
  );
}
