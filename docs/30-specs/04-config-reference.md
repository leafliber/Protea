# 规范：配置参考

> 状态：Accepted（M0–M3 部分）· 更新：2026-11-03 · 设计：[../10-architecture/16-deployment.md](../10-architecture/16-deployment.md) §4

配置文件 `/data/config.yaml`，首次启动时写入一份带注释的模板。所有键都有默认值。层叠顺序（后者覆盖前者）：内置默认 → `config.yaml` → `PROTEA_*` 环境变量。对象逐层合并，数组与标量整体替换。

## 1. 已生效的键（M0–M3）

```yaml
daemon:
  timezone: Asia/Shanghai              # 默认取 TZ 环境变量或系统时区；无效值回退 UTC 并告警
  language: zh
  shutdown: { graceMs: 25000 }         # SIGTERM 后等待当前批的时间，超时中止（可恢复）

control:
  listen: 0.0.0.0:7788                 # "host:port"；端口 0 表示随机
  adminTokenSecret: PROTEA_ADMIN_TOKEN # 秘密名；缺失时自动生成
  publicUrl: null                      # 浏览器访问控制平面的地址（MCP OAuth 回调）；null 时取实际监听地址

owner:
  identities:                          # 只有匹配的 (plugin, senderKey) 能产生 L1 事件
    - { plugin: console, senderKey: "*" }

scheduler:
  levels:                              # debounceMs: null 表示该等级不开窗口，只能顺带投递
    0: { debounceMs: 0,     maxWaitMs: 0 }       # maxWaitMs：老化阈值，超过后提升为 flush；0 = 不老化
    1: { debounceMs: 300,   maxWaitMs: 0 }
    2: { debounceMs: 2000,  maxWaitMs: 30000 }
    3: { debounceMs: 30000, maxWaitMs: 300000 }
    4: { debounceMs: null,  maxWaitMs: 1800000 }
  preemptStorm:                        # 同一来源 windowMs 内实际造成 count 次 preempt/interrupt → 冷却 cooldownMs
    count: 3
    windowMs: 10000
    cooldownMs: 60000                  # 冷却期间该来源的 preempt/interrupt 按 flush 调度；0 = 只计数
  forks:
    maxConcurrent: 2                   # 同时运行（含暂停中）的 Fork 数
    maxQueued: 8                       # 排队数达到上限且无空位时拒绝派生
    yieldLevel: 1                      # 主会话运行该等级或更紧急的批时 Fork 让路；null = 从不让路
    yieldTimeoutMs: 30000              # L3/L4 Fork 未及时到达边界 → 取消其模型调用（恢复时重发）
    maxTurns: 20                       # Fork 模型回合数的默认值与上限

budget:                                # M1 只统计、不限制（限制在 M6 生效）
  dailyUsd: null                       # 滚动 24 h 总预算（美元）；null = 不限
  shares: { 0: null, 1: 0.6, 2: 0.2, 3: 0.15, 4: 0.05 }   # 各等级份额；null = 该等级不限
  warnAt: 0.9                          # 越过该比例与 100% 时各记一次 budget.threshold 事件

session:
  rounds: { soft: 12, hard: 30 }       # 每批模型回合数：软上限发提醒事件，硬上限结束批
  backoffMs: [5000, 15000, 45000]      # SDK 自身重试之后，可重试错误的额外退避

providers:
  default: anthropic                   # anthropic | echo（离线开发）
  anthropic:
    apiKeySecret: ANTHROPIC_API_KEY
    baseUrl: null
    models: { main: claude-opus-5-5, fork: claude-sonnet-5-5, cheap: claude-haiku-5-5 }
    effort:
      main: { 0: high, 1: medium, 2: high, 3: high, 4: high }   # 按批等级
      fork: high
      cheap: low
    fallbacks: default                 # 服务端拒答回退（beta server-side-fallback-2026-07-01）；null 关闭
    thinkingDisplay: omitted           # omitted | summarized
    cacheTtl: 1h                       # 5m | 1h
    maxOutputTokens: 64000
    timeoutMs: 600000
    maxRetries: 2                      # SDK 内部重试次数
    pricing: {}                        # 覆盖内置价格表：{ <model>: { input, output, cacheRead } }，美元/百万 token
  echo:
    delayMs: 0                         # 每次回复前的延迟（用于崩溃测试）

plugins:                             # 每个插件一组：enabled（未列出的插件默认 false）+ config（按插件的 configSchema 校验）
  console: { enabled: true, config: {} }
  cron:
    enabled: true
    config:
      schedules:                       # 每项：name，cron 或 at 二选一，可选 note、level（3|4）
        - { name: morning-brief, cron: "0 7 * * *", note: "Prepare the morning brief" }
  telegram:                            # 需要秘密 TELEGRAM_BOT_TOKEN，并在 owner.identities 加 telegram:<用户 id>
    enabled: true
    config: { pollTimeoutSec: 30 }     # 还有 apiBase、ownerChatId、stopWords、groupMentionsOnly
  webhook:
    enabled: true
    config:
      hooks:
        - { name: github, verify: github, secret: "${secret:GITHUB_WEBHOOK_SECRET}" }
  filewatch:
    enabled: true
    config: { paths: [inbox] }

pluginHost:                            # 进程外插件的监督
  restartBackoffMs: [1000, 2000, 4000, 8000, 16000, 32000, 60000]   # 第 n 次崩溃后的重启延迟，末项重复
  maxCrashes: 5                        # 连续崩溃这么多次 → failed
  stableAfterMs: 60000                 # 运行这么久后崩溃计数清零
  drainTimeoutMs: 30000                # 停止前等待进行中的工具调用
  initializeTimeoutMs: 20000
  stopTimeoutMs: 5000                  # stop 之后多久发 SIGTERM（再 5 s 后 SIGKILL）

permissions:
  default: allow                       # 其他规则都不覆盖时的策略
  tools:                               # 精确名或 glob → allow | ask | deny；优先于插件清单的 sideEffectTools
    tg_send_chat: ask
  approvalTtlMs: 86400000              # 审批请求与审批的有效期（24 h）

mcp:                                   # MCP 服务器（docs/10-architecture/09-mcp-integration.md §2）；监督参数沿用 pluginHost
  servers:
    fetch: { command: uvx, args: [mcp-server-fetch] }
    files:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/data/workspace"]
      trust: low                       # low | normal | high
    github:
      url: https://api.githubcopilot.com/mcp/
      auth: { type: oauth }            # 或 { type: bearer, token: "${secret:GITHUB_MCP_TOKEN}" }
  # 每个服务器还可设：enabled、transport（stdio | streamable-http | sse）、env、cwd、headers、
  # tools: { allow, deny }、toolTimeoutMs（60000）、envPrompt、descriptionOverrides、subscribe
  pingIntervalMs: 30000                # 连续 3 次 ping 失败 → 重启；0 关闭
  listChangedDebounceMs: 500

skills:
  disabled: []                         # 不进目录的 Skill 名（文件保留）
  mcpPrompts: true                     # MCP prompts 以 mcp:<server>/<prompt> 进入 Skills 目录

context:
  toolSearch:
    mode: auto                         # auto：工具总数超过 threshold 时延迟加载 MCP 工具；always；never
    threshold: 40
    keepPerServer: 3                   # 每个 MCP 服务器调用最多的几个工具保持加载

observability:
  logLevel: info                       # trace | debug | info | warn | error | silent
  logFormat: auto                      # auto（TTY 下 pretty）| json | pretty；运行目录里的 log.jsonl 总是 JSON
  logEventText: false
```

