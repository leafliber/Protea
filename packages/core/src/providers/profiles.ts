import { LEVELS, MODEL_ROLES, PROVIDER_PROTOCOLS, type Effort, type Level, type ModelRole } from '@protea/protocol';
import type { ProviderProfile, ProviderProtocol, ProvidersSettings } from '../config/types.js';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The built-in profile behind `providers.default: echo` (offline development). */
export const ECHO_PROFILE_ID = 'echo';

/** Claude models per role: the defaults of an Anthropic profile. */
export const CLAUDE_MODELS: Record<ModelRole, string> = { main: 'claude-opus-5-5', fork: 'claude-sonnet-5-5', cheap: 'claude-haiku-5-5' };

/** Where each protocol goes when the profile has no baseUrl. */
export const PROTOCOL_DEFAULT_URL: Record<ProviderProtocol, string | null> = {
  anthropic: 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  echo: null,
};

/** The secret a profile's key is stored under unless it names another: PROVIDER_<ID>_API_KEY. */
export function providerKeySecretName(id: string): string {
  return `PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export function isProfileId(id: string): boolean {
  return PROFILE_ID_RE.test(id);
}

/** A complete profile for a protocol, before the operator's values are applied. */
export function defaultProfile(protocol: ProviderProtocol, id: string = protocol): ProviderProfile {
  return {
    label: null,
    protocol,
    baseUrl: null,
    apiKeySecret: protocol === 'echo' ? null : providerKeySecretName(id),
    models: protocol === 'anthropic' ? { ...CLAUDE_MODELS } : protocol === 'echo' ? { main: 'echo', fork: 'echo', cheap: 'echo' } : { main: '', fork: '', cheap: '' },
    effort: { main: { 0: 'high', 1: 'medium', 2: 'high', 3: 'high', 4: 'high' }, fork: 'high', cheap: 'low' },
    maxOutputTokens: protocol === 'anthropic' ? 64_000 : 8_192,
    contextWindow: null,
    timeoutMs: 600_000,
    maxRetries: 2,
    headers: {},
    pricing: {},
    anthropic: { features: 'full', fallbacks: 'default', thinkingDisplay: 'omitted', cacheTtl: '1h', thinkingMismatch: 'drop_block' },
    openai: { reasoningEffort: false, maxTokensField: 'max_tokens' },
    echo: { delayMs: 0 },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

/**
 * Fill a profile from config.yaml with its protocol's defaults and check it. Fork and cheap
 * fall back to the main model when an OpenAI-style profile names only that one.
 */
export function normalizeProviderProfile(id: string, raw: unknown): ProviderProfile {
  const at = `providers.profiles.${id}`;
  if (!isProfileId(id)) throw new Error(`${at}: a profile id is lower-case letters, digits and "-" (at most 32), starting with a letter`);
  if (!isPlainObject(raw)) throw new Error(`${at} must be a mapping`);
  const protocol = raw['protocol'] ?? 'anthropic';
  if (!PROVIDER_PROTOCOLS.includes(protocol as ProviderProtocol)) throw new Error(`${at}.protocol must be one of ${PROVIDER_PROTOCOLS.join(', ')}`);
  const p = merge(defaultProfile(protocol as ProviderProtocol, id), raw);
  for (const role of MODEL_ROLES) {
    if (typeof p.models[role] !== 'string') throw new Error(`${at}.models.${role} must be a model name`);
    p.models[role] = p.models[role].trim();
  }
  if (p.protocol !== 'anthropic') {
    if (!p.models.fork) p.models.fork = p.models.main;
    if (!p.models.cheap) p.models.cheap = p.models.main;
  }
  if (p.label !== null && typeof p.label !== 'string') throw new Error(`${at}.label must be text or null`);
  if (p.baseUrl !== null) {
    if (typeof p.baseUrl !== 'string') throw new Error(`${at}.baseUrl must be a URL or null`);
    p.baseUrl = p.baseUrl.trim().replace(/\/+$/, '');
    if (p.baseUrl === '') p.baseUrl = null;
    else {
      let u: URL;
      try {
        u = new URL(p.baseUrl);
      } catch {
        throw new Error(`${at}.baseUrl must be an http(s) URL`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${at}.baseUrl must be an http(s) URL`);
    }
  }
  if (p.apiKeySecret !== null && (typeof p.apiKeySecret !== 'string' || !SECRET_RE.test(p.apiKeySecret))) {
    throw new Error(`${at}.apiKeySecret must be a secret name (UPPER_CASE) or null`);
  }
  for (const l of LEVELS) if (!EFFORTS.includes(p.effort.main[l as Level])) throw new Error(`${at}.effort.main.${l} must be one of ${EFFORTS.join(', ')}`);
  if (!EFFORTS.includes(p.effort.fork) || !EFFORTS.includes(p.effort.cheap)) throw new Error(`${at}.effort.fork and .cheap must be one of ${EFFORTS.join(', ')}`);
  if (!(Number.isInteger(p.maxOutputTokens) && p.maxOutputTokens >= 16)) throw new Error(`${at}.maxOutputTokens must be an integer of at least 16`);
  if (p.contextWindow !== null && !(Number.isInteger(p.contextWindow) && p.contextWindow >= 1024)) throw new Error(`${at}.contextWindow must be an integer of at least 1024, or null`);
  if (!(Number.isInteger(p.timeoutMs) && p.timeoutMs >= 1000)) throw new Error(`${at}.timeoutMs must be an integer of at least 1000`);
  if (!(Number.isInteger(p.maxRetries) && p.maxRetries >= 0 && p.maxRetries <= 10)) throw new Error(`${at}.maxRetries must be an integer from 0 to 10`);
  if (!isPlainObject(p.headers) || !Object.values(p.headers).every((v) => typeof v === 'string')) throw new Error(`${at}.headers must map header names to text`);
  if (!isPlainObject(p.pricing)) throw new Error(`${at}.pricing must be a mapping`);
  const a = p.anthropic;
  if (a.features !== 'full' && a.features !== 'basic') throw new Error(`${at}.anthropic.features must be full or basic`);
  if (a.fallbacks !== null && a.fallbacks !== 'default') throw new Error(`${at}.anthropic.fallbacks must be default or null`);
  if (a.thinkingDisplay !== 'omitted' && a.thinkingDisplay !== 'summarized') throw new Error(`${at}.anthropic.thinkingDisplay must be omitted or summarized`);
  if (a.cacheTtl !== '5m' && a.cacheTtl !== '1h') throw new Error(`${at}.anthropic.cacheTtl must be 5m or 1h`);
  if (a.thinkingMismatch !== null && a.thinkingMismatch !== 'drop_block' && a.thinkingMismatch !== 'error') {
    throw new Error(`${at}.anthropic.thinkingMismatch must be drop_block, error or null`);
  }
  if (typeof p.openai.reasoningEffort !== 'boolean') throw new Error(`${at}.openai.reasoningEffort must be true or false`);
  if (p.openai.maxTokensField !== 'max_tokens' && p.openai.maxTokensField !== 'max_completion_tokens') {
    throw new Error(`${at}.openai.maxTokensField must be max_tokens or max_completion_tokens`);
  }
  if (!(typeof p.echo.delayMs === 'number' && p.echo.delayMs >= 0)) throw new Error(`${at}.echo.delayMs must be a non-negative number`);
  return p;
}

