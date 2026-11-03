import type { Effort, Level, ModelRole } from '@protea/protocol';
import type { HandoffSettings } from '../session/handoff.js';
import type { ToolSearchSettings } from '../context/tool-search.js';
import type { McpSettings } from '../mcp/settings.js';
import type { PermissionSettings } from '../permissions/policy.js';
import type { PluginHostSettings } from '../plugins/host.js';

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
}

export interface OwnerIdentity {
  plugin: string;
  /** Exact senderKey, or "*" for any sender of that plugin. */
  senderKey: string;
}

export interface AnthropicSettings {
  apiKeySecret: string;
  baseUrl: string | null;
  models: Record<ModelRole, string>;
  effort: { main: Record<Level, Effort>; fork: Effort; cheap: Effort };
  /** Server-side refusal fallback ("default" routes by refusal category); null disables. */
  fallbacks: 'default' | null;
  thinkingDisplay: 'omitted' | 'summarized';
  /** Prompt cache TTL. Events arrive minutes apart, so 1h is the default. */
  cacheTtl: '5m' | '1h';
  maxOutputTokens: number;
  /**
   * What the API does with a thinking block whose conversation prefix changed (beta
   * thinking-binding-controls-2026-08-01): drop_block degrades instead of failing; error
   * fails the request; null sends nothing (the account's default applies).
   */
  thinkingMismatch: 'drop_block' | 'error' | null;
  timeoutMs: number;
  maxRetries: number;
  pricing: Record<string, ModelPricing>;
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
}

export interface MemorySettings {
  /** Declare the provider's own memory tool type instead of a schema (the API then adds its own memory instructions). */
  nativeTool: boolean;
}

export interface ProteaConfig {
  daemon: { timezone: string; language: string; shutdown: { graceMs: number } };
  /** `publicUrl`: how a browser reaches the control plane (OAuth redirects); null derives it from `listen`. */
  control: { listen: string; adminTokenSecret: string; publicUrl: string | null };
  owner: { identities: OwnerIdentity[] };
  scheduler: { levels: Record<Level, LevelSettings>; preemptStorm: PreemptStormSettings; forks: ForkSchedulerSettings };
  budget: BudgetSettings;
  session: { rounds: { soft: number; hard: number }; backoffMs: number[] };
  providers: {
    default: string;
    anthropic: AnthropicSettings;
    echo: { delayMs: number };
  };
  plugins: Record<string, PluginSettings>;
  pluginHost: PluginHostSettings;
  permissions: PermissionSettings;
  mcp: McpSettings;
  skills: SkillsSettings;
  context: ContextSettings;
  memory: MemorySettings;
  /** Persona directory, relative to the data directory. */
  persona: { dir: string };
  observability: { logLevel: string; logFormat: 'json' | 'pretty' | 'auto'; logEventText: boolean };
}
