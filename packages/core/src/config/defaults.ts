import { DEFAULT_VISION_SETTINGS } from '../blobs/settings.js';
import { DEFAULT_CHAT_SETTINGS } from '../chat/settings.js';
import { DEFAULT_TOOL_SEARCH } from '../context/settings.js';
import { DEFAULT_DREAM, DEFAULT_IDLE_COMPACTION } from '../maintenance/settings.js';
import { DEFAULT_MCP_SETTINGS } from '../mcp/settings.js';
import { DEFAULT_BOARD } from '../memory/settings.js';
import { DEFAULT_PLUGIN_HOST_SETTINGS } from '../plugins/settings.js';
import { DEFAULT_HANDOFF } from '../session/settings.js';
import { defaultTimeZone } from '../util/time.js';
import type { ProteaConfig } from './types.js';

export function defaultConfig(): ProteaConfig {
  return {
    daemon: { timezone: defaultTimeZone(), language: 'zh', shutdown: { graceMs: 25_000 } },
    control: {
      listen: '0.0.0.0:7788',
      adminTokenSecret: 'PROTEA_ADMIN_TOKEN',
      readonlyTokenSecret: 'PROTEA_READONLY_TOKEN',
      publicUrl: null,
      publicMetrics: false,
      allowCidrs: [],
    },
    owner: { identities: [{ plugin: 'console', senderKey: '*' }, { plugin: 'webchat', senderKey: '*' }] },
    scheduler: {
      levels: {
        0: { debounceMs: 0, maxWaitMs: 0 },
        1: { debounceMs: 300, maxWaitMs: 0 },
        2: { debounceMs: 2_000, maxWaitMs: 30_000 },
        3: { debounceMs: 30_000, maxWaitMs: 300_000 },
        4: { debounceMs: null, maxWaitMs: 1_800_000 },
      },
      preemptStorm: { count: 3, windowMs: 10_000, cooldownMs: 60_000 },
      forks: { maxConcurrent: 2, maxQueued: 8, yieldLevel: 1, yieldTimeoutMs: 30_000, maxTurns: 20, idleTtlMs: 30 * 60_000, maxIdle: 4 },
    },
    budget: { dailyUsd: null, shares: { 0: null, 1: 0.6, 2: 0.2, 3: 0.15, 4: 0.05 }, warnAt: 0.9, enforce: true, hardDailyUsd: null },
    session: { rounds: { soft: 12, hard: 30 }, backoffMs: [5_000, 15_000, 45_000] },
    // No provider until the owner adds one (console → 模型, `protea providers set`, or config.yaml).
    providers: { default: null, roles: {}, profiles: {} },
    plugins: {
      console: { enabled: true, config: {} },
      cron: { enabled: true, config: {} },
    },
    pluginHost: {
      ...DEFAULT_PLUGIN_HOST_SETTINGS,
      restartBackoffMs: [...DEFAULT_PLUGIN_HOST_SETTINGS.restartBackoffMs],
      limits: { ...DEFAULT_PLUGIN_HOST_SETTINGS.limits },
    },
    permissions: {
      default: 'allow',
      tools: {},
      approvalTtlMs: 86_400_000,
      grantMaxMs: 8 * 3_600_000,
      mode: 'ask',
      auto: { environment: '', allow: '', ask: '', timeoutMs: 30_000, pauseAfterConsecutive: 3, pauseAfterPerHour: 20 },
    },
    mcp: { ...DEFAULT_MCP_SETTINGS, servers: {} },
    skills: { disabled: [], mcpPrompts: true },
    context: {
      toolSearch: { ...DEFAULT_TOOL_SEARCH },
      handoff: { ...DEFAULT_HANDOFF },
      compaction: { enabled: false, triggerTokens: 150_000, instructions: null },
      idleCompaction: { ...DEFAULT_IDLE_COMPACTION },
    },
    memory: { board: { ...DEFAULT_BOARD }, dream: { ...DEFAULT_DREAM } },
    vision: { ...DEFAULT_VISION_SETTINGS },
    chat: { ...DEFAULT_CHAT_SETTINGS },
    persona: { dir: 'persona' },
    observability: { logLevel: 'info', logFormat: 'auto', logEventText: false, keepRuns: 20, logRotateMb: 50, logRotateKeep: 4, requiredPlugins: [], recordProvider: 'off' },
  };
}

