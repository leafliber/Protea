import { useState } from 'react';
import type { EventEnvelope, StatusResponse } from '@protea/protocol';
import { post, qs, useAction, useApi } from '../api';
import { Badge, Bar, Button, Card, Empty, ErrorText, KV, LevelBadge, Ring, StateBadge, compact, oneLine, timeAgo, usd } from '../components/ui';
import { useReloadOn } from '../live';
import { go, useSession } from '../session';

export function Overview({ status, reload }: { status: StatusResponse | undefined; reload: () => void }) {
  const { canWrite } = useSession();
  const internal = useApi<{ events: EventEnvelope[] }>(`/api/events${qs({ source: 'core', limit: 12 })}`);
  useReloadOn('event', internal.reload, 800);
  const act = useAction();
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  if (!status) return <Empty>加载中…</Empty>;
  const u = status.usage24h;
  const activeForks = status.forks.filter((f) => ['queued', 'running', 'paused'].includes(f.state));
  const badPlugins = status.plugins.filter((p) => p.enabled && p.state !== 'running');
  const badMcp = status.mcp.filter((m) => m.enabled && m.state !== 'running');
  return (
    <div className="grid">
      {status.scheduler.paused && (
        <div className="banner banner-bad span-all">
          事件投递已被 {status.scheduler.paused} 暂停：新事件照常入库，但不会交给模型。
          {canWrite && (
            <Button kind="primary" small busy={act.busy} onClick={() => void act.run(() => post('/api/scheduler/resume')).then(reload)}>
              恢复投递
            </Button>
          )}
        </div>
      )}
      {!status.provider.ready && (
        <div className="banner banner-bad span-all">
          模型未就绪：{status.provider.problem} <a href="#/providers">去「模型」页配置</a>
        </div>
      )}
      {(badPlugins.length > 0 || badMcp.length > 0) && (
        <div className="banner banner-warn span-all">
          {badPlugins.map((p) => (
            <span key={p.id}>
              插件 <a href={`#/plugins?id=${p.id}`}>{p.id}</a> <StateBadge state={p.state} />{' '}
            </span>
          ))}
          {badMcp.map((m) => (
            <span key={m.id}>
              MCP <a href="#/mcp">{m.id}</a> <StateBadge state={m.state} />{' '}
            </span>
          ))}
        </div>
      )}

      <Card title="运行">
        <KV
          rows={[
            ['阶段', <span key="p">{status.phase}{status.batchId ? <span className="muted"> · {status.batchId}</span> : null}</span>],
            ['模型', <span key="m">{status.provider.id}/{status.provider.mainModel} {status.provider.ready ? <Badge tone="good">ready</Badge> : <Badge tone="bad">not ready</Badge>}</span>],
            ['运行时长', `${Math.floor(status.uptimeSec / 3600)} 小时 ${Math.floor((status.uptimeSec % 3600) / 60)} 分`],
            ['工具', `${status.tools.total}${status.tools.deferred ? `（${status.tools.deferred} 个按需加载）` : ''}`],
            ['Skills', `${status.skills.listed} 个已列出${status.skills.rejected ? `，${status.skills.rejected} 个被拒绝` : ''}`],
            ['记忆', `${status.memory.files} 个文件${status.persona.hooks ? ' · 人格钩子已加载' : ''}${status.persona.problem ? ` · 钩子错误：${status.persona.problem}` : ''}`],
          ]}
        />
        {canWrite && (
          <div className="row">
            {status.scheduler.paused ? (
              <Button small busy={act.busy} onClick={() => void act.run(() => post('/api/scheduler/resume')).then(reload)}>
                恢复投递
              </Button>
            ) : (
              <Button small busy={act.busy} onClick={() => confirm('暂停事件投递？事件会继续入库，正在运行的批会跑完。') && void act.run(() => post('/api/scheduler/pause')).then(reload)}>
                暂停投递
              </Button>
            )}
            <ErrorText error={act.error} />
          </div>
        )}
      </Card>

      <Card title="待处理" actions={<a href="#/events?state=pending">查看</a>}>
        <div className="levels">
          {Object.entries(status.pending).map(([l, n]) => (
            <div key={l} className="level-cell">
              <LevelBadge level={Number(l)} />
              <strong>{n}</strong>
            </div>
          ))}
        </div>
        {status.scheduler.cooldowns.length > 0 && (
          <div className="muted small">抢占冷却：{status.scheduler.cooldowns.map((c) => `${c.source}（到 ${new Date(c.untilMs).toLocaleTimeString()}）`).join('，')}</div>
        )}
      </Card>

      <Card title="上下文" actions={<a href="#/sessions">会话</a>}>
        <div className="row">
          <Ring
            value={status.context.estimatedTokens}
            max={status.context.softTokens}
            warnAt={status.context.softTokens * 0.8}
            label={
              <>
                <div>
                  ~{compact(status.context.estimatedTokens)} / {compact(status.context.softTokens)} tokens
                </div>
                <div className="muted small">
                  {status.context.transcript} · 交接 {status.context.handoffs} 次 · 硬上限 {compact(status.context.hardTokens)}
                </div>
              </>
            }
          />
        </div>
        {canWrite && (
          <div className="row">
            <Button
              small
              busy={act.busy}
              onClick={() =>
                confirm('现在交接主会话？较早的对话会写成交接笔记，只保留最近一批。') &&
                void act.run(async () => {
                  const r = await post<Record<string, unknown>>('/api/sessions/main/handoff', { reason: 'console' });
                  setHandoffNote(r['scheduled'] ? '正在运行一批，交接会在下一批开始时进行' : r['handedOff'] ? `已交接到 ${String(r['transcript'])}，笔记 /memories/${String(r['notes'])}` : '还没有可以交接的内容');
                  reload();
                })
              }
            >
              手动交接
            </Button>
            {handoffNote && <span className="muted small">{handoffNote}</span>}
          </div>
        )}
      </Card>

      <Card title="24 小时用量">
        <KV
          rows={[
            ['调用', String(u.calls)],
            ['tokens', `输入 ${compact(u.inputTokens)} · 输出 ${compact(u.outputTokens)} · 缓存读 ${compact(u.cacheReadTokens)} · 写 ${compact(u.cacheWriteTokens)}`],
            ['缓存命中', u.cacheHitRatio === null ? '—' : `${(u.cacheHitRatio * 100).toFixed(1)}%`],
            ['费用', usd(u.costUsd, 4)],
          ]}
        />
      </Card>

      <Card title="预算（按等级）" actions={<a href="#/config?tab=budget">设置</a>}>
        {Object.entries(status.budget.levels).map(([l, b]) => (
          <div key={l} className="budget-row">
            <LevelBadge level={Number(l)} />
            <Bar ratio={b.usedRatio} />
            <span className="small">
              {usd(b.spentUsd)}
              {b.limitUsd !== null ? ` / ${usd(b.limitUsd)}` : ' · 不限'}
            </span>
          </div>
        ))}
        <div className="muted small">{status.budget.enforced ? `预算已强制执行${status.budget.hardCapReached ? '；已到全局硬上限，只处理 L0/L1' : ''}` : '预算只统计、不限制（budget.enforce: false）'}</div>
      </Card>

      <Card title="Fork" actions={<a href="#/sessions?tab=forks">全部</a>}>
        {activeForks.length === 0 ? (
          <Empty>没有进行中的 Fork</Empty>
        ) : (
          <ul className="list">
            {activeForks.map((f) => (
              <li key={f.id} onClick={() => go('sessions', { tab: 'forks', fork: f.id })} className="clickable">
                <StateBadge state={f.state} /> <LevelBadge level={f.level} /> {oneLine(f.goal, 80)} <span className="muted small">{f.rounds} 回合</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="插件与 MCP">
        <div className="chips">
          {status.plugins.map((p) => (
            <a key={p.id} href={`#/plugins?id=${p.id}`} className="chip">
              {p.id} <StateBadge state={p.enabled ? p.state : 'disabled'} />
            </a>
          ))}
          {status.mcp.map((m) => (
            <a key={m.id} href="#/mcp" className="chip">
              mcp:{m.id} <StateBadge state={m.enabled ? m.state : 'disabled'} />
            </a>
          ))}
        </div>
      </Card>

      <Card title="最近的内部事件" className="span-2" actions={<a href="#/events?source=core">全部</a>}>
        {internal.data?.events.length ? (
          <ul className="list">
            {internal.data.events.map((e) => (
              <li key={e.cursor} className="clickable" onClick={() => go('events', { cursor: String(e.cursor) })}>
                <span className="muted small">#{e.cursor}</span> <LevelBadge level={e.effLevel} /> <code>{e.type}</code> {oneLine(e.text, 110)}{' '}
                <span className="muted small">{timeAgo(e.receivedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>还没有</Empty>
        )}
      </Card>
    </div>
  );
}
