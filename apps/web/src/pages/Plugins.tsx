import { useState, type FormEvent } from 'react';
import type { LogRecord, PluginStatus } from '@protea/protocol';
import { api, enc, post, qs, useAction, useApi } from '../api';
import { SchemaForm } from '../components/SchemaForm';
import { Badge, Button, Card, Empty, ErrorText, KV, StateBadge, Tabs, oneLine } from '../components/ui';
import { useReloadOn } from '../live';
import { go, useSession } from '../session';
import { LogLines } from './Logs';

export function InstallForm({ kind, onDone }: { kind: 'plugin' | 'skill'; onDone: () => void }) {
  const [source, setSource] = useState<'git' | 'tarball' | 'path'>('git');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [subdir, setSubdir] = useState('');
  const act = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = source === 'path' ? { path: url, ...(subdir ? { subdir } : {}) } : { source, url, ...(ref && source === 'git' ? { ref } : {}), ...(subdir ? { subdir } : {}) };
    if (await act.run(() => post(kind === 'plugin' ? '/api/plugins' : '/api/skills', body))) {
      setUrl('');
      onDone();
    }
  };
  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          <option value="git">Git 仓库</option>
          <option value="tarball">tarball（.tgz URL）</option>
          <option value="path">守护进程所在机器的目录</option>
        </select>
        <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={source === 'path' ? '/data/workspace/my-plugin' : 'https://github.com/you/protea-plugin-x.git'} />
      </div>
      <div className="row">
        {source === 'git' && <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="分支或标签（可选）" />}
        <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="子目录（可选）" />
        <Button kind="primary" type="submit" busy={act.busy} disabled={!url.trim()}>
          安装
        </Button>
      </div>
      <ErrorText error={act.error} />
      <div className="muted small">
        {kind === 'plugin'
          ? '来源里要有 protea.plugin.json 和可直接运行的入口（构建好的 dist）；装到 /data/plugins/<id> 并启用。插件代码在守护进程里以子进程运行，只装信任的来源。'
          : '来源里要有 SKILL.md；装到 /data/skills/<name>。'}
      </div>
    </form>
  );
}

function PluginDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { canWrite } = useSession();
  const [tab, setTab] = useState<'config' | 'logs' | 'manifest'>('config');
  const p = useApi<PluginStatus & { manifest: Record<string, unknown> | null }>(`/api/plugins/${enc(id)}`);
  const cfg = useApi<{ config: Record<string, unknown>; schema: Record<string, unknown> | null; coldKeys: string[] }>(`/api/plugins/${enc(id)}/config`);
  const logs = useApi<{ logs: LogRecord[] }>(`/api/plugins/${enc(id)}/logs${qs({ limit: 300 })}`, { refreshMs: 5000 });
  useReloadOn('plugin', () => {
    p.reload();
    cfg.reload();
  });
  const act = useAction();
  const action = (a: string) => void act.run(() => post(`/api/plugins/${enc(id)}/${a}`)).then(() => (p.reload(), onChanged()));
  const s = p.data;
  if (!s) return <ErrorText error={p.error} />;
  const m = s.manifest ?? {};
  return (
    <Card
      title={
        <>
          {String(m['displayName'] ?? s.id)} <StateBadge state={s.state} />
        </>
      }
      actions={
        canWrite && (
          <>
            {s.enabled ? <Button small onClick={() => action('disable')}>禁用</Button> : <Button small kind="primary" onClick={() => action('enable')}>启用</Button>}
            <Button small onClick={() => action('reload')} title="重新读取清单与配置并重启">重载</Button>
            {(s.state === 'failed' || s.state === 'crashed') && <Button small onClick={() => action('restart')}>重启</Button>}
            {s.origin === 'data' && (
              <Button
                small
                kind="danger"
                onClick={() =>
                  confirm(`卸载 ${s.id}？（需先禁用；插件数据默认一并删除）`) &&
                  void act.run(() => api('DELETE', `/api/plugins/${enc(id)}`)).then(() => {
                    onChanged();
                    go('plugins');
                  })
                }
              >
                卸载
              </Button>
            )}
          </>
        )
      }
    >
      <ErrorText error={act.error} />
      {s.error && <div className="banner banner-bad">{s.error}</div>}
      <KV
        rows={[
          ['类型', `${s.kind} · ${s.origin}${s.version ? ` · v${s.version}` : ''}`],
          ['说明', String(m['description'] ?? '—')],
          ['工具', s.tools.length ? s.tools.join(', ') : '—'],
          ['进程', s.pid ? `pid ${s.pid}${s.restarts ? ` · 重启 ${s.restarts} 次` : ''}` : '—'],
          ...(Array.isArray(m['secrets']) && (m['secrets'] as string[]).length ? ([['需要的秘密', (m['secrets'] as string[]).join(', ')]] as Array<[string, string]>) : []),
        ]}
      />
      <Tabs
        tabs={[
          ['config', '配置'],
          ['logs', '日志'],
          ['manifest', '清单'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'config' &&
        (cfg.data ? (
          <SchemaForm
            schema={cfg.data.schema}
            value={cfg.data.config}
            coldKeys={cfg.data.coldKeys}
            readOnly={!canWrite}
            onSave={async (config) => {
              await api('PATCH', `/api/plugins/${enc(id)}/config`, { config });
              cfg.reload();
              p.reload();
            }}
          />
        ) : (
          <ErrorText error={cfg.error} />
        ))}
      {tab === 'logs' && <LogLines logs={logs.data?.logs ?? []} />}
      {tab === 'manifest' && <pre className="json">{JSON.stringify(m, null, 2)}</pre>}
    </Card>
  );
}

export function Plugins({ params }: { params: URLSearchParams }) {
  const { canWrite } = useSession();
  const list = useApi<{ plugins: PluginStatus[] }>('/api/plugins');
  useReloadOn('plugin', list.reload);
  const [showInstall, setShowInstall] = useState(false);
  const selected = params.get('id');
  return (
    <div className="page">
      <div className="row">
        <h1 className="grow">插件</h1>
        {canWrite && <Button onClick={() => setShowInstall((x) => !x)}>{showInstall ? '收起' : '安装插件'}</Button>}
      </div>
      {showInstall && (
        <Card title="安装插件">
          <InstallForm
            kind="plugin"
            onDone={() => {
              setShowInstall(false);
              list.reload();
            }}
          />
        </Card>
      )}
      <ErrorText error={list.error} />
      <div className="cards">
        {list.data?.plugins.map((p) => (
          <button key={p.id} className={`plugin-card ${selected === p.id ? 'selected' : ''}`} onClick={() => go('plugins', { id: p.id })}>
            <div className="row">
              <strong className="grow">{p.id}</strong>
              <StateBadge state={p.enabled ? p.state : 'disabled'} />
            </div>
            <div className="muted small">
              {p.kind} · {p.origin}
              {p.version ? ` · v${p.version}` : ''}
            </div>
            <div className="small">
              {p.tools.length} 个工具{p.restarts ? <Badge tone="warn">重启 {p.restarts}</Badge> : null}
            </div>
            {p.error && <div className="error-text small">{oneLine(p.error, 90)}</div>}
          </button>
        ))}
      </div>
      {list.data?.plugins.length === 0 && <Empty>没有插件</Empty>}
      {selected && <PluginDetail key={selected} id={selected} onChanged={list.reload} />}
      {!selected && <div className="muted small">点一个插件看它的配置、日志与清单。</div>}
    </div>
  );
}
