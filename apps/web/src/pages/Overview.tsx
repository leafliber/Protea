import { useState } from 'react';
import type { ApprovalInfo, EventEnvelope, ScheduleInfo, StatusResponse } from '@protea/protocol';
import { post, qs, useAction, useApi } from '../api';
import { approvalTitle } from '../components/ApprovalCard';
import { Bar, Button, Card, Empty, ErrorText, KV, LevelBadge, RelTime, Skeleton, Stat, StateBadge, compact, oneLine, timeAgo, usd, useFeedback } from '../components/ui';
import { useReloadOn } from '../live';
import { consoleHref, go, useSession } from '../session';
import { usePendingChanges } from './Changes';

const PHASE_NAME: Record<string, string> = { idle: '空闲', delivering: '正在接收事件', model: '思考中', tools: '正在使用工具', backoff: '模型不可用，重试中', handoff: '整理对话中', draining: '收尾中' };

interface Todo {
  key: string;
  tone: 'bad' | 'warn' | 'info';
  text: string;
  href?: string;
  action?: { label: string; run: () => void };
}

export function Overview({ status, reload }: { status: StatusResponse | undefined; reload: () => void }) {
  const { canWrite } = useSession();
  const { confirm, toast } = useFeedback();
  const recent = useApi<{ events: EventEnvelope[] }>(`/api/events${qs({ limit: 8 })}`);
  useReloadOn('event', recent.reload, 800);
  const approvals = useApi<{ approvals: ApprovalInfo[] }>(canWrite ? '/api/approvals?state=pending' : null);
  useReloadOn('approval', approvals.reload, 300);
  const schedules = useApi<{ schedules: ScheduleInfo[] }>('/api/schedules', { refreshMs: 60_000 });
  useReloadOn('schedule', schedules.reload, 400);
  const changes = usePendingChanges();
  const act = useAction();
  const [details, setDetails] = useState(false);
  if (!status) return <Skeleton lines={8} />;

  const u = status.usage24h;
  const activeForks = status.forks.filter((f) => ['queued', 'running', 'paused'].includes(f.state));
  const badPlugins = status.plugins.filter((p) => p.enabled && p.state !== 'running');
  const badMcp = status.mcp.filter((m) => m.enabled && m.state !== 'running');
  const pendingApprovals = approvals.data?.approvals.filter((a) => a.state === 'pending') ?? [];
  const queued = Object.values(status.pending).reduce((a, b) => a + b, 0);
  const budgetLevels = Object.entries(status.budget.levels);
  const tightest = budgetLevels.reduce<number | null>((m, [, b]) => (b.usedRatio === null ? m : Math.max(m ?? 0, b.usedRatio)), null);
  const ctxRatio = status.context.softTokens > 0 ? status.context.estimatedTokens / status.context.softTokens : 0;
  const upcoming = (schedules.data?.schedules ?? []).filter((s) => s.enabled && s.nextAt).slice(0, 4);
  const resume = () => void act.run(() => post('/api/scheduler/resume')).then(reload);

  const todos: Todo[] = [];
  if (status.scheduler.paused) todos.push({ key: 'paused', tone: 'bad', text: `事件投递已被 ${status.scheduler.paused} 暂停：新事件照常记录，但助理不会处理。`, ...(canWrite ? { action: { label: '恢复投递', run: resume } } : {}) });
  if (!status.provider.ready) todos.push({ key: 'provider', tone: 'bad', text: `模型没有准备好：${status.provider.problem ?? '未知原因'}`, href: consoleHref('providers') });
  if (pendingApprovals.length > 0) todos.push({ key: 'approvals', tone: 'warn', text: pendingApprovals.length === 1 ? `助理在等你确认：${approvalTitle(pendingApprovals[0] as ApprovalInfo)}` : `有 ${pendingApprovals.length} 个操作在等你确认`, href: consoleHref('approvals') });
  if (changes.length > 0) todos.push({ key: 'changes', tone: 'warn', text: `助理提议了 ${changes.length} 项对自己能力的改动，等你审核`, href: consoleHref('approvals', { tab: 'changes' }) });
  for (const p of badPlugins) todos.push({ key: `p:${p.id}`, tone: 'warn', text: `插件 ${p.id} 没有在运行（${p.state}）`, href: consoleHref('plugins', { id: p.id }) });
  for (const m of badMcp) todos.push({ key: `m:${m.id}`, tone: 'warn', text: `MCP 服务器 ${m.id} 没有在运行（${m.state}）`, href: consoleHref('mcp') });
  if (status.budget.hardCapReached) todos.push({ key: 'cap', tone: 'bad', text: '今天的费用到了硬上限，现在只处理最紧急的事件。', href: consoleHref('config', { tab: 'budget' }) });
  else if (status.budget.enforced && tightest !== null && tightest >= 0.8) todos.push({ key: 'budget', tone: 'warn', text: `今天的预算已用掉 ${Math.round(tightest * 100)}%`, href: consoleHref('config', { tab: 'budget' }) });
  if (ctxRatio >= 1) todos.push({ key: 'ctx', tone: 'info', text: '对话已经很长，下次空闲时会自动整理。', href: consoleHref('sessions') });
  if (!status.timezone.set) todos.push({ key: 'tz', tone: 'info', text: `没有设置时区，正在用系统的 ${status.timezone.zone}：日志按这个时区分日，每日记忆整理也按它的时间运行。请在 config.yaml 设置 daemon.timezone 并重启。`, href: consoleHref('config') });
  if (status.memory.dream.disabled) todos.push({ key: 'dream', tone: 'warn', text: `每日记忆整理连续失败 ${status.memory.dream.failures} 次，已暂停`, href: consoleHref('memory') });

  const handoff = async () => {
    if (!(await confirm({ title: '现在整理主会话？', body: '较早的对话会写成笔记，只保留最近的一批。助理不会忘记写进记忆的内容。', confirm: '整理' }))) return;
    void act.run(async () => {
      const r = await post<Record<string, unknown>>('/api/sessions/main/handoff', { reason: 'console' });
      toast(r['scheduled'] ? '助理正在忙，会在下一批开始时整理' : r['handedOff'] ? '已整理，笔记写进了记忆' : '还没有可以整理的内容');
      reload();
    });
  };
  const pause = async () => {
    if (!(await confirm({ title: '暂停事件投递？', body: '新事件会继续记录，但助理不再处理，直到你恢复。正在进行的这一批会跑完。', confirm: '暂停', danger: true }))) return;
    void act.run(() => post('/api/scheduler/pause')).then(reload);
  };

  return (
    <div className="page">
      <section className={todos.length > 0 ? 'todo todo-some' : 'todo todo-none'} aria-label="需要你处理">
        <h2>{todos.length > 0 ? '需要你处理' : '一切正常，没有需要你处理的事'}</h2>
        {todos.length > 0 && (
          <ul>
            {todos.map((t) => (
              <li key={t.key} className={`todo-item todo-${t.tone}`}>
                <span className="todo-dot" />
                {t.href ? <a href={t.href}>{t.text}</a> : <span>{t.text}</span>}
                {t.action && (
                  <Button small kind="primary" busy={act.busy} onClick={t.action.run}>
                    {t.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ErrorText error={act.error} />
      </section>

      <div className="stats">
        <Stat label="现在" value={PHASE_NAME[status.phase] ?? status.phase} hint={status.batchId ? <a href={consoleHref('events', { batch: status.batchId })}>查看正在处理的这一批</a> : `已运行 ${Math.floor(status.uptimeSec / 3600)} 小时 ${Math.floor((status.uptimeSec % 3600) / 60)} 分`} {...(status.phase === 'backoff' ? { tone: 'bad' as const } : {})} />
        {u.unpricedCalls > 0 ? (
          <Stat label="过去 24 小时花费" value={usd(u.costUsd)} hint={`${u.unpricedCalls} / ${u.calls} 次调用的模型没有价格，未计入：去「模型」设置`} href={consoleHref('providers')} tone="warn" />
        ) : (
          <Stat label="过去 24 小时花费" value={usd(u.costUsd)} hint={`${u.calls} 次模型调用${u.cacheHitRatio === null ? '' : ` · 缓存命中 ${(u.cacheHitRatio * 100).toFixed(0)}%`}`} href={consoleHref('config', { tab: 'budget' })} />
        )}
        <Stat label="对话长度" value={`${Math.round(ctxRatio * 100)}%`} hint={`约 ${compact(status.context.estimatedTokens)} / ${compact(status.context.softTokens)} tokens`} href={consoleHref('sessions')} {...(ctxRatio >= 1 ? { tone: 'bad' as const } : ctxRatio >= 0.8 ? { tone: 'warn' as const } : {})} />
        <Stat label="排队的事件" value={queued} hint={queued === 0 ? '都处理完了' : Object.entries(status.pending).filter(([, n]) => n > 0).map(([l, n]) => `L${l} ${n}`).join(' · ')} href={consoleHref('events', { state: 'pending' })} />
      </div>

      <div className="grid-2">
        <div className="col">
          <Card title="正在进行" actions={<a href={consoleHref('sessions', { tab: 'forks' })}>全部后台任务</a>}>
            {activeForks.length === 0 ? (
              <Empty>没有进行中的后台任务</Empty>
            ) : (
              <ul className="list">
                {activeForks.map((f) => (
                  <li key={f.id} onClick={() => go('sessions', { tab: 'forks', fork: f.id })} className="clickable">
                    <StateBadge state={f.state} /> {oneLine(f.goal, 90)} <span className="muted small">第 {f.rounds} 轮</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="最近发生的事" actions={<a href={consoleHref('events')}>运行流</a>}>
            {!recent.data && <Skeleton />}
            {recent.data && recent.data.events.length === 0 && <Empty>还没有事件</Empty>}
            <ul className="list">
              {recent.data?.events.map((e) => (
                <li key={e.cursor} className="clickable" onClick={() => go('events', { cursor: String(e.cursor) })}>
                  <span className="muted small nowrap">{timeAgo(e.receivedAt)}</span> <code>{e.type}</code> {oneLine(e.text, 100)}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="col">
          <Card title="接下来的定时任务" actions={<a href={consoleHref('schedules')}>全部</a>}>
            {upcoming.length === 0 ? (
              <Empty>没有即将运行的定时任务</Empty>
            ) : (
              <ul className="list">
                {upcoming.map((s) => (
                  <li key={s.id} className="clickable" onClick={() => go('schedules', { id: s.id })}>
                    <div className="row">
                      <span className="grow">{s.name}</span>
                      <RelTime at={s.nextAt} future />
                    </div>
                    <div className="muted small">{s.human}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="今天的预算" actions={<a href={consoleHref('config', { tab: 'budget' })}>设置</a>}>
            {budgetLevels.map(([l, b]) => (
              <div key={l} className="budget-row">
                <LevelBadge level={Number(l)} />
                <Bar ratio={b.usedRatio} />
                <span className="small nowrap">
                  {usd(b.spentUsd)}
                  {b.limitUsd !== null ? ` / ${usd(b.limitUsd)}` : ' · 不限'}
                </span>
              </div>
            ))}
            <div className="muted small">{status.budget.enforced ? '超出预算的等级会暂缓处理。' : '现在只统计，不限制。'}</div>
          </Card>
        </div>
      </div>

      <Card
        title="运行详情"
        actions={
          <Button small kind="ghost" onClick={() => setDetails(!details)}>
            {details ? '收起' : '展开'}
          </Button>
        }
      >
        {details ? (
          <>
            <KV
              rows={[
                ['模型', `${status.provider.id}/${status.provider.mainModel}`],
                ['工具', `${status.tools.total} 个${status.tools.deferred ? `（${status.tools.deferred} 个按需加载）` : ''}`],
                ['Skills', `${status.skills.listed} 个${status.skills.rejected ? `，${status.skills.rejected} 个被拒绝` : ''}`],
                ['记忆', `${status.memory.files} 个文件${status.persona.problem ? ` · 人格钩子错误：${status.persona.problem}` : ''}`],
                ['对话文件', `${status.context.transcript} · 已整理 ${status.context.handoffs} 次 · 硬上限 ${compact(status.context.hardTokens)} tokens`],
                ['24 小时 tokens', `输入 ${compact(u.inputTokens)} · 输出 ${compact(u.outputTokens)} · 缓存读 ${compact(u.cacheReadTokens)} · 写 ${compact(u.cacheWriteTokens)}`],
                ['版本', `${status.version} · run ${status.runId.slice(-6)}`],
              ]}
            />
            <div className="chips">
              {status.plugins
                .filter((p) => p.enabled)
                .map((p) => (
                  <a key={p.id} href={consoleHref('plugins', { id: p.id })} className="chip">
                    {p.id} <StateBadge state={p.state} />
                  </a>
                ))}
              {status.mcp.map((m) => (
                <a key={m.id} href={consoleHref('mcp')} className="chip">
                  mcp:{m.id} <StateBadge state={m.enabled ? m.state : 'disabled'} />
                </a>
              ))}
            </div>
            {canWrite && (
              <div className="row">
                <Button small busy={act.busy} onClick={() => void handoff()}>
                  现在整理对话
                </Button>
                {!status.scheduler.paused && (
                  <Button small busy={act.busy} onClick={() => void pause()}>
                    暂停事件投递
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="muted small">
            {status.provider.id}/{status.provider.mainModel} · {status.tools.total} 个工具 · {status.plugins.filter((p) => p.enabled && p.state === 'running').length} 个插件在运行 · {status.version}
          </div>
        )}
      </Card>
    </div>
  );
}
