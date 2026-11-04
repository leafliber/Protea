# 控制平面

> 状态：Accepted（M5）· 更新：2026-11-04 · 规范：[../30-specs/05-control-api.md](../30-specs/05-control-api.md)

> **实现状态（M5）**：HTTP API 与鉴权在 `packages/control/src/`（`app.ts`、`ops.ts`、`auth.ts`），WebSocket 在 `ws.ts`，SSE/WS 共用的总线投影在 `stream.ts`，控制台托管在 `static.ts`；Web 控制台是 `apps/web`；CLI 在 `apps/cli/src/`（`main.ts`、`ops.ts`）。未实现：`protea replay`、`POST /api/budget/release`（M6），`protea backup`（M6），`/mcp` 服务端（M7）。

## 1. 组成

| 组件 | 技术 | 作用 |
|---|---|---|
| HTTP API | Hono（`@hono/node-server`） | 一切运维操作的唯一入口；控制台与 CLI 都只调用它 |
| 实时流 | 同一端口；SSE `/api/stream`（M0，CLI 用）与 WebSocket `/ws`（M5，控制台用） | 事件、批生命周期、阶段、调度动作、插件输出、状态变化、用量、日志 |
| Web 控制台 | Vite + React（`apps/web`），构建产物由守护进程托管在 `/` | 浏览器运维界面 |
| CLI | `protea` 命令（镜像内置，也可本地安装） | 脚本化与紧急操作 |
| 指标 | `/metrics`（prom-client） | Prometheus 抓取 |
| Webhook 入口 | `/hooks/*` | 属于 `webhook` 事件源，但共享端口 |
| MCP 服务端 | `/mcp`（M7） | Protea 作为 MCP 服务器 |

所有组件走同一个监听端口（默认 7788），便于单容器单端口暴露。

## 2. 鉴权

- **管理员令牌**：秘密 `PROTEA_ADMIN_TOKEN`。首次启动若未设置，生成随机值写入 `/data/secrets/PROTEA_ADMIN_TOKEN`（0600），日志只给出文件路径、不打印令牌；容器内的 CLI 会自动读取该文件。API 与 WS 用 `Authorization: Bearer`。
- **只读令牌**（可选）：秘密 `PROTEA_READONLY_TOKEN`（名字可用 `control.readonlyTokenSecret` 改）存在时生效。只允许 GET 与 WS 订阅，并且读不到 `/api/memory*`、`/api/persona*`、`/api/secrets*`；用于监控面板与 Prometheus。
- **控制台会话**：`POST /api/auth/login {token}` 校验后设置 cookie `protea_session`（HttpOnly、SameSite=Strict、Path=/，经 HTTPS 访问时加 Secure，30 天）。cookie 的值是 `v1.<role>.` 加上令牌对固定串的 HMAC：服务端不存会话，重启不掉登录，换令牌即全部失效，cookie 里也没有令牌本身。
- **CSRF**：用 cookie 鉴权的写请求必须带 `x-protea-csrf: 1`（跨站表单设不了自定义头，跨站脚本又过不了同源策略）；WS 用 cookie 连接时 `Origin` 必须与 `Host` 一致。
- **限流**：同一地址 1 分钟内失败登录 10 次后返回 429。
- **审计**：每个写请求（非 GET）记一条 `control_write`（`METHOD /path`、主体 `api|console:<role>`、状态码），记忆写入另记 `memory_write`。
- **Webhook** 与 MCP OAuth 回调不用令牌：前者由插件校验签名，后者靠 `state` 匹配。
- 反向代理与 TLS 由部署层负责（[16-deployment.md](16-deployment.md) §6）；控制平面默认监听 `0.0.0.0:7788`。控制台在明文 HTTP 且非本机地址上访问时持续显示风险提示。

## 3. API 资源（摘要）

| 资源 | 主要操作 |
|---|---|
| `/api/status` | 运行信息、阶段、待处理、Provider、插件/MCP/Skills/工具、上下文、记忆、人格、24 h 用量、调度暂停与冷却、Fork、预算 |
| `/api/auth` | 登录、登出、当前身份 |
| `/api/events` | 列表（游标分页、按等级/来源/状态/类型过滤）、详情与投递记录、`POST` 推送（`console` 来源）、提升、撤回 |
| `/api/batches` | 批历史、批的事件与每轮模型调用 |
| `/api/sessions` | 主会话与 Fork 列表、转录（思考摘要开关）、手动交接、派生/取消/暂停/恢复 Fork |
| `/api/plugins` | 列表、详情（含清单）、安装（目录 / Git / tarball）、启用、禁用、重载、重启、卸载、配置（附 schema）、日志 |
| `/api/mcp/servers` | 同上 + 工具列表 + OAuth 授权流程 |
| `/api/skills` | 列表、启用/禁用、安装（目录 / Git）、正文、删除 |
| `/api/config` | 生效配置（秘密脱敏，附每个键的来源层）、`PATCH` JSON Merge Patch 写回 `config.yaml` |
| `/api/secrets` | 只能写与列出名称；不可读值 |
| `/api/permissions` | 规则与每个工具的当前决定；`PATCH` 改规则 |
| `/api/approvals` | 列表、决定（同意/拒绝） |
| `/api/audit` | 审计记录 |
| `/api/memory` | 浏览、读写、检索记忆文件（管理员） |
| `/api/persona` | 列出与读写人格 Markdown 文件（管理员） |
| `/api/budget` | 预算配置与余量；临时放行在 M6 |
| `/api/scheduler` | 暂停/恢复投递、清空 L2–L4 的 pending |
| `/api/logs` `/api/runs` | 日志检索（本次运行的内存缓冲或某次运行的 `log.jsonl`）、运行目录 |
| `/healthz` `/readyz` `/metrics` | 探针与 Prometheus |

