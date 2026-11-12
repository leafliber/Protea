# 规范：配置参考

> 状态：Accepted（M0–M6）· 更新：2026-11-05 · 设计：[../10-architecture/16-deployment.md](../10-architecture/16-deployment.md) §4

配置文件 `/data/config.yaml`，首次启动时写入一份带注释的模板。所有键都有默认值。层叠顺序（后者覆盖前者）：内置默认 → `config.yaml` → `PROTEA_*` 环境变量。对象逐层合并，数组与标量整体替换。

## 1. 已生效的键（M0–M6）

```yaml
daemon:
  timezone: Asia/Shanghai              # 主人的时区：日志分日、每日记忆整理、提示里的时间都按它。默认取 TZ 环境变量或系统时区；
                                       # 配置和 PROTEA_DAEMON__TIMEZONE 都没有设置时启动告警、控制台首页提示；无效值回退 UTC 并告警
  language: zh
  shutdown: { graceMs: 25000 }         # SIGTERM 后等待当前批的时间，超时中止（可恢复）

control:
  listen: 0.0.0.0:7788                 # "host:port"；端口 0 表示随机
  adminTokenSecret: PROTEA_ADMIN_TOKEN # API 令牌（CLI、脚本）的秘密名；缺失时自动生成。控制台用账号登录，第一个管理员账号用
                                       # 启动时打印的设置码创建（秘密 PROTEA_SETUP_CODE，建好后作废；13-control-plane.md §2）
  readonlyTokenSecret: PROTEA_READONLY_TOKEN # 这个秘密存在时，它的值是只读令牌（GET 与 WS 订阅；M5）
  publicUrl: null                      # 浏览器访问控制平面的地址（MCP OAuth 回调）；null 时取实际监听地址
  publicMetrics: false                 # true：/metrics 不需要令牌（只用于私有网络；M5）
  allowCidrs: []                       # 允许访问控制平面的客户端地址（CIDR 或单个地址）；空 = 不限（M6）。
                                       # 回环地址总是允许；/hooks/* 不受限（由插件校验签名）；经反向代理时看到的是代理的地址

owner:
  identities:                          # 只有匹配的 (plugin, senderKey) 能产生 L1 事件；默认 console 与 webchat 的所有发送者；只写了 console 时 webchat 按相同发送者补上
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
    maxTurns: 20                       # Fork 模型回合数的默认值与上限（每件工作单独计）
    idleTtlMs: 1800000                 # Fork 汇报后待命多久可以接着派活（fork_send）；到时没有新工作就回收；0 = 汇报即结束
    maxIdle: 4                         # 最多保留几个待命的 Fork，超出时回收待命最久的

budget:                                # 热更新（M5）；强制执行在 M6
  dailyUsd: null                       # 滚动 24 h 总预算（美元）；null = 不限
  shares: { 0: null, 1: 0.6, 2: 0.2, 3: 0.15, 4: 0.05 }   # 各等级份额；null = 该等级不限
  warnAt: 0.9                          # 越过该比例记一次 L4 budget.threshold 事件
  enforce: true                        # 池用尽后：新 L2 事件改为 piggyback，新 L3/L4 事件只入库；L1 不受影响（M6）
  hardDailyUsd: null                   # 全局硬上限（滚动 24 h 全部花费）；到达后只投递 L0/L1，L2–L4 入库，拒绝新的 L2–L4 Fork（M6）

session:
  rounds: { soft: 12, hard: 30 }       # 每批模型回合数：软上限发提醒事件，硬上限结束批
  backoffMs: [5000, 15000, 45000]      # SDK 自身重试之后，可重试错误的额外退避

providers:                             # 模型供应商（12-model-providers.md §3）；热更新，下一次模型请求生效。
                                       # 推荐在控制台「模型」页或用 protea providers set 管理
  default: null                        # 各角色默认用的档案 id；null = 还没配置（守护进程照常启动，/readyz 报告原因）。
                                       # "echo" 是内置的离线开发档案，不用写在 profiles 里
  roles: {}                            # 按角色换档案，如 { cheap: local }（角色：main、fork、cheap、judge）
  profiles:
    claude:                            # id：小写字母、数字和 -，以字母开头，最长 32
      label: null                      # 控制台里显示的名字；null 显示 id
      protocol: anthropic              # anthropic | openai-chat | openai-responses | echo
      baseUrl: null                    # null = 协议的默认地址：anthropic → https://api.anthropic.com（SDK 自己加 /v1/messages）；
                                       # openai-* → https://api.openai.com/v1（后面加 /chat/completions 或 /responses）
      apiKeySecret: PROVIDER_CLAUDE_API_KEY   # 默认 PROVIDER_<ID>_API_KEY；null = 接口不要密钥（本机模型服务）
      models: { main: claude-opus-5-5, fork: claude-sonnet-5-5, cheap: claude-haiku-5-5 }
                                       # anthropic 的默认值如上；其他协议没有默认，fork 与 cheap 缺省时用 main 的模型
                                       # judge（auto 权限模式的判断模型）缺省时跟随 main
      effort:
        main: { 0: high, 1: medium, 2: high, 3: high, 4: high }   # 按批等级
        fork: high
        cheap: low
        judge: medium
      maxOutputTokens: 64000           # anthropic 默认 64000，其他协议 8192
      contextWindow: null              # 输入上限；null：Claude 模型按型号（1M 或 200k），其他 128000
      timeoutMs: 600000
      maxRetries: 2                    # 连接错误、429、5xx 的重试次数（会话自己的退避之外）
      headers: {}                      # 每个请求附加的 HTTP 头（不是秘密：控制台会显示）
      pricing: {}                      # { <model>: { input, output, cacheRead } }，美元/百万 token；Claude 有内置价格表，
                                       # 其他模型不填就没有费用估算（预算按 0 计）
      anthropic:                       # 只对 protocol: anthropic 生效
        features: full                 # full：自适应思考、effort、缓存、beta 功能（官方 API）；basic：只发标准 Messages 字段，
                                       # 给其他厂商的 Anthropic 兼容接口用（没有思考、工具搜索、精确计数）
        fallbacks: default             # 服务端拒答回退（beta server-side-fallback-2026-07-01）；null 关闭
        thinkingMismatch: drop_block   # thinking 块前缀不匹配时：drop_block | error | null（beta thinking-binding-controls-2026-08-01；M4）
        thinkingDisplay: omitted       # omitted | summarized
        cacheTtl: 1h                   # 5m | 1h
      openai:                          # 只对 openai-chat / openai-responses 生效
        reasoningEffort: false         # true：把 effort 作为推理强度发送（只对推理模型开启，其他模型会拒绝该参数）
        maxTokensField: max_tokens     # openai-chat 的输出上限字段；OpenAI 官方接口用 max_completion_tokens
        promptCacheKey: null           # 发送 prompt_cache_key；null：只发给 api.openai.com
      echo:
        delayMs: 0                     # protocol: echo 每次回复前的延迟（崩溃测试与长稳测试）；用量按长度估算（M6）
    local:                             # 例：本机 Ollama，只做轻量任务（roles: { cheap: local }）
      protocol: openai-chat
      baseUrl: http://host.docker.internal:11434/v1
      apiKeySecret: null
      models: { main: qwen3:8b }

# 2026-11-05 之前的写法（providers.anthropic {…}、providers.echo {…}、秘密 ANTHROPIC_API_KEY）在启动时自动迁移：
# config.yaml 改写成 providers.profiles.anthropic（其他部分与注释保留），secrets/ANTHROPIC_API_KEY 改名为
# PROVIDER_ANTHROPIC_API_KEY；只有旧密钥文件、没有 providers 配置的数据卷也会得到一个 anthropic 档案。

plugins:                             # 每个插件一组：enabled（未列出的插件默认 false）+ config（按插件的 configSchema 校验）
                                     # + 可选 alwaysLoad：true 工具始终加载，false 可按需加载；不写时连接器与内置进程内插件始终加载，tool / source 插件可按需加载
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
  dida365:                             # 滴答清单（可选插件，先安装，ADR-0025）；需要秘密 DIDA365_TOKEN（设置 → 账户 → API Token）
    enabled: true
    config:
      timeZone: Asia/Shanghai          # 读写时间的时区，默认守护进程时区；还有 apiBase、defaultProjectId、toolsets、maxResults、timeoutSec
      reminders: { enabled: true, dailyAt: "09:00" }   # 任务到期事件；还有 intervalMin、leadMin、overdue、level、projectIds

pluginHost:                            # 进程外插件的监督
  restartBackoffMs: [1000, 2000, 4000, 8000, 16000, 32000, 60000]   # 第 n 次崩溃后的重启延迟，末项重复
  maxCrashes: 5                        # 连续崩溃这么多次 → failed
  stableAfterMs: 60000                 # 运行这么久后崩溃计数清零
  drainTimeoutMs: 30000                # 停止前等待进行中的工具调用
  initializeTimeoutMs: 20000
  stopTimeoutMs: 5000                  # stop 之后多久发 SIGTERM（再 5 s 后 SIGKILL）
  limits:                              # 每个插件与 stdio MCP 服务器的进程树（M6；冷配置，重启生效）
    memoryMb: 512                      # 常驻内存（含子进程）超过它 → 按崩溃处理并重启；null = 不限；≥ 32
    openFiles: 1024                    # 启动前设置的文件描述符软上限（ulimit -n）；null = 继承；≥ 64
    checkMs: 15000                     # 内存采样间隔
  outboundPerMinute: 20                # 每个 connector 插件（console、telegram…）每分钟的工具调用上限，主会话与 Fork 共用；
                                       # null = 不限（M6）。只读工具不计

permissions:
  default: allow                       # 其他规则都不覆盖时的策略
  tools:                               # 精确名或 glob → allow | ask | deny；优先于插件清单的 sideEffectTools
    tg_send_chat: ask
  approvalTtlMs: 86400000              # 审批请求与审批的有效期（24 h）
  grantMaxMs: 28800000                 # 时限授权与 bypass 模式的上限（8 h）；0 同时关闭两者
  mode: ask                            # 长期的权限模式：ask | auto | locked（bypass 只能临时，见 protea mode）
  auto:                                # auto 模式
    environment: ""                    # 三段常驻规则，自然语言：这个助理是什么、用什么
    allow: ""                          # 判断模型可以放行的操作
    ask: ""                            # 必须问主人的操作，优先于 allow
    timeoutMs: 30000                   # 一次判断的时限，超时按 ask 处理
    pauseAfterConsecutive: 3           # 连续这么多次没放行，auto 暂停
    pauseAfterPerHour: 20              # 一小时内这么多次没放行，auto 暂停

vision:                                # 对话里的图片（ADR-0014）；模型能否看图由供应商档案的 vision 决定
  maxImageKb: 1536                     # 单张图片的上限，超过的写成占位文字
  maxImagesPerMessage: 4               # 一个工具回执或一个事件最多带几张
  blobRetentionDays: 30                # 保留期，过期后引用显示"图片已不再保存"；0 一直保留

chat:                                  # 回复可以带什么（17-chat-and-console.md §2）；热更新
  widgets: true                        # chat_send 可以带内联小组件（模型写的 HTML，在沙箱外壳里运行，14-security-and-permissions.md §8.1）
  widgetMaxKb: 64                      # 小组件代码的上限（1–1024）

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
  # tools: { allow, deny }、toolTimeoutMs（60000）、envPrompt、alwaysLoad（true = 工具永不延迟加载）、descriptionOverrides、subscribe、
  # memoryMb（这个服务器进程树的内存上限，默认用 pluginHost.limits.memoryMb）、
  # roots（声明给服务器的根目录，相对数据目录，默认 [workspace]）
  pingIntervalMs: 30000                # 连续 3 次 ping 失败 → 重启；0 关闭
  listChangedDebounceMs: 500

skills:
  disabled: []                         # 不进目录的 Skill 名（文件保留）
  mcpPrompts: true                     # MCP prompts 以 mcp:<server>/<prompt> 进入 Skills 目录

context:
  toolSearch:
    mode: auto                         # auto：工具总数超过 threshold，或可延迟工具的定义超过 thresholdTokens 时延迟加载它们；always；never
    threshold: 40
    thresholdTokens: 8000              # 可延迟工具（MCP 工具、没设为始终加载的插件工具）定义的估算 token；0 = 不按大小判断
    keepPerOwner: 3                    # 每个来源（MCP 服务器或插件）调用最多的几个工具保持加载
  handoff:                             # 容量交接（M4，docs/10-architecture/05-sessions-and-agent-loop.md §8）
    softTokens: 80000                  # 批开始时估算超过它就交接
    hardTokens: null                   # 任何请求前超过它就交接；null = 上下文窗口 − maxOutputTokens − max(8000, 5 %)
    keepRatio: 0.333                   # 新对话原样保留的尾部 = keepRatio × softTokens
    notesMaxTokens: 16000              # 压缩笔记请求的输出上限（含思考；请求固定 effort low，笔记长度由提示词限制）
    notesInputTokens: 150000           # 交给笔记模型的历史上限，超出先丢最早的部分
  compaction:                          # 服务端压缩（M4，Anthropic beta compact-2026-01-12），交接前的第一道
    enabled: false
    triggerTokens: 150000              # ≥ 50000
    instructions: null                 # 替换默认的摘要提示
  idleCompaction:                      # 闲时压缩（docs/10-architecture/05-sessions-and-agent-loop.md §8）
    enabled: true
    minTokens: 32000                   # 对话（不含前缀）超过它，且 Provider 的缓存已过期时压缩
    earlyTokens: 48000                 # 对话超过它时，只需空闲 earlyAfterMs
    earlyAfterMs: 900000
    coldAfterMs: 1800000               # Provider 不声明缓存寿命时，空闲多久算缓存已过期
    keepTokens: 8000                   # 原样保留的最近内容
    minDroppableTokens: 16000          # 可丢弃的内容少于它就不压缩
    minIntervalMs: 600000              # 两次尝试的最短间隔（失败也计入；连续失败后加倍，最多四倍）
                                       # 每连续失败 3 次换更大的笔记模型：cheap → fork → main；都失败后等对话变长

memory:                                # 常驻文件 core/owner.md（2000 字符）与 core/rules.md（4000）的上限是固定的
  board: { maxItems: 60, maxChars: 6000 }   # 白板上限
  dream:                               # 每日记忆整理（需要重启生效）
    enabled: true
    at: "03:30"                        # 每天最早的开始时间（守护进程时区）
    minIdleMs: 1800000                 # 主会话至少空闲这么久
    model: main                        # main | fork | cheap
    maxTurns: 40                       # 模型回合上限；不受 scheduler.forks.maxTurns 限制

persona:
  dir: persona                         # 人格目录，相对数据目录

observability:
  logLevel: info                       # 终端级别：trace | debug | info | warn | error | silent；log.jsonl 与内存缓冲总是 debug 起
  logFormat: auto                      # auto（TTY 下 pretty）| json | pretty；运行目录里的 log.jsonl 总是 JSON
  logEventText: false                  # true："event stored" 追踪日志带上事件正文（截到 2000 字）
  keepRuns: 20                         # /data/runs 下保留的运行目录数（M5）
  logRotateMb: 50                      # 一次运行的 log.jsonl 超过这个大小就轮转成 log.1.jsonl（0 = 不轮转）
  logRotateKeep: 4                     # 每次运行保留的轮转文件数（0–100）
  requiredPlugins: []                  # 这些插件不在 running 时 /readyz 不就绪（M5）
  recordProvider: off                  # off | responses | full：把模型调用录到 runs/<id>/provider.jsonl（回放与测试夹具；M6）。
                                       # full 还录请求（已脱敏，但每条都含整个上下文，体积大）
```

