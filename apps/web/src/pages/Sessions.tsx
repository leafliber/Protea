import { useState, type FormEvent } from 'react';
import type { BatchInfo, ContentBlock, EventEnvelope, ForkInfo, StatusResponse, TranscriptMessage, UsageInfo } from '@protea/protocol';
import { enc, post, qs, useAction, useApi } from '../api';
import { Button, Card, Drawer, Empty, ErrorText, Field, KV, LevelBadge, Ring, StateBadge, Tabs, clock, compact, dateTime, oneLine, timeAgo, usd } from '../components/ui';
import { BlockView, ContextView } from '../components/Trace';
import { useReloadOn } from '../live';
import { go, useSession } from '../session';

type Block = ContentBlock;

function TranscriptView({ id }: { id: string }) {
  const [showThinking, setShowThinking] = useState(false);
  const [from, setFrom] = useState<number | null>(null);
  const t = useApi<{ total: number; from: number; messages: TranscriptMessage[] }>(`/api/sessions/${enc(id)}/transcript${qs({ limit: 60, from: from ?? undefined, thinking: showThinking ? 'summary' : 'none' })}`);
  useReloadOn(['batch.ended', 'phase', 'handoff'], () => from === null && t.reload(), 600);
  const data = t.data;
  return (
    <div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> 显示思考摘要
        </label>
        {data && (
          <span className="muted small">
            {data.from + 1}–{data.from + data.messages.length} / {data.total} 条
          </span>
        )}
        {data && data.from > 0 && <Button small onClick={() => setFrom(Math.max(0, data.from - 60))}>更早</Button>}
        {data && data.from + data.messages.length < data.total && <Button small onClick={() => setFrom(data.from + 60 >= data.total - 60 ? null : data.from + 60)}>更新</Button>}
        {from !== null && <Button small kind="ghost" onClick={() => setFrom(null)}>最新</Button>}
      </div>
      <ErrorText error={t.error} />
      <div className="transcript">
        {data?.messages.map((m, i) => (
          <div key={`${data.from + i}`} className={`msg msg-${m.role}`}>
            <div className="msg-role">{m.role === 'assistant' ? '助理' : '事件 / 工具结果'}</div>
            {(m.content as unknown as Block[]).map((b, j) => (
              <BlockView key={j} b={b} showThinking={showThinking} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function BatchDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useApi<{ batch: BatchInfo; events: EventEnvelope[]; rounds: UsageInfo[] }>(`/api/batches/${enc(id)}`);
  const b = r.data?.batch;
  return (
    <Drawer title={`批 ${id}`} onClose={onClose}>
      <ErrorText error={r.error} />
      {b && (
        <>
          <KV
            rows={[
              ['等级', <LevelBadge key="l" level={b.level} />],
              ['原因', b.reason],
              ['会话', b.sessionId],
              ['开始', dateTime(b.startedAt)],
              ['结束', b.endedAt ? `${dateTime(b.endedAt)} · ${b.endReason}` : '进行中'],
              ['回合', String(b.rounds)],
            ]}
          />
          <h3>事件</h3>
          <ul className="list">
            {r.data?.events.map((e) => (
              <li key={e.cursor} className="clickable" onClick={() => go('events', { cursor: String(e.cursor) })}>
                #{e.cursor} <LevelBadge level={e.effLevel} /> <code>{e.type}</code> {oneLine(e.text, 100)}
              </li>
            ))}
          </ul>
          <div className="row">
            <a href={`#/console/events?batch=${enc(id)}`}>查看这一批的完整过程</a>
          </div>
          <h3>模型调用</h3>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>模型</th>
                <th>输入</th>
                <th>缓存读</th>
                <th>输出</th>
                <th>费用</th>
                <th>停止</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.rounds.map((u, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{u.model}</td>
                  <td>{compact(u.inputTokens)}</td>
                  <td>{compact(u.cacheReadTokens)}</td>
                  <td>{compact(u.outputTokens)}</td>
                  <td>{usd(u.costUsd, 4)}</td>
                  <td>{u.stopReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Drawer>
  );
}

function Batches({ selected }: { selected: string | null }) {
  const [before, setBefore] = useState<string | null>(null);
  const r = useApi<{ batches: BatchInfo[] }>(`/api/batches${qs({ limit: 50, before })}`);
  useReloadOn(['batch.started', 'batch.ended'], () => before === null && r.reload(), 500);
  const list = r.data?.batches ?? [];
  return (
    <Card title="批">
      <ErrorText error={r.error} />
      <table className="table clickable-rows">
        <thead>
          <tr>
            <th>开始</th>
            <th>批</th>
            <th>等级</th>
            <th>原因</th>
            <th>回合</th>
            <th>结束</th>
          </tr>
        </thead>
        <tbody>
          {list.map((b) => (
            <tr key={b.id} onClick={() => go('sessions', { tab: 'batches', batch: b.id })}>
              <td title={dateTime(b.startedAt)}>{timeAgo(b.startedAt)}</td>
              <td className="mono small">{b.id}</td>
              <td>
                <LevelBadge level={b.level} />
              </td>
              <td>{b.reason}</td>
              <td>{b.rounds}</td>
              <td>{b.endReason ? <StateBadge state={['end_turn', 'ends_turn'].includes(b.endReason) ? 'completed' : b.endReason} title={b.endReason} /> : <StateBadge state="running" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        {before && <Button onClick={() => setBefore(null)}>最新</Button>}
        {list.length === 50 && <Button onClick={() => setBefore(list[list.length - 1]?.id ?? null)}>更早</Button>}
      </div>
      {selected && <BatchDetail id={selected} onClose={() => go('sessions', { tab: 'batches' })} />}
    </Card>
  );
}

function SpawnFork({ onDone }: { onDone: () => void }) {
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [level, setLevel] = useState('3');
  const [model, setModel] = useState('fork');
  const act = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => post('/api/sessions/forks', { goal, level: Number(level), model, ...(context.trim() ? { context } : {}) }))) {
      setGoal('');
      setContext('');
      onDone();
    }
  };
  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      <Field label="目标">
        <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例如：整理本周未读邮件的要点" />
      </Field>
      <Field label="背景（可选）">
        <textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} />
      </Field>
      <div className="row">
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {[1, 2, 3, 4].map((l) => (
            <option key={l} value={l}>
              L{l}
            </option>
          ))}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="fork">fork 模型</option>
          <option value="main">main 模型</option>
          <option value="cheap">cheap 模型</option>
        </select>
        <Button kind="primary" type="submit" busy={act.busy} disabled={!goal.trim()}>
          派生 Fork
        </Button>
        <ErrorText error={act.error} />
      </div>
    </form>
  );
}

function Forks({ selected }: { selected: string | null }) {
  const { canWrite } = useSession();
  const r = useApi<{ forks: ForkInfo[] }>('/api/sessions/forks');
  useReloadOn('fork', r.reload, 300);
  const act = useAction();
  const forkAction = (id: string, action: 'cancel' | 'pause' | 'resume') => void act.run(() => post(`/api/sessions/forks/${enc(id)}/${action}`)).then(r.reload);
  const sel = r.data?.forks.find((f) => f.id === selected);
  return (
    <>
      {canWrite && (
        <Card title="派生 Fork">
          <SpawnFork onDone={r.reload} />
        </Card>
      )}
      <Card title="Fork">
        <ErrorText error={r.error ?? act.error} />
        {r.data?.forks.length === 0 && <Empty>没有 Fork</Empty>}
        <ul className="list">
          {r.data?.forks.map((f) => (
            <li key={f.id} className={`clickable ${f.id === selected ? 'selected' : ''}`} onClick={() => go('sessions', { tab: 'forks', fork: f.id })}>
              <StateBadge state={f.state} title={f.state === 'idle' ? '已完成并汇报，保留着上下文等后续任务；到时间没有新任务就回收' : (f.pauseReason ?? f.error ?? '')} /> <LevelBadge level={f.level} /> <span className="mono small">{f.id}</span> {oneLine(f.goal, 90)}{' '}
              <span className="muted small">
                {f.model} · {f.rounds} 回合 · {timeAgo(f.createdAt)}
                {f.pauseReason ? ` · 暂停原因 ${f.pauseReason}` : ''}
                {f.tasks ? ` · 第 ${f.tasks} 个任务` : ''}
                {f.idleUntil ? ` · 待命到 ${clock(f.idleUntil)}` : ''}
              </span>
              {canWrite && !['completed', 'cancelled', 'failed'].includes(f.state) && (
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {f.state === 'idle' ? (
                    <Button small onClick={() => forkAction(f.id, 'cancel')}>回收</Button>
                  ) : (
                    <>
                      {f.state === 'paused' && f.pauseReason === 'operator' ? (
                        <Button small onClick={() => forkAction(f.id, 'resume')}>恢复</Button>
                      ) : (
                        <Button small onClick={() => forkAction(f.id, 'pause')}>暂停</Button>
                      )}
                      <Button small kind="danger" onClick={() => confirm('取消这个 Fork？') && forkAction(f.id, 'cancel')}>
                        取消
                      </Button>
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {sel && (
        <Card title={`Fork ${sel.id}`}>
          <KV
            rows={[
              ['目标', sel.goal],
              ['状态', <StateBadge key="s" state={sel.state} />],
              ...(sel.summary ? ([['结果', sel.summary]] as Array<[string, string]>) : []),
              ...(sel.error ? ([['错误', sel.error]] as Array<[string, string]>) : []),
            ]}
          />
          <TranscriptView id={sel.id} />
        </Card>
      )}
    </>
  );
}

export function Sessions({ status, params }: { status: StatusResponse | undefined; params: URLSearchParams }) {
  const { canWrite } = useSession();
  const tab = (params.get('tab') ?? 'main') as 'main' | 'context' | 'batches' | 'forks';
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="page">
      <Tabs
        tabs={[
          ['main', '主会话'],
          ...(canWrite ? ([['context', '上下文']] as Array<['context', string]>) : []),
          ['batches', '批'],
          ['forks', 'Fork'],
        ]}
        value={tab}
        onChange={(t) => go('sessions', { tab: t })}
      />
      {tab === 'main' && (
        <>
          {status && (
            <Card title="主会话">
              <div className="row">
                <Ring
                  value={status.context.estimatedTokens}
                  max={status.context.softTokens}
                  warnAt={status.context.softTokens * 0.8}
                  label={
                    <>
                      <div>~{compact(status.context.estimatedTokens)} tokens</div>
                      <div className="muted small">
                        交接阈值 {compact(status.context.softTokens)} · 硬上限 {compact(status.context.hardTokens)}
                      </div>
                      <div className="muted small">
                        {status.context.transcript} · 已交接 {status.context.handoffs} 次
                      </div>
                    </>
                  }
                />
                {canWrite && (
                  <div>
                    <Button
                      busy={act.busy}
                      onClick={() =>
                        confirm('现在交接？较早的对话写成交接笔记，只保留最近一批。') &&
                        void act.run(async () => {
                          const r = await post<Record<string, unknown>>('/api/sessions/main/handoff', { reason: 'console' });
                          setNote(r['scheduled'] ? '正在运行一批，交接在下一批开始时进行' : r['handedOff'] ? `已交接：${String(r['dropped'])} 条写入 /memories/${String(r['notes'])}，保留 ${String(r['kept'])} 条` : '还没有可以交接的内容');
                        })
                      }
                    >
                      手动交接
                    </Button>
                    {note && <div className="muted small">{note}</div>}
                    <ErrorText error={act.error} />
                  </div>
                )}
              </div>
            </Card>
          )}
          <Card title="转录">
            <TranscriptView id="main" />
          </Card>
        </>
      )}
      {tab === 'context' && canWrite && <ContextView id="main" />}
      {tab === 'batches' && <Batches selected={params.get('batch')} />}
      {tab === 'forks' && <Forks selected={params.get('fork')} />}
    </div>
  );
}
