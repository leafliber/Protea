# 可观测性

> 状态：Accepted（M6）· 更新：2026-11-04

> **实现状态（M6）**：日志在 `packages/core/src/observability/logger.ts` 与 `logs.ts`（内存缓冲、过滤、读 `log.jsonl`、运行目录列表与清理），指标在 `metrics.ts`，关停记录与崩溃报告在 `run-dir.ts`，Provider 录制在 `providers/recorder.ts`。M6 加了日志的秘密过滤、延迟与数据库大小指标、录制模式。未实现：OpenTelemetry 追踪、软告警（§6）。

## 1. 三类信号

| 信号 | 技术 | 去向 |
|---|---|---|
| 结构化日志 | pino（JSON 行） | stdout（容器日志）+ `/data/runs/<runId>/log.jsonl`（按运行归档）+ 内存里最近 5000 行（`/api/logs`、WS `logs`） |
| 指标 | prom-client，`/metrics` | Prometheus / 任意抓取器 |
| 追踪（可选） | OpenTelemetry（Anthropic SDK 的 OTel 集成 + 自定义 span） | OTLP 端点（配置后开启；未实现） |

此外，**事件流本身**是最重要的可观测面：所有调度决策、插件生命周期、预算动作都是 `internal` 事件，在控制台事件流中与业务事件并列可见。

`observability.logLevel` 只决定终端输出的级别（`silent` 关掉终端）；运行目录的文件与内存缓冲总是收到 debug 及以上。

## 2. 日志字段约定

每行至少：`time`（毫秒）、`level`（10–60）、`msg`、`run`、`component`；按上下文追加 `plugin, session, batch, turn, cursor, callId, tool, mcp, correlation`。插件通过宿主 `log` 方法写日志时自动带 `plugin` 与关联字段。

秘密过滤（M6，[14-security-and-permissions.md](14-security-and-permissions.md) §4）：每一行序列化之后、交给任何目标（终端、`log.jsonl`、内存缓冲）之前，已知秘密值（原样与 JSON 转义后的写法）都替换成 `[REDACTED:<NAME>]`。崩溃报告与 `shutdown.json` 写盘前同样处理。

过滤条件（API、WS 与 `protea logq` 共用 `LogFilter`）：最低级别（名字或数字）、`component`、`plugin`、整行的不区分大小写子串 `q`、时间范围，以及任意字段的精确匹配（`batch`、`session`、`cursor`、`tool` 等）。

## 3. 关键指标

| 指标 | 类型 | 标签 |
|---|---|---|
| `protea_info` | gauge（恒为 1） | version, run |
| `protea_events_total` | counter（结算时计数） | source, level, outcome |
| `protea_events_pending` | gauge | level |
| `protea_batch_wait_seconds` | histogram（从入库到进入批） | level |
| `protea_event_to_request_seconds` | histogram（从入库到第一次带着它的主会话模型请求发出；M6） | level |
| `protea_preemptions_total` | counter | source, kind(preempt/interrupt) |
| `protea_aging_promotions_total` | counter | level |
| `protea_turns_total` | counter（主会话按批，Fork 按整个 Fork） | session_kind, end_reason |
| `protea_turn_duration_seconds` | histogram | session_kind |
| `protea_model_tokens_total` | counter | role, kind(input/output/cache_read/cache_write) |
| `protea_model_cost_usd_total` | counter | level（无等级为 `none`） |
| `protea_cache_hit_ratio` | gauge（滚动 24 h） | role |
| `protea_budget_remaining_ratio` | gauge（只有有上限的池） | level |
| `protea_plugin_state` | gauge（当前状态为 1，其余为 0） | plugin, state |
| `protea_plugin_restarts_total` | counter | plugin |
| `protea_tool_calls_total` | counter | tool, outcome(ok/error) |
| `protea_tool_duration_seconds` | histogram | tool |
| `protea_mcp_server_up` | gauge | server |
| `protea_forks_active` | gauge | state(queued/running/paused) |
| `protea_context_tokens` | gauge | session |
| `protea_db_size_bytes` | gauge（抓取时读文件大小；M6） | file(db/wal) |

