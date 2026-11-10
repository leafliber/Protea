import { useState, type FormEvent } from 'react';
import type { McpServerStatus, McpToolInfo } from '@protea/protocol';
import { api, enc, post, useAction, useApi } from '../api';
import { Badge, Button, PageActions, Card, Empty, ErrorText, Field, StateBadge, oneLine } from '../components/ui';
import { useReloadOn } from '../live';
import { useSession } from '../session';

function pairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function AddServer({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'oauth'>('none');
  const [bearer, setBearer] = useState('');
  const [trust, setTrust] = useState('normal');
  const act = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entry: Record<string, unknown> = { id, trust };
    if (transport === 'stdio') {
      const parts = command.trim().split(/\s+/);
      entry['command'] = parts[0];
      entry['args'] = parts.slice(1);
      const vars = pairs(env);
      if (Object.keys(vars).length) entry['env'] = vars;
    } else {
      entry['transport'] = 'streamable-http';
      entry['url'] = url;
      if (auth === 'bearer') entry['auth'] = { type: 'bearer', token: `\${secret:${bearer}}` };
      if (auth === 'oauth') entry['auth'] = { type: 'oauth' };
    }
    if (await act.run(() => post('/api/mcp/servers', entry))) {
      setId('');
      setCommand('');
      setUrl('');
      onDone();
    }
  };
  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="id，如 fetch" />
        <select value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}>
          <option value="stdio">本地命令（stdio）</option>
          <option value="streamable-http">远程（Streamable HTTP）</option>
        </select>
        <select value={trust} onChange={(e) => setTrust(e.target.value)} title="信任级别">
          <option value="low">trust low</option>
          <option value="normal">trust normal</option>
          <option value="high">trust high</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <>
          <Field label="命令" hint="例如 uvx mcp-server-fetch，或 npx -y @modelcontextprotocol/server-filesystem /data/workspace">
            <input value={command} onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field label="环境变量（每行 KEY=VALUE，可写 ${secret:NAME}）">
            <textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
          <div className="row">
            <select value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}>
              <option value="none">无鉴权</option>
              <option value="bearer">Bearer（秘密）</option>
              <option value="oauth">OAuth</option>
            </select>
            {auth === 'bearer' && <input value={bearer} onChange={(e) => setBearer(e.target.value.toUpperCase())} placeholder="秘密名，如 MCP_TOKEN" />}
          </div>
        </>
      )}
      <div className="row">
        <Button kind="primary" type="submit" busy={act.busy} disabled={!id.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}>
          添加并启动
        </Button>
        <ErrorText error={act.error} />
      </div>
    </form>
  );
}

function Tools({ id }: { id: string }) {
  const r = useApi<{ tools: McpToolInfo[] }>(`/api/mcp/servers/${enc(id)}/tools`);
  if (r.error) return <ErrorText error={r.error} />;
  if (!r.data) return null;
  if (r.data.tools.length === 0) return <Empty>没有工具</Empty>;
  return (
    <ul className="list">
      {r.data.tools.map((t) => (
        <li key={t.name}>
          <code>{t.name}</code> {t.readOnly && <Badge tone="good">只读</Badge>} {t.destructive && <Badge tone="bad">破坏性</Badge>} {t.filtered && <Badge tone="muted">已过滤</Badge>}
          <div className="muted small">{oneLine(t.description, 200)}</div>
        </li>
      ))}
    </ul>
  );
}

export function Mcp() {
  const { canWrite } = useSession();
  const r = useApi<{ servers: McpServerStatus[] }>('/api/mcp/servers');
  useReloadOn('mcp', r.reload);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const action = (id: string, a: string) => void act.run(() => post(`/api/mcp/servers/${enc(id)}/${a}`)).then(r.reload);
  return (
    <div className="page">
      <PageActions>
        {canWrite && !r.data?.servers.some((s) => s.id === 'browser') && (
          <Button busy={act.busy} title="无头 Chromium，由助理调用；需要镜像目标 browser" onClick={() => void act.run(() => post('/api/mcp/presets/browser')).then(r.reload)}>
            启用内置浏览器
          </Button>
        )}
        {canWrite && <Button kind="primary" onClick={() => setAdding((x) => !x)}>{adding ? '收起' : '添加服务器'}</Button>}
      </PageActions>
      {adding && (
        <Card title="添加 MCP 服务器">
          <AddServer
            onDone={() => {
              setAdding(false);
              r.reload();
            }}
          />
        </Card>
      )}
      <ErrorText error={r.error ?? act.error} />
      {r.data?.servers.length === 0 && <Empty>还没有 MCP 服务器</Empty>}
      {r.data?.servers.map((m) => (
        <Card
          key={m.id}
          title={
            <>
              {m.id} <StateBadge state={m.enabled ? m.state : 'disabled'} /> <span className="muted small">{m.transport} · trust {m.trust}</span>
            </>
          }
          actions={
            canWrite && (
              <>
                {m.state === 'auth_required' && (
                  <Button
                    small
                    kind="primary"
                    onClick={() =>
                      void act.run(async () => {
                        const res = await post<{ authorizeUrl?: string }>(`/api/mcp/servers/${enc(m.id)}/oauth/start`);
                        if (res.authorizeUrl) window.open(res.authorizeUrl, '_blank', 'noopener');
                      })
                    }
                  >
                    授权
                  </Button>
                )}
                {m.enabled ? <Button small onClick={() => action(m.id, 'disable')}>禁用</Button> : <Button small onClick={() => action(m.id, 'enable')}>启用</Button>}
                <Button small onClick={() => action(m.id, 'restart')}>重启</Button>
                <Button small kind="danger" onClick={() => confirm(`移除 ${m.id}？它的工具从下一回合起消失。`) && void act.run(() => api('DELETE', `/api/mcp/servers/${enc(m.id)}`)).then(r.reload)}>
                  移除
                </Button>
              </>
            )
          }
        >
          {m.error && <div className="banner banner-bad">{m.error}</div>}
          {m.warnings?.map((w) => (
            <div key={w} className="banner banner-warn">
              {w}
            </div>
          ))}
          {m.authorizeUrl && (
            <div className="banner banner-warn">
              需要授权：<a href={m.authorizeUrl} target="_blank" rel="noopener noreferrer">打开授权页面</a>
            </div>
          )}
          <div className="muted small">
            {m.server ? `${m.server.name} ${m.server.version} · ` : ''}
            {m.tools.length} 个工具{m.prompts ? ` · ${m.prompts} 个 prompts` : ''}
            {m.resources ? ' · 资源' : ''}
            {m.avgLatencyMs !== undefined ? ` · 平均 ${m.avgLatencyMs} ms/次` : ''}
            {m.pid ? ` · pid ${m.pid}` : ''}
            {m.restarts ? ` · 重启 ${m.restarts} 次` : ''}
          </div>
          <Button small kind="ghost" onClick={() => setOpen(open === m.id ? null : m.id)}>
            {open === m.id ? '收起工具' : '查看工具'}
          </Button>
          {open === m.id && <Tools id={m.id} />}
        </Card>
      ))}
    </div>
  );
}
