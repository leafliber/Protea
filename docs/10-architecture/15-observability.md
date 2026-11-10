# 可观测性

> 状态：Accepted（M6）· 更新：2026-11-10

> **实现状态（M6）**：日志在 `packages/core/src/observability/logger.ts` 与 `logs.ts`（内存缓冲、过滤、读 `log.jsonl`、运行目录列表与清理），指标在 `metrics.ts`，关停记录与崩溃报告在 `run-dir.ts`，Provider 录制在 `providers/recorder.ts`。M6 加了日志的秘密过滤、延迟与数据库大小指标、录制模式。为实际测试又加了追踪日志（`trace.ts`，§2.1）、日志轮转与诊断包（`packages/core/src/diagnostics.ts`，§8）。未实现：OpenTelemetry 追踪、软告警（§6）。

## 1. 三类信号

| 信号 | 技术 | 去向 |
|---|---|---|
| 结构化日志 | pino（JSON 行） | stdout（容器日志）+ `/data/runs/<runId>/log.jsonl`（按运行归档）+ 内存里最近 5000 行（`/api/logs`、WS `logs`） |
| 指标 | prom-client，`/metrics` | Prometheus / 任意抓取器 |
| 追踪（可选） | OpenTelemetry（Anthropic SDK 的 OTel 集成 + 自定义 span） | OTLP 端点（配置后开启；未实现） |

此外，**事件流本身**是最重要的可观测面：所有调度决策、插件生命周期、预算动作都是 `internal` 事件，在控制台运行流中与业务事件并列可见。运行流还实时显示每次模型调用的上下文摘要、思考与正文、工具调用与结果（[17-chat-and-console.md](17-chat-and-console.md) §5）。

`observability.logLevel` 只决定终端输出的级别（`silent` 关掉终端）；运行目录的文件与内存缓冲总是收到 debug 及以上。

## 2. 日志字段约定

每行至少：`time`（毫秒）、`level`（10–60）、`msg`、`run`、`component`；按上下文追加 `plugin, session, batch, turn, cursor, callId, tool, mcp, correlation`。插件通过宿主 `log` 方法写日志时自动带 `plugin` 与关联字段。

秘密过滤（M6，[14-security-and-permissions.md](14-security-and-permissions.md) §4）：每一行序列化之后、交给任何目标（终端、`log.jsonl`、内存缓冲）之前，已知秘密值（原样与 JSON 转义后的写法）都替换成 `[REDACTED:<NAME>]`。崩溃报告与 `shutdown.json` 写盘前同样处理。

日志字段里不用 `level` 表示事件、批或 Fork 的等级（那是日志级别）：分别写作 `eventLevel`、`batchLevel`、`forkLevel`、`budgetLevel`。

### 2.1 追踪日志

为了在实际使用中复盘问题，每个环节都有一行 info 日志，只含元数据（类型、等级、大小、耗时、token），不含消息或事件正文：

| `msg` | `component` | 字段 |
|---|---|---|
| `event stored` | trace | `cursor, source, type, origin, eventLevel, trigger, state, sender, chars`；声明等级被降级时有 `declaredLevel`；`observability.logEventText: true` 时加 `text`（截到 2000 字） |
| `event promoted` | trace | `cursor, trigger, state` |
| `batch started` / `batch extended` | trace | `batch, batchLevel, reason, events/added, cursors`（前 20 个） |
| `batch ended` | main-session | `batch, endReason, rounds, batchLevel` |
| `model call` | model | 所有角色（main、fork、cheap/交接笔记、judge）：`role, model, requested`（回退时）`, ms, stop, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheHit, costUsd, messages, tools` |
| `model call failed` / `model call cancelled` | model | `role, model, ms, kind, err`（取消是 debug） |
| `tool done` | tools | `tool, callId, ms, failed, resultChars` |
| `tool not run` / `tool held by the permission policy` | tools | `tool, callId, reason` |
| `approval changed` | trace | `approval, tool, state, by` |
| `events settled`、`fork changed` | trace | debug 级 |

`cacheHit` = cacheRead / (input + cacheRead + cacheWrite)，即这次请求的提示有多少来自缓存。验证 M0 的缓存命中率时，直接按 `msg=model call` 过滤看它；诊断包的 `summary.json` 里有按角色和模型汇总的值。

### 2.2 过滤

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
| `protea_compactions_total` | counter | kind（idle、capacity、requested、overflow） |
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
├── log.1.jsonl …        ← 轮转出去的旧日志（observability.logRotateMb，默认 50 MB 一个，保留 logRotateKeep=4 个）
├── transcript.jsonl     ← 启动修复时移出的记录（orphan-result-drop 等）
├── shutdown.json        ← 正常关停时写入：原因、总耗时与各步骤（drain、mcp、plugins、server）耗时、
│                          关停前的阶段/批/待处理/Fork 数、批是否跑完、插件/MCP/未结束 Fork 的状态
├── crash/<time>.json    ← 未捕获异常或未处理的 Promise 拒绝：错误与堆栈、最近 200 条总线记录（每条截到 2 KB）
└── provider.jsonl       ← 录制模式（observability.recordProvider: responses | full）下每次模型调用一行：
                           角色、模型、耗时、响应或错误；full 时还有（已脱敏的）请求
