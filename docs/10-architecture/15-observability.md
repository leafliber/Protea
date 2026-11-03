# 可观测性

> 状态：Draft · 更新：2026-11-03

## 1. 三类信号

| 信号 | 技术 | 去向 |
|---|---|---|
| 结构化日志 | pino（JSON 行） | stdout（容器日志）+ `/data/runs/<runId>/log.jsonl`（按运行归档，可配置保留） |
| 指标 | prom-client，`/metrics` | Prometheus / 任意抓取器 |
| 追踪（可选） | OpenTelemetry（Anthropic SDK 的 OTel 集成 + 自定义 span） | OTLP 端点（配置后开启） |

此外，**事件流本身**是最重要的可观测面：所有调度决策、插件生命周期、预算动作都是 `internal` 事件，在控制台事件流中与业务事件并列可见。

## 2. 日志字段约定

每行至少：`time, level, msg, run, component`；按上下文追加 `plugin, session, batch, turn, cursor, callId, toolName, mcp, correlation`。插件通过宿主 `log` 方法写日志时自动带 `plugin` 与关联字段。秘密过滤（[14-security-and-permissions.md](14-security-and-permissions.md) §4）同样作用于日志。

## 3. 关键指标

| 指标 | 类型 | 标签 |
|---|---|---|
| `protea_events_total` | counter | source, level, outcome |
| `protea_events_pending` | gauge | level |
| `protea_batch_wait_seconds` | histogram | level |
| `protea_preemptions_total` | counter | source, kind(preempt/interrupt) |
| `protea_aging_promotions_total` | counter | level |
| `protea_turns_total` | counter | session_kind, end_reason |
| `protea_turn_duration_seconds` | histogram | session_kind |
| `protea_model_tokens_total` | counter | role, kind(input/output/cache_read/cache_write) |
| `protea_model_cost_usd_total` | counter | level |
| `protea_cache_hit_ratio` | gauge | role |
| `protea_budget_remaining_ratio` | gauge | level |
| `protea_plugin_state` | gauge（0/1） | plugin, state |
| `protea_plugin_restarts_total` | counter | plugin |
| `protea_tool_calls_total` | counter | tool, outcome |
| `protea_tool_duration_seconds` | histogram | tool |
| `protea_mcp_server_up` | gauge | server |
| `protea_forks_active` | gauge | state |
| `protea_context_tokens` | gauge | session |

## 4. 运行目录

```
/data/runs/<runId>/
├── log.jsonl            ← 本次运行的全部日志
├── transcript.jsonl     ← 启动修复时移出的记录（orphan-result-drop 等）
├── shutdown.json        ← 关停时插件的 shutdownVerification 快照
└── crash/               ← 未捕获异常的堆栈与最近 N 条总线记录
```

`protea logq`（M5）：按字段查询日志的小工具，灵感来自 Cortico 的 `pnpm logq`。

## 5. 健康检查

- `/healthz`：进程存活（总线可用）。
- `/readyz`：SQLite 可写、Provider 配置存在、至少一个连接器 `running`（可配置哪些插件是"必需"的）。
- 容器 `HEALTHCHECK` 调 `/healthz`；编排层用 `/readyz` 决定流量（虽然 Protea 几乎没有"流量"，但 Webhook 有）。

## 6. 告警建议

内置"软告警"（控制台横幅 + 可选发给主人的 L2 `internal` 事件）：缓存命中率连续低、插件反复重启、预算 90%、拒答连续发生、pending 事件老化超过两倍 `maxWait`、SQLite 文件超过阈值。

## 7. 隐私

日志默认不记录事件 `text` 全文（只记长度与哈希）；调试模式可开启全文，控制台明示。Provider 请求体不落盘，除非开启录制模式（用于回放测试）。
