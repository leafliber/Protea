import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

export function timeAgo(iso: string | number | undefined | null): string {
  if (iso === undefined || iso === null || iso === '') return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

export function clock(iso: string | number): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function dateTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

export function usd(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? '—' : `$${n.toFixed(digits)}`;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'muted'; children: ReactNode; title?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`)} title={title}>
      {children}
    </span>
  );
}

const LEVEL_TONES = ['bad', 'warn', 'info', 'neutral', 'muted'] as const;
export function LevelBadge({ level }: { level: number }) {
  return <Badge tone={LEVEL_TONES[level] ?? 'neutral'}>L{level}</Badge>;
}

export function stateTone(state: string): 'good' | 'warn' | 'bad' | 'info' | 'muted' | 'neutral' {
  if (['running', 'delivered', 'completed', 'approved', 'used', 'listed', 'ready', 'applied'].includes(state)) return 'good';
  if (['failed', 'crashed', 'invalid', 'denied', 'auth_required', 'error', 'rejected'].includes(state)) return 'bad';
  if (['pending', 'starting', 'draining', 'paused', 'queued', 'delivering', 'backoff'].includes(state)) return 'warn';
  if (['withdrawn', 'expired', 'discarded', 'stopped', 'disabled', 'cancelled', 'archived', 'stale'].includes(state)) return 'muted';
  if (['idle'].includes(state)) return 'info';
  return 'neutral';
}

/** States as a person reads them; the raw value stays in the tooltip. */
const STATE_LABEL: Record<string, string> = {
  running: '运行中',
  delivered: '已送达',
  completed: '已完成',
  approved: '已同意',
  used: '已执行',
  listed: '已列出',
  ready: '就绪',
  applied: '已应用',
  failed: '失败',
  crashed: '已崩溃',
  invalid: '无效',
  denied: '已拒绝',
  auth_required: '需要登录',
  error: '出错',
  rejected: '已拒绝',
  pending: '待处理',
  starting: '启动中',
  draining: '收尾中',
  paused: '已暂停',
  queued: '排队中',
  delivering: '送达中',
  backoff: '重试中',
  withdrawn: '已撤回',
  expired: '已过期',
  discarded: '已丢弃',
  stopped: '已停止',
  disabled: '已停用',
  cancelled: '已取消',
  archived: '已归档',
  stale: '已失效',
  idle: '空闲',
  merged: '已合并',
  dropped: '已丢弃',
  loaded: '已加载',
  restarting: '重启中',
  stopping: '停止中',
  interrupted: '被打断',
  preempted: '被抢占',
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

export function StateBadge({ state, title }: { state: string; title?: string }) {
  return (
    <Badge tone={stateTone(state)} title={title ?? state}>
      {stateLabel(state)}
    </Badge>
  );
}

export function Button({
  children,
  onClick,
  busy,
  disabled,
  kind = 'default',
  title,
  type = 'button',
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  kind?: 'default' | 'primary' | 'danger' | 'ghost';
  title?: string;
  type?: 'button' | 'submit';
  small?: boolean;
}) {
  return (
    <button type={type} className={cx('btn', `btn-${kind}`, small && 'btn-small')} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? '…' : children}
    </button>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <div className="error-text">{error}</div> : null;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, ReactNode]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={cx('tab', value === id && 'tab-on')} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/**
 * A centred dialog over the page. Esc, a press on the backdrop and ✕ all call `onClose`, so the
 * caller can refuse (unsaved changes). `actions` sit in the header, before ✕.
 */
export function Modal({ title, actions, onClose, children, small }: { title: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode; small?: boolean }) {
  const close = useRef(onClose);
  close.current = onClose;
  const box = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    box.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, []);
  return (
    // mousedown, not click: a text selection dragged out of a field must not close the dialog.
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className={cx('modal', small && 'modal-small')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={box}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="关闭">
            <IconClose size={18} />
          </button>
          {actions && <div className="modal-actions">{actions}</div>}
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function KV({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A usage ring (context window, budget). */
export function Ring({ value, max, label, warnAt }: { value: number; max: number; label: ReactNode; warnAt?: number }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const r = 36;
  const c = 2 * Math.PI * r;
  const tone = ratio >= 1 ? 'bad' : warnAt !== undefined && value >= warnAt ? 'warn' : 'good';
  return (
    <div className="ring">
      <svg viewBox="0 0 90 90" width="96" height="96" aria-hidden="true">
        <circle cx="45" cy="45" r={r} className="ring-track" />
        <circle cx="45" cy="45" r={r} className={`ring-fill ring-${tone}`} strokeDasharray={`${c * ratio} ${c}`} transform="rotate(-90 45 45)" />
        <text x="45" y="50" textAnchor="middle" className="ring-text">
          {Math.round(ratio * 100)}%
        </text>
      </svg>
      <div className="ring-label">{label}</div>
    </div>
  );
}

export function Bar({ ratio, tone }: { ratio: number | null; tone?: 'good' | 'warn' | 'bad' }) {
  const r = ratio === null ? 0 : Math.max(0, Math.min(1, ratio));
  const t = tone ?? (r >= 1 ? 'bad' : r >= 0.8 ? 'warn' : 'good');
  return (
    <div className="bar">
      <div className={`bar-fill bar-${t}`} style={{ width: `${r * 100}%` }} />
    </div>
  );
}

/** Text editor with save; tracks unsaved changes. */
export function Editor({ value, onSave, readOnly, rows = 22 }: { value: string; onSave: (text: string) => Promise<unknown>; readOnly?: boolean; rows?: number }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setText(value);
    setSaved(false);
  }, [value]);
  const dirty = text !== value;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="editor">
      <textarea
        value={text}
        rows={rows}
        spellCheck={false}
        readOnly={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            if (dirty && !readOnly) void save();
          }
        }}
      />
      {!readOnly && (
        <div className="row">
          <Button kind="primary" onClick={() => void save()} busy={busy} disabled={!dirty}>
            保存
          </Button>
          {dirty && <Button onClick={() => setText(value)}>撤销修改</Button>}
          {saved && !dirty && <span className="muted">已保存</span>}
          <span className="muted small">⌘/Ctrl+S 保存</span>
          <ErrorText error={error} />
        </div>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Where a console page's header actions go (the shell renders the header). */
export const PageActionsContext = createContext<HTMLElement | null>(null);

/** Buttons for the page header, next to the title. */
export function PageActions({ children }: { children: ReactNode }) {
  const el = useContext(PageActionsContext);
  return el ? createPortal(children, el) : null;
}

/** "2 小时后", "3 天后"; past instants read as `timeAgo`. */
export function timeUntil(iso: string | number | undefined | null): string {
  if (iso === undefined || iso === null || iso === '') return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return timeAgo(t);
  if (s < 60) return '不到 1 分钟后';
  if (s < 3600) return `${Math.round(s / 60)} 分钟后`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时后`;
  return `${Math.round(s / 86400)} 天后`;
}

/** Re-render every `ms`, for text that depends on the current time. */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

/** A relative time that keeps itself current; the exact time is in the tooltip. */
export function RelTime({ at, future }: { at: string | number | null | undefined; future?: boolean }) {
  useTick();
  if (at === null || at === undefined || at === '') return <span className="muted">—</span>;
  return (
    <time className="nowrap" title={dateTime(at)}>
      {future ? timeUntil(at) : timeAgo(at)}
    </time>
  );
}

/** Time left until `until`, counting down: "9:41", "2 小时 5 分". */
export function Countdown({ until, done = '已到期' }: { until: string | number; done?: string }) {
  useTick(1000);
  const left = Math.round(((typeof until === 'number' ? until : Date.parse(until)) - Date.now()) / 1000);
  if (!(left > 0)) return <span className="countdown">{done}</span>;
  const text = left >= 3600 ? `${Math.floor(left / 3600)} 小时 ${Math.floor((left % 3600) / 60)} 分` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return <span className={cx('countdown', left < 60 && 'countdown-soon')}>{text}</span>;
}

/** An on/off control. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cx('switch', checked && 'switch-on')}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** A small set of exclusive choices, shown side by side. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: Array<[T, ReactNode]>; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={cx('seg', value === id && 'seg-on')} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** One number that matters, with what it is and a line of context. */
export function Stat({ label, value, hint, tone, href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad'; href?: string }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={cx('stat-value', tone && `stat-${tone}`)}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </>
  );
  return href ? (
    <a className="stat stat-link" href={href}>
      {body}
    </a>
  ) : (
    <div className="stat">{body}</div>
  );
}

/** Nothing here yet: what this place is for, and what to do next. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Placeholder lines while something loads. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="加载中">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** A ⋯ button with a small menu of actions. */
export function Menu({ items, label = '更多操作' }: { items: Array<{ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | null | false>; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="menu" ref={box} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="icon-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="menu-dots" aria-hidden="true">
          ⋯
        </span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.filter(Boolean).map((raw) => {
            const it = raw as { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };
            return (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                className={cx('menu-item', it.danger && 'menu-danger')}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
}

interface Feedback {
  /** Ask before something that cannot be taken back. Resolves to whether the person agreed. */
  confirm(o: ConfirmOptions): Promise<boolean>;
  /** Say briefly that something happened (or failed). */
  toast(text: string, tone?: 'good' | 'bad'): void;
}

const FeedbackContext = createContext<Feedback>({
  confirm: (o) => Promise.resolve(window.confirm(o.title)),
  toast: () => undefined,
});

/** `confirm` and `toast` for a page: `const { confirm, toast } = useFeedback()`. */
export const useFeedback = (): Feedback => useContext(FeedbackContext);

/** Hosts the confirmation dialog and the toasts of everything inside it. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<(ConfirmOptions & { done: (ok: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; tone: 'good' | 'bad' }>>([]);
  const seq = useRef(0);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((done) => setAsk({ ...o, done })), []);
  const toast = useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 6000 : 3000);
  }, []);
  const api = useRef<Feedback>({ confirm, toast });
  const answer = (ok: boolean) => {
    ask?.done(ok);
    setAsk(null);
  };
  return (
    <FeedbackContext.Provider value={api.current}>
      {children}
      {ask && (
        <Modal small title={ask.title} onClose={() => answer(false)}>
          <div className="confirm">
            {ask.body && <div className="confirm-body">{ask.body}</div>}
            <div className="confirm-actions">
              <Button onClick={() => answer(false)}>取消</Button>
              <Button kind={ask.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
                {ask.confirm ?? '确定'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {toasts.length > 0 &&
        createPortal(
          <div className="toasts" role="status" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className={cx('toast', `toast-${t.tone}`)}>
                {t.text}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </FeedbackContext.Provider>
  );
}

/**
 * Ask, then act: `ask('删除这个账号？', () => remove())`. For the common case where a
 * confirmation guards one action. Destructive by default, as most such actions are.
 */
export function useAsk(): (title: string, then: () => unknown, o?: { danger?: boolean; confirm?: string; body?: ReactNode }) => void {
  const { confirm } = useFeedback();
  return useCallback(
    (title, then, o) => {
      void confirm({ title, danger: o?.danger ?? true, ...(o?.confirm ? { confirm: o.confirm } : {}), ...(o?.body ? { body: o.body } : {}) }).then((ok) => {
        if (ok) then();
      });
    },
    [confirm],
  );
}
