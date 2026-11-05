import { useEffect, useState, type FormEvent } from 'react';
import type { ControlRole, StatusResponse, WhoAmIResponse } from '@protea/protocol';
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
import { Providers } from './pages/Providers';
import { Setup } from './pages/Setup';
import { Sessions } from './pages/Sessions';
import { Skills } from './pages/Skills';

const PAGES: Array<[string, string]> = [
  ['overview', '总览'],
  ['events', '事件流'],
  ['sessions', '会话'],
  ['plugins', '插件'],
  ['providers', '模型'],
  ['mcp', 'MCP'],
  ['skills', 'Skills'],
  ['approvals', '审批'],
  ['memory', '记忆与人格'],
  ['config', '配置'],
  ['logs', '日志'],
];

function Login({ onDone }: { onDone: (me: WhoAmIResponse) => void }) {
  const [withToken, setWithToken] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<WhoAmIResponse>('POST', '/api/auth/login', withToken ? { token } : { username, password });
      setToken('');
      setPassword('');
      onDone(r);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? withToken
            ? '令牌不对'
            : '用户名或密码不对'
          : err instanceof ApiError && err.status === 429
            ? '失败次数太多，请一分钟后再试'
            : err instanceof Error
              ? err.message
              : String(err),
      );
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
        {withToken ? (
          <>
            <p className="muted">
              用 API 令牌登录：管理员令牌在数据卷的 <code>secrets/PROTEA_ADMIN_TOKEN</code>，只读令牌是 <code>PROTEA_READONLY_TOKEN</code>。
            </p>
            <input type="password" autoFocus autoComplete="off" placeholder="令牌" value={token} onChange={(e) => setToken(e.target.value)} />
          </>
        ) : (
          <>
            <input autoFocus autoComplete="username" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input type="password" autoComplete="current-password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}
        <Button kind="primary" type="submit" busy={busy} disabled={withToken ? !token.trim() : !username.trim() || !password}>
          登录
        </Button>
        <ErrorText error={error} />
        <div className="row small">
          <button type="button" className="link" onClick={() => setWithToken(!withToken)}>
            {withToken ? '用账号密码登录' : '改用 API 令牌登录'}
          </button>
          <span className="spacer" />
          <span className="muted" title="在服务器上重设密码">
            忘记密码：<code>protea accounts passwd 用户名</code>
          </span>
        </div>
      </form>
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = { idle: '空闲', model: '思考中', tools: '运行工具', backoff: '模型不可用，重试中', draining: '收尾中' };

function Header({ status, me, onLogout }: { status: StatusResponse | undefined; me: WhoAmIResponse; onLogout: () => void }) {
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
      <span className="badge badge-muted" title={me.username ? `账号 ${me.username}` : '用 API 令牌登录'}>
        {me.username ?? (me.role === 'admin' ? '管理员令牌' : '只读令牌')} · {me.role === 'admin' ? '管理员' : '只读'}
      </span>
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

function Shell({ me, onLogout }: { me: WhoAmIResponse; onLogout: () => void }) {
  const role: ControlRole = me.role;
  const { page, params } = useRoute();
  const { status, reload } = useStatus();
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, []);
  const pending = status ? Object.values(status.pending).reduce((a, b) => a + b, 0) : 0;
  return (
    <SessionContext.Provider value={{ role, canWrite: role === 'admin', ...(me.username ? { username: me.username } : {}) }}>
      <Header status={status} me={me} onLogout={onLogout} />
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
          {page === 'providers' && <Providers />}
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
  // undefined: loading; null: signed out (the setup page when no admin account exists yet).
  const [me, setMe] = useState<WhoAmIResponse | null | undefined>(undefined);
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    api<WhoAmIResponse>('GET', '/api/auth/whoami').then(
      (r) => setMe(r),
      () => {
        api<{ required: boolean }>('GET', '/api/setup').then(
          (s) => setSetup(s.required),
          () => setSetup(false),
        );
        setMe(null);
      },
    );
    return onUnauthorized(() => setMe(null));
  }, []);
  if (me === undefined) return <div className="empty">加载中…</div>;
  if (setup)
    return (
      <Setup
        onDone={(m) => {
          setSetup(false);
          setMe(m);
          go('overview');
        }}
      />
    );
  if (me === null) return <Login onDone={setMe} />;
  return (
    <Shell
      me={me}
      onLogout={() => {
        live.stop();
        void post('/api/auth/logout').finally(() => setMe(null));
      }}
    />
  );
}
