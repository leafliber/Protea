import { useEffect, useState, type FormEvent } from 'react';
import type { WhoAmIResponse } from '@protea/protocol';
import { ApiError, api, onUnauthorized, post } from './api';
import { Button, ErrorText } from './components/ui';
import { ConsoleShell } from './Console';
import { live } from './live';
import { SessionContext, goChat, useRoute, useStatus } from './session';
import { ChatApp } from './pages/Chat';
import { Setup } from './pages/Setup';

function Login({ onDone }: { onDone: (me: WhoAmIResponse) => void }) {
  const [withToken, setWithToken] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = '登录 · Protea';
  }, []);
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
        <div className="login-brand">
          <img src="./favicon.svg" alt="" width="40" height="40" />
          <h1>Protea</h1>
          <p className="muted">登录后继续对话</p>
        </div>
        {withToken ? (
          <>
            <p className="muted small">
              用 API 令牌登录：管理员令牌在数据卷的 <code>secrets/PROTEA_ADMIN_TOKEN</code>，只读令牌是 <code>PROTEA_READONLY_TOKEN</code>。
            </p>
            <input type="password" autoFocus autoComplete="off" placeholder="令牌" aria-label="令牌" value={token} onChange={(e) => setToken(e.target.value)} />
          </>
        ) : (
          <>
            <input autoFocus autoComplete="username" placeholder="用户名" aria-label="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input type="password" autoComplete="current-password" placeholder="密码" aria-label="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}
        <Button kind="primary" type="submit" busy={busy} disabled={withToken ? !token.trim() : !username.trim() || !password}>
          登录
        </Button>
        <ErrorText error={error} />
        <div className="login-foot small">
          <button type="button" className="link" onClick={() => setWithToken(!withToken)}>
            {withToken ? '用账号密码登录' : '改用 API 令牌登录'}
          </button>
          <span className="muted" title="在服务器上重设密码">
            忘记密码：<code>protea accounts passwd 用户名</code>
          </span>
        </div>
      </form>
    </div>
  );
}

/** Plain HTTP to a non-local host sends the session cookie and everything else in the clear. */
function RiskBanner() {
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) || location.hostname.endsWith('.localhost');
  if (location.protocol === 'https:' || local) return null;
  return <div className="risk">这个连接没有加密（HTTP，非本机）：对话、令牌和记忆都以明文传输。请放在 TLS 反向代理后面，或只在本机 / 内网 VPN 里访问。</div>;
}

/** Signed in: the conversation at `#/`, the console under `#/console/…`. */
function SignedIn({ me, onLogout }: { me: WhoAmIResponse; onLogout: () => void }) {
  const { mode, page, params } = useRoute();
  const { status, reload } = useStatus();
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, []);
  return (
    <SessionContext.Provider value={{ role: me.role, canWrite: me.role === 'admin', ...(me.username ? { username: me.username } : {}) }}>
      <div className={mode === 'chat' ? 'app app-chat' : 'app app-console'}>
        <RiskBanner />
        {mode === 'chat' ? <ChatApp me={me} status={status} onLogout={onLogout} /> : <ConsoleShell me={me} page={page} params={params} status={status} reload={reload} onLogout={onLogout} />}
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
        }}
      />
    );
  if (me === null) return <Login onDone={setMe} />;
  return (
    <SignedIn
      me={me}
      onLogout={() => {
        live.stop();
        void post('/api/auth/logout').finally(() => {
          setMe(null);
          goChat();
        });
      }}
    />
  );
}
