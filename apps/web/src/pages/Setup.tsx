import { useState, type FormEvent } from 'react';
import type { ProvidersResponse, WhoAmIResponse } from '@protea/protocol';
import { ApiError, api, useApi } from '../api';
import { Button, Empty, ErrorText, Field } from '../components/ui';
import { ProviderEditor } from './Providers';

function Steps({ step }: { step: number }) {
  const names = ['创建管理员账号', '配置模型供应商', '完成'];
  return (
    <div className="steps">
      {names.map((n, i) => (
        <span key={n} className={i + 1 === step ? 'step step-on' : i + 1 < step ? 'step step-done' : 'step'}>
          {i + 1}. {n}
        </span>
      ))}
    </div>
  );
}

function AccountStep({ onDone }: { onDone: (me: WhoAmIResponse) => void }) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) {
      setError('两次输入的密码不一样');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await api<WhoAmIResponse>('POST', '/api/setup', { code, username, password }));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'bad_code' ? '设置码不对。它在守护进程启动时打印在日志里（docker logs protea），也保存在数据卷的 secrets/PROTEA_SETUP_CODE。' : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      <p className="muted">
        第一次使用：用守护进程启动时打印的<b>设置码</b>创建管理员账号。看设置码：<code>docker logs protea</code>，或 <code>docker exec protea protea setup</code>。账号建好后设置码作废。
      </p>
      <Field label="设置码">
        <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" required />
      </Field>
      <Field label="用户名" hint="字母、数字、. _ -">
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      </Field>
      <Field label="密码" hint="至少 8 个字符">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
      </Field>
      <Field label="再输一次密码">
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" minLength={8} required />
      </Field>
      <Button kind="primary" type="submit" busy={busy}>
        创建账号
      </Button>
      <ErrorText error={error} />
    </form>
  );
}

function ProviderStep({ onDone }: { onDone: (skipped: boolean) => void }) {
  const r = useApi<ProvidersResponse>('/api/providers');
  if (!r.data) return r.error ? <ErrorText error={r.error} /> : <Empty>加载中…</Empty>;
  return (
    <div className="form-grid">
      <p className="muted">选一个模型供应商，填上接口地址、API Key 和模型名，先点"测试连接"确认能用。以后可以在「模型」页随时增加、切换或按角色分配。</p>
      <ProviderEditor view={r.data} initial={null} compact onSaved={() => onDone(false)} />
      <button type="button" className="link small" onClick={() => onDone(true)}>
        跳过，稍后在「模型」页设置
      </button>
    </div>
  );
}

/** First run: the admin account (with the setup code), then a model provider. */
export function Setup({ onDone }: { onDone: (me: WhoAmIResponse) => void }) {
  const [step, setStep] = useState(1);
  const [me, setMe] = useState<WhoAmIResponse | null>(null);
  const [skipped, setSkipped] = useState(false);
  return (
    <div className="login">
      <div className="card login-card setup-card">
        <h1>
          <img src="./favicon.svg" alt="" width="28" height="28" /> Protea 初始化
        </h1>
        <Steps step={step} />
        {step === 1 && (
          <AccountStep
            onDone={(m) => {
              setMe(m);
              setStep(2);
            }}
          />
        )}
        {step === 2 && (
          <ProviderStep
            onDone={(s) => {
              setSkipped(s);
              setStep(3);
            }}
          />
        )}
        {step === 3 && me && (
          <div className="form-grid">
            <p>
              管理员账号 <b>{me.username}</b> 已创建{skipped ? '。模型供应商还没配置，Protea 暂时不能回答消息。' : '，模型供应商已配置。'}
            </p>
            <p className="muted small">CLI 和脚本仍用 API 令牌（容器里的 protea 命令会自动读取），网页用账号登录。</p>
            <Button kind="primary" onClick={() => onDone(me)}>
              进入控制台
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
