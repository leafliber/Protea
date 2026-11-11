import { useEffect, useRef, useState } from 'react';
import { Button, ErrorText } from './ui';

type Schema = Record<string, unknown>;

function typeOf(s: Schema): string {
  const t = s['type'];
  if (Array.isArray(t)) return String(t.find((x) => x !== 'null') ?? 'string');
  if (typeof t === 'string') return t;
  if (Array.isArray(s['enum'])) return 'enum';
  return 'json';
}

/** Is this property simple enough for a form control (otherwise it is edited as JSON)? */
function simple(s: Schema): boolean {
  const t = typeOf(s);
  if (['string', 'number', 'integer', 'boolean'].includes(t) || Array.isArray(s['enum'])) return true;
  if (t === 'array') {
    const items = (s['items'] ?? {}) as Schema;
    return typeOf(items) === 'string' && !Array.isArray(items['enum']);
  }
  return false;
}

/** A config object as text that does not depend on the order of its top-level keys. */
function canon(o: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}

/** Does this JSON text say something other than the saved config (`base`, from `canon`)? Text that does not parse counts as a change. */
function differs(raw: string, base: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || canon(parsed as Record<string, unknown>) !== base;
  } catch {
    return true;
  }
}

/**
 * A form generated from a plugin's JSON Schema (top-level properties). Complex properties get
 * a JSON box; `x-hot: false` keys are marked (changing them reloads the plugin); `x-secret`
 * keys expect a `${secret:NAME}` reference. "JSON" switches to editing the whole object.
 * `onDirtyChange` reports whether there are edits that have not been saved.
 */
export function SchemaForm({
  schema,
  value,
  coldKeys,
  onSave,
  readOnly,
  onDirtyChange,
}: {
  schema: Schema | null;
  value: Record<string, unknown>;
  coldKeys: string[];
  onSave: (config: Record<string, unknown>) => Promise<unknown>;
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const props = ((schema?.['properties'] ?? {}) as Record<string, Schema>) || {};
  const required = new Set((schema?.['required'] as string[] | undefined) ?? []);
  const [draft, setDraft] = useState<Record<string, unknown>>(value);
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  const [mode, setMode] = useState<'form' | 'json'>(schema && Object.keys(props).length > 0 ? 'form' : 'json');
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The saved config is refetched whenever any plugin changes; only a different config replaces the edits.
  const base = canon(value);
  useEffect(() => {
    setDraft(value);
    setRaw(JSON.stringify(value, null, 2));
  }, [base]);

  const dirty = !readOnly && (mode === 'json' ? differs(raw, base) : canon(draft) !== base || Object.keys(jsonErrors).length > 0);
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);

  const set = (k: string, v: unknown) => {
    setSaved(false);
    setDraft((d) => {
      const next = { ...d };
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let cfg = draft;
      if (mode === 'json') {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('配置必须是一个 JSON 对象');
        cfg = parsed as Record<string, unknown>;
      } else if (Object.keys(jsonErrors).length > 0) {
        throw new Error(`修正 JSON 字段：${Object.keys(jsonErrors).join(', ')}`);
      }
      await onSave(cfg);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const extraKeys = Object.keys(draft).filter((k) => !(k in props));

  return (
    <div className="schema-form">
      <div className="row">
        <button className={`tab ${mode === 'form' ? 'tab-on' : ''}`} disabled={!schema} onClick={() => setMode('form')}>
          表单
        </button>
        <button
          className={`tab ${mode === 'json' ? 'tab-on' : ''}`}
          onClick={() => {
            setRaw(JSON.stringify(draft, null, 2));
            setMode('json');
          }}
        >
          JSON
        </button>
        {!schema && <span className="muted small">这个插件没有配置 schema，只能按 JSON 编辑</span>}
      </div>
      {mode === 'json' ? (
        <textarea className="mono" rows={14} value={raw} spellCheck={false} readOnly={readOnly} onChange={(e) => (setRaw(e.target.value), setSaved(false))} />
      ) : (
        <div className="form-grid">
          {Object.entries(props).map(([k, s]) => {
            const t = typeOf(s);
            const v = draft[k];
            const label = (
              <span className="field-label">
                {k}
                {required.has(k) && <span className="req">*</span>}
                {coldKeys.includes(k) && <span className="tag-cold" title="改动会重载插件">重载</span>}
              </span>
            );
            const hint = [s['description'] as string | undefined, s['x-secret'] === true ? '用 ${secret:NAME} 引用秘密' : undefined, s['default'] !== undefined ? `默认 ${JSON.stringify(s['default'])}` : undefined]
              .filter(Boolean)
              .join(' · ');
            let control;
            if (!simple(s)) {
              control = (
                <textarea
                  className="mono"
                  rows={4}
                  spellCheck={false}
                  readOnly={readOnly}
                  defaultValue={v === undefined ? '' : JSON.stringify(v, null, 2)}
                  onChange={(e) => {
                    const text = e.target.value.trim();
                    try {
                      set(k, text === '' ? undefined : (JSON.parse(text) as unknown));
                      setJsonErrors(({ [k]: _drop, ...rest }) => rest);
                    } catch {
                      setJsonErrors((m) => ({ ...m, [k]: 'invalid' }));
                    }
                  }}
                />
              );
            } else if (Array.isArray(s['enum'])) {
              control = (
                <select disabled={readOnly} value={v === undefined ? '' : JSON.stringify(v)} onChange={(e) => set(k, e.target.value === '' ? undefined : (JSON.parse(e.target.value) as unknown))}>
                  <option value="">（默认）</option>
                  {(s['enum'] as unknown[]).map((o) => (
                    <option key={JSON.stringify(o)} value={JSON.stringify(o)}>
                      {String(o)}
                    </option>
                  ))}
                </select>
              );
            } else if (t === 'boolean') {
              control = (
                <select disabled={readOnly} value={v === undefined ? '' : String(v)} onChange={(e) => set(k, e.target.value === '' ? undefined : e.target.value === 'true')}>
                  <option value="">（默认）</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              );
            } else if (t === 'number' || t === 'integer') {
              control = (
                <input
                  type="number"
                  readOnly={readOnly}
                  step={t === 'integer' ? 1 : 'any'}
                  value={v === undefined ? '' : String(v)}
                  onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))}
                />
              );
            } else if (t === 'array') {
              control = (
                <textarea
                  rows={3}
                  readOnly={readOnly}
                  value={Array.isArray(v) ? (v as unknown[]).join('\n') : ''}
                  placeholder="每行一项"
                  onChange={(e) => set(k, e.target.value === '' ? undefined : e.target.value.split('\n').filter((x) => x.trim() !== ''))}
                />
              );
            } else {
              control = <input type="text" readOnly={readOnly} value={v === undefined ? '' : String(v)} onChange={(e) => set(k, e.target.value === '' ? undefined : e.target.value)} />;
            }
            return (
              <label key={k} className="field">
                {label}
                {control}
                {jsonErrors[k] && <span className="error-text">JSON 无效</span>}
                {hint && <span className="field-hint">{hint}</span>}
              </label>
            );
          })}
          {extraKeys.length > 0 && <div className="muted small">schema 之外的键（保留）：{extraKeys.join(', ')}</div>}
        </div>
      )}
      {!readOnly && (
        <div className="row">
          <Button kind="primary" onClick={() => void save()} busy={busy}>
            校验并保存
          </Button>
          {saved && <span className="muted">已保存并应用</span>}
          <ErrorText error={error} />
        </div>
      )}
    </div>
  );
}
