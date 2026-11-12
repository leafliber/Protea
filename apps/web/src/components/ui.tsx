import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

export function StateBadge({ state, title }: { state: string; title?: string }) {
  return (
    <Badge tone={stateTone(state)} {...(title ? { title } : {})}>
      {state}
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
export function Modal({ title, actions, onClose, children }: { title: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode }) {
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
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={box}>
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
