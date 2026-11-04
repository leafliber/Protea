import { useEffect, useRef, useState } from 'react';
import type { LogRecord } from '@protea/protocol';
import { enc, get, qs, useApi } from '../api';
import { Badge, Button, Card, Empty, ErrorText, Json, Tabs, dateTime } from '../components/ui';
import { useLive } from '../live';
import { go } from '../session';

const NAMES: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const SKIP = new Set(['level', 'time', 'msg', 'run', 'component', 'pid', 'hostname']);

export function LogLines({ logs }: { logs: LogRecord[] }) {
  if (logs.length === 0) return <Empty>没有日志</Empty>;
  return (
    <div className="logs">
      {logs.map((e, i) => {
        const extra = Object.entries(e)
          .filter(([k]) => !SKIP.has(k))
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ');
        return (
          <div key={`${e.time}-${i}`} className={`log log-${e.level >= 50 ? 'error' : e.level >= 40 ? 'warn' : e.level <= 20 ? 'debug' : 'info'}`}>
            <span className="log-time">{new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span className="log-level">{NAMES[e.level] ?? e.level}</span>
            {e['component'] ? <span className="log-comp">[{String(e['component'])}]</span> : null}
            <span className="log-msg">{e.msg}</span>
            {extra && <span className="log-extra">{extra}</span>}
          </div>
        );
      })}
    </div>
  );
}

function Tail() {
  const [lines, setLines] = useState<LogRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState('info');
  const [component, setComponent] = useState('');
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    get<{ logs: LogRecord[] }>(`/api/logs${qs({ limit: 300, level })}`).then((r) => setLines(r.logs), () => undefined);
  }, [level]);
  const min = { debug: 20, info: 30, warn: 40, error: 50 }[level] ?? 30;
  useLive('log', (m) => {
    if (m.topic !== 'log' || pausedRef.current || m.data.level < min) return;
    setLines((old) => [...old, m.data].slice(-2000));
  });
  useEffect(() => {
    if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, paused]);
  const needle = q.toLowerCase();
  const shown = lines.filter((e) => (!component || e['component'] === component) && (!needle || JSON.stringify(e).toLowerCase().includes(needle)));
  return (
    <Card
      title="实时日志"
      actions={
        <>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="info">info 及以上</option>
            <option value="warn">warn 及以上</option>
            <option value="error">error</option>
          </select>
          <input value={component} onChange={(e) => setComponent(e.target.value)} placeholder="组件，如 plugins" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="包含文字" />
          <Button small onClick={() => setPaused((x) => !x)}>{paused ? '继续' : '暂停滚动'}</Button>
          <Button small kind="ghost" onClick={() => setLines([])}>清屏</Button>
        </>
      }
    >
      <div className="logs-box" ref={box}>
        <LogLines logs={shown} />
      </div>
      <div className="muted small">实时连接只推送 info 及以上；debug 日志用"检索"。</div>
    </Card>
  );
}

function Search({ run }: { run: string | null }) {
  const [form, setForm] = useState({ level: '', component: '', plugin: '', q: '', since: '', batch: '' });
  const [result, setResult] = useState<LogRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    try {
      const since = form.since ? Date.now() - Number(form.since) * 60_000 : undefined;
      const r = await get<{ logs: LogRecord[] }>(`/api/logs${qs({ ...form, since, run, limit: 1000 })}`);
      setResult(r.logs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Card title={run ? `检索运行 ${run}` : '检索本次运行'}>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <select value={form.level} onChange={set('level')}>
          <option value="">所有级别</option>
          <option value="debug">debug+</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">error+</option>
        </select>
        <input value={form.component} onChange={set('component')} placeholder="组件" />
        <input value={form.plugin} onChange={set('plugin')} placeholder="插件" />
        <input value={form.batch} onChange={set('batch')} placeholder="批 id" />
        <input value={form.q} onChange={set('q')} placeholder="包含文字" />
        <select value={form.since} onChange={set('since')}>
          <option value="">任何时间</option>
          <option value="15">最近 15 分钟</option>
          <option value="60">最近 1 小时</option>
          <option value="1440">最近 1 天</option>
        </select>
        <Button kind="primary" type="submit">
          检索
        </Button>
        {run && <Button kind="ghost" onClick={() => go('logs', { tab: 'search' })}>回到本次运行</Button>}
      </form>
      <ErrorText error={error} />
      {result && (
        <>
          <div className="muted small">{result.length} 条（最多 1000 条，取最新的）</div>
          <LogLines logs={result} />
        </>
      )}
    </Card>
  );
}

interface RunRow {
  id: string;
  startedAt: string;
  logBytes: number;
  crashes: number;
  hasShutdown: boolean;
}

function RunDetail({ id }: { id: string }) {
  const r = useApi<{ shutdown: unknown; crashes: Array<{ file: string; report: unknown }> }>(`/api/runs/${enc(id)}`);
  if (r.error) return <ErrorText error={r.error} />;
  if (!r.data) return null;
  return (
    <div>
      <h3>关停记录</h3>
      {r.data.shutdown ? <Json value={r.data.shutdown} /> : <div className="muted">没有（进程没有正常关停，或仍在运行）</div>}
      <h3>崩溃报告</h3>
      {r.data.crashes.length === 0 ? <div className="muted">没有</div> : r.data.crashes.map((c) => <details key={c.file}><summary>{c.file}</summary><Json value={c.report} /></details>)}
    </div>
  );
}

function Runs() {
  const r = useApi<{ current: string | null; runs: RunRow[] }>('/api/runs');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="运行目录">
      <ErrorText error={r.error} />
      <table className="table">
        <thead>
          <tr>
            <th>运行</th>
            <th>开始</th>
            <th>日志</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {r.data?.runs.map((x) => (
            <tr key={x.id}>
              <td className="mono small">
                <button className="link" onClick={() => setOpen(open === x.id ? null : x.id)}>
                  {x.id}
                </button>
              </td>
              <td>{dateTime(x.startedAt)}</td>
              <td>{Math.round(x.logBytes / 1024)} KB</td>
              <td>
                {x.id === r.data?.current ? <Badge tone="good">当前</Badge> : x.hasShutdown ? <Badge tone="muted">正常关停</Badge> : <Badge tone="warn">无关停记录</Badge>}{' '}
                {x.crashes > 0 && <Badge tone="bad">{x.crashes} 个崩溃报告</Badge>}
              </td>
              <td>
                <Button small kind="ghost" onClick={() => go('logs', { tab: 'search', run: x.id })}>
                  检索日志
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <RunDetail id={open} />}
    </Card>
  );
}

export function Logs({ params }: { params: URLSearchParams }) {
  const tab = (params.get('tab') ?? 'tail') as 'tail' | 'search' | 'runs';
  return (
    <div className="page">
      <Tabs
        tabs={[
          ['tail', '实时'],
          ['search', '检索'],
          ['runs', '运行目录'],
        ]}
        value={tab}
        onChange={(t) => go('logs', { tab: t })}
      />
      {tab === 'tail' && <Tail />}
      {tab === 'search' && <Search run={params.get('run')} />}
      {tab === 'runs' && <Runs />}
    </div>
  );
}
