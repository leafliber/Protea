import type { Effort, Level, ModelRole, ProviderProtocolName } from '@protea/protocol';
import type { HandoffSettings } from '../session/settings.js';
import type { ToolSearchSettings } from '../context/settings.js';
import type { DreamSettings, IdleCompactionSettings } from '../maintenance/settings.js';
import type { McpSettings } from '../mcp/settings.js';
import type { BoardSettings } from '../memory/settings.js';
import type { PermissionSettings } from '../permissions/policy.js';
import type { PluginHostSettings } from '../plugins/settings.js';

export interface LevelSettings {
  /** Batch window; null means the level never opens a window (it only rides along). */
  debounceMs: number | null;
  /** Aging: a pending event older than this is promoted to flush (level unchanged). 0 disables. */
  maxWaitMs: number;
}

export interface PreemptStormSettings {
  /** This many preemptions by one source within windowMs start a cooldown. */
  count: number;
  windowMs: number;
  /** During the cooldown the source's preempt/interrupt requests are scheduled as flush. */
  cooldownMs: number;
}

export interface ForkSchedulerSettings {
  maxConcurrent: number;
  /** Queued (not yet running) forks beyond this are refused. */
  maxQueued: number;
  /** Forks pause while the main session runs a batch at this level or more urgent; null never yields. */
  yieldLevel: Level | null;
  /** A fork at L3/L4 that has not reached a boundary this long after a yield request has its model call cancelled. */
  yieldTimeoutMs: number;
  /** Default and ceiling for a fork's model rounds. */
  maxTurns: number;
}

export interface BudgetSettings {
  /** Total daily spend (rolling 24 h) shared by the level pools; null means unlimited. */
  dailyUsd: number | null;
  /** Share of dailyUsd per level; null means that level's pool is unlimited. */
  shares: Record<Level, number | null>;
  /** Usage ratio at which an internal notice is recorded (and again at 100 %). */
  warnAt: number;
  /**
   * Exhausted pools change how new events are scheduled (docs/10-architecture/04-scheduling-and-preemption.md §6).
   * false only tracks and reports, as before M6.
   */
  enforce: boolean;
  /** Global cap over the rolling 24 h; once reached only L0/L1 events are delivered. null: none. */
  hardDailyUsd: number | null;
}

export interface OwnerIdentity {
  plugin: string;
  /** Exact senderKey, or "*" for any sender of that plugin. */
  senderKey: string;
}

export type ProviderProtocol = ProviderProtocolName;

/** Options only the Anthropic Messages protocol uses. */
export interface AnthropicOptions {
  /**
   * `full`: Claude's API features (adaptive thinking, effort, betas, tool search, token counting).
   * `basic`: plain Messages requests for Anthropic-compatible endpoints of other vendors.
   */
  features: 'full' | 'basic';
  /** Server-side refusal fallback ("default" routes by refusal category); null disables. */
  fallbacks: 'default' | null;
  thinkingDisplay: 'omitted' | 'summarized';
  /** Prompt cache TTL. Events arrive minutes apart, so 1h is the default. */
  cacheTtl: '5m' | '1h';
  /**
   * What the API does with a thinking block whose conversation prefix changed (beta
   * thinking-binding-controls-2026-08-01): drop_block degrades instead of failing; error
   * fails the request; null sends nothing (the account's default applies).
   */
  thinkingMismatch: 'drop_block' | 'error' | null;
}

/** Options the OpenAI-style protocols (Chat Completions, Responses) use. */
export interface OpenAiOptions {
  /** Send the effort as reasoning effort (reasoning models only; others reject the parameter). */
  reasoningEffort: boolean;
  /** Chat Completions: the output limit field (`max_completion_tokens` for OpenAI's own API). */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** Send `prompt_cache_key` so requests with one prefix reach the same cache; null = only to api.openai.com (other servers may reject it). */
  promptCacheKey: boolean | null;
}

/**
 * One model provider: which protocol, which endpoint, which key and which model per role.
 * Lives in config.yaml (providers.profiles.<id>); the key itself is a secret.
 */
