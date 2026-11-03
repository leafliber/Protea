# 规范：配置参考

> 状态：Accepted（M0 部分）· 更新：2026-11-03 · 设计：[../10-architecture/16-deployment.md](../10-architecture/16-deployment.md) §4

配置文件 `/data/config.yaml`，首次启动时写入一份带注释的模板。所有键都有默认值。层叠顺序（后者覆盖前者）：内置默认 → `config.yaml` → `PROTEA_*` 环境变量。对象逐层合并，数组与标量整体替换。

## 1. M0 已生效的键

```yaml
daemon:
  timezone: Asia/Shanghai              # 默认取 TZ 环境变量或系统时区；无效值回退 UTC 并告警
  language: zh
  shutdown: { graceMs: 25000 }         # SIGTERM 后等待当前批的时间，超时中止（可恢复）

control:
  listen: 0.0.0.0:7788                 # "host:port"；端口 0 表示随机
  adminTokenSecret: PROTEA_ADMIN_TOKEN # 秘密名；缺失时自动生成

owner:
  identities:                          # 只有匹配的 (plugin, senderKey) 能产生 L1 事件
    - { plugin: console, senderKey: "*" }

scheduler:
  levels:                              # debounceMs: null 表示该等级不开窗口，只能顺带投递
    0: { debounceMs: 0,     maxWaitMs: 0 }
    1: { debounceMs: 300,   maxWaitMs: 0 }
    2: { debounceMs: 2000,  maxWaitMs: 30000 }
    3: { debounceMs: 30000, maxWaitMs: 300000 }
    4: { debounceMs: null,  maxWaitMs: 1800000 }   # maxWaitMs（老化）从 M1 生效

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

plugins:
  console: { enabled: true, config: {} }
  cron:
    enabled: true
    config:
      schedules:                       # 每项：name，cron 或 at 二选一，可选 note、level（3|4）
        - { name: morning-brief, cron: "0 7 * * *", note: "Prepare the morning brief" }

observability:
  logLevel: info                       # trace | debug | info | warn | error | silent
  logFormat: auto                      # auto（TTY 下 pretty）| json | pretty；运行目录里的 log.jsonl 总是 JSON
  logEventText: false
```

## 2. 计划中的键（后续里程碑）

| 键 | 里程碑 |
|---|---|
| `scheduler.preemptStorm`、`scheduler.forks`、`scheduler.retention` | M1 |
| `budget.*` | M1 |
| `permissions.*` | M2 |
| `mcp.servers.*` | M3 |
| `skills.*` | M3 |
| `context.*`（工具搜索阈值、交接比例）、`memory.*`、`persona.dir` | M4 |
| `control.allowCidrs`、`control.readonlyTokenSecret`、`observability.metrics`、`observability.otlp` | M5 |

## 3. 环境变量映射

`PROTEA_<PATH>`，路径段以双下划线分隔，每段由大写下划线转成小驼峰：`PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500` → `scheduler.levels.1.debounceMs`。值先按 JSON 解析（数字、布尔、`null`、数组），失败则作为字符串。不含 `__` 的变量（如 `PROTEA_DATA_DIR`、`PROTEA_URL`、`PROTEA_ADMIN_TOKEN`）不是配置路径。

秘密的解析顺序：`PROTEA_SECRET_<NAME>` → `<NAME>` → `/data/secrets/<NAME>` 文件。

## 4. 热更新

M0 在启动时读取配置，变更需要重启。文件监视与热更新（热项立即生效、`x-hot: false` 项重建组件）在 M2 随插件热插拔一起实现。