## 4. 实时流

SSE 与 WebSocket 的消息都是总线记录的 JSON 投影，字段与存储一致。投影通过总线的 tap 读取：tap 在所有监听器之前看到每条记录，所以一个事件总是先于为它开的批和它的结算被发出（因果顺序）。

WebSocket 客户端发 `{ subscribe: [...], since?, logFilter? }`，每条订阅消息替换之前的；分组：

| 分组 | 服务端消息 |
|---|---|
| `events` | `event`、`settled`、`promoted` |
| `phase` | `phase`、`batch.started`、`batch.extended`、`batch.ended` |
| `scheduler` | `scheduler`（抢占、打断、老化、风暴冷却、Fork 让渡/恢复、暂停/恢复、清空） |
| `output` | `output`（插件输出，如 `con_send`） |
| `changes` | `fork`、`plugin`、`approval`、`mcp`、`skills`、`handoff`、`persona` |
| `usage` | `usage`（每次模型调用） |
| `logs` | `log`（按 `logFilter` 过滤） |

带 `since` 时先按游标补发之后的事件，期间到达的实时消息暂存，补发完再放出，保证不漏不重。30 s 一次 ping；未缓冲完的数据超过 8 MB 的客户端被断开。

## 5. 控制台页面（v1 最小集）

| 页面 | 内容 |
|---|---|
| 总览 | 阶段呼吸灯、待处理、上下文占用环、24 h 用量、按等级的预算、进行中的 Fork、最近的内部事件；暂停/恢复投递、手动交接 |
| 事件流 | 实时 + 历史（按等级着色、分页），调度动作与内部事件高亮；点开看信封与投递记录，提升或撤回；顶部输入框即 `console` 来源 |
| 会话 | 主会话转录（思考摘要开关）、上下文环、手动交接；批与每轮用量；Fork 列表、转录、派生、暂停/恢复/取消 |
| 插件 | 卡片：状态、来源、工具数、重启次数、最近错误；安装（Git / tarball / 目录）/启用/禁用/重载/卸载；配置表单（由 JSON Schema 生成，标出 `x-hot: false`）与 JSON 编辑；日志；清单 |
| MCP | 服务器列表、工具、延迟、添加（本地命令或远程 URL，bearer / OAuth）、OAuth 授权 |
| Skills | 列表、正文预览、诊断、安装、启停、删除 |
| 审批 | 待处理与历史、审计记录 |
| 记忆与人格 | 记忆目录树、全文检索、编辑器；人格文件编辑（钩子是代码，不在这里编辑） |
| 配置 | 生效配置与来源层、按路径或补丁修改；秘密名称管理；权限；预算；调度 |
| 日志 | 实时尾随（WS）、检索（本次或历次运行）、运行目录的关停记录与崩溃报告 |

控制台不做"聊天"界面；与助理对话走 `console` 连接器（事件流页面的输入框即是），保持"一切皆事件"。只读令牌登录时，所有修改控件隐藏。界面为中文；多语言在 M7。

## 6. CLI

```
protea serve                    # 守护进程（容器入口）
protea status
protea events push|tail|ls|show|promote|withdraw
protea batches [ls]|show <id>
protea sessions [ls]|handoff
protea forks [ls]|show|spawn|cancel|pause|resume
protea plugins ls|show|install <dir>|install --git URL|--tarball URL|enable|disable|reload|restart|config|logs|uninstall
protea mcp ls|add|rm|tools|enable|disable|restart|auth <id>
protea skills ls|show|install <dir>|install --git URL|enable|disable|rm <name>
protea config get [path] [--sources]|set <path> <value>|unset <path>
protea secrets [ls]|set <NAME>|rm <NAME>     # set 从 stdin 读值
protea scheduler [status]|pause|resume|discard --levels 3,4
protea budget
protea approvals ls|approve|deny <id>
protea memory [ls]|cat|put|search
protea persona [ls]|cat|put
protea logs [--level --component --plugin --q --since --run] [--follow]
protea logq [同上过滤] [--run ID|--all]      # 直接读 <data>/runs/*/log.jsonl，不需要守护进程
protea runs
protea audit [--kind K]
protea dev-plugin <dir> [--check]            # 本地插件开发宿主 / 协议一致性检查
protea replay --from <c> --to <c>            # M6
protea backup [--to <git-url>]               # M6
```

CLI 通过 `PROTEA_URL` 与 `PROTEA_ADMIN_TOKEN` 访问 API（`--url`、`--token`、`--data-dir` 可覆盖）；在容器内默认指向本机并从数据卷读令牌。`logs --follow` 走 WebSocket，`events tail` 与 `events push` 走 SSE。
