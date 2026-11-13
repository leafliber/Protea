import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ModelPriceInfo, ModelPriceRow, ModelRole, ProbeProviderResponse, ProviderProfileInfo, ProviderProtocolName, ProvidersResponse, SpeechTestResponse, SpeechView } from '@protea/protocol';
import { api, enc, post, useAction, useApi } from '../api';
import { Badge, Button, PageActions, Card, Drawer, Empty, ErrorText, Field, cx, useAsk } from '../components/ui';
import { useSession } from '../session';

const ROLES: Array<[ModelRole, string, string]> = [
  ['main', '主会话', '回答你、处理事件的模型'],
  ['fork', '后台 Fork', '后台任务、例程'],
  ['cheap', '轻量', '交接笔记、压缩、分类'],
  ['judge', '判断', 'auto 权限模式下审核工具调用'],
];

const PROTOCOL_HINT: Record<ProviderProtocolName, string> = {
  anthropic: 'Claude 的 Messages API；其他厂商的"Anthropic 兼容"接口也走它（选"基础"特性）',
  'openai-chat': '最通用：OpenAI、DeepSeek、通义、Kimi、GLM、OpenRouter、Ollama、vLLM 等都支持',
  'openai-responses': 'OpenAI 的新接口（/responses）；第三方支持较少',
  echo: '离线开发：不调用任何模型，回显控制台消息',
};

type Draft = Record<string, unknown> & { protocol: ProviderProtocolName; models: Record<ModelRole, string> };

/** A price as typed: text per field, so a half-typed number is not lost. */
type PriceText = { input: string; output: string; cacheRead: string };

const usd = (n: number): string => `$${Number(n.toFixed(4))}`;

/** "输入 $2 · 输出 $10 · 缓存读 $0.2" per million tokens. */
export function priceLine(p: ModelPriceInfo): string {
  const parts = [`输入 ${usd(p.input)}`, `输出 ${usd(p.output)}`, `缓存读 ${usd(p.cacheRead ?? p.input)}`];
  if (p.cacheWrite !== undefined) parts.push(`缓存写 ${usd(p.cacheWrite)}`);
  const tier = p.tiers?.length ? `；超过 ${p.tiers.map((t) => `${Math.round(t.above / 1000)}K`).join('/')} token 另计` : '';
  return `${parts.join(' · ')}${tier}`;
}

function priceText(p: ModelPriceInfo | undefined): PriceText {
  const t = (n: number | undefined) => (n === undefined ? '' : String(n));
  return { input: t(p?.input), output: t(p?.output), cacheRead: t(p?.cacheRead) };
}

/** The typed prices as config: rows left empty are dropped; other fields of an entry (tiers, cacheWrite) stay. */
export function pricingOf(rows: Record<string, PriceText>, before: Record<string, ModelPriceInfo>): Record<string, ModelPriceInfo> {
  const out: Record<string, ModelPriceInfo> = {};
  for (const [model, t] of Object.entries(rows)) {
    if (!t.input.trim() && !t.output.trim() && !t.cacheRead.trim()) continue;
    const num = (v: string, what: string): number => {
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`${model} 的${what}价格要填一个不小于 0 的数（美元/百万 token）`);
      return n;
    };
    const p: ModelPriceInfo = { ...before[model], input: num(t.input, '输入'), output: num(t.output, '输出') };
    if (t.cacheRead.trim()) p.cacheRead = num(t.cacheRead, '缓存读');
    else delete p.cacheRead;
    out[model] = p;
  }
  return out;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function suggestId(base: string, taken: string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '') || 'provider';
  let id = clean.slice(0, 32);
  for (let i = 2; taken.includes(id); i++) id = `${clean.slice(0, 29)}-${i}`;
  return id;
}

function ProbeResult({ r }: { r: ProbeProviderResponse | null }) {
  if (!r) return null;
  if (r.ok) {
    if (r.models) return <span className="small"><Badge tone="good">已连通</Badge> 找到 {r.models.length} 个模型（{r.ms} ms）</span>;
    return (
      <span className="small">
        <Badge tone="good">连接正常</Badge> {r.model}，{r.ms} ms{r.reply ? `，回复"${r.reply}"` : ''}
      </span>
    );
  }
  const what = r.kind === 'config' ? '密钥或配置有问题' : r.kind === 'timeout' ? '超时' : r.status === 404 ? '地址或模型不存在' : '失败';
  return (
    <span className="small">
      <Badge tone="bad">{what}</Badge> <span className="error-text">{r.error}</span>
    </span>
  );
}