## 2. 计划中的键（后续里程碑）

| 键 | 里程碑 |
|---|---|
| `scheduler.retention`（已结束 Fork 转录与事件的保留期） | M5 |
| `budget.enforce`（耗尽时降级/存储） | M6 |
| `permissions.conditions`（按批等级/参数/时间窗）、`permissions.egress` | M6 |
| `pluginHost.resources`（插件内存/CPU 上限） | M6 |
| `context.*`（交接比例等）、`memory.*`、`persona.dir` | M4 |
| `control.allowCidrs`、`control.readonlyTokenSecret`、`observability.metrics`、`observability.otlp` | M5 |

## 3. 环境变量映射

`PROTEA_<PATH>`，路径段以双下划线分隔，每段由大写下划线转成小驼峰：`PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500` → `scheduler.levels.1.debounceMs`。值先按 JSON 解析（数字、布尔、`null`、数组），失败则作为字符串。不含 `__` 的变量（如 `PROTEA_DATA_DIR`、`PROTEA_URL`、`PROTEA_ADMIN_TOKEN`）不是配置路径。

秘密的解析顺序：`PROTEA_SECRET_<NAME>` → `<NAME>` → `/data/secrets/<NAME>` 文件。

## 4. 热更新（M2）

守护进程监视 `config.yaml`（300 ms 去抖）。文件改动后重新加载并校验整份配置；无效则记错误并保留运行中的配置。

| 部分 | 生效方式 |
|---|---|
| `owner` | 立即（身份映射） |
| `permissions` | 立即；系统前缀的权限摘要在下一个回合边界更新 |
| `plugins.<id>.enabled` | 立即启用/禁用 |
| `plugins.<id>.config` | 热键：`config/changed`；`x-hot: false` 的键：重载该插件；进程内插件：重载 |
| `mcp.servers.<id>` | 新增 → 启动；删除 → 停止并移除工具；改动 → 重启该服务器 |
| `skills` | 立即重扫，目录在下一个回合边界更新 |
| `context.toolSearch` | 下一次模型请求生效 |
| 其他部分 | 需要重启，日志会列出改动了哪些部分 |

通过 API 或 CLI 做的修改（插件的启用、禁用、卸载、`PATCH /api/plugins/:id/config`；MCP 服务器的增删与启停；Skill 的启用/禁用）会写回 `config.yaml`。写入用 YAML 文档模型，保留注释与格式，并以"临时文件 + rename"原子替换。环境变量覆盖的值不会被文件改动覆盖。
