# 规范：控制 API

> 状态：Draft（M0–M2 部分已实现，见文末）· 更新：2026-11-03 · 设计：[../10-architecture/13-control-plane.md](../10-architecture/13-control-plane.md)

基址 `http://host:7788`。JSON；错误形态 `{ error: { code, message, details? } }`。鉴权 `Authorization: Bearer <token>`。分页用 `?cursor=&limit=`（事件按游标）或 `?page=&size=`。

## 状态

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活 |
| GET | `/readyz` | 就绪（含原因列表） |
| GET | `/metrics` | Prometheus |
| GET | `/api/status` | `StatusResponse`：`{ runId, version, startedAt, uptimeSec, phase, batchId, pending: {0..4}, provider, plugins, usage24h, forks: ForkInfo[], budget: { enforced, dailyUsd, levels: {0..4: { spentUsd, tokens, limitUsd, usedRatio }} } }` |

## 事件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/events?level=&source=&state=&since=&until=&cursor=&limit=` | 列表 |
| GET | `/api/events/:cursor` | 信封 + 投递记录 |
| POST | `/api/events` | 推送（来源固定为 `console`，senderKey 为令牌主体；等级 ≤ 1） |
| POST | `/api/events/:cursor/promote` | `{ trigger }` |
| POST | `/api/events/:cursor/withdraw` | |
| GET | `/api/batches?limit=` · `/api/batches/:id` | 批与回合 |

## 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions` | 主会话 + Fork 列表（`{ sessions: [{ id: 'main', kind, phase, batchId }, { kind: 'fork', ...ForkInfo }] }`） |
| GET | `/api/sessions/:id/transcript?from=&limit=&thinking=summary\|none` | 转录；`:id` 为 `main` 或 Fork id（M1 未实现 `thinking` 参数） |
| GET | `/api/sessions/forks` · `/api/sessions/forks/:id` | Fork 列表（未结束的 + 最近 10 个已结束的）、详情（`ForkInfo`） |
| POST | `/api/sessions/main/handoff` | 手动交接 |
| POST | `/api/sessions/forks` | 派生 Fork（ForkOptions） |
| POST | `/api/sessions/forks/:id/cancel` · `/pause` · `/resume` | 返回 `ForkInfo`；对已结束的 Fork 无副作用 |

## 插件 / MCP / Skills

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` · `/api/plugins/:id` | 列表、详情（状态、清单、工具、最近错误） |
| POST | `/api/plugins` | `{ source: git\|tarball\|path, url }` 安装（M2：`{ path, enable? }`，本地目录；201 返回 `PluginStatus`） |
| POST | `/api/plugins/:id/enable` · `/disable` · `/reload` · `/restart` | 返回 `PluginStatus`；`restart` 从 failed 恢复 |
| DELETE | `/api/plugins/:id?keepData=true` | 卸载（须先禁用）；返回 `{ ok, replacedBy }`（重新出现的同名内置插件） |
| GET/PATCH | `/api/plugins/:id/config` | 按 schema 校验（M2：`PATCH {config}` 整体替换并写回 `config.yaml`） |
| GET | `/api/plugins/:id/logs?limit=` | |
| GET/POST/DELETE | `/api/mcp/servers[/:id]` | 增删查 |
| GET | `/api/mcp/servers/:id/tools` | |
| POST | `/api/mcp/servers/:id/oauth/start` → `{ authorizeUrl }`；GET `/api/mcp/oauth/callback` | |
| GET | `/api/skills` · `/api/skills/:name` | 列表、正文 |
| POST | `/api/skills` | `{ gitUrl }` |
| POST | `/api/skills/:name/enable` · `/disable` | |

## 配置、秘密、权限、预算

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config?effective=true` | 生效配置（秘密脱敏，附来源层） |
| PATCH | `/api/config` | JSON Merge Patch；校验后写回文件 |
| GET | `/api/secrets` | 名称列表 |
| PUT | `/api/secrets/:name` | 写值（body 为纯文本） |
| DELETE | `/api/secrets/:name` | |
| GET/PATCH | `/api/permissions` | |
| GET | `/api/approvals?state=pending` | `{ approvals: ApprovalInfo[] }`（state：pending、approved、denied、expired、used） |
| POST | `/api/approvals/:id/decide` | `{ decision: approve\|deny, note? }`；决定者记为 `console:admin`；已决定或已过期 → 409 |
| GET/PATCH | `/api/budget` | |
| POST | `/api/budget/release` | `{ level, untilTs }` 临时放行 |

## Webhook

| 方法 | 路径 | 说明 |
|---|---|---|
| 任意 | `/hooks/<name>[/…]` | **不需要**管理员令牌；转给声明了该 hook 的运行中插件（`http/request`），由插件校验签名。没有插件服务该名字 → 404；插件出错 → 502；请求体上限 1 MB |

## 调度器

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/scheduler/pause` · `/resume` | 暂停投递（事件继续入库） |
| POST | `/api/scheduler/discard` | `{ levels: [3,4] }` 清空 pending（记 discarded） |

## 记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/memory/tree` · `/api/memory/file?path=` | |
| PUT | `/api/memory/file?path=` | 写入（记审计） |

## 实时流

**SSE（M0 起）** `GET /api/stream?since=<cursor>`。连接后先发 `hello {runId}`；带 `since` 时先按游标补发之后的事件，再转为实时。事件名：`event`（id 为游标）、`settled`、`phase`、`batch.started`、`batch.extended`（M1 起带 `level`）、`batch.ended`、`output`（插件输出，如 `con_send`）、`scheduler`（M1：`preempt` / `interrupt` / `aged` / `storm_cooldown` / `fork_yield` / `fork_resume`）、`fork`（M1：`ForkInfo` 变化）、`plugin`（M2：`PluginStatus` 变化）、`approval`（M2：`ApprovalInfo` 变化）、`ping`（15 s 保活）。载荷形态见 `@protea/protocol` 的 `StreamMessage` 与 `SchedulerAction`。

已实现的 HTTP 端点：
- M0：`/healthz`、`/readyz`、`GET /api/status`、`POST|GET /api/events`、`GET /api/events/:cursor`、`GET /api/stream`。
- M1：`GET /api/sessions`、`GET /api/sessions/:id/transcript?from=&limit=`、`GET /api/sessions/forks`、`GET /api/sessions/forks/:id`、`POST /api/sessions/forks/:id/cancel`。
- M2：`GET /api/plugins`、`GET /api/plugins/:id`、`POST /api/plugins`、`POST /api/plugins/:id/enable|disable|reload|restart`、`PATCH /api/plugins/:id/config`、`DELETE /api/plugins/:id`、`GET /api/approvals`、`POST /api/approvals/:id/decide`、`/hooks/<name>`。`PluginStatus`：`{ id, kind, state, enabled, origin: inproc|builtin|data, version?, tools, pid?, restarts?, error? }`。

其余端点在 M2–M5 实现。

### WebSocket `/ws`（M5）

客户端发送 `{ subscribe: ["events", "phase", "logs", "usage"], since?: cursor, logFilter?: {...} }`；服务端推送 `{ topic, data }`。心跳 30 s。
