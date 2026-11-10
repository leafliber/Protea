import { useState } from 'react';
import type { BatchTraceResponse, ContentBlock, SessionContextResponse } from '@protea/protocol';
import { enc, qs, useApi } from '../api';
import { useReloadOn } from '../live';
import { Badge, Button, Card, Drawer, ErrorText, KV, LevelBadge, StateBadge, clock, compact, dateTime, oneLine } from './ui';

type Block = ContentBlock;

/** One content block of a model message or tool result. */
export function BlockView({ b, showThinking }: { b: Block; showThinking: boolean }) {
  switch (b.type) {
    case 'text':
      return <div className="msg-text">{String(b['text'])}</div>;
    case 'thinking':
      return showThinking ? <details className="msg-thinking"><summary>思考</summary><div>{String(b['thinking'] ?? '')}</div></details> : null;
    case 'redacted_thinking':
      return showThinking ? <div className="muted small">[已加密的思考]</div> : null;
    case 'tool_use':
    case 'server_tool_use':
      return (
        <details className="msg-tool">
          <summary>
            → <code>{String(b['name'])}</code> {oneLine(JSON.stringify(b['input'] ?? {}), 100)}
          </summary>
          <pre>{JSON.stringify(b['input'], null, 2)}</pre>
        </details>
      );
    case 'tool_result': {
      const content = b['content'];
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return (
        <details className={`msg-tool ${b['is_error'] ? 'msg-error' : ''}`}>
          <summary>← {oneLine(text, 120)}</summary>
          <pre>{text}</pre>
        </details>
      );
    }
    default:
      return <div className="muted small">[{b.type}]</div>;
  }
}

