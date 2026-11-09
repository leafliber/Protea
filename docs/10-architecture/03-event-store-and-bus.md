# 事件存储与总线

> 状态：Accepted（M0–M6）· 更新：2026-11-08 · 规范：[../30-specs/06-storage-schema.md](../30-specs/06-storage-schema.md)

## 1. 职责

Event Store 是 Protea 的唯一事实源（[ADR-0002](../20-decisions/ADR-0002-event-log-as-source-of-truth.md)）：

- **追加**事件、投递记录、撤回记录、审批记录、用量记录。
- 分配**全局游标**，保证持久化顺序。
- 提供按游标、按来源、按等级、按状态的**查询**。
- 向调度器与控制平面**广播**新记录（进程内总线）。
- 支持**回放**：从任意游标起把事件重新喂给一个离线会话（调试、回归测试）。

## 2. 存储引擎

SQLite（WAL 模式），单文件 `/data/protea.db`（[ADR-0006](../20-decisions/ADR-0006-sqlite-single-store.md)）。理由：单实例、零运维、事务与查询能力、备份就是复制文件。

核心表（完整 DDL 见规范）：

| 表 | 作用 | 写入者 |
|---|---|---|
| `events` | 事件信封主体（JSON 列 + 索引列：cursor、source、level、type、ts、state） | PluginHost |
| `event_blobs` | 附件元数据；二进制存 `/data/blobs/<sha256>` | PluginHost |
| `deliveries` | 事件终结记录：`cursor → outcome, batchId, sessionId, at` | Scheduler / Session |
| `batches` | 批：id、等级、触发原因、开始/结束、回合数、是否被取消 | Scheduler |
| `sessions` | 会话索引：id、kind(main/fork)、状态、转录文件路径、模型、起止 | Session Manager |
| `approvals` | 审批请求与决定 | Policy Engine |
| `usage` | 每次模型调用的 token / 费用 / 缓存命中，按等级与会话 | Provider |
| `kv` | 小型键值（插件状态、动态日程、配置覆盖） | 各组件 |
| `audit` | 副作用工具调用的审计 | Tool Dispatcher |

会话**转录**不存 SQLite，而是每会话一个 append-only JSONL 文件（`/data/sessions/<id>.jsonl`），便于直接查看与修复（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §6）。

## 3. 游标与顺序

- `cursor` 是 `events` 表的自增主键，在**事务提交时**确定。插件得到的 `pushEvent` 返回值即游标。
- 跨来源顺序 = 写入顺序，不是 `ts` 顺序。调度器组批时按游标排序；人格若需要按世界时间排序，可在渲染层处理（Core 不做）。
- 启动恢复只扫描非终结状态的事件（`pending` / `delivering`），由 `(state, eff_level, cursor)` 索引支撑，不需要单独维护高水位。

## 4. 幂等与去重

- 来源可提供 `dedupeKey`（例如 Telegram `update_id`、邮件 `Message-ID`、Webhook `delivery` 头）。`(source, dedupeKey)` 唯一索引；冲突时返回已有游标并计数，不产生新事件。
- 没有 `dedupeKey` 的来源默认不去重；PluginHost 对 `(source, type, senderKey, text)` 在 5 秒内完全相同的事件做一次软去重（可关闭）。
- 去重保证"重启后插件重新拉取"不会造成重复投递（P9）。

## 5. 保留与清理

- 事件默认永久保留；`ephemeral: true` 的事件在投递后 24 小时清理。
- 可配置按等级的保留期（例如 L4 保留 30 天）。清理是追加一条 `purge` 审计记录后批量删除，不影响游标连续性（游标不复用）。
- 附件按引用计数清理。

## 6. 进程内总线

Core 内部使用一个简单的类型化发布/订阅总线（无外部依赖）：

| 主题 | 载荷 | 订阅者 |
|---|---|---|
| `event.stored` | cursor, level, trigger | Scheduler、控制台 WS |
| `event.settled` | cursor, outcome | PluginHost（回调来源）、控制台 |
| `batch.*` | 批生命周期 | 控制台、指标 |
| `session.phase` | sessionId, RunPhase | 插件（`onRunPhase`）、控制台 |
| `plugin.*` | 插件生命周期 | 人格（`onPluginLifecycle`）、控制台 |
| `budget.*` | 等级、余量 | Scheduler、控制台 |

总线是进程内的，不持久化；持久化的是它所通知的记录。控制台的 WebSocket 只是总线的一个订阅者加上回放能力（连接时可携带 `since=cursor`）。

除了按主题订阅，总线还有 `tap`（M5）：它在该条记录的所有监听器之前看到每个主题的每条记录。SSE、WebSocket 与崩溃报告的"最近总线记录"都用 tap，因此外发顺序是因果顺序：一个事件的 `event.stored` 总是先于调度器因它而开的批（`batch.started`）与它的结算（`event.settled`）——监听器在处理中再发出的记录排在后面。

## 7. 回放

`protea replay [--from C] [--to C] [--provider recorded|echo|config] [--run ID] [--out DIR]`（M6，`apps/daemon/src/replay.ts`）把一段事件按原顺序和原批次边界（`events.batch_id` 与 `batches` 表）重新投递给一个**离线**主会话：

- 离线会话有自己的数据目录（默认 `<data>/replays/<时间>/data`）：复制人格、记忆、Skills 与覆盖文件，配置是生产配置关掉所有插件（console 除外）、所有 MCP 服务器、录制与预算强制执行之后的样子。生产数据库只读。
- 模型：`recorded`（默认）按角色依次回放某次运行的 `provider.jsonl`（`observability.recordProvider` 录下的响应，免费且确定）；`echo`；`config` 用配置的真实模型（会花钱，CLI 会提示）。真实模型的 API key 只在内存里交给离线会话。
- 工具：所有调用都不真正执行。能在生产转录里找到对应结果的（按 tool_use id，或按工具名加输入）直接返回录下的结果；Core 的只读工具在离线副本上真的运行；其余返回桩（"离线回放没有这次调用的录制结果"）。
- 每批之后等到会话空闲（包括可能的交接）再投下一批；调度器在离线会话里是暂停的，批的边界完全由原记录决定。
- 结束时报告批数、事件数、区间内从未到达模型的事件数、模型调用数、工具调用的来源（录制/离线运行/桩），以及录制里没用完的响应数（说明回放走了不同的路径）。

用途：

- 复现调度 bug（抢占时序）。
- 回归测试人格/系统提示变更。
- 生成评测集。

回放不写入生产 `events` 表。

## 8. 一致性边界

- 事件写入与游标分配在同一事务。
- 投递记录与会话转录的追加**不在**同一事务（跨文件）；因此可能出现"转录里有、deliveries 里没有"。启动时以转录为准补写 deliveries（转录是回合的真实记录），规则见 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §6。
