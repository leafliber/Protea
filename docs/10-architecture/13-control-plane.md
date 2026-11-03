# 控制平面

> 状态：Draft · 更新：2026-11-03 · 规范：[../30-specs/05-control-api.md](../30-specs/05-control-api.md)

## 1. 组成

| 组件 | 技术 | 作用 |
|---|---|---|
| HTTP API | Hono（Node 22 原生 `fetch` 风格，轻量） | 一切运维操作的唯一入口；控制台与 CLI 都只调用它 |
| 实时流 | 同一端口；M0 为 SSE `/api/stream`，M5 增加 WebSocket `/ws` | 实时事件流、会话阶段、批生命周期、插件输出 |
| Web 控制台 | Vite + React，静态文件由守护进程托管 | 浏览器运维界面 |
| CLI | `protea` 命令（镜像内置，也可本地安装） | 脚本化与紧急操作 |
| Webhook 入口 | `/hooks/*` | 属于 `webhook` 事件源，但共享端口 |
| MCP 服务端 | `/mcp`（M7） | Protea 作为 MCP 服务器 |

所有组件走同一个监听端口（默认 7788），便于单容器单端口暴露。

## 2. 鉴权

- **管理员令牌**：秘密 `PROTEA_ADMIN_TOKEN`。首次启动若未设置，生成随机值写入 `/data/secrets/PROTEA_ADMIN_TOKEN`（0600），日志只给出文件路径、不打印令牌；容器内的 CLI 会自动读取该文件。API 与 WS 用 `Authorization: Bearer`；控制台登录页存入 cookie（HttpOnly、SameSite=Strict）。
- **只读令牌**（可选）：仅允许 GET 与 WS 订阅，用于监控面板。
- **Webhook**：各自签名校验，不用管理员令牌。
- 反向代理与 TLS 由部署层负责（[16-deployment.md](16-deployment.md) §6）；控制平面默认只监听 `0.0.0.0:7788`，并在未配置 TLS 与非回环访问时在控制台持续提示风险。

## 3. API 资源（摘要）

| 资源 | 主要操作 |
|---|---|
| `/api/status` | 运行信息、阶段、预算、插件摘要 |
| `/api/events` | 列表（游标分页、按等级/来源/状态过滤）、`POST` 推送（作为 `console` 来源，L1） |
| `/api/batches` | 批历史与其回合 |
| `/api/sessions` | 主会话与 Fork 列表、转录读取、手动交接、取消 Fork、恢复 Fork |
| `/api/plugins` | 列表、安装、启用、禁用、重载、卸载、配置读写、日志 |
| `/api/mcp/servers` | 同上 + 工具列表 + OAuth 授权流程 |
| `/api/skills` | 列表、启用/禁用、安装、正文 |
| `/api/config` | 读取生效配置（脱敏）、`PATCH` 覆盖、查看层叠来源 |
| `/api/secrets` | 只允许写与列出名称；不可读值 |
| `/api/approvals` | 列表、决定（同意/拒绝） |
| `/api/memory` | 浏览与编辑记忆文件（管理员） |
| `/api/budget` | 预算配置与余量；临时放行 |
| `/api/scheduler` | 清空队列（discard）、暂停/恢复投递、修改等级参数 |
| `/healthz` `/readyz` `/metrics` | 探针与 Prometheus |

## 4. WebSocket 主题

客户端订阅：`events`（可带 `since`）、`phase`、`logs`（可带过滤）、`usage`。服务端消息是总线记录的 JSON 投影，字段与存储一致。

## 5. 控制台页面（v1 最小集）

| 页面 | 内容 |
|---|---|
| 总览 | 阶段呼吸灯、今日用量按等级、pending 队列、活跃 Fork、最近 internal 事件 |
| 事件流 | 实时 + 历史，按等级着色，点开看信封与投递记录；手动推送事件、promote、撤回 |
| 会话 | 主会话转录（含 thinking 摘要开关）、Fork 列表与转录、上下文占用环、手动交接 |
| 插件 | 卡片：状态、等级、工具数、最近错误；安装/启用/禁用/重载；配置表单（由 JSON Schema 生成，`x-hot` 标注） |
| MCP | 服务器列表、工具、延迟、OAuth 授权 |
| Skills | 列表、正文预览、诊断 |
| 审批 | 待处理与历史 |
| 记忆 | 目录树与编辑器（管理员） |
| 配置 | 生效配置与来源层、秘密名称管理 |
| 日志 | 尾随与搜索 |

控制台不做"聊天"界面；与助理对话走 `console` 连接器（事件流页面的输入框即是），保持"一切皆事件"。

## 6. CLI

```
protea serve                    # 守护进程（容器入口）
protea status
protea events tail [--level 1] [--source telegram]
protea events push "text" [--level 1 --trigger flush]
protea plugins ls|install <dir>|enable|disable|reload|restart|config|uninstall <id>   # M2 ✓
protea mcp ls|add|rm|tools <id>
protea skills ls|install <git-url>
protea config get|set <path> [value]
protea secrets set <NAME>       # 从 stdin 读值
protea approvals ls|approve|deny <id>                  # M2 ✓
protea sessions handoff|forks
protea replay --from <c> --to <c>
protea backup [--to <git-url>]
protea dev-plugin <dir> [--check]                      # M2 ✓ 本地插件开发宿主 / 协议一致性检查
```

CLI 通过 `PROTEA_URL` 与 `PROTEA_ADMIN_TOKEN` 访问 API；在容器内默认指向本机。
