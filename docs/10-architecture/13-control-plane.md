# 控制平面

> 状态：Accepted（M6）· 更新：2026-11-05 · 规范：[../30-specs/05-control-api.md](../30-specs/05-control-api.md)

> **实现状态（M6）**：HTTP API 与鉴权在 `packages/control/src/`（`app.ts`、`ops.ts`、`auth.ts`），地址白名单在 `allow.ts`，WebSocket 在 `ws.ts`，SSE/WS 共用的总线投影在 `stream.ts`，控制台托管在 `static.ts`；Web 控制台是 `apps/web`；CLI 在 `apps/cli/src/`（`main.ts`、`ops.ts`，以及在数据目录上直接工作的 `admin.ts`：migrate、healthcheck、backup、restore、replay）。M6 新增预算放行、备份 API 与 `control.allowCidrs`。2026-11-05 新增账号、设置码与供应商档案：账号与会话存储在 `packages/core/src/auth/accounts.ts`，路由在 `auth.ts` 与 `providers.ts`，控制台的 `pages/Setup.tsx`、`pages/Providers.tsx`，CLI 的 `accounts.ts`（`setup`、`accounts`、`providers`）。同日新增对话（`pages/Chat.tsx`）：回复存进 `outputs` 表（`packages/core/src/events/outputs.ts`），历史由 `GET /api/chat` 提供。2026-11-06 起网页分成两部分：对话窗口（`#/`）是入口，控制台（`#/console/…`，外壳在 `apps/web/src/Console.tsx`）从对话窗口右上角进入。未实现：`/mcp` 服务端（M7）。

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

控制台用**账号**（用户名 + 密码）登录；CLI、脚本与监控用 **API 令牌**（Bearer）。两者是同一组角色：`admin` 与 `readonly`。

- **首次设置**：数据库里还没有管理员账号时，守护进程生成一次性**设置码**（4 组 4 个字符，约 78 位，不含易混字符），存入秘密 `PROTEA_SETUP_CODE`（`/data/secrets/`，0600），并在启动时把它连同控制台地址打印到标准输出（`docker logs protea` 看得到）。这一段不经过日志器，所以 `log.jsonl`、内存日志缓冲与诊断包里都没有设置码；它同时是已知秘密值，万一出现在别处的日志行里也会被脱敏。控制台检测到 `GET /api/setup` 为 `required` 时显示初始化页：输入设置码、用户名与密码创建管理员（同时登录），再引导配置模型供应商（[12-model-providers.md](12-model-providers.md) §3）。账号建好后设置码文件删除、不再有效；之后重启也不再打印。也可以在容器里完成：`docker exec -it protea protea setup --user <name>`（CLI 从数据卷读设置码，密码不回显）。
- **账号**：`accounts` 表；密码用 scrypt（N=2¹⁵、r=8、p=1，32 MiB，约 0.1 s）加 16 字节盐，哈希串自带参数便于以后调高；用户名不区分大小写。管理员可以增删账号、改角色、重设密码（重设会结束该账号的全部会话）；每个账号可以改自己的密码。最后一个管理员不能删除或降级。忘记密码：`docker exec -it protea protea accounts passwd <name>`（CLI 用 API 令牌）。
- **控制台会话**：登录成功后设置 cookie `protea_session`（HttpOnly、SameSite=Strict、Path=/，经 HTTPS 访问时加 Secure，30 天）。cookie 值是随机的 `v2.<32 字节>`，数据库 `auth_sessions` 只存它的 SHA-256，所以会话可以单独注销（退出、改密码、删账号都会结束会话），重启不掉登录。
- **API 令牌**：秘密 `PROTEA_ADMIN_TOKEN`。首次启动若未设置，生成随机值写入 `/data/secrets/PROTEA_ADMIN_TOKEN`（0600），日志只给出文件路径、不打印令牌；容器内的 CLI 会自动读取该文件。API 与 WS 用 `Authorization: Bearer`。控制台登录页也可以"改用 API 令牌登录"（恢复用）：这样的会话记着令牌指纹，换令牌即失效。
- **只读令牌**（可选）：秘密 `PROTEA_READONLY_TOKEN`（名字可用 `control.readonlyTokenSecret` 改）存在时生效。只允许 GET 与 WS 订阅，并且读不到 `/api/memory*`、`/api/persona*`、`/api/secrets*`、`/api/diagnostics*`、`/api/accounts*`；用于监控面板与 Prometheus。只读账号的限制相同。
- **CSRF**：用 cookie 鉴权的写请求必须带 `x-protea-csrf: 1`（跨站表单设不了自定义头，跨站脚本又过不了同源策略）；WS 用 cookie 连接时 `Origin` 必须与 `Host` 一致。
- **限流**：同一地址 1 分钟内失败的登录、设置码尝试与改密码合计 10 次后返回 429。
- **地址白名单**（M6）：`control.allowCidrs` 非空时，只有其中的地址与回环地址能访问 HTTP 与 WS（在鉴权之前判断）；`/hooks/*` 不受限。反向代理后面看到的是代理的地址，此时应在代理上做白名单。
- **审计**：每个写请求（非 GET）记一条 `control_write`（`METHOD /path`、主体 `api:<role>` / `console:<用户名>` / `console:<role>`、状态码），记忆写入另记 `memory_write`；用设置码建管理员另记一条。
- **Webhook** 与 MCP OAuth 回调不用令牌：前者由插件校验签名，后者靠 `state` 匹配。
- 反向代理与 TLS 由部署层负责（[16-deployment.md](16-deployment.md) §6）；控制平面默认监听 `0.0.0.0:7788`。控制台在明文 HTTP 且非本机地址上访问时持续显示风险提示。

