import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { EventEnvelope, PushEventResponse, SchedulerAction, WsServerMessage } from '@protea/protocol';
import { enc, get, post, qs, useAction } from '../api';
import { Badge, Button, Drawer, Empty, ErrorText, Json, KV, LevelBadge, StateBadge, clock, dateTime, oneLine } from '../components/ui';
import { useLive } from '../live';
import { go, useSession } from '../session';

type Row =
  | { kind: 'event'; key: string; at: number; e: EventEnvelope }
  | { kind: 'action'; key: string; at: number; a: SchedulerAction }
  | { kind: 'output'; key: string; at: number; plugin: string; text: string }
  | { kind: 'batch'; key: string; at: number; text: string; tone: 'info' | 'muted' | 'warn' };

const MAX_ROWS = 1500;
let seq = 0;

function actionText(a: SchedulerAction): string {
  switch (a.kind) {
    case 'preempt':
    case 'interrupt':
      return `#${a.cursor}（L${a.level}，${a.source}）${a.kind === 'preempt' ? '抢占' : '打断'}了 ${a.batchId}（L${a.batchLevel}，${a.phase}）`;
    case 'aged':
      return `老化提升为 flush：${a.cursors.map((c) => `#${c}`).join(' ')}`;
    case 'storm_cooldown':
      return `${a.source} 抢占过于频繁，冷却到 ${new Date(a.untilMs).toLocaleTimeString()}`;
    case 'fork_yield':
      return `Fork 让渡给主会话：${a.forkIds.join(' ')}`;
    case 'fork_resume':
      return `Fork 恢复：${a.forkIds.join(' ')}`;
    case 'paused':
      return `${a.by} 暂停了投递`;
    case 'resumed':
      return `${a.by} 恢复了投递`;
    case 'discarded':
      return `${a.by} 清空了 L${a.levels.join(',')} 的 ${a.cursors.length} 个待处理事件`;
  }
}

/** Internal events that report scheduling or budget actions get highlighted. */
function isAction(e: EventEnvelope): boolean {
  return e.origin === 'internal' && /^(scheduler|budget|context|secret|plugin|mcp)\.|^session\.(preempted|interrupted|handoff)/.test(e.type);
}

function EventDetail({ cursor, onClose }: { cursor: number; onClose: () => void }) {
  const { canWrite } = useSession();
  const [data, setData] = useState<{ event: EventEnvelope; delivery: { outcome: string; batchId: string | null; at: string } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState('flush');
  const act = useAction();
  const load = () => get<typeof data>(`/api/events/${cursor}`).then(setData, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [cursor]);
  useLive(['settled', 'promoted'], (m) => {
    if ((m.topic === 'settled' && m.data.cursors.includes(cursor)) || (m.topic === 'promoted' && m.data.cursor === cursor)) void load();
  });
  const e = data?.event;
  const waiting = e && (e.state === 'pending' || e.state === 'archived');
  return (
    <Drawer title={`事件 #${cursor}`} onClose={onClose}>
      <ErrorText error={error} />
      {e && (
        <>
          <KV
            rows={[
              ['类型', <code key="t">{e.type}</code>],
              ['来源', `${e.source}${e.senderKey ? ` · ${e.senderKey}` : ''}${e.senderRole ? `（${e.senderRole === 'owner' ? '主人' : '未知发送者'}）` : ''}`],
              ['等级 / 触发', <span key="l"><LevelBadge level={e.effLevel} /> {e.effTrigger}{e.level !== e.effLevel ? <span className="muted">（声明 L{e.level}）</span> : null}</span>],
              ['状态', <StateBadge key="s" state={e.state} />],
              ['收到', dateTime(e.receivedAt)],
              ['批', e.batchId ? <a key="b" href={`#/console/sessions?tab=batches&batch=${enc(e.batchId)}`}>{e.batchId}</a> : '—'],
              ['投递记录', data?.delivery ? `${data.delivery.outcome} · ${dateTime(data.delivery.at)}` : '—'],
            ]}
          />
          <h3>正文</h3>
          <pre className="text-block">{e.text}</pre>
          {canWrite && waiting && (
            <div className="row">
              <select value={trigger} onChange={(ev) => setTrigger(ev.target.value)}>
                {['flush', 'debounce', 'piggyback', 'preempt', 'interrupt'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <Button busy={act.busy} onClick={() => void act.run(() => post(`/api/events/${cursor}/promote`, { trigger })).then(load)}>
                提升
              </Button>
              <Button kind="danger" busy={act.busy} onClick={() => confirm(`撤回 #${cursor}？它将不会交给模型。`) && void act.run(() => post(`/api/events/${cursor}/withdraw`)).then(load)}>
                撤回
              </Button>
              <ErrorText error={act.error} />
            </div>
          )}
          <h3>信封</h3>
          <Json value={e} />
        </>
      )}
    </Drawer>
  );
}

function Composer() {
  const { canWrite } = useSession();
  const [text, setText] = useState('');
  const [level, setLevel] = useState('1');
  const [trigger, setTrigger] = useState('');
  const [last, setLast] = useState<PushEventResponse | null>(null);
  const act = useAction();
  if (!canWrite) return null;
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const ok = await act.run(async () => {
      const r = await post<PushEventResponse>('/api/events', { text, level: Number(level), ...(trigger ? { trigger } : {}) });
      setLast(r);
    });
    if (ok) setText('');
  };
  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <textarea
        rows={2}
        placeholder="给助理发一条消息（作为 console 来源的事件）… Enter 发送，Shift+Enter 换行"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (text.trim()) void submit(e as unknown as FormEvent);
          }
        }}
      />
      <div className="row">
        <select value={level} onChange={(e) => setLevel(e.target.value)} title="等级">
          {[1, 2, 3, 4].map((l) => (
            <option key={l} value={l}>
              L{l}
            </option>
          ))}
        </select>
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)} title="触发方式">
          <option value="">默认触发</option>
          {['flush', 'debounce', 'piggyback', 'store', 'preempt', 'interrupt'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <Button kind="primary" type="submit" busy={act.busy} disabled={!text.trim()}>
          发送
        </Button>
        {last && (
          <span className="muted small">
            #{last.cursor} L{last.effectiveLevel} {last.effectiveTrigger}
            {last.deduped ? '（重复）' : ''}
            {last.warnings.length ? ` · ${last.warnings.join('；')}` : ''}
          </span>
        )}
        <ErrorText error={act.error} />
      </div>
    </form>
  );
}