内置插件 `shell`（默认不启用，[ADR-0013](../20-decisions/ADR-0013-sandboxed-shell-and-in-container-browser.md)）的配置：

```yaml
plugins:
  shell:
    enabled: true
    config:
      backend: sandbox                 # sandbox：独立的沙箱容器；local：主容器内，没有隔离，只有 sh_run
      socket: /run/protea-sandbox/agent.sock
      timeoutSec: 120                  # 每条命令的默认与最长时间，超时杀掉整个进程组
      maxOutputKb: 64                  # 返回给模型的输出（stdout+stderr），过长时截掉中间
      shell: /bin/sh                   # 仅 local：用 -c 执行命令的 shell
      maxConcurrent: 2
      env: {}                          # 额外的环境变量（明文值；名字像秘密的会被丢弃）
      jobs: { max: 8, logMb: 16 }      # 同时运行的后台任务数；每个任务保留的日志
```

## 2. 计划中的键（后续里程碑）

| 键 | 里程碑 |
|---|---|
| `scheduler.retention`（已结束 Fork 转录与事件的保留期） | M7（M6 的长稳测试：事件库每个事件约 1 KB，转录 1.5 h 写了 13 MB，见路线图） |
| `permissions.conditions`（按批等级/参数/时间窗）、`permissions.egress` | M7 |
| `pluginHost.limits.cpu`（CPU 上限；内存与文件描述符在 M6 已有） | M7 |
| `observability.otlp` | M7 |

