import { useState, type FormEvent, type ReactNode } from 'react';
import type { LogRecord, PluginLoginView, PluginStatus } from '@protea/protocol';
import { api, enc, post, qs, useAction, useApi } from '../api';
import { SchemaForm } from '../components/SchemaForm';
import { Badge, Button, PageActions, Card, Empty, ErrorText, KV, Modal, StateBadge, Tabs, cx, oneLine, useAsk } from '../components/ui';
import { useReloadOn } from '../live';
import { PendingChangesBanner } from './Changes';
import { go, useSession } from '../session';
import { visiblePlugins } from '../view-logic';
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

const LOGIN_TEXT: Record<PluginLoginView['state'], string> = {
  idle: '还没有登录。',
  waiting: '用手机扫描这个二维码。',
  scanned: '已扫描，请在手机上确认。',
  need_code: '输入手机上显示的数字。',
  connected: '已登录',
  already_bound: '这个账号已经连接过，这次没有下发新的登录凭据。',
  failed: '登录没有完成。',
  unavailable: '插件没有运行，启用后才能登录。',
};

function LoginPanel({ id }: { id: string }) {
  const ask = useAsk();
  const { canWrite } = useSession();
  const view = useApi<PluginLoginView>(`/api/plugins/${enc(id)}/login`, { refreshMs: 2000 });
  const act = useAction();
  const [code, setCode] = useState('');
  const base = `/api/plugins/${enc(id)}/login`;
  const run = (fn: () => Promise<unknown>) => void act.run(fn).then(() => view.reload());
  const v = view.data;
  if (!v) return <ErrorText error={view.error} />;
  const inProgress = v.state === 'waiting' || v.state === 'scanned' || v.state === 'need_code';
  return (
    <div className="form-grid">
      <div>
        {LOGIN_TEXT[v.state]}
        {v.state === 'connected' && v.account ? `：${v.account}` : ''}
      </div>
      {v.message && <div className="muted small">{v.message}</div>}
      {v.qr && <img className="login-qr" alt="登录二维码" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.qr.svg)}`} />}
      {v.expiresAt && inProgress && <div className="muted small">二维码有效期至 {new Date(v.expiresAt).toLocaleTimeString()}，过期后会自动刷新。</div>}
      <ErrorText error={act.error} />
      {canWrite && v.state === 'need_code' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => post(`${base}/code`, { code }));
            setCode('');
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="手机上显示的数字" />
          <Button kind="primary" type="submit" busy={act.busy} disabled={!code.trim()}>
            提交
          </Button>
        </form>
      )}
      {canWrite && v.state !== 'unavailable' && (
        <div className="row">
          {!inProgress && (
            <Button kind="primary" busy={act.busy} onClick={() => run(() => post(base))}>
              {v.state === 'connected' ? '重新扫码' : '扫码登录'}
            </Button>
          )}
          {inProgress && <Button onClick={() => run(() => post(`${base}/cancel`))}>取消</Button>}
          {v.state === 'connected' && (
            <Button kind="danger" onClick={() => ask('退出这个平台的登录？', () => run(() => api('DELETE', base)), { body: '登录凭据和这个平台上的主人身份都会清除。', confirm: '退出登录' })}>
              退出登录
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The kinds the plugin host runs, in tab order. Any other kind a manifest claims gets a tab of its own. */
const KINDS: readonly string[] = ['source', 'connector', 'tool'];
const KIND_LABEL: Record<string, string> = { source: '事件源', connector: '连接器', tool: '工具', unknown: '未识别' };
const KIND_HINT: Record<string, string> = {
  source: '事件源把外部发生的事（定时、邮件、订阅、文件变化、Webhook）作为事件推给助理。',
  connector: '连接器是聊天平台：既推送事件，也把助理的回复发出去。',
  tool: '工具插件只提供助理可以调用的工具，不推送事件。',
};
const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;

const SHOW_DISABLED_KEY = 'protea.plugins.showDisabled';
function readShowDisabled(): boolean {
  try {
    return localStorage.getItem(SHOW_DISABLED_KEY) === '1';
  } catch {
    return false;
  }
}

type DetailTab = 'login' | 'config' | 'logs' | 'manifest';

/** One plugin in a dialog of its own: actions, facts, then sign-in, config, logs and manifest. */
function PluginModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const ask = useAsk();
  const { canWrite } = useSession();
  const [picked, setTab] = useState<DetailTab | null>(null);
  const [dirty, setDirty] = useState(false);
  const p = useApi<PluginStatus & { manifest: Record<string, unknown> | null }>(`/api/plugins/${enc(id)}`);
  const cfg = useApi<{ config: Record<string, unknown>; schema: Record<string, unknown> | null; coldKeys: string[] }>(`/api/plugins/${enc(id)}/config`);
  const logs = useApi<{ logs: LogRecord[] }>(picked === 'logs' ? `/api/plugins/${enc(id)}/logs${qs({ limit: 300 })}` : null, { refreshMs: 5000 });
  useReloadOn('plugin', () => {
    p.reload();
    cfg.reload();
  });
  const act = useAction();
  const action = (a: string) => void act.run(() => post(`/api/plugins/${enc(id)}/${a}`)).then(() => (p.reload(), onChanged()));
  const close = () => {
    if (!dirty) onClose();
    else ask('放弃还没保存的修改？', onClose, { body: '配置有还没保存的修改，关闭后会丢失。', confirm: '放弃修改' });
  };
  const s = p.data;
  if (!s)
    return (
      <Modal title={id} onClose={onClose}>
        {p.error ? <ErrorText error={p.error} /> : <div className="muted">加载中…</div>}
      </Modal>
    );
  const m = s.manifest ?? {};
  const hasLogin = m['login'] !== undefined;
  const tab = picked ?? (hasLogin ? 'login' : 'config');
  return (
    <Modal
      title={
        <>
          {String(m['displayName'] ?? s.id)} <StateBadge state={s.state} />
        </>
      }
      onClose={close}
      actions={
        canWrite && (
          <>
            {s.enabled ? <Button small onClick={() => action('disable')}>禁用</Button> : <Button small kind="primary" onClick={() => action('enable')}>启用</Button>}
            <Button small onClick={() => action('reload')} title="重新读取清单与配置并重启">重载</Button>
            {s.tools.length > 0 && (
              <Button small kind="ghost" title="按需加载：工具多时不随每次请求发送定义，助理用到时再取。插件不重启，下一次请求生效。" onClick={() => action(s.alwaysLoad ? 'on-demand' : 'always-load')}>
                {s.alwaysLoad ? '改为按需加载' : '改为始终加载'}
              </Button>
            )}
            {(s.state === 'failed' || s.state === 'crashed') && <Button small onClick={() => action('restart')}>重启</Button>}
            {s.origin === 'data' && (
              <Button
                small
                kind="danger"
                onClick={() =>
                  ask(
                    `卸载插件 ${s.id}？`,
                    () =>
                      void act.run(() => api('DELETE', `/api/plugins/${enc(id)}`)).then((ok) => {
                        onChanged();
                        if (ok) onClose();
                      }),
                    { body: '需要先禁用。插件的数据默认一并删除。', confirm: '卸载' },
                  )
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
          ['类型', `${kindLabel(s.kind)} · ${s.origin}${s.version ? ` · v${s.version}` : ''}`],
          ['说明', String(m['description'] ?? '—')],
          ['工具', s.tools.length ? s.tools.join(', ') : '—'],
          ...(s.tools.length ? [['加载', s.alwaysLoad ? '始终加载' : s.deferredTools ? `按需加载（现有 ${s.deferredTools} 个按需）` : '可按需加载（工具不多时仍随请求发送）'] as [string, string]] : []),
          ['进程', s.pid ? `pid ${s.pid}${s.restarts ? ` · 重启 ${s.restarts} 次` : ''}` : '—'],
          ...(Array.isArray(m['secrets']) && (m['secrets'] as string[]).length ? ([['需要的秘密', (m['secrets'] as string[]).join(', ')]] as Array<[string, string]>) : []),
        ]}
      />
      <Tabs
        tabs={[
          ...(hasLogin ? ([['login', '登录']] as Array<[DetailTab, string]>) : []),
          ['config', dirty ? '配置 •' : '配置'],
          ['logs', '日志'],
          ['manifest', '清单'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'login' && <LoginPanel id={id} />}
      {/* Stays mounted while another tab is shown, so edits survive a look at the logs. */}
      <div hidden={tab !== 'config'}>
        {cfg.data ? (
          <SchemaForm
            schema={cfg.data.schema}
            value={cfg.data.config}
            coldKeys={cfg.data.coldKeys}
            readOnly={!canWrite}
            onDirtyChange={setDirty}
            onSave={async (config) => {
              await api('PATCH', `/api/plugins/${enc(id)}/config`, { config });
              cfg.reload();
              p.reload();
            }}
          />
        ) : (
          <ErrorText error={cfg.error} />
        )}
      </div>
      {tab === 'logs' && (logs.data ? <LogLines logs={logs.data.logs} /> : <ErrorText error={logs.error} />)}
      {tab === 'manifest' && <pre className="json">{JSON.stringify(m, null, 2)}</pre>}
    </Modal>
  );
}

export function Plugins({ params }: { params: URLSearchParams }) {
  const { canWrite } = useSession();
  const list = useApi<{ plugins: PluginStatus[] }>('/api/plugins');
  useReloadOn('plugin', list.reload);
  const [showInstall, setShowInstall] = useState(false);
  const plugins = list.data?.plugins ?? [];
  const kinds = [...KINDS, ...[...new Set(plugins.map((p) => p.kind))].filter((k) => !KINDS.includes(k)).sort()];
  const asked = params.get('kind');
  const kind = asked !== null && kinds.includes(asked) ? asked : 'all';
  const [showDisabled, setShowDisabled] = useState(readShowDisabled);
  const toggleDisabled = () => {
    const next = !showDisabled;
    setShowDisabled(next);
    try {
      localStorage.setItem(SHOW_DISABLED_KEY, next ? '1' : '0');
    } catch {
      // Storage is unavailable: the choice lasts until the page is reloaded.
    }
  };
  const disabled = plugins.filter((p) => !p.enabled).length;
  const disabledHere = plugins.filter((p) => !p.enabled && (kind === 'all' || p.kind === kind)).length;
  const listed = visiblePlugins(plugins, showDisabled);
  const shown = kind === 'all' ? listed : listed.filter((p) => p.kind === kind);
  const selected = params.get('id');
  /** This page on the tab `k`, with a plugin's dialog open when `id` is given. */
  const open = (k: string, id?: string) => go('plugins', { ...(k !== 'all' ? { kind: k } : {}), ...(id !== undefined ? { id } : {}) });
  const count = (k: string) => (k === 'all' ? listed.length : listed.filter((p) => p.kind === k).length);
  const disabledToggle = disabled > 0 && (
    <button type="button" className="link-btn small" onClick={toggleDisabled}>
      {showDisabled ? '隐藏已禁用' : `显示已禁用（${disabled}）`}
    </button>
  );
  return (
    <div className="page">
      <PageActions>{canWrite && <Button kind="primary" onClick={() => setShowInstall((x) => !x)}>{showInstall ? '收起' : '安装插件'}</Button>}</PageActions>
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
      <PendingChangesBanner kind="plugin" />
      <ErrorText error={list.error} />
      <Tabs
        tabs={['all', ...kinds].map((k): [string, ReactNode] => [
          k,
          <>
            {k === 'all' ? '全部' : kindLabel(k)}
            {list.data && <span className="tab-count">{count(k)}</span>}
          </>,
        ])}
        value={kind}
        onChange={(k) => open(k)}
      />
      <div className="cards">
        {shown.map((p) => (
          <button key={p.id} className={cx('plugin-card', selected === p.id && 'selected')} onClick={() => open(kind, p.id)}>
            <div className="row">
              <strong className="grow">{p.id}</strong>
              <StateBadge state={p.enabled ? p.state : 'disabled'} />
            </div>
            <div className="muted small">{[kind === 'all' ? kindLabel(p.kind) : null, p.origin, p.version ? `v${p.version}` : null].filter(Boolean).join(' · ')}</div>
            <div className="small">
              {p.tools.length} 个工具{p.deferredTools ? `（${p.deferredTools} 个按需加载）` : ''}{p.restarts ? <Badge tone="warn">重启 {p.restarts}</Badge> : null}
            </div>
            {p.error && <div className="error-text small">{oneLine(p.error, 90)}</div>}
          </button>
        ))}
      </div>
      {list.data && shown.length === 0 && (
        <Empty>
          {kind === 'all' ? '没有插件' : `没有${kindLabel(kind)}插件`}
          {!showDisabled && disabledHere > 0 ? `在用，另有 ${disabledHere} 个已禁用` : ''}
        </Empty>
      )}
      <div className="row muted small">
        <span className="grow">{KIND_HINT[kind] ?? '点一个插件，打开它的配置、日志与清单。'}</span>
        {disabledToggle}
      </div>
      {selected && <PluginModal key={selected} id={selected} onClose={() => open(kind)} onChanged={list.reload} />}
    </div>
  );
}