/** Only what differs from the protocol's defaults (what config.yaml keeps for a profile). */
export function compactProfile(id: string, p: ProviderProfile): Record<string, unknown> {
  const diff = (value: unknown, base: unknown): unknown => {
    if (isPlainObject(value) && isPlainObject(base)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const d = k in base ? diff(v, base[k]) : v;
        if (d !== undefined) out[k] = d;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
  };
  const out = (diff(p, defaultProfile(p.protocol, id)) as Record<string, unknown> | undefined) ?? {};
  // The protocol always stays visible, and so do the models (the main thing to read in the file).
  return { protocol: p.protocol, ...out, models: { ...p.models } };
}

/** Problems that keep a profile from serving requests (no models yet), or null. */
export function profileProblem(p: ProviderProfile): string | null {
  const missing = MODEL_ROLES.filter((r) => !p.models[r]);
  return missing.length > 0 ? `no model set for ${missing.join(', ')}` : null;
}

/** Validate providers.*: profiles filled in, default and roles pointing at profiles (echo is built in). */
export function normalizeProviders(raw: ProvidersSettings): ProvidersSettings {
  if (!isPlainObject(raw)) throw new Error('providers must be a mapping');
  const profilesRaw = raw.profiles ?? {};
  if (!isPlainObject(profilesRaw)) throw new Error('providers.profiles must be a mapping');
  const profiles: Record<string, ProviderProfile> = {};
  for (const [id, p] of Object.entries(profilesRaw)) profiles[id] = normalizeProviderProfile(id, p);
  const known = (id: string): boolean => id in profiles || id === ECHO_PROFILE_ID;
  const def = raw.default ?? null;
  if (def !== null && (typeof def !== 'string' || !known(def))) throw new Error(`providers.default: no profile "${String(def)}" (add it under providers.profiles, or use echo)`);
  const roles = raw.roles ?? {};
  if (!isPlainObject(roles)) throw new Error('providers.roles must be a mapping');
  for (const [role, id] of Object.entries(roles)) {
    if (!MODEL_ROLES.includes(role as ModelRole)) throw new Error(`providers.roles.${role}: roles are ${MODEL_ROLES.join(', ')}`);
    if (id === null || id === undefined) {
      delete (roles as Record<string, unknown>)[role];
      continue;
    }
    if (typeof id !== 'string' || !known(id)) throw new Error(`providers.roles.${role}: no profile "${String(id)}"`);
  }
  if ((def === ECHO_PROFILE_ID || Object.values(roles).includes(ECHO_PROFILE_ID)) && !profiles[ECHO_PROFILE_ID]) {
    profiles[ECHO_PROFILE_ID] = defaultProfile('echo');
  }
  return { default: def, roles: roles as Partial<Record<ModelRole, string>>, profiles };
}

/** The profile id serving a role, or null when nothing is configured. */
export function profileIdFor(s: ProvidersSettings, role: ModelRole): string | null {
  return s.roles[role] ?? s.default;
}

/**
 * Starting points for the console's "add a provider" form: protocol, endpoint and the
 * Anthropic feature level. Model names are left to the operator (or the endpoint's model
 * list) except for Claude; endpoints are the vendors' documented defaults at the time of writing.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string | null;
  /** The endpoint takes no key (a local model server). */
  noKey?: boolean;
  models?: Partial<Record<ModelRole, string>>;
  anthropic?: Partial<ProviderProfile['anthropic']>;
  openai?: Partial<ProviderProfile['openai']>;
  note?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: null, models: { ...CLAUDE_MODELS } },
  { id: 'openai', label: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', openai: { maxTokensField: 'max_completion_tokens' } },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'qwen', label: '通义千问（阿里云百炼）', protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'kimi', label: 'Kimi（Moonshot）', protocol: 'openai-chat', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'glm', label: '智谱 GLM', protocol: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    protocol: 'openai-chat',
    baseUrl: 'http://host.docker.internal:11434/v1',
    noKey: true,
    note: '容器里访问宿主机用 host.docker.internal（Linux 需要 --add-host=host.docker.internal:host-gateway）',
  },
  { id: 'anthropic-compatible', label: 'Anthropic 兼容接口（其他厂商）', protocol: 'anthropic', baseUrl: null, models: { main: '', fork: '', cheap: '' }, anthropic: { features: 'basic', fallbacks: null, thinkingMismatch: null } },
  { id: 'custom', label: '自定义（OpenAI 兼容）', protocol: 'openai-chat', baseUrl: null },
];