## 3. 环境变量映射

`PROTEA_<PATH>`，路径段以双下划线分隔，每段由大写下划线转成小驼峰：`PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500` → `scheduler.levels.1.debounceMs`。值先按 JSON 解析（数字、布尔、`null`、数组），失败则作为字符串。不含 `__` 的变量（如 `PROTEA_DATA_DIR`、`PROTEA_URL`、`PROTEA_ADMIN_TOKEN`）不是配置路径。

供应商也可以只用环境变量配置（不需要控制台），例如 DeepSeek：`PROTEA_PROVIDERS__DEFAULT=deepseek`、`PROTEA_PROVIDERS__PROFILES__DEEPSEEK__PROTOCOL=openai-chat`、`PROTEA_PROVIDERS__PROFILES__DEEPSEEK__BASE_URL=https://api.deepseek.com/v1`、`PROTEA_PROVIDERS__PROFILES__DEEPSEEK__MODELS__MAIN=deepseek-chat`，密钥 `PROVIDER_DEEPSEEK_API_KEY=…`（或 `PROTEA_SECRET_PROVIDER_DEEPSEEK_API_KEY`）。环境变量里的档案 id 会被转成小驼峰，所以只能用不含 `-` 的 id；环境变量设置的值在控制台里改不掉（环境层优先）。