export const STARTER_CONFIG_YAML = `# Protea configuration. Every key is optional; see docs/30-specs/04-config-reference.md.
# Values here override the built-in defaults; PROTEA_<PATH> environment variables override this file
# (path segments separated by "__", e.g. PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500).

# daemon:
#   timezone: Asia/Shanghai   # the owner's zone: journal dates, the daily memory consolidation and times in the prompt follow it

# owner:
#   identities:
#     - { plugin: console, senderKey: "*" }
#     - { plugin: webchat, senderKey: "*" }

# budget:
#   dailyUsd: 5              # pools per level (L1 60 %, L2 20 %, L3 15 %, L4 5 %) over the rolling 24 h;
#                            # an exhausted L2 pool turns new L2 events into piggyback, L3/L4 into store
#   hardDailyUsd: 10         # global cap: once reached only L0/L1 events are delivered

# providers:                  # model providers; easiest from the console (模型 page) or "protea providers set"
#   default: claude             # the profile every role uses unless roles says otherwise ("echo": offline development)
#   roles: { cheap: local }     # optional: a different profile per role (main, fork, cheap, judge)
#   profiles:
#     claude:
#       protocol: anthropic     # anthropic | openai-chat | openai-responses | echo
#       # baseUrl: null         # null = the protocol's default endpoint
#       # apiKeySecret: PROVIDER_CLAUDE_API_KEY   # default PROVIDER_<ID>_API_KEY ("protea secrets set" or the console)
#       models: { main: claude-opus-5-5, fork: claude-sonnet-5-5, cheap: claude-haiku-5-5 }
#     local:
#       protocol: openai-chat
#       baseUrl: http://host.docker.internal:11434/v1
#       apiKeySecret: null      # no key
#       models: { main: qwen3:8b }   # fork and cheap default to main

# plugins:
#   cron:
#     config:
#       schedules:
#         - { name: morning-brief, cron: "0 7 * * *", note: "Prepare the morning brief" }
#   telegram:                 # needs the secret TELEGRAM_BOT_TOKEN; add the owner to owner.identities
#     enabled: true
#     config: {}
#   wechat:                   # enable it, then scan the QR code (console or "protea plugins login wechat")
#     enabled: true
#     config: {}
#   qq:                       # enable it, then scan the QR code: that creates the QQ bot (or "protea plugins login qq")
#     enabled: true
#     config: { groups: false }   # true: deliver group messages that mention the bot; answering in the group (qq_group_reply) asks first

# permissions:
#   tools: { tg_send_chat: ask }    # allow | ask | deny; globs like "mcp__*" work too; an ask written here always reaches you
#   mode: ask                 # who clears the other asks: ask (you), auto (a judge model, the rest come to you), locked (none run)
#   auto:                     # standing rules for the judge, in plain language
#     environment: "A personal assistant; the sandbox is disposable."
#     allow: "Reading and changing files in the workspace."
#     ask: "Anything posted publicly."

# vision:                     # images in the conversation; a profile's "vision: true" says its models can see them
#   maxImageKb: 1536
#   maxImagesPerMessage: 4
#   blobRetentionDays: 30     # 0 keeps stored images

# chat:
#   widgets: true             # replies may carry an inline widget (HTML/SVG in a sandbox frame)
#   widgetMaxKb: 64

# mcp:
#   servers:                  # add with "protea mcp add"; tools appear as mcp__<server>__<tool>
#     fetch: { command: uvx, args: [mcp-server-fetch] }
#     files: { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem", "/data/workspace"], trust: low }

# skills:
#   disabled: []              # names hidden from the catalog; skills live in /data/skills/<name>/SKILL.md

# context:
#   handoff:                  # when the conversation grows too long it is handed off to a new one
#     softTokens: 80000       # at the start of a batch above this; the newest third is carried over
#     hardTokens: null        # before any request above this (null: context window - max output - 5 %)
#   idleCompaction:           # while idle the conversation is compacted before it gets long
#     minTokens: 32000        # conversation tokens above which it is compacted once the provider's cache is cold
#     keepTokens: 8000        # newest tokens carried over verbatim

# memory:
#   dream:                    # daily consolidation of the memory directory
#     at: "03:30"             # earliest local time of each day's run
#     model: main             # main | fork | cheap
#     maxTurns: 40            # model rounds it may take

# control:
#   listen: 0.0.0.0:7788      # the web console is at http://<host>:7788/ (first visit: create the admin account
#                             # with the setup code the daemon prints at start)
#   publicMetrics: false      # true serves /metrics without a token (private networks only)
#                             # a secret PROTEA_READONLY_TOKEN enables a read-only token for dashboards
#   allowCidrs: []            # e.g. [10.0.0.0/8, 192.168.0.0/16]; empty allows any address (loopback always)

# pluginHost:
#   limits: { memoryMb: 512, openFiles: 1024 }   # per plugin / MCP server process tree; over memory → restart
#   outboundPerMinute: 20     # tool calls per connector plugin (e.g. telegram) per minute

# observability:
#   keepRuns: 20              # run directories (log.jsonl, crash reports) kept under /data/runs
#   logRotateMb: 50           # a run's log.jsonl moves to log.1.jsonl past this size (0 = never)
#   logRotateKeep: 4          # rotated log files kept per run
#   logEventText: false       # true: "event stored" log lines carry the event text (clipped to 2000 chars)
#   requiredPlugins: []       # plugins that must be running for /readyz, e.g. [telegram]
#   recordProvider: off       # responses | full: record model calls to runs/<id>/provider.jsonl (protea replay)
`;
