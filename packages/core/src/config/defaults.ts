import { DEFAULT_PLUGIN_HOST_SETTINGS } from '../plugins/host.js';
import { defaultTimeZone } from '../util/time.js';
import type { ProteaConfig } from './types.js';

export function defaultConfig(): ProteaConfig {
  return {
    daemon: { timezone: defaultTimeZone(), language: 'zh', shutdown: { graceMs: 25_000 } },
    control: { listen: '0.0.0.0:7788', adminTokenSecret: 'PROTEA_ADMIN_TOKEN' },
    owner: { identities: [{ plugin: 'console', senderKey: '*' }] },
    scheduler: {
      levels: {
        0: { debounceMs: 0, maxWaitMs: 0 },
        1: { debounceMs: 300, maxWaitMs: 0 },
        2: { debounceMs: 2_000, maxWaitMs: 30_000 },
        3: { debounceMs: 30_000, maxWaitMs: 300_000 },
        4: { debounceMs: null, maxWaitMs: 1_800_000 },
      },
      preemptStorm: { count: 3, windowMs: 10_000, cooldownMs: 60_000 },
      forks: { maxConcurrent: 2, maxQueued: 8, yieldLevel: 1, yieldTimeoutMs: 30_000, maxTurns: 20 },
    },
    budget: { dailyUsd: null, shares: { 0: null, 1: 0.6, 2: 0.2, 3: 0.15, 4: 0.05 }, warnAt: 0.9 },
    session: { rounds: { soft: 12, hard: 30 }, backoffMs: [5_000, 15_000, 45_000] },
    providers: {
      default: 'anthropic',
      anthropic: {
        apiKeySecret: 'ANTHROPIC_API_KEY',
        baseUrl: null,
        models: { main: 'claude-opus-5-5', fork: 'claude-sonnet-5-5', cheap: 'claude-haiku-5-5' },
        effort: { main: { 0: 'high', 1: 'medium', 2: 'high', 3: 'high', 4: 'high' }, fork: 'high', cheap: 'low' },
        fallbacks: 'default',
        thinkingDisplay: 'omitted',
        cacheTtl: '1h',
        maxOutputTokens: 64_000,
        timeoutMs: 600_000,
        maxRetries: 2,
        pricing: {},
      },
      echo: { delayMs: 0 },
    },
    plugins: {
      console: { enabled: true, config: {} },
      cron: { enabled: true, config: {} },
    },
    pluginHost: { ...DEFAULT_PLUGIN_HOST_SETTINGS, restartBackoffMs: [...DEFAULT_PLUGIN_HOST_SETTINGS.restartBackoffMs] },
    permissions: { default: 'allow', tools: {}, approvalTtlMs: 86_400_000 },
    observability: { logLevel: 'info', logFormat: 'auto', logEventText: false },
  };
}

export const STARTER_CONFIG_YAML = `# Protea configuration. Every key is optional; see docs/30-specs/04-config-reference.md.
# Values here override the built-in defaults; PROTEA_<PATH> environment variables override this file
# (path segments separated by "__", e.g. PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500).

# daemon:
#   timezone: Asia/Shanghai

# owner:
#   identities:
#     - { plugin: console, senderKey: "*" }

# budget:
#   dailyUsd: 5              # tracked per level (L1 60 %, L2 20 %, L3 15 %, L4 5 %); not enforced yet

# providers:
#   default: anthropic        # or "echo" for offline development
#   anthropic:
#     models: { main: claude-opus-5-5 }

# plugins:
#   cron:
#     config:
#       schedules:
#         - { name: morning-brief, cron: "0 7 * * *", note: "Prepare the morning brief" }
#   telegram:                 # needs the secret TELEGRAM_BOT_TOKEN; add the owner to owner.identities
#     enabled: true
#     config: {}

# permissions:
#   tools: { tg_send_chat: ask }    # allow | ask | deny; globs like "mcp__*" work too
`;