秘密的解析顺序：`PROTEA_SECRET_<NAME>` → `<NAME>` → `/data/secrets/<NAME>` 文件。

## 4. 热更新（M2）

守护进程监视 `config.yaml`（300 ms 去抖）。文件改动后重新加载并校验整份配置；无效则记错误并保留运行中的配置。

| 部分 | 生效方式 |
|---|---|
| `owner` | 立即（身份映射） |
| `permissions` | 立即；系统前缀的权限摘要在下一个回合边界更新 |
| `plugins.<id>.enabled` | 立即启用/禁用 |
| `plugins.<id>.config` | 热键：`config/changed`；`x-hot: false` 的键：重载该插件；进程内插件：重载 |
| `plugins.<id>.alwaysLoad` | 下一次模型请求生效，插件不重启 |
| `mcp.servers.<id>` | 新增 → 启动；删除 → 停止并移除工具；改动 → 重启该服务器 |
| `skills` | 立即重扫，目录在下一个回合边界更新 |
| `context.toolSearch`、`context.handoff`、`context.compaction` | 下一次模型请求生效 |
| `budget` | 立即（M5 起；下一次状态查询与阈值检查用新值） |
| `providers` | 下一次模型请求生效（2026-11-05 起；进行中的请求用旧设置跑完）。存进秘密的密钥同样立即生效 |
| `persona/` 目录里的文件（不是配置键） | 下一次模型请求生效（目录监视） |
| 其他部分（包括 `control`） | 需要重启，日志会列出改动了哪些部分；`PATCH /api/config` 在 `restartRequired` 里返回它们 |

通过 API 或 CLI 做的修改（插件的启用、禁用、卸载、`PATCH /api/plugins/:id/config`；MCP 服务器的增删与启停；Skill 的启用/禁用；M5 起任意键：`PATCH /api/config`、`protea config set`）会写回 `config.yaml`。`PATCH /api/config` 是 JSON Merge Patch，与环境变量层合并后整体校验，通过才写入，随即重载（不等文件监视）。写入用 YAML 文档模型，保留注释与格式，并以"临时文件 + rename"原子替换。环境变量覆盖的值不会被文件改动覆盖。