```

运行 id 是 ULID，按时间排序。启动时只保留最近 `observability.keepRuns`（默认 20）个目录。一个运行的日志超过 `logRotateMb` 时，`log.jsonl` 改名为 `log.1.jsonl`（更早的依次后移，只留 `logRotateKeep` 个）并开始新文件，所以一次运行最多占 (keep + 1) × logRotateMb；`protea logq` 与 `/api/logs/query` 只读当前的 `log.jsonl`，旧文件在诊断包里。没有 `shutdown.json` 的旧运行说明进程没有正常退出（被杀或崩溃）。未捕获异常写报告后进程以 1 退出（下次启动续跑中断的批）；未处理的拒绝只写报告并记错误日志，进程继续。

`protea logq`：直接读运行目录里的 `log.jsonl`（不需要守护进程，也能查已经停掉的运行），默认最新一次，`--run <id>` 指定、`--all` 全部；过滤参数同 `protea logs`，`--json` 输出原始行。灵感来自 Cortico 的 `pnpm logq`。

## 5. 健康检查

- `/healthz`：进程存活（总线可用）。
- `/readyz`：Provider 配置就绪、已启用的插件与 MCP 服务器没有 failed、`observability.requiredPlugins` 里的插件都是 running、SQLite 能拿到写锁、投递没有被暂停。返回 `{ ready, reasons }`，不就绪 503。
- 容器 `HEALTHCHECK` 调 `/healthz`；编排层用 `/readyz` 决定流量（虽然 Protea 几乎没有"流量"，但 Webhook 有）。

## 6. 告警建议

内置"软告警"（控制台横幅 + 可选发给主人的 L2 `internal` 事件）：缓存命中率连续低、插件反复重启、预算 90%、拒答连续发生、pending 事件老化超过两倍 `maxWait`、SQLite 文件超过阈值。M5 的控制台已显示投递暂停、Provider 未就绪、插件/MCP 不在运行的横幅；其余推迟到 M7。

## 7. 隐私

日志默认不记录事件 `text` 全文（只记长度）；`observability.logEventText: true` 时追踪日志带上正文（截到 2000 字）。Provider 请求体不落盘，除非开启 `full` 录制模式；`responses` 模式只录响应（回放用它就够了）。录制器在脱敏之后，录下的内容不含秘密值。崩溃报告里的总线记录可能含事件正文，与事件库同等对待（同在 `/data` 卷）。

## 8. 诊断包

实际测试或报告问题时，用一个 `.tar.gz` 把需要的东西一次带出来，而不是分别去找容器日志、运行目录和数据库：

- 命令行：`protea diag [--since 72h] [--runs 5] [--content] [--transcripts] [--recordings] [--out FILE|DIR] [--offline]`。守护进程在运行时由它生成（带上实时状态与指标）；连不上时直接读数据目录离线生成（守护进程崩溃后也能用）。容器里：`docker exec protea protea diag`，再 `docker cp protea:/data/exports/<名字> .`。
- 控制台："日志 → 导出诊断包"，选时间范围、运行目录个数和是否带内容，生成后直接下载。
- API：`POST /api/diagnostics`、`GET /api/diagnostics`、`GET /api/diagnostics/<名字>`（只有管理员令牌，[../30-specs/05-control-api.md](../30-specs/05-control-api.md)）。

包里的内容（默认存到 `/data/exports/`，保留最近 10 个）：

| 文件 | 内容 |
|---|---|
| `manifest.json` | 版本、镜像、生成时间、选项、文件列表 |
| `summary.json` | 时间窗内事件按状态/等级/来源/类型计数、降级数、交接次数、批按结束原因计数与平均轮数、用量与缓存命中率（总计、按角色、按模型）、审批、各运行是否正常关停 |
| `system.json` | Node、平台、CPU、内存、负载、时区、数据目录各部分大小、`PROTEA_*` 变量名（不含值） |
| `config.yaml` | 数据目录里的配置文件 |
| `live/` | 守护进程在运行时：`status.json`、`metrics.prom`、`config.effective.json`、`plugins.json`、`mcp.json`、`forks.json`、`budget.json` |
| `runs/<id>/` | 最近 N 次运行的 `log.jsonl`（含轮转文件）、`shutdown.json`、`crash/`；`--recordings` 时加 `provider.jsonl`，`--content` 时加启动修复移出的 `transcript.jsonl` |
| `db/*.jsonl` | 时间窗内的事件（元数据与正文长度）、投递、批、用量、审批、审计，加全部会话、工具统计、schema 版本 |
| `memory/handoff/` | `--content` 时：时间窗内的交接笔记 |
| `sessions/` | `--transcripts` 时：时间窗内写过的会话转录 |

隐私：`secrets/` 从不读取；每个文件写入前都过一遍秘密过滤（已知秘密值换成 `[REDACTED:<NAME>]`，包括值写进日志之后才登记的秘密）。默认不含对话内容：事件只有元数据和正文长度，审批与审计的摘要、会话摘要留空。`--content`、`--transcripts`、`--recordings` 会带上对话内容，分享前要确认接收方。