`protea_event_to_request_seconds` 对应成功标准里的"事件入库 → 模型开始输出 P95 ≤ 2 s（不含模型思考时间）"：它包含等级的防抖窗口、排在运行中的批后面的等待与上下文组装，到请求发出为止；之后的首字节时间取决于模型，不计入。插件状态与 MCP 状态里的 `memoryBytes` 是进程树内存的最近一次采样（`pluginHost.limits`）。

另有 prom-client 的 Node.js 默认指标（`process_resident_memory_bytes`、`nodejs_heap_size_used_bytes`、`nodejs_eventloop_lag_p99_seconds` 等），供 M6 的长稳测试看内存是否持续增长。计数器跟随总线记录，量表在抓取时读取，注册表是守护进程私有的。

`/metrics` 默认需要令牌（只读令牌即可）；`control.publicMetrics: true` 时开放（只用于私有网络）。`docker/observability/prometheus.yml` 是抓取配置（用 `credentials_file` 放只读令牌），`docker/observability/grafana-dashboard.json` 是示例面板（概览、事件与调度、模型、工具/插件/MCP、进程五组共 27 个面板），导入时选择 Prometheus 数据源。

## 4. 运行目录

```
/data/runs/<runId>/
├── log.jsonl            ← 本次运行的全部日志（debug 及以上）
├── transcript.jsonl     ← 启动修复时移出的记录（orphan-result-drop 等）
├── shutdown.json        ← 正常关停时写入：原因、总耗时与各步骤（drain、mcp、plugins、server）耗时、
│                          关停前的阶段/批/待处理/Fork 数、批是否跑完、插件/MCP/未结束 Fork 的状态
├── crash/<time>.json    ← 未捕获异常或未处理的 Promise 拒绝：错误与堆栈、最近 200 条总线记录（每条截到 2 KB）
└── provider.jsonl       ← 录制模式（observability.recordProvider: responses | full）下每次模型调用一行：
                           角色、模型、耗时、响应或错误；full 时还有（已脱敏的）请求
```

运行 id 是 ULID，按时间排序。启动时只保留最近 `observability.keepRuns`（默认 20）个目录。没有 `shutdown.json` 的旧运行说明进程没有正常退出（被杀或崩溃）。未捕获异常写报告后进程以 1 退出（下次启动续跑中断的批）；未处理的拒绝只写报告并记错误日志，进程继续。

`protea logq`：直接读运行目录里的 `log.jsonl`（不需要守护进程，也能查已经停掉的运行），默认最新一次，`--run <id>` 指定、`--all` 全部；过滤参数同 `protea logs`，`--json` 输出原始行。灵感来自 Cortico 的 `pnpm logq`。

## 5. 健康检查

- `/healthz`：进程存活（总线可用）。
- `/readyz`：Provider 配置就绪、已启用的插件与 MCP 服务器没有 failed、`observability.requiredPlugins` 里的插件都是 running、SQLite 能拿到写锁、投递没有被暂停。返回 `{ ready, reasons }`，不就绪 503。
- 容器 `HEALTHCHECK` 调 `/healthz`；编排层用 `/readyz` 决定流量（虽然 Protea 几乎没有"流量"，但 Webhook 有）。

## 6. 告警建议

内置"软告警"（控制台横幅 + 可选发给主人的 L2 `internal` 事件）：缓存命中率连续低、插件反复重启、预算 90%、拒答连续发生、pending 事件老化超过两倍 `maxWait`、SQLite 文件超过阈值。M5 的控制台已显示投递暂停、Provider 未就绪、插件/MCP 不在运行的横幅；其余推迟到 M7。

## 7. 隐私

日志默认不记录事件 `text` 全文（只记长度与哈希）；调试模式可开启全文，控制台明示。Provider 请求体不落盘，除非开启 `full` 录制模式；`responses` 模式只录响应（回放用它就够了）。录制器在脱敏之后，录下的内容不含秘密值。崩溃报告里的总线记录可能含事件正文，与事件库同等对待（同在 `/data` 卷）。