## 3. API 资源（摘要）

| 资源 | 主要操作 |
|---|---|
| `/api/status` | 运行信息、阶段、待处理、Provider、插件/MCP/Skills/工具、上下文、记忆、人格、24 h 用量、调度暂停与冷却、Fork、预算 |
| `/api/setup` | 是否需要初始化；用设置码创建第一个管理员 |
| `/api/auth` | 账号或令牌登录、登出、当前身份、改自己的密码 |
| `/api/accounts` | 账号列表、添加、改角色或重设密码、删除（管理员） |
| `/api/providers` | 供应商档案（设置、密钥状态、就绪）、保存（含密钥）、删除、默认与按角色选择、测试连接、模型列表 |
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
| `/api/budget` | 预算配置、余量、被扣住的事件；临时放行（M6） |
| `/api/backups` | 列出与在线创建备份、推送人格与记忆到 Git（M6） |
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
| `output` | `output`（插件输出，如 `con_send`；带存储的 `id` 与 `batchId`） |
| `changes` | `fork`、`plugin`、`approval`、`mcp`、`skills`、`handoff`、`persona` |
| `usage` | `usage`（每次模型调用） |
| `logs` | `log`（按 `logFilter` 过滤） |

带 `since` 时先按游标补发之后的事件，期间到达的实时消息暂存，补发完再放出，保证不漏不重。30 s 一次 ping；未缓冲完的数据超过 8 MB 的客户端被断开。

## 5. 网页：对话窗口与控制台

网页分成两种体验，共用登录与实时连接：

- **对话窗口**（`#/`，登录后的默认页）：只做一件事——和助理说话。
  - 布局：顶部只有助理名称与状态（在线 / 正在思考 / 正在使用工具 / 未配置模型 / 连接中断）、"控制台"入口和账号菜单；中间是居中的对话；底部是输入框。
  - 消息：回复按正文排版（带头像，渲染常见 Markdown：代码块、列表、粗体、链接，可一键复制）；你的消息是气泡。同一方几分钟内的连续消息合成一组，只显示一次时间。按天分隔。
  - 状态：处理中显示"正在思考…"等提示；消息下只在值得说时标出状态（等待处理、没有回复及原因、被打断、已读没有回复），失败的可以"重新发送"，模型问题附"检查模型设置"。由定时提醒等其他事件引起的回复注明来源。
  - 输入：Enter 发送、Shift+Enter 换行（手机上 Enter 换行，用按钮发送）；助理忙时可"打断并发送"（`interrupt`）；空对话给出几个示例。
  - 审批：待批准的操作以卡片出现在输入框上方，直接批准或拒绝；时间线里留一行说明。
  - 其他：向上滚动自动加载更早的消息；离开底部时有"回到最新"按钮并提示新消息；断线重连后补齐。只读账号只能看。
  - 对话窗口只是 `console` 连接器的视图：发出的仍是普通的 `console` 事件（和事件流页、`protea events push` 一样经调度器、等级与抢占），回复仍是 `con_send` 工具调用的输出，所以"一切皆事件"不变。