export function Events({ params }: { params: URLSearchParams }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [maxLevel, setMaxLevel] = useState(params.get('level') ?? '');
  const [source, setSource] = useState(params.get('source') ?? '');
  const [state, setState] = useState(params.get('state') ?? '');
  const [q, setQ] = useState('');
  const [showMarkers, setShowMarkers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selected = params.get('cursor');

  const filters = qs({ level: maxLevel, source, state, limit: 100 });
  const loadHistory = async (cursor?: number) => {
    try {
      const r = await get<{ events: EventEnvelope[]; nextCursor: number | null }>(`/api/events${filters}${cursor ? `&cursor=${cursor}` : ''}`.replace('?&', '?'));
      const fresh: Row[] = r.events.map((e) => ({ kind: 'event', key: `e${e.cursor}`, at: Date.parse(e.receivedAt), e }));
      setRows((old) => {
        const have = new Set(old.map((x) => x.key));
        return cursor ? [...old, ...fresh.filter((x) => !have.has(x.key))] : fresh;
      });
      setNext(r.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void loadHistory();
  }, [filters]);

  const matches = (e: EventEnvelope): boolean =>
    (maxLevel === '' || e.effLevel <= Number(maxLevel)) && (source === '' || e.source === source) && (state === '' || state.split(',').includes(e.state));

  const add = (row: Row) => setRows((old) => [row, ...old].slice(0, MAX_ROWS));
  const update = (cursors: number[], fn: (e: EventEnvelope) => EventEnvelope) =>
    setRows((old) => old.map((r) => (r.kind === 'event' && cursors.includes(r.e.cursor) ? { ...r, e: fn(r.e) } : r)));

  useLive(['event', 'settled', 'promoted', 'scheduler', 'output', 'batch.started', 'batch.ended'], (m: WsServerMessage) => {
    const now = Date.now();
    switch (m.topic) {
      case 'event':
        if (matches(m.data)) {
          setRows((old) => (old.some((r) => r.key === `e${m.data.cursor}`) ? old : [{ kind: 'event', key: `e${m.data.cursor}`, at: Date.parse(m.data.receivedAt), e: m.data } as Row, ...old].slice(0, MAX_ROWS)));
        }
        break;
      case 'settled':
        update(m.data.cursors, (e) => ({ ...e, state: m.data.outcome, ...(m.data.batchId ? { batchId: m.data.batchId } : {}) }));
        break;
      case 'promoted':
        update([m.data.cursor], () => m.data);
        break;
      case 'scheduler':
        add({ kind: 'action', key: `a${++seq}`, at: now, a: m.data });
        break;
      case 'output':
        add({ kind: 'output', key: `o${++seq}`, at: Date.parse(m.data.at) || now, plugin: m.data.plugin, text: m.data.text });
        break;
      case 'batch.started':
        update(m.data.cursors, (e) => ({ ...e, state: 'delivering', batchId: m.data.batchId }));
        add({ kind: 'batch', key: `b${++seq}`, at: now, text: `▶ 批 ${m.data.batchId} 开始（L${m.data.level}，${m.data.reason}，${m.data.cursors.length} 个事件）`, tone: 'info' });
        break;
      case 'batch.ended':
        add({ kind: 'batch', key: `b${++seq}`, at: now, text: `■ 批 ${m.data.batchId} 结束：${m.data.endReason}，${m.data.rounds} 回合`, tone: ['end_turn', 'ends_turn'].includes(m.data.endReason) ? 'muted' : 'warn' });
        break;
    }
  });

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.kind !== 'event') return showMarkers && (!needle || JSON.stringify(r).toLowerCase().includes(needle));
      return !needle || r.e.text.toLowerCase().includes(needle) || r.e.type.includes(needle);
    });
  }, [rows, q, showMarkers]);

  return (
    <div className="page">
      <Composer />
      <div className="filters">
        <select value={maxLevel} onChange={(e) => setMaxLevel(e.target.value)} title="最低优先级">
          <option value="">所有等级</option>
          {[0, 1, 2, 3].map((l) => (
            <option key={l} value={l}>
              ≤ L{l}
            </option>
          ))}
        </select>
        <input placeholder="来源（如 telegram、core）" value={source} onChange={(e) => setSource(e.target.value.trim())} />
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">所有状态</option>
          <option value="pending">pending</option>
          <option value="pending,archived">pending + archived</option>
          <option value="delivering">delivering</option>
          <option value="delivered">delivered</option>
          <option value="withdrawn,expired,discarded">withdrawn / expired / discarded</option>
        </select>
        <input placeholder="搜索正文" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} /> 批与调度动作
        </label>
      </div>
      <ErrorText error={error} />
      {visible.length === 0 ? (
        <Empty>没有事件</Empty>
      ) : (
        <ul className="timeline">
          {visible.map((r) => {
            if (r.kind === 'event') {
              const e = r.e;
              return (
                <li key={r.key} className={`tl-event tl-l${e.effLevel} ${isAction(e) ? 'tl-internal' : ''}`} onClick={() => go('events', { ...Object.fromEntries(params), cursor: String(e.cursor) })}>
                  <span className="tl-time">{clock(e.receivedAt)}</span>
                  <span className="muted small">#{e.cursor}</span>
                  <LevelBadge level={e.effLevel} />
                  <code className="tl-type">{e.type}</code>
                  <span className="tl-text">{oneLine(e.text, 160)}</span>
                  <StateBadge state={e.state} />
                  <span className="muted small">{e.effTrigger}</span>
                </li>
              );
            }
            if (r.kind === 'action') {
              return (
                <li key={r.key} className={`tl-marker tl-action tl-${r.a.kind}`}>
                  <span className="tl-time">{clock(r.at)}</span>
                  <Badge tone={r.a.kind === 'preempt' || r.a.kind === 'interrupt' ? 'bad' : 'warn'}>⚡ {r.a.kind}</Badge>
                  <span>{actionText(r.a)}</span>
                </li>
              );
            }
            if (r.kind === 'output') {
              return (
                <li key={r.key} className="tl-marker tl-output">
                  <span className="tl-time">{clock(r.at)}</span>
                  <Badge tone="info">◂ {r.plugin}</Badge>
                  <span className="tl-reply">{r.text}</span>
                </li>
              );
            }
            return (
              <li key={r.key} className={`tl-marker tl-batch tl-${r.tone}`}>
                <span className="tl-time">{clock(r.at)}</span>
                <span>{r.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {next !== null && (
        <div className="row center">
          <Button onClick={() => void loadHistory(next)}>更早的事件</Button>
        </div>
      )}
      {selected && <EventDetail cursor={Number(selected)} onClose={() => go('events', Object.fromEntries([...params].filter(([k]) => k !== 'cursor')))} />}
    </div>
  );
}