/** A finished batch step by step, rebuilt from its transcript and what it sent. */
export function BatchTrace({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useApi<BatchTraceResponse>(`/api/batches/${enc(id)}/trace`);
  useReloadOn('batch.ended', r.reload, 300);
  const b = r.data?.batch;
  const eventOf = (cursor: number) => r.data?.events.find((e) => e.cursor === cursor);
  return (
    <Drawer title={`批 ${id} 的过程`} onClose={onClose}>
      <ErrorText error={r.error} />
      {b && (
        <KV
          rows={[
            ['等级', <LevelBadge key="l" level={b.level} />],
            ['开始', dateTime(b.startedAt)],
            ['结束', b.endedAt ? `${dateTime(b.endedAt)} · ${b.endReason}` : '进行中'],
            ['回合', String(b.rounds)],
          ]}
        />
      )}
      {r.data && r.data.steps.length === 0 && <p className="muted small">这一批没有留下转录（比如转录文件已被清理）。</p>}
      <ol className="trace-steps">
        {r.data?.steps.map((s, i) => {
          switch (s.kind) {
            case 'events':
              return (
                <li key={i}>
                  <div className="trace-head">
                    <span className="tl-time">{clock(s.at)}</span> <Badge tone="info">输入</Badge>
                  </div>
                  {s.cursors.map((c) => {
                    const e = eventOf(c);
                    return (
                      <div key={c} className="trace-event">
                        #{c} {e && <LevelBadge level={e.effLevel} />} {e && <code>{e.type}</code>} {e && <StateBadge state={e.state} />}
                        {e && <pre className="text-block">{e.text}</pre>}
                      </div>
                    );
                  })}
                </li>
              );
            case 'model':
              return (
                <li key={i}>
                  <div className="trace-head">
                    <span className="tl-time">{clock(s.at)}</span> <Badge tone="neutral">模型 · 第 {s.round} 回合</Badge>{' '}
                    <span className="muted small">
                      {s.model}
                      {s.stopReason ? ` · ${s.stopReason}` : ''}
                      {s.usage ? ` · 输入 ${compact(s.usage.inputTokens + s.usage.cacheReadTokens + s.usage.cacheWriteTokens)}（缓存 ${compact(s.usage.cacheReadTokens)}）· 输出 ${compact(s.usage.outputTokens)}` : ''}
                    </span>
                  </div>
                  {s.content.map((b2, j) => (
                    <BlockView key={j} b={b2} showThinking />
                  ))}
                </li>
              );
            case 'tool_result':
              return (
                <li key={i}>
                  <details className={`msg-tool ${s.isError ? 'msg-error' : ''}`}>
                    <summary>
                      <span className="tl-time">{clock(s.at)}</span> ← <code>{s.name}</code> {oneLine(s.text, 100)}
                    </summary>
                    <pre>{s.text}</pre>
                  </details>
                </li>
              );
            case 'output':
              return (
                <li key={i}>
                  <div className="trace-head">
                    <span className="tl-time">{clock(s.at)}</span> <Badge tone="info">◂ {s.plugin}</Badge>
                  </div>
                  <div className="msg-text">{s.text}</div>
                </li>
              );
            case 'mark':
              return (
                <li key={i} className="muted small">
                  <span className="tl-time">{clock(s.at)}</span> {s.mark} {Object.keys(s.detail).length > 0 ? JSON.stringify(s.detail) : ''}
                </li>
              );
          }
        })}
      </ol>
    </Drawer>
  );
}

const PAGE = 40;

/** What the next model request of a session would carry: system segments, tools and messages. */
export function ContextView({ id }: { id: string }) {
  const [from, setFrom] = useState<number | null>(null);
  const r = useApi<SessionContextResponse>(`/api/sessions/${enc(id)}/context${qs({ limit: PAGE, from: from ?? undefined })}`);
  useReloadOn(['batch.ended', 'handoff', 'plugin', 'mcp', 'skills', 'persona'], () => from === null && r.reload(), 600);
  const d = r.data;
  return (
    <>
      <ErrorText error={r.error} />
      {d && (
        <Card title="下一次请求">
          <KV
            rows={[
              ['模型', `${d.model} · ${d.role} · ${d.effort}`],
              ['估算合计', `${compact(d.totals.estimatedTokens)} tokens${d.limits ? `（交接阈值 ${compact(d.limits.softTokens)}，硬上限 ${compact(d.limits.hardTokens)}）` : ''}`],
              ['组成', `系统段 ${compact(d.totals.systemTokens)} · 工具 ${compact(d.totals.toolTokens)} · 消息 ${compact(d.totals.messageTokens)}`],
              ...(d.cacheHitRatio !== undefined && d.cacheHitRatio !== null ? ([['上次缓存命中', `${Math.round(d.cacheHitRatio * 100)}%`]] as Array<[string, string]>) : []),
            ]}
          />
        </Card>
      )}
      {d && (
        <Card title={`系统段（${d.system.length}）`}>
          {d.system.map((s) => (
            <details key={s.id} className="msg-tool">
              <summary>
                <code>{s.id}</code> <span className="muted small">~{compact(s.tokens)} tokens</span>
              </summary>
              <pre>{s.text}</pre>
            </details>
          ))}
        </Card>
      )}
      {d && (
        <Card title={`工具（${d.tools.length}）`}>
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>来自</th>
                <th>Tokens</th>
                <th>加载</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {d.tools.map((t) => (
                <tr key={t.name}>
                  <td className="mono small">{t.name}</td>
                  <td>{t.owner ?? '—'}</td>
                  <td>{compact(t.tokens)}</td>
                  <td>{t.deferred ? '按需' : '预先'}</td>
                  <td className="muted small">{oneLine(t.description, 90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {d && (
        <Card title="消息">
          <div className="row">
            <span className="muted small">
              {d.from + 1}–{d.from + d.messages.length} / {d.totalMessages} 条
            </span>
            {d.from > 0 && <Button small onClick={() => setFrom(Math.max(0, d.from - PAGE))}>更早</Button>}
            {d.from + d.messages.length < d.totalMessages && <Button small onClick={() => setFrom(d.from + PAGE >= d.totalMessages - PAGE ? null : d.from + PAGE)}>更新</Button>}
            {from !== null && <Button small kind="ghost" onClick={() => setFrom(null)}>最新</Button>}
          </div>
          <div className="transcript">
            {d.messages.map((m, i) => (
              <div key={d.from + i} className={`msg msg-${m.role}`}>
                <div className="msg-role">{m.role === 'assistant' ? '助理' : '事件 / 工具结果'}</div>
                {m.content.map((b, j) => (
                  <BlockView key={j} b={b} showThinking />
                ))}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