- **控制台**（`#/console/<页面>`，旧的 `#/<页面>` 链接仍然有效）：运维与配置。左侧分组导航（运行：总览、事件流、会话、审批；能力：模型、插件、MCP、Skills、记忆与人格；系统：配置、日志），顶端是"返回对话"；顶栏有面包屑、运行阶段、实时连接状态与账号菜单；每页有统一的标题、说明与操作按钮区。窄屏时导航收进抽屉。

控制台页面（v1 最小集）：

| 页面 | 内容 |
|---|---|
| 总览 | 阶段、待处理、上下文占用环、24 h 用量、按等级的预算、进行中的 Fork、最近的内部事件；暂停/恢复投递、手动交接 |
| 事件流 | 实时 + 历史（按等级着色、分页），调度动作与内部事件高亮；点开看信封与投递记录，提升或撤回；顶部输入框即 `console` 来源 |
| 会话 | 主会话转录（思考摘要开关）、上下文环、手动交接；批与每轮用量；Fork 列表、转录、派生、暂停/恢复/取消 |
| 模型 | 供应商档案卡片（协议、地址、模型、密钥状态、服务的角色、就绪）；添加/编辑（厂商预设、协议、地址、API Key、按角色的模型、获取模型列表、测试连接、高级设置）；设为默认；按角色选择供应商 |
| 插件 | 卡片：状态、来源、工具数、重启次数、最近错误；安装（Git / tarball / 目录）/启用/禁用/重载/卸载；配置表单（由 JSON Schema 生成，标出 `x-hot: false`）与 JSON 编辑；日志；清单 |
| MCP | 服务器列表、工具、延迟、添加（本地命令或远程 URL，bearer / OAuth）、OAuth 授权 |
| Skills | 列表、正文预览、诊断、安装、启停、删除 |
| 审批 | 待处理与历史、审计记录 |
| 记忆与人格 | 记忆目录树、全文检索、编辑器；人格文件编辑（钩子是代码，不在这里编辑） |
| 配置 | 生效配置与来源层、按路径或补丁修改；账号（添加、角色、重设密码、删除）与自己的密码；秘密名称管理；权限；预算；调度 |
| 日志 | 实时尾随（WS）、检索（本次或历次运行）、运行目录的关停记录与崩溃报告 |

首次访问（还没有管理员账号）时显示初始化页：设置码 + 管理员账号 → 模型供应商 → 完成，之后进入对话窗口（也可以直接打开控制台）。只读账号或只读令牌登录时，所有修改控件隐藏。界面为中文；多语言在 M7。

## 6. CLI

```
protea serve                    # 守护进程（容器入口）
protea migrate                  # 数据库迁移（先快照；镜像入口脚本每次启动都跑）
protea healthcheck              # /healthz 应答时退出码 0（镜像 HEALTHCHECK）
protea status [--json]
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
protea budget [release [--levels 2,3,4] [--hard-cap] [--hours 24]]
protea approvals ls|approve|deny <id>
protea memory [ls]|cat|put|search
protea persona [ls]|cat|put
protea logs [--level --component --plugin --q --since --run] [--follow]
protea logq [同上过滤] [--run ID|--all]      # 直接读 <data>/runs/*/log.jsonl，不需要守护进程
protea runs
protea audit [--kind K]
protea dev-plugin <dir> [--check]            # 本地插件开发宿主 / 协议一致性检查
protea backup [--to DIR|GIT_URL] [--archive] [--include-workspace] [--include-runs]
protea restore <backup-dir|.tar.gz> [--force] # 守护进程须已停止；被替换的文件移到 backups/pre-restore-*
protea replay [--from C] [--to C] [--provider recorded|echo|config] [--run ID] [--out DIR]
```

CLI 通过 `PROTEA_URL` 与 `PROTEA_ADMIN_TOKEN` 访问 API（`--url`、`--token`、`--data-dir` 可覆盖）；在容器内默认指向本机并从数据卷读令牌。`logs --follow` 走 WebSocket，`events tail` 与 `events push` 走 SSE。`migrate`、`healthcheck`、`backup`、`restore`、`replay` 与 `logq` 直接读写数据目录，不经 API（守护进程停着也能用）。容器里以 root 运行的 CLI（`docker exec` 的默认）会按 `PROTEA_RUN_AS` 先降为守护进程的用户，写出的文件属主不变。