/**
 * Add or edit a provider profile: preset, protocol, endpoint, key, a model per role; test the
 * connection and fetch the endpoint's model list before saving.
 */
export function ProviderEditor({ view, initial, onSaved, onCancel, compact }: { view: ProvidersResponse; initial: ProviderProfileInfo | null; onSaved: (v: ProvidersResponse) => void; onCancel?: () => void; compact?: boolean }) {
  const taken = view.profiles.map((p) => p.id);
  const [presetId, setPresetId] = useState(initial ? '' : (view.presets[0]?.id ?? 'custom'));
  const [id, setId] = useState(initial?.id ?? suggestId(view.presets[0]?.id ?? 'provider', taken));
  const [draft, setDraft] = useState<Draft>(() => (initial ? clone(initial.profile) : fromPreset(view, view.presets[0]?.id ?? 'custom')));
  const [apiKey, setApiKey] = useState('');
  const [sameModel, setSameModel] = useState(() => {
    const m = (initial?.profile.models ?? draft.models) as Record<ModelRole, string>;
    return draft.protocol !== 'anthropic' && m.main === m.fork && m.main === m.cheap && (m.judge || m.main) === m.main;
  });
  const [models, setModels] = useState<string[]>([]);
  const [probe, setProbe] = useState<ProbeProviderResponse | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [makeDefault, setMakeDefault] = useState(view.default === null || view.default === initial?.id);
  const savedPricing = (initial?.profile['pricing'] ?? {}) as Record<string, ModelPriceInfo>;
  const [prices, setPrices] = useState<Record<string, PriceText>>(() => Object.fromEntries(Object.entries(savedPricing).map(([m, p]) => [m, priceText(p)])));
  const [newPriceKey, setNewPriceKey] = useState('');
  const act = useAction();
  const probing = useAction();
  const preset = view.presets.find((p) => p.id === presetId);
  const noKey = draft['apiKeySecret'] === null;
  const vision = !!(draft['vision'] as Record<string, unknown> | undefined)?.['main'];
  const keySet = initial?.key.set ?? false;
  const proto = view.protocols.find((p) => p.id === draft.protocol);

  const choosePreset = (pid: string) => {
    setPresetId(pid);
    setDraft(fromPreset(view, pid));
    if (!initial) setId(suggestId(pid, taken));
    setSameModel(view.presets.find((p) => p.id === pid)?.protocol !== 'anthropic');
    setModels([]);
    setProbe(null);
  };
  const set = (path: string[], value: unknown) =>
    setDraft((d) => {
      const next = clone(d) as Record<string, unknown>;
      let node = next;
      for (const k of path.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
      node[path[path.length - 1] as string] = value;
      return next as Draft;
    });
  /**
   * Another protocol: its defaults, keeping the name and the key setting. The endpoint and models
   * carry over only between the two OpenAI protocols (the same vendor); echo needs neither.
   */
  const changeProtocol = (protocol: ProviderProtocolName) =>
    setDraft((d) => {
      const next = clone(view.defaults[protocol] as Draft);
      const openai = (p: ProviderProtocolName) => p === 'openai-chat' || p === 'openai-responses';
      next['label'] = d['label'] ?? null;
      if (protocol !== 'echo') {
        if (d['apiKeySecret'] === null) next['apiKeySecret'] = null;
        else if (initial) next['apiKeySecret'] = initial.profile.apiKeySecret;
        else delete next['apiKeySecret'];
      }
      if (openai(protocol) && openai(d.protocol)) {
        next['baseUrl'] = d['baseUrl'] ?? null;
        next.models = d.models;
      }
      return next;
    });
  const setModel = (role: ModelRole, v: string) => {
    if (sameModel && role === 'main') setDraft((d) => ({ ...d, models: { main: v, fork: v, cheap: v, judge: v } }));
    else set(['models', role], v);
  };
  const body = () => {
    const profile = clone(draft) as Record<string, unknown>;
    if (sameModel) profile['models'] = { main: draft.models.main, fork: draft.models.main, cheap: draft.models.main, judge: draft.models.main };
    if (profile['baseUrl'] === '') profile['baseUrl'] = null;
    if (!initial && profile['apiKeySecret'] !== null) delete profile['apiKeySecret']; // PROVIDER_<ID>_API_KEY
    profile['pricing'] = pricingOf(prices, savedPricing);
    return profile;
  };
  const runProbe = (what: 'test' | 'models') =>
    void probing.run(async () => {
      setProbe(null);
      const r = await post<ProbeProviderResponse>(`/api/providers/${what}`, { id, profile: body(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setProbe(r);
      if (r.ok && r.models) setModels(r.models);
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await act.run(async () => {
      const v = await api<ProvidersResponse>('PUT', `/api/providers/${enc(id)}`, { profile: body(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), makeDefault });
      setApiKey('');
      onSaved(v);
    });
  };
  const listId = `models-${id}`;
  const roleModels = sameModel ? [draft.models.main] : ROLES.map(([role]) => draft.models[role]);
  const priceRows = [...new Set([...roleModels, ...(initial?.prices.map((x) => x.model) ?? []), ...Object.keys(prices)].filter((m): m is string => !!m && m.trim() !== ''))];
  const setPrice = (model: string, field: keyof PriceText, v: string) => setPrices((old) => ({ ...old, [model]: { ...(old[model] ?? { input: '', output: '', cacheRead: '' }), [field]: v } }));
  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      {!initial && (
        <Field label="供应商" hint={preset?.note}>
          <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
            {view.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="row">
        <Field label="名称（id）" hint={initial ? '保存后不能改' : '小写字母、数字和 -'}>
          <input value={id} disabled={!!initial} onChange={(e) => setId(e.target.value.toLowerCase())} required pattern="[a-z][a-z0-9-]{0,31}" />
        </Field>
        <Field label="显示名（可选）">
          <input value={String(draft['label'] ?? '')} onChange={(e) => set(['label'], e.target.value || null)} placeholder={preset?.label ?? id} />
        </Field>
      </div>
      <Field label="协议" hint={PROTOCOL_HINT[draft.protocol]}>
        <select
          value={draft.protocol}
          onChange={(e) => {
            const protocol = e.target.value as ProviderProtocolName;
            changeProtocol(protocol);
            // Claude has a model per role; the others usually run one model for all three.
            setSameModel(protocol !== 'anthropic');
            setModels([]);
            setProbe(null);
          }}
        >
          {view.protocols.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {draft.protocol !== 'echo' && (
        <>
          <Field label="接口地址" hint={draft.protocol === 'anthropic' ? 'API 根地址（SDK 会加 /v1/messages）；留空用官方地址' : '一般以 /v1 结尾，会在后面加 /chat/completions 或 /responses；留空用官方地址'}>
            <input value={String(draft['baseUrl'] ?? '')} onChange={(e) => set(['baseUrl'], e.target.value)} placeholder={proto?.defaultUrl ?? ''} />
          </Field>
          <Field
            label="API Key"
            hint={
              noKey
                ? '这个接口不需要密钥（本机模型服务）'
                : keySet
                  ? `已保存在秘密 ${String(initial?.profile.apiKeySecret)}（${initial?.key.source === 'env' ? '来自环境变量' : '数据卷'}）；留空保持不变`
                  : `保存为秘密 ${initial ? String(initial.profile.apiKeySecret) : `PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`}，不写进配置文件、不进日志`
            }
          >
            <div className="row">
              <input className="grow" type="password" autoComplete="off" value={apiKey} disabled={noKey} onChange={(e) => setApiKey(e.target.value)} placeholder={noKey ? '不需要' : keySet ? '••••••（已保存）' : 'sk-…'} />
              <label className="check">
                <input type="checkbox" checked={noKey} onChange={(e) => set(['apiKeySecret'], e.target.checked ? null : (initial?.profile.apiKeySecret ?? undefined))} />
                无需密钥
              </label>
            </div>
          </Field>
          <div className="row">
            <Button small onClick={() => runProbe('models')} busy={probing.busy}>
              获取模型列表
            </Button>
            <Button small onClick={() => runProbe('test')} busy={probing.busy} disabled={!draft.models.main}>
              测试连接
            </Button>
            <ProbeResult r={probe} />
          </div>
          <ErrorText error={probing.error} />
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {draft.protocol !== 'anthropic' && (
            <label className="check">
              <input type="checkbox" checked={sameModel} onChange={(e) => setSameModel(e.target.checked)} />
              所有角色用同一个模型
            </label>
          )}
          {ROLES.filter(([r]) => !sameModel || r === 'main').map(([role, label, hint]) => (
            <Field key={role} label={sameModel ? '模型' : `模型 · ${label}`} hint={sameModel ? undefined : hint}>
              <input list={listId} value={draft.models[role] ?? ''} onChange={(e) => setModel(role, e.target.value)} placeholder={role === 'judge' ? `留空用主模型（${draft.models.main || '未设置'}）` : (models[0] ?? '模型名，例如 deepseek-chat')} required={role === 'main'} />
            </Field>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={vision}
              onChange={(e) => set(['vision'], { main: e.target.checked, fork: e.target.checked, cheap: e.target.checked })}
            />{' '}
            模型能看图片（否则图片以文字占位）
          </label>
          <PricingFields
            rows={priceRows}
            prices={prices}
            known={initial?.prices ?? []}
            checked={view.pricesChecked}
            onChange={setPrice}
            onClear={(m) => setPrices((old) => Object.fromEntries(Object.entries(old).filter(([k]) => k !== m)))}
            newKey={newPriceKey}
            setNewKey={setNewPriceKey}
            onAdd={() => {
              const k = newPriceKey.trim();
              if (!k) return;
              setPrices((old) => ({ ...old, [k]: old[k] ?? { input: '', output: '', cacheRead: '' } }));
              setNewPriceKey('');
            }}
          />
          <button type="button" className="link small" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '收起高级设置' : '高级设置'}
          </button>
          {advanced && (
            <div className="form-grid">
              <div className="row">
                <Field label="单次最多输出 token">
                  <input type="number" min={16} value={Number(draft['maxOutputTokens'] ?? 0)} onChange={(e) => set(['maxOutputTokens'], Number(e.target.value))} />
                </Field>
                <Field label="上下文窗口（留空自动）" hint="Claude 已知；其他默认 128000">
                  <input type="number" min={1024} value={draft['contextWindow'] === null || draft['contextWindow'] === undefined ? '' : Number(draft['contextWindow'])} onChange={(e) => set(['contextWindow'], e.target.value ? Number(e.target.value) : null)} />
                </Field>
                <Field label="请求超时（毫秒）">
                  <input type="number" min={1000} value={Number(draft['timeoutMs'] ?? 600000)} onChange={(e) => set(['timeoutMs'], Number(e.target.value))} />
                </Field>
              </div>
              {draft.protocol === 'anthropic' ? (
                <Field label="特性" hint="完整：自适应思考、effort、缓存与 beta 功能（Anthropic 官方）；基础：只发标准字段（其他厂商的兼容接口）">
                  <select value={String((draft['anthropic'] as Record<string, unknown> | undefined)?.['features'] ?? 'full')} onChange={(e) => set(['anthropic', 'features'], e.target.value)}>
                    <option value="full">完整</option>
                    <option value="basic">基础</option>
                  </select>
                </Field>
              ) : (
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={!!(draft['openai'] as Record<string, unknown> | undefined)?.['reasoningEffort']} onChange={(e) => set(['openai', 'reasoningEffort'], e.target.checked)} />
                    发送推理强度（只对推理模型开启）
                  </label>
                  {draft.protocol === 'openai-chat' && (
                    <select value={String((draft['openai'] as Record<string, unknown> | undefined)?.['maxTokensField'] ?? 'max_tokens')} onChange={(e) => set(['openai', 'maxTokensField'], e.target.value)} title="输出上限字段">
                      <option value="max_tokens">max_tokens</option>
                      <option value="max_completion_tokens">max_completion_tokens（OpenAI 官方）</option>
                    </select>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          设为默认供应商
        </label>
        <div className="spacer" />
        {onCancel && (
          <Button onClick={onCancel} kind="ghost">
            取消
          </Button>
        )}
        <Button kind="primary" type="submit" busy={act.busy}>
          {compact ? '保存并继续' : '保存'}
        </Button>
      </div>
      <ErrorText error={act.error} />
    </form>
  );
}

/**
 * Prices per model, USD per million tokens. An empty row uses the built-in price when there is
 * one; a name with * covers a group of models ("glm-5.3*").
 */
function PricingFields(o: {
  rows: string[];
  prices: Record<string, PriceText>;
  known: ModelPriceRow[];
  checked: string;
  onChange: (model: string, field: keyof PriceText, v: string) => void;
  onClear: (model: string) => void;
  newKey: string;
  setNewKey: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <fieldset className="form-grid price-fields">
      <legend>价格（美元 / 百万 token）</legend>
      <p className="muted small">
        用来估算费用和执行每日预算。留空的模型用内置价格（核对于 {o.checked}），没有内置价格就不计费。缓存读留空按输入价计。名字里可以用 *，例如 glm-5.3* 覆盖一组模型。
      </p>
      <div className="price-row price-head" aria-hidden="true">
        <span>模型</span>
        <span>输入</span>
        <span>输出</span>
        <span>缓存读</span>
        <span />
      </div>
      {o.rows.map((model) => {
        const t = o.prices[model];
        const k = o.known.find((x) => x.model === model);
        const builtin = k?.source === 'builtin' ? k.pricing : undefined;
        const custom = !!t && !!(t.input || t.output || t.cacheRead);
        return (
          <div className="price-row" key={model}>
            <span className="mono small price-model" title={model}>
              {model}{' '}
              {!custom && (builtin ? <Badge tone="info">内置</Badge> : k?.source === 'custom' && k.key !== model ? <Badge tone="info">{k.key}</Badge> : k?.source === 'custom' ? null : <Badge tone="warn">无价格</Badge>)}
            </span>
            <input type="number" min={0} step="any" aria-label={`${model} 输入价格`} placeholder={builtin ? String(builtin.input) : '输入'} value={t?.input ?? ''} onChange={(e) => o.onChange(model, 'input', e.target.value)} />
            <input type="number" min={0} step="any" aria-label={`${model} 输出价格`} placeholder={builtin ? String(builtin.output) : '输出'} value={t?.output ?? ''} onChange={(e) => o.onChange(model, 'output', e.target.value)} />
            <input type="number" min={0} step="any" aria-label={`${model} 缓存读价格`} placeholder={builtin ? String(builtin.cacheRead ?? builtin.input) : '缓存读'} value={t?.cacheRead ?? ''} onChange={(e) => o.onChange(model, 'cacheRead', e.target.value)} />
            {t ? (
              <button type="button" className="link small" onClick={() => o.onClear(model)}>
                清除
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      <div className="row">
        <input
          className="grow"
          value={o.newKey}
          onChange={(e) => o.setNewKey(e.target.value)}
          placeholder="其他模型名，或 glm-*"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              o.onAdd();
            }
          }}
        />
        <Button small onClick={o.onAdd} disabled={!o.newKey.trim()}>
          添加
        </Button>
      </div>
    </fieldset>
  );
}

function PriceList({ rows }: { rows: ModelPriceRow[] }) {
  if (rows.length === 0) return <span className="muted">无</span>;
  return (
    <span className="price-list">
      {rows.map((x) => (
        <span key={x.model} className="small">
          <span className="mono">{x.model}</span>{' '}
          {x.pricing ? (
            <>
              <span className="muted">{priceLine(x.pricing)}</span> <Badge tone="info">{x.source === 'custom' ? '自定义' : '内置'}</Badge>
            </>
          ) : (
            <Badge tone="warn">没有价格{x.unpricedCalls > 0 ? `：7 天内 ${x.unpricedCalls} 次调用未计费` : ''}</Badge>
          )}
        </span>
      ))}
    </span>
  );
}

function fromPreset(view: ProvidersResponse, presetId: string): Draft {
  const p = view.presets.find((x) => x.id === presetId) ?? view.presets[0];
  const protocol = p?.protocol ?? 'openai-chat';
  const d = clone(view.defaults[protocol]) as Draft;
  delete d['apiKeySecret'];
  d['baseUrl'] = p?.baseUrl ?? null;
  if (p?.noKey) d['apiKeySecret'] = null;
  if (p?.models) d.models = { ...d.models, ...p.models } as Record<ModelRole, string>;
  if (p?.anthropic) d['anthropic'] = { ...(d['anthropic'] as object), ...p.anthropic };
  if (p?.openai) d['openai'] = { ...(d['openai'] as object), ...p.openai };
  return d;
}

function ProfileCard({ p, view, onEdit, onChange }: { p: ProviderProfileInfo; view: ProvidersResponse; onEdit: () => void; onChange: (v: ProvidersResponse) => void }) {
  const ask = useAsk();
  const { canWrite } = useSession();
  const [probe, setProbe] = useState<ProbeProviderResponse | null>(null);
  const act = useAction();
  const isDefault = view.default === p.id;
  const m = p.profile.models;
  const same = m.main === m.fork && m.main === m.cheap && m.main === m.judge;
  return (
    <Card
      title={
        <span>
          {p.profile.label ?? p.id} {isDefault && <Badge tone="info">默认</Badge>} {p.ready ? <Badge tone="good">就绪</Badge> : <Badge tone="bad">未就绪</Badge>}
        </span>
      }
      actions={
        canWrite && (
          <>
            <Button small busy={act.busy} onClick={() => void act.run(async () => setProbe(await post<ProbeProviderResponse>('/api/providers/test', { id: p.id })))}>
              测试
            </Button>
            {!isDefault && (
              <Button small onClick={() => void act.run(async () => onChange(await api<ProvidersResponse>('PATCH', '/api/providers', { default: p.id })))}>
                设为默认
              </Button>
            )}
            <Button small onClick={onEdit}>
              编辑
            </Button>
            <Button
              small
              kind="danger"
              onClick={() => {
                ask(`删除供应商 ${p.id}？`, () => void act.run(async () => onChange(await api<ProvidersResponse>('DELETE', `/api/providers/${enc(p.id)}`))), { body: '它的密钥（若是默认名字）也会删除。', confirm: '删除' });
              }}
            >
              删除
            </Button>
          </>
        )
      }
    >
      <div className="kv">
        <div className="kv-row">
          <span className="muted">协议</span>
          <span>{view.protocols.find((x) => x.id === p.profile.protocol)?.label ?? p.profile.protocol}</span>
        </div>
        {p.endpoint && (
          <div className="kv-row">
            <span className="muted">地址</span>
            <span className="mono small">{p.endpoint}</span>
          </div>
        )}
        <div className="kv-row">
          <span className="muted">模型</span>
          <span className="mono small">{same ? m.main : `main ${m.main} · fork ${m.fork} · cheap ${m.cheap} · judge ${m.judge}`}</span>
        </div>
        <div className="kv-row">
          <span className="muted">密钥</span>
          <span>{!p.key.required ? '不需要' : p.key.set ? <span>已设置 <span className="muted small">{p.profile.apiKeySecret}（{p.key.source === 'env' ? '环境变量' : '数据卷'}）</span></span> : <Badge tone="warn">未设置 {p.profile.apiKeySecret}</Badge>}</span>
        </div>
        {p.profile.protocol !== 'echo' && (
          <div className="kv-row">
            <span className="muted">价格</span>
            <PriceList rows={p.prices} />
          </div>
        )}
        <div className="kv-row">
          <span className="muted">服务角色</span>
          <span>{p.roles.length ? p.roles.map((r) => ROLES.find((x) => x[0] === r)?.[1]).join('、') : <span className="muted">无</span>}</span>
        </div>
      </div>
      {p.problem && <div className="error-text small">{p.problem}</div>}
      <ProbeResult r={probe} />
      <ErrorText error={act.error} />
    </Card>
  );
}

function RoleRouting({ view, onChange }: { view: ProvidersResponse; onChange: (v: ProvidersResponse) => void }) {
  const { canWrite } = useSession();
  const act = useAction();
  const ids = view.profiles.map((p) => p.id);
  return (
    <Card title="按角色选择供应商">
      <p className="muted small">默认所有角色都用默认供应商。也可以让某个角色换一个，例如轻量任务用本机模型省钱。</p>
      <div className="form-grid">
        {ROLES.map(([role, label, hint]) => (
          <div className="row" key={role}>
            <span style={{ minWidth: 90 }}>{label}</span>
            <select
              disabled={!canWrite || act.busy}
              value={view.roles[role] ?? ''}
              onChange={(e) => void act.run(async () => onChange(await api<ProvidersResponse>('PATCH', '/api/providers', { roles: { [role]: e.target.value || null } })))}
            >
              <option value="">跟随默认（{view.default ?? '未设置'}）</option>
              {ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <span className="muted small">{hint}</span>
          </div>
        ))}
      </div>
      <ErrorText error={act.error} />
    </Card>
  );
}

/**
 * Speech-to-text: the web chat's microphone and voice messages on QQ, WeChat and Telegram. Any
 * OpenAI-compatible /audio/transcriptions endpoint.
 */
function SpeechCard() {
  const { canWrite } = useSession();
  const r = useApi<SpeechView>('/api/speech');
  const [draft, setDraft] = useState<SpeechView['settings'] | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<SpeechTestResponse | null>(null);
  const act = useAction();
  const testing = useAction();
  const v = r.data;
  if (!v) return r.error ? <ErrorText error={r.error} /> : null;
  const s = draft ?? v.settings;
  const editing = draft !== null;
  const noKey = s.apiKeySecret === null;
  const set = (patch: Partial<SpeechView['settings']>) => setDraft({ ...s, ...patch });
  const body = (settings: SpeechView['settings']) => ({ settings: { ...settings, baseUrl: settings.baseUrl?.trim() || null }, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
  const save = (settings: SpeechView['settings']) =>
    void act.run(async () => {
      r.setData(await api<SpeechView>('PUT', '/api/speech', body(settings)));
      setDraft(null);
      setApiKey('');
      setTest(null);
    });
  return (
    <Card
      title={
        <span>
          语音转文字 {v.ready ? <Badge tone="good">已开启</Badge> : <Badge tone="info">未开启</Badge>}
        </span>
      }
      actions={
        canWrite &&
        !editing && (
          <Button small onClick={() => setDraft({ ...v.settings })}>
            {v.settings.baseUrl ? '编辑' : '设置'}
          </Button>
        )
      }
    >
      <p className="muted small">网页聊天的麦克风（点按听写、按住说话），以及 QQ、微信、Telegram 里的语音消息，都用它转成文字。任何 OpenAI 兼容的 /audio/transcriptions 接口都可以。这里没设置或转写失败时，QQ、微信用它们自带的识别文字。</p>
      {!editing ? (
        <div className="kv">
          <div className="kv-row">
            <span className="muted">接口</span>
            <span className="mono small">{v.settings.baseUrl ?? '未设置'}</span>
          </div>
          {v.settings.baseUrl && (
            <>
              <div className="kv-row">
                <span className="muted">模型</span>
                <span className="mono small">{v.settings.model}</span>
              </div>
              <div className="kv-row">
                <span className="muted">语言</span>
                <span>{v.settings.language ?? '自动识别'}</span>
              </div>
              <div className="kv-row">
                <span className="muted">密钥</span>
                <span>{!v.key.required ? '不需要' : v.key.set ? <span>已设置 <span className="muted small">{v.settings.apiKeySecret}</span></span> : <Badge tone="warn">未设置 {v.settings.apiKeySecret}</Badge>}</span>
              </div>
            </>
          )}
          {v.problem && v.settings.baseUrl && <div className="error-text small">{v.problem}</div>}
        </div>
      ) : (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            save(s);
          }}
        >
          <Field label="服务">
            <select
              value=""
              onChange={(e) => {
                const p = v.presets.find((x) => x.id === e.target.value);
                if (p) set({ baseUrl: p.baseUrl || null, model: p.model, apiKeySecret: p.noKey ? null : (v.settings.apiKeySecret ?? 'SPEECH_API_KEY') });
              }}
            >
              <option value="">选择预设填入…</option>
              {v.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.note ? `（${p.note}）` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="接口地址" hint="一般以 /v1 结尾，会在后面加 /audio/transcriptions">
            <input value={s.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.siliconflow.cn/v1" required />
          </Field>
          <Field label="API Key" hint={noKey ? '这个接口不需要密钥' : v.key.set ? `已保存在秘密 ${String(s.apiKeySecret)}；留空保持不变` : `保存为秘密 ${String(s.apiKeySecret)}，不写进配置文件`}>
            <div className="row">
              <input className="grow" type="password" autoComplete="off" value={apiKey} disabled={noKey} onChange={(e) => setApiKey(e.target.value)} placeholder={noKey ? '不需要' : v.key.set ? '••••••（已保存）' : 'sk-…'} />
              <label className="check">
                <input type="checkbox" checked={noKey} onChange={(e) => set({ apiKeySecret: e.target.checked ? null : 'SPEECH_API_KEY' })} />
                无需密钥
              </label>
            </div>
          </Field>
          <Field label="模型">
            <input value={s.model} onChange={(e) => set({ model: e.target.value })} placeholder="FunAudioLLM/SenseVoiceSmall" required />
          </Field>
          <Field label="语言" hint="留空自动识别；中文填 zh，英文填 en">
            <input value={s.language ?? ''} onChange={(e) => set({ language: e.target.value.trim() || null })} placeholder="自动" maxLength={3} />
          </Field>
          <div className="row">
            <Button
              small
              busy={testing.busy}
              onClick={() =>
                void testing.run(async () => {
                  setTest(null);
                  setTest(await post<SpeechTestResponse>('/api/speech/test', body(s)));
                })
              }
            >
              测试
            </Button>
            {test && (test.ok ? <span className="small"><Badge tone="good">可用</Badge> {test.ms} ms</span> : <span className="small"><Badge tone="bad">失败</Badge> <span className="error-text">{test.error}</span></span>)}
            <div className="spacer" />
            {v.settings.baseUrl && (
              <Button kind="danger" onClick={() => save({ ...v.settings, baseUrl: null, model: '' })}>
                关闭
              </Button>
            )}
            <Button kind="ghost" onClick={() => (setDraft(null), setTest(null), setApiKey(''))}>
              取消
            </Button>
            <Button kind="primary" type="submit" busy={act.busy}>
              保存
            </Button>
          </div>
          <ErrorText error={testing.error} />
        </form>
      )}
      <ErrorText error={act.error} />
    </Card>
  );
}

/** The 模型 page: provider profiles, the default, per-role routing, speech-to-text. */
export function Providers() {
  const { canWrite } = useSession();
  const r = useApi<ProvidersResponse>('/api/providers');
  const [editing, setEditing] = useState<ProviderProfileInfo | null | 'new'>(null);
  const view = r.data;
  const sorted = useMemo(() => (view ? [...view.profiles].sort((a, b) => Number(b.id === view.default) - Number(a.id === view.default) || a.id.localeCompare(b.id)) : []), [view]);
  useEffect(() => {
    if (view && view.profiles.length === 0 && canWrite && editing === null) setEditing('new');
  }, [view, canWrite, editing]);
  if (!view) return <div className="page">{r.error ? <ErrorText error={r.error} /> : <Empty>加载中…</Empty>}</div>;
  const saved = (v: ProvidersResponse) => {
    r.setData(v);
    setEditing(null);
  };
  return (
    <div className="page">
      <PageActions>
        {canWrite && (
          <Button kind="primary" onClick={() => setEditing('new')}>
            添加供应商
          </Button>
        )}
      </PageActions>
      {!view.ready && <div className={cx('banner', 'banner-bad')}>模型未就绪：{view.problem}</div>}
      {sorted.length === 0 ? (
        <Empty>还没有供应商。添加一个后，Protea 才能回答消息。</Empty>
      ) : (
        <div className="grid">
          {sorted.map((p) => (
            <ProfileCard key={p.id} p={p} view={view} onEdit={() => setEditing(p)} onChange={r.setData} />
          ))}
        </div>
      )}
      {view.profiles.length > 0 && <RoleRouting view={view} onChange={r.setData} />}
      <SpeechCard />
      {editing !== null && (
        <Drawer title={editing === 'new' ? '添加供应商' : `编辑 ${editing.id}`} onClose={() => setEditing(null)}>
          <ProviderEditor view={view} initial={editing === 'new' ? null : editing} onSaved={saved} onCancel={() => setEditing(null)} />
        </Drawer>
      )}
    </div>
  );
}
