import { useEffect, useState, type FormEvent } from 'react';
import type { ControlRole, StatusResponse } from '@protea/protocol';
import { ApiError, api, onUnauthorized, post } from './api';
import { Button, ErrorText, cx } from './components/ui';
import { live, useLiveState } from './live';
import { SessionContext, go, useRoute, useStatus } from './session';
import { Approvals } from './pages/Approvals';
import { Config } from './pages/Config';
import { Events } from './pages/Events';
import { Logs } from './pages/Logs';
import { Mcp } from './pages/Mcp';
import { Memory } from './pages/Memory';
import { Overview } from './pages/Overview';
import { Plugins } from './pages/Plugins';
import { Sessions } from './pages/Sessions';
import { Skills } from './pages/Skills';

const PAGES: Array<[string, string]> = [
  ['overview', '总览'],
  ['events', '事件流'],
  ['sessions', '会话'],
  ['plugins', '插件'],
  ['mcp', 'MCP'],
  ['skills', 'Skills'],
  ['approvals', '审批'],
  ['memory', '记忆与人格'],
  ['config', '配置'],
  ['logs', '日志'],
];

function Login({ onDone }: { onDone: (role: ControlRole) => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ role: ControlRole }>('POST', '/api/auth/login', { token });
      setToken('');
      onDone(r.role);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? '令牌不对' : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card login-card" onSubmit={(e) => void submit(e)}>
        <h1>
          <img src="./favicon.svg" alt="" width="28" height="28" /> Protea
        </h1>
        <p className="muted">
          输入管理员令牌登录。令牌在数据卷的 <code>secrets/PROTEA_ADMIN_TOKEN</code>，或环境变量 <code>PROTEA_ADMIN_TOKEN</code>。
          也可以用只读令牌（<code>PROTEA_READONLY_TOKEN</code>）只看不改。
        </p>
        <input type="password" autoFocus autoComplete="current-password" placeholder="令牌" value={token} onChange={(e) => setToken(e.target.value)} />
        <Button kind="primary" type="submit" busy={busy} disabled={!token.trim()}>
          登录
        </Button>
        <ErrorText error={error} />
      </form>
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = { idle: '空闲', model: '思考中', tools: '运行工具', backoff: '模型不可用，重试中', draining: '收尾中' };

function Header({ status, role, onLogout }: { status: StatusResponse | undefined; role: ControlRole; onLogout: () => void }) {
  const ws = useLiveState();
  const phase = status?.phase ?? 'idle';
  return (
    <header className="topbar">
      <div className="brand" onClick={() => go('overview')}>
        <img src="./favicon.svg" alt="" width="22" height="22" />
        <span>Protea</span>
      </div>
      <div className={cx('phase', `phase-${phase}`)} title={status?.batchId ?? ''}>
        <span className="lamp" />
        {PHASE_LABEL[phase] ?? phase}
      </div>
      {status?.scheduler.paused && <span className="badge badge-bad">投递已暂停</span>}
      <div className="spacer" />
      <span className={cx('ws', `ws-${ws}`)} title="实时连接">
        {ws === 'open' ? '实时' : ws === 'connecting' ? '连接中' : '已断开'}
      </span>
      {status && <span className="muted small">{status.version} · run {status.runId.slice(-6)}</span>}
      <span className="badge badge-muted">{role === 'admin' ? '管理员' : '只读'}</span>
      <Button kind="ghost" small onClick={onLogout}>
        退出
      </Button>
    </header>
  );
}

/** Plain HTTP to a non-local host sends the session cookie and everything else in the clear. */
function RiskBanner() {
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) || location.hostname.endsWith('.localhost');
  if (location.protocol === 'https:' || local) return null;
  return (
    <div className="risk">
      这个连接没有加密（HTTP，非本机）：令牌、对话和记忆都以明文传输。请放在 TLS 反向代理后面，或只在本机 / 内网 VPN 里访问。
    </div>
  );
}

function Shell({ role, onLogout }: { role: ControlRole; onLogout: () => void }) {
  const { page, params } = useRoute();
  const { status, reload } = useStatus();
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, []);
  const pending = status ? Object.values(status.pending).reduce((a, b) => a + b, 0) : 0;
  return (
    <SessionContext.Provider value={{ role, canWrite: role === 'admin' }}>
      <Header status={status} role={role} onLogout={onLogout} />
      <RiskBanner />
      <div className="layout">
        <nav className="nav">
          {PAGES.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={cx('nav-item', page === id && 'nav-on')}>
              {label}
              {id === 'events' && pending > 0 && <span className="nav-count">{pending}</span>}
            </a>
          ))}
        </nav>
        <main className="main">
          {page === 'overview' && <Overview status={status} reload={reload} />}
          {page === 'events' && <Events params={params} />}
          {page === 'sessions' && <Sessions status={status} params={params} />}
          {page === 'plugins' && <Plugins params={params} />}
          {page === 'mcp' && <Mcp />}
          {page === 'skills' && <Skills />}
          {page === 'approvals' && <Approvals />}
          {page === 'memory' && <Memory params={params} />}
          {page === 'config' && <Config />}
          {page === 'logs' && <Logs params={params} />}
          {!PAGES.some(([id]) => id === page) && <div className="empty">没有这个页面</div>}
        </main>
      </div>
    </SessionContext.Provider>
  );
}

export function App() {
  const [role, setRole] = useState<ControlRole | null | undefined>(undefined);
  useEffect(() => {
    api<{ role: ControlRole }>('GET', '/api/auth/whoami').then(
      (r) => setRole(r.role),
      () => setRole(null),
    );
    return onUnauthorized(() => setRole(null));
  }, []);
  if (role === undefined) return <div className="empty">加载中…</div>;
  if (role === null) return <Login onDone={setRole} />;
  return (
    <Shell
      role={role}
      onLogout={() => {
        live.stop();
        void post('/api/auth/logout').finally(() => setRole(null));
      }}
    />
  );
}
