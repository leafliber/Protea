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
    },
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

# providers:
#   default: anthropic        # or "echo" for offline development
#   anthropic:
#     models: { main: claude-opus-5-5 }

# plugins:
#   cron:
#     config:
#       schedules:
#         - { name: morning-brief, cron: "0 7 * * *", note: "Prepare the morning brief" }
`;