export interface ProviderProfile {
  /** Shown in the console; null shows the id. */
  label: string | null;
  protocol: ProviderProtocol;
  /**
   * Endpoint; null uses the protocol's default. Anthropic: the API root (the SDK adds /v1/messages);
   * OpenAI-style: the root that /chat/completions or /responses is appended to, usually ending in /v1.
   */
  baseUrl: string | null;
  /** Secret holding the API key; null for endpoints without one (a local model server). */
  apiKeySecret: string | null;
  models: Record<ModelRole, string>;
  effort: { main: Record<Level, Effort>; fork: Effort; cheap: Effort };
  maxOutputTokens: number;
  /** Input tokens the models accept; null: known for Claude models, 128000 otherwise. */
  contextWindow: number | null;
  timeoutMs: number;
  /** Retries of connection errors, 429 and 5xx before the session's own backoff. */
  maxRetries: number;
  /** Extra HTTP headers sent with every request (not secret: they are shown in the console). */
  headers: Record<string, string>;
  /** USD per million tokens by model; overrides the built-in table (Claude models only). */
  pricing: Record<string, ModelPricing>;
  anthropic: AnthropicOptions;
  openai: OpenAiOptions;
  echo: { delayMs: number };
}

export interface ProvidersSettings {
  /** Profile used for every role without its own entry in `roles`; null: no provider configured yet. */
  default: string | null;
  /** Per-role profile, e.g. { cheap: local } runs handoff notes on a local model. */
  roles: Partial<Record<ModelRole, string>>;
  profiles: Record<string, ProviderProfile>;
}

export interface ModelPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
}

export interface PluginSettings {
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SkillsSettings {
  /** Skill names hidden from the catalog (the files stay). */
  disabled: string[];
  /** MCP prompts appear in the catalog as read-only skills `mcp:<server>/<prompt>`. */
  mcpPrompts: boolean;
}

export interface CompactionSettings {
  /** Server-side compaction before the handoff threshold (Anthropic beta compact-2026-01-12). */
  enabled: boolean;
  /** Input tokens at which the provider compacts. */
  triggerTokens: number;
  /** Replaces the provider's summarization prompt; null keeps it. */
  instructions: string | null;
}

export interface ContextSettings {
  toolSearch: ToolSearchSettings;
  handoff: HandoffSettings;
  compaction: CompactionSettings;
  idleCompaction: IdleCompactionSettings;
}

export interface MemorySettings {
  /** Declare the provider's own memory tool type instead of a schema (the API then adds its own memory instructions). */
  nativeTool: boolean;
  board: BoardSettings;
  dream: DreamSettings;
}

export interface ProteaConfig {
  daemon: { timezone: string; language: string; shutdown: { graceMs: number } };
  /**
   * `publicUrl`: how a browser reaches the control plane (OAuth redirects); null derives it from `listen`.
   * `readonlyTokenSecret`: a secret that, when set, is a token for GET and WebSocket only.
   * `publicMetrics`: serve /metrics without a token (a scraper on a private network).
   */
  control: {
    listen: string;
    adminTokenSecret: string;
    readonlyTokenSecret: string;
    publicUrl: string | null;
    publicMetrics: boolean;
    /** Client addresses allowed to reach the control plane (CIDRs); empty allows any. Loopback and /hooks/* are always allowed. */
    allowCidrs: string[];
  };
  owner: { identities: OwnerIdentity[] };
  scheduler: { levels: Record<Level, LevelSettings>; preemptStorm: PreemptStormSettings; forks: ForkSchedulerSettings };
  budget: BudgetSettings;
  session: { rounds: { soft: number; hard: number }; backoffMs: number[] };
  providers: ProvidersSettings;
  plugins: Record<string, PluginSettings>;
  pluginHost: PluginHostSettings;
  permissions: PermissionSettings;
  mcp: McpSettings;
  skills: SkillsSettings;
  context: ContextSettings;
  memory: MemorySettings;
  /** Persona directory, relative to the data directory. */
  persona: { dir: string };
  /**
   * `keepRuns`: run directories (logs, crash reports) kept under <data>/runs.
   * `logRotateMb` / `logRotateKeep`: a run's log.jsonl moves to log.1.jsonl past this size (0 = never); this many rotated files are kept.
   * `logEventText`: trace lines for stored events carry the (clipped) event text.
   * `requiredPlugins`: plugin ids that must be running for /readyz.
   * `recordProvider`: record model responses (and requests) for replay.
   */
  observability: {
    logLevel: string;
    logFormat: 'json' | 'pretty' | 'auto';
    logEventText: boolean;
    keepRuns: number;
    logRotateMb: number;
    logRotateKeep: number;
    requiredPlugins: string[];
    /**
     * Provider recording (replay and test fixtures): `responses` writes every model response to
     * <run>/provider.jsonl, `full` the (redacted) requests too. `off` by default.
     */
    recordProvider: 'off' | 'responses' | 'full';
  };
}
