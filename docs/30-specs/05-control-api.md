# 规范：控制 API

> 状态：Accepted（M6）· 更新：2026-11-05 · 设计：[../10-architecture/13-control-plane.md](../10-architecture/13-control-plane.md)

基址 `http://host:7788`。JSON；错误形态 `{ error: { code, message, details? } }`。鉴权 `Authorization: Bearer <token>`（API 令牌，CLI 与脚本用）或控制台会话 cookie（账号登录，见"鉴权"）。分页：事件用 `?cursor=&limit=`（返回 `nextCursor`），批用 `?before=&limit=`。类型定义在 `@protea/protocol`（`control.ts`）。

## 鉴权

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/setup` | `{ required }`：还没有管理员账号时为 true（控制台显示初始化页）。**不需要令牌** |
| POST | `/api/setup` | `{ code, username, password }`：用设置码创建第一个管理员账号并登录（设置 cookie）→ 201 `{ role: admin, via: cookie, username }`。设置码不对 401 `bad_code`；用户名或密码不合规 400；已有管理员 409 `done`。与登录共用失败限流。**不需要令牌** |
| POST | `/api/auth/login` | `{ username, password }` → `{ role, via: cookie, username }`；或 `{ token }`（管理员或只读 API 令牌）→ `{ role, via: cookie }`。成功都设置 cookie `protea_session`（HttpOnly、SameSite=Strict、Path=/、HTTPS 下 Secure、30 天）。失败 401；同一地址 1 分钟内失败 10 次后 429。**不需要令牌** |
| POST | `/api/auth/logout` | 结束这个会话（服务端删除）并清除 cookie |
| GET | `/api/auth/whoami` | `WhoAmIResponse`：`{ role: admin\|readonly, via: bearer\|cookie, username? }`；未登录 401 |
| POST | `/api/auth/password` | `{ current, password }`：改自己的密码（只读账号也可以）；该账号的其他会话全部结束。只接受用密码登录的会话；需要 CSRF 头 |

- 角色：`admin` 可以做一切；`readonly`（只读账号，或秘密 `PROTEA_READONLY_TOKEN` 存在时的只读令牌）只有 GET 与 WS 订阅，且 `/api/memory*`、`/api/persona*`、`/api/secrets*`、`/api/diagnostics*`、`/api/accounts*` 返回 403。
- 会话存在数据库 `auth_sessions`（只存 cookie 值的 SHA-256）。cookie 值形如 `v2.<随机 32 字节>`。用令牌登录的会话记着令牌指纹：令牌一换，这些会话就失效。
- 用 cookie 鉴权的非 GET 请求必须带 `x-protea-csrf: 1`，否则 403 `csrf`。
- 所有非 GET 请求（鉴权通过之后）记审计 `control_write`：`summary` 为 `METHOD /path`，`owner` 为 `api:<role>`（令牌）、`console:<用户名>`（账号）或 `console:<role>`（用令牌登录的控制台会话），`outcome` 为状态码。
- `control.allowCidrs` 非空时（M6），客户端地址不在其中且不是回环地址的请求一律 403 `forbidden`（在鉴权之前，`/healthz` 也一样）；`/hooks/*` 不受限。WebSocket 升级同样检查，被拒时直接回 `403`。

## 账号（管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/accounts` | `{ accounts: AccountInfo[] }`：`{ id, username, role, createdAt, updatedAt, lastLoginAt }`（没有密码哈希） |
| POST | `/api/accounts` | `{ username, password, role? }`（role 默认 `admin`）→ 201 `{ account }`；重名 409 |
| PATCH | `/api/accounts/:username` | `{ role?, password? }`：改角色或重设密码（重设会结束该账号的全部会话，管理员给自己改时保留当前会话）→ `{ account }` |
| DELETE | `/api/accounts/:username` | 删除账号与它的会话 |

用户名 1–32 个字母、数字、`.`、`_`、`-`（不区分大小写）；密码至少 8 个字符。最后一个管理员不能删除，也不能降为只读（409 `last_admin`）。

## 模型供应商

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/providers` | `ProvidersResponse`：`{ default, roles, profiles: ProviderProfileInfo[], presets, protocols, defaults, ready, problem? }`。每个档案带完整设置（默认值已填入）、实际使用的地址 `endpoint`、服务的角色、密钥状态 `key: { required, set, source: env\|file\|null }`（从不含密钥值）、`ready` 与 `problem`。只读角色可看 |
| PUT | `/api/providers/:id` | `PutProviderRequest`：`{ profile, apiKey?, makeDefault? }`。校验后把档案写进 `config.yaml` 的 `providers.profiles.<id>`（只写与默认值不同的键，外加 protocol 与 models）；`apiKey` 为字符串时存为该档案的秘密（默认 `PROVIDER_<ID>_API_KEY`），为 null 时删除，省略则不变。第一个档案自动成为默认。立即生效（下一次模型请求起）→ 新的 `ProvidersResponse`；无效 400 |
| DELETE | `/api/providers/:id` | 删除档案；它若是默认，换成下一个已配置的档案（没有则为 null）；指向它的角色恢复跟随默认；默认名字的密钥秘密一并删除 |
| PATCH | `/api/providers` | `{ default?, roles? }`：换默认档案，或按角色指定（`{ roles: { cheap: "local" } }`；值为 null 恢复跟随默认） |
| POST | `/api/providers/test` | `ProbeProviderRequest`：`{ id, profile?, apiKey?, role? }`。对档案（已保存的，或表单里尚未保存的 `profile`，可带刚输入的 `apiKey`）的模型发一个很小的请求（最多 256 个输出 token）→ `{ ok: true, ms, model, reply?, stopReason? }` 或 `{ ok: false, ms, kind, error, status? }`。不重试、60 s 超时；`apiKey` 只在内存里用一次 |
| POST | `/api/providers/models` | 同上的请求体；返回该接口的模型名（`GET /v1/models`）→ `{ ok: true, models }` |

## 状态
## 状态

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活。不需要令牌 |
| GET | `/readyz` | `{ ready, reasons }`，不就绪 503：Provider 未就绪、已启用但 failed 的插件或 MCP 服务器、`observability.requiredPlugins` 中没有 running 的插件、SQLite 拿不到写锁、投递被暂停。不需要令牌 |
| GET | `/metrics` | Prometheus 文本格式（[15-observability.md](../10-architecture/15-observability.md) §3）；需要令牌（只读即可），`control.publicMetrics: true` 时不需要 |
| GET | `/api/status` | `StatusResponse`：`{ runId, version, startedAt, uptimeSec, phase, batchId, pending: {0..4}, provider: { id（主会话的供应商档案，未配置为 none）, protocol?, mainModel, ready, problem? }, setupRequired, plugins, mcp, skills, tools, context, memory, persona, usage24h, scheduler: { paused, cooldowns }, forks: ForkInfo[], budget: { enforced, dailyUsd, levels: {0..4: { spentUsd, tokens, limitUsd, usedRatio }} } }` |

## 事件与批

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/events?level=&source=&state=&type=&since=&until=&cursor=&limit=&order=` | `{ events, nextCursor }`。默认新的在前；`cursor` 取比它旧的一页，`nextCursor` 为 null 表示没有更多。`level` 是最大等级，`state` 可逗号分隔，`limit` ≤ 1000 |
| GET | `/api/events/:cursor` | `{ event, delivery }`（信封 + 投递记录） |
| GET | `/api/blobs/:handle` | 图片内容（仅管理员，`x-content-type-options: nosniff`）；不存在或已过期 404 |
| POST | `/api/blobs` | 存一张图片（仅管理员）：`{ dataBase64 }` → 201 `{ handle, mime, size }`；类型按内容判断，不是图片或超过 `vision.maxImageKb` 时 422 |
| POST | `/api/chat/messages` | 主人在 `webchat` 里说话：`{ text, images?: [{ handle, mime }], trigger?: flush \| interrupt }`（有图片时 `text` 可为空；图片要先上传，否则 400）→ 同 `POST /api/events` 的回执 |
| GET | `/api/chat?platform=&before=&limit=` | 一个对话的历史（`platform` 默认 `webchat`，`all` 为全部平台）：`ChatHistoryResponse` `{ items, batches, before }`。`items` 由旧到新，每条带 `platform`，是 `chat.message` 事件（`kind: owner`，带 `cursor`、`state`、`sender`）与 `chat_send` 发出的消息（`kind: reply`，审批提示为 `notice`）；分界之前的 `console` 对话算作 `webchat`；`batches` 是这些条目所在批的结局（`endReason`、`sources`、`replied`，`model_error` 时带 `error`）。`before` 取更早的一页（为 null 表示没有更多），`limit` ≤ 200，默认 50 |
| GET | `/api/chat/batches?ids=a,b` | `{ batches }`：这些批的结局（同上；至多 100 个，未知的省略）。控制台在 `batch.ended` 后用它刷新状态 |
| POST | `/api/events` | 推送 `{ text, level?, trigger?, tags? }`（来源固定为 `console`，senderKey 为 `api:admin`、`console:<用户名>` 或 `console:admin`）→ 201 `PushEventResponse` |
| POST | `/api/events/:cursor/promote` | `{ trigger }`（默认 `flush`，不接受 `store`）→ `{ event }`；只对 pending/archived 事件，否则 409 |
| POST | `/api/events/:cursor/withdraw` | → `{ event }`（状态 `withdrawn`）；在途或已结束的事件 409 |
| GET | `/api/batches?limit=&before=&session=` | `{ batches: BatchInfo[] }`，新的在前；`BatchInfo`：`{ id, level, reason, sessionId, startedAt, endedAt, rounds, endReason }` |
| GET | `/api/batches/:id` | `{ batch, events, rounds: UsageInfo[] }`（批里的事件与每次模型调用） |
| GET | `/api/batches/:id/trace` | `BatchTraceResponse` `{ batch, events, steps }`：从转录、输出和事件重建的步骤（`events` / `model` / `tool_result` / `output` / `mark`），跨交接；转录已清理时 `steps` 为空 |

## 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions` | 主会话 + Fork 列表（`{ sessions: [{ id: 'main', kind, phase, batchId }, { kind: 'fork', ...ForkInfo }] }`） |
| GET | `/api/sessions/:id/transcript?from=&limit=&thinking=summary\|none` | `{ total, from, messages }`；`:id` 为 `main` 或 Fork id；`summary`（默认）保留思考文本但去掉签名，`none` 去掉思考块 |
| GET | `/api/sessions/:id/context?from=&limit=` | 仅管理员。`SessionContextResponse`：下一次请求的系统段（正文与 token）、工具（来源、是否按需加载）、合并后的消息（分页）、合计，主会话另有阈值与上次缓存命中率。只读取，不改变转录；秘密值已脱敏 |
| GET | `/api/sessions/forks` · `/api/sessions/forks/:id` | Fork 列表（未结束的 + 最近 10 个已结束的）、详情（`ForkInfo`） |
| POST | `/api/sessions/main/handoff` | 手动交接 `{ reason? }`：空闲时立即执行，返回 `{ handedOff, transcript?, notes?, dropped?, kept? }`（没有可丢弃的内容时 `handedOff: false`）；忙时 202 `{ scheduled: true }`，在下一批开始时执行 |
| POST | `/api/sessions/forks` | `{ goal, level?(默认 3), model?: fork\|main\|cheap, context?, tools?, maxTurns?, reportTo?: main\|none }` → 201 `ForkInfo`；被拒（并发上限等）422 |
| POST | `/api/sessions/forks/:id/cancel` · `/pause` · `/resume` | 返回 `ForkInfo`。`pause`：运行中的在下一个边界停下、排队的不再启动（`pauseReason: operator`，重启后保留）；`resume` 只恢复运营暂停；对已结束的 Fork 无副作用 |

## 插件 / MCP / Skills

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` · `/api/plugins/:id` | 列表、详情（`PluginStatus` + `manifest`：显示名、说明、版本、等级、触发、声明的秘密、目录、清单错误与警告） |
| POST | `/api/plugins` | `{ path, enable? }`、`{ source: git, url, ref?, subdir?, enable? }` 或 `{ source: tarball, url, subdir?, enable? }`：取到本地临时目录（Git 浅克隆；tarball ≤ 50 MB，单层包装目录自动展开），校验清单后复制到 `/data/plugins/<id>`（不含 `.git`）→ 201 `PluginStatus`。来源里必须有可直接运行的入口；指向来源外的符号链接、越界的 `subdir` 一律 400 |
| POST | `/api/plugins/:id/enable` · `/disable` · `/reload` · `/restart` | 返回 `PluginStatus`；`restart` 从 failed 恢复 |
| DELETE | `/api/plugins/:id?keepData=true` | 卸载（须先禁用）；返回 `{ ok, replacedBy }`（重新出现的同名内置插件） |
| GET | `/api/plugins/:id/config` | `{ config, schema, coldKeys }`：`schema` 为插件的 JSON Schema（没有则 null）；`x-secret` 键若不是 `${secret:…}` 引用则显示为 `********`；`coldKeys` 是 `x-hot: false` 的键 |
| PATCH | `/api/plugins/:id/config` | `{ config }` 整体替换：按 schema 校验，写回 `config.yaml` 并应用 |
| GET | `/api/plugins/:id/logs?limit=&level=&q=&since=` | `{ logs }`：本次运行中带该插件字段的日志 |
| GET | `/api/mcp/servers` · `/api/mcp/servers/:id` | `{ servers: McpServerStatus[] }` · `McpServerStatus` |
| POST | `/api/mcp/servers` | `{ id, ...配置项 }`（同 `mcp.servers.<id>`）：校验、写回 `config.yaml`、启动并等它就绪或失败；新建 201、替换 200；配置无效 400 |
| POST | `/api/mcp/presets/browser` | 写入并启动内置浏览器（`mcp.servers.browser`）：`{ noSandbox?: boolean }` → 201 `McpServerStatus`；镜像里没有浏览器时 409 |
| DELETE | `/api/mcp/servers/:id` | 停止、移除工具、从 `config.yaml` 删除 |
| POST | `/api/mcp/servers/:id/enable` · `/disable` · `/restart` | 返回 `McpServerStatus`；`restart` 从 failed 恢复 |
| GET | `/api/mcp/servers/:id/tools` | `{ tools: McpToolInfo[] }`（含被 allow/deny 过滤掉的，标 `filtered`） |
| POST | `/api/mcp/servers/:id/oauth/start` | `{ authorizeUrl?, state }`：开始或继续 OAuth 授权 |
| GET | `/api/mcp/oauth/callback?code&state` | **不需要令牌**（浏览器回跳，靠 `state` 匹配）；返回一页 HTML；未知 state 400 |
| GET | `/api/skills` · `/api/skills/<name>` | `{ skills: SkillInfo[] }`（含被拒绝的目录及原因）· 详情加 `body` 与 `files`；名字是路径的剩余部分（MCP prompt 型 Skill 的名字含 `:` 与 `/`，需 URL 编码） |
| POST | `/api/skills` | `{ path }`、`{ gitUrl, ref?, subdir? }` 或 `{ source, url, … }`（同插件）→ 201 `SkillInfo` |
| POST | `/api/skills/<name>/enable` · `/disable` | 写回 `skills.disabled` |
| DELETE | `/api/skills/<name>` | 删除用户 Skill（`/data/skills/<name>`）；返回 `{ ok, replacedBy }` |

## 配置、秘密、权限、预算、审计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | `ConfigResponse`：`{ config, layers, sources, hot }`。`config` 是生效配置，其中出现的秘密值替换为 `[REDACTED:<NAME>]`；`layers` 是来源层（低到高）；`sources` 是每个叶子键（点分路径，数组算叶子）的来源 `defaults \| file \| environment`；`hot` 是不需重启即生效的顶层分节 |
| PATCH | `/api/config` | JSON Merge Patch（RFC 7386：对象合并、`null` 删除、其余替换；空对象不产生键；YAML 里的数字键按原样匹配）。与环境变量层合并后整体校验，通过才原子写回 `config.yaml`（保留注释），随即重载 → `{ changed: string[], restartRequired: string[] }`（改动涉及的非热分节）；无效 400 且文件不变 |
| GET | `/api/secrets` | `{ secrets: SecretInfo[] }`：`{ name, source: env\|file, shadowedFile }`，永远不含值 |
| PUT | `/api/secrets/:name` | 请求体为纯文本值（不能为空）；名字须为 `UPPER_CASE`；原子写入 `/data/secrets/<NAME>`（0600）→ `{ ok, secret }`。使用它的插件与 MCP 服务器在重启时取到新值 |
| DELETE | `/api/secrets/:name` | 删除文件 → `{ ok, stillSetByEnvironment }`；管理员令牌不能删（400）；没有这个秘密 404 |
| GET | `/api/permissions` | `{ settings, tools: [{ name, owner, policy, rule }] }`：规则与每个工具当前的决定 |
| PATCH | `/api/permissions` | `permissions` 分节的 Merge Patch（如 `{ tools: { chat_send: ask } }`，`null` 删除规则），经 `PATCH /api/config` → 合并后的结果 |
| GET | `/api/approvals?state=pending` | `{ approvals: ApprovalInfo[] }`（state：pending、approved、denied、expired、used） |
| GET | `/api/permissions/mode` | `PermissionModeInfo`：`{ mode, baseline, override?: { mode, until, by, setAt }, paused?: { at, reason }, auto: { since, allowed, held, judge: { model, ready, problem? } }, bypassMaxMs }` |
| POST | `/api/permissions/mode` | `{ mode: ask\|auto\|bypass\|locked, forMs? }`，返回 `PermissionModeInfo`；不带 `forMs` 写成基线，`bypass` 必须带 `forMs`，否则 400 |
| GET | `/api/approvals/grants` | `{ grants: ApprovalGrantInfo[] }`：时限授权，新的在前 |
| POST | `/api/approvals/grants/:id/revoke` | 提前结束授权，返回 `ApprovalGrantInfo` |
| POST | `/api/approvals/:id/decide` | `{ decision: approve\|deny, grantMs?, note? }`；`grantMs`：同意时还在这段时间内放行同一组工具（上限 `permissions.grantMaxMs`）；决定者记为 `console:admin`；已决定或已过期 → 409 |
| GET | `/api/budget` | `{ settings, status: BudgetStatus }`。`status`：`enforced`、`dailyUsd`、`hardDailyUsd`、`spentUsd`（24 h 合计）、`hardCapReached`、`hardCapReleasedUntil?`，`levels.<L>`：`spentUsd`、`tokens`、`limitUsd`、`usedRatio`、`held?`（被预算改了投递方式且仍在等的事件数）、`releasedUntil?` |
| PATCH | `/api/budget` | `budget` 分节的 Merge Patch（热更新） |
| POST | `/api/budget/release` | `{ levels?: [2,3,4], hardCap?: boolean, hours?: number }`（默认 L2–L4、设置了硬上限时连同硬上限、24 h；`hours` ≤ 168）：在这段时间内不对这些等级强制执行，被扣住的事件恢复原来的投递方式 → `{ levels, hardCap, untilMs, until, promoted: number[] }`；记 L4 事件 `budget.released`。放行记在 kv，重启后仍有效（M6） |
| GET | `/api/audit?kind=&tool=&limit=` | `{ audit: AuditRow[] }`，新的在前；kind：`tool_call`、`tool_blocked`、`approval_requested`、`approval_decided`、`approval_expired`、`memory_write`、`control_write` |

## Webhook

| 方法 | 路径 | 说明 |
|---|---|---|
| 任意 | `/hooks/<name>[/…]` | **不需要**管理员令牌；转给声明了该 hook 的运行中插件（`http/request`），由插件校验签名。没有插件服务该名字 → 404；插件出错 → 502；请求体上限 1 MB |

## 调度器

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/scheduler` | `{ paused, cooldowns, pending }` |
| POST | `/api/scheduler/pause` · `/resume` | 暂停投递（事件继续入库，正在运行的批跑完，抢占也等待）→ `{ paused, changed }`；暂停记为内部事件 `scheduler.paused` 与调度动作 `paused`，并在重启后保持 |
| POST | `/api/scheduler/discard` | `{ levels: [3,4] }`（只能 2–4）把这些等级的 pending 事件结算为 `discarded` → `{ discarded, cursors }`；记内部事件 `scheduler.discarded` |

## 记忆与人格

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/memory/tree` | `{ files: [{ path, size, mtime }] }`（相对记忆目录） |
| GET | `/api/memory/file?path=` | `{ path, text }`；`path` 可写 `notes/a.md` 或 `/memories/notes/a.md`；越界 400，不存在 404 |
| PUT | `/api/memory/file?path=` | 请求体为纯文本，整份写入（原子替换），记审计 `memory_write`；越界或超过 1 MB 400 |
| GET | `/api/memory/search?q=&paths=&limit=` | `{ hits: [{ path, snippet, summary? }] }`，搜索全部层 |
| GET | `/api/memory/board?closed=1` | `{ rev, items, closed? }`；`closed` 是最近关闭的条目 |
| POST | `/api/memory/board` | 请求体是 `BoardCommand`（`add` / `update` / `done` / `drop`），返回 `{ ok, receipt, rev }`，记审计 `memory_write`；无效 400 |
| GET | `/api/memory/dream` | `DreamStatus`：是否启用或停用、是否运行中、最近一次的日期与结果 |
| POST | `/api/memory/dream` | 立即整理，202 `{ started, forkId }`；已在运行或预算不允许时 409。同时解除连续失败后的停用 |
| GET | `/api/persona/files` | `{ files: [{ path, size, mtime }] }`：人格目录下的 `.md`（`SOUL.md`、`OPERATING.md`、`USER.md` 总在列表里，不存在时 size 为 0），含 `plugins/<id>/ENV_PROMPT.md` |
| GET | `/api/persona/file?path=` | `{ path, text }`；不存在 404 |
| PUT | `/api/persona/file?path=` | 纯文本整份写入（≤ 256 KB，原子替换），随即重载人格，从下一次模型请求生效；只接受目录内的 `.md`（钩子是代码，不开放）→ 400 |

## 日志与运行目录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/logs?level=&component=&plugin=&q=&since=&until=&batch=&session=&cursor=&tool=&limit=&run=` | `{ run, logs: LogRecord[] }`，旧的在前、最多 `limit`（≤ 5000）条最新的。没有 `run`（或为本次运行）时查内存里最近 5000 行；否则读 `/data/runs/<run>/log.jsonl`。`level` 是最低级别（名字或数字），`since`/`until` 接受毫秒或日期，`q` 是整行的不区分大小写子串；未知级别 400 |
| GET | `/api/runs` | `{ current, runs: [{ id, startedAt, logBytes, crashes, hasShutdown }] }`，新的在前 |
| GET | `/api/runs/:id` | `{ id, info, shutdown, crashes: [{ file, report }] }` |

## 备份（M6）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/backups` | `{ dir, backups: [{ name, createdAt?, bytes?, archive }] }`：`<data>/backups` 下的备份，新的在前 |
| POST | `/api/backups` | `{ archive?, includeWorkspace?, includeRuns? }` → `{ path, manifest }`：在线备份到 `<data>/backups`（API 不接受文件系统路径）；`{ to: <Git 地址> }` → `{ commit, changed }`：把 `config.yaml`、`persona/`、`memory/`、`skills/` 推到该仓库（凭据用守护进程所在环境的 SSH 密钥 / Git 凭据）。`to` 不是 Git 地址 400；失败 422 `backup_failed` |

恢复没有 API：要先停掉守护进程，用 `protea restore`（见 [../10-architecture/16-deployment.md](../10-architecture/16-deployment.md) §8）。

## 诊断包

只有管理员令牌（只读令牌 403）。内容见 [../10-architecture/15-observability.md](../10-architecture/15-observability.md) §8。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/diagnostics` | `{ dir, archives: [{ name, bytes, createdAt }] }`：`<data>/exports` 下的诊断包，新的在前 |
| POST | `/api/diagnostics` | `{ sinceHours?（默认 72，≤ 2160）, runs?（默认 5，≤ 100）, content?, transcripts?, recordings? }` → `{ name, bytes, manifest }`。参数越界 400；失败 422 `diagnostics_failed`。最多保留 10 个 |
| GET | `/api/diagnostics/:name` | 下载（`application/gzip`，`attachment`）。名字必须是 `protea-diag-<时间>.tar.gz`，否则 400；不存在 404 |

## 控制台

`GET /`、`/index.html`、`/assets/*`、`/favicon.svg` 返回构建好的控制台（`apps/web/dist`，或 `PROTEA_WEB_DIR`），不需要令牌（页面自己调用 `/api/auth/*`）。响应带 `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; …`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`；`/assets/` 下的文件长期缓存，`index.html` 每次校验。未构建时返回一页说明。

## 实时流

**SSE（M0 起）** `GET /api/stream?since=<cursor>&trace=1`。`trace=1` 时另外推 `model.response` 与 `tool.call`（`protea events tail` 用）。连接后先发 `hello {runId}`；带 `since` 时先按游标补发之后的事件，再转为实时。事件名：`event`（id 为游标）、`settled`、`phase`、`batch.started`、`batch.extended`（M1 起带 `level`）、`batch.ended`、`output`（`chat_send` 发出的消息与插件输出；2026-11-05 起带存储的 `id` 与发出它的 `batchId`，与 `/api/chat` 的条目对应）、`scheduler`（M1：`preempt` / `interrupt` / `aged` / `storm_cooldown` / `fork_yield` / `fork_resume`；M5：`paused` / `resumed` / `discarded`）、`fork`（M1：`ForkInfo` 变化）、`plugin`（M2：`PluginStatus` 变化）、`approval`（M2：`ApprovalInfo` 变化）、`mcp`（M3：`McpServerStatus` 变化）、`skills`（M3：目录变化，`{ names }`）、`handoff`（M4：`{ from, to, notes, dropped, kept }`）、`ping`（15 s 保活）。载荷形态见 `@protea/protocol` 的 `StreamMessage` 与 `SchedulerAction`。

**WebSocket（M5）** `GET /ws`（升级）。鉴权同 HTTP：`Authorization: Bearer` 或会话 cookie；用 cookie 时 `Origin` 的主机必须等于 `Host`，否则 403；没有凭据 401。

- 连接后服务端先发 `{ topic: 'hello', data: { runId, role } }`。
- 客户端发 `WsClientMessage`：`{ subscribe: WsTopic[], since?: cursor, logFilter?: { level?, component?, plugin?, q? } }`；每条替换之前的订阅，服务端回 `{ topic: 'subscribed', data: { topics } }`；未知分组回 `{ topic: 'error', data: { message } }`。
- 分组 `WS_TOPICS`：`events`（`event`、`settled`、`promoted`）、`phase`（`phase`、`batch.*`）、`scheduler`、`output`、`changes`（`fork`、`plugin`、`approval`、`permission`、`mcp`、`skills`、`handoff`、`persona`）、`usage`（`UsageInfo`）、`logs`（`log`，`LogRecord`）。 `trace`（`model.request`、`model.delta`、`model.response`、`tool.call`，运行流；载荷见 `@protea/protocol` 的 `TraceMessage`）。
- 带 `since` 且订阅了 `events` 时，先补发游标之后存储的全部事件，期间的实时消息暂存后放出；同一游标不会发两次。
- 服务端每 30 s ping，一个周期内没有 pong 的连接被终止；未发出的数据超过 8 MB 时以 1013 关闭。

SSE 与 WS 的消息都按总线记录的因果顺序发出：事件先于为它开的批、它的结算与之后的调度动作。

## 实现进度

- M0：`/healthz`、`/readyz`、`GET /api/status`、`POST|GET /api/events`、`GET /api/events/:cursor`、`GET /api/stream`。
- M1：`GET /api/sessions`、`GET /api/sessions/:id/transcript`、`GET /api/sessions/forks[/:id]`、`POST /api/sessions/forks/:id/cancel`。
- M2：`/api/plugins*`（目录安装）、`/api/approvals*`、`/hooks/<name>`。
- M3：`/api/mcp/servers*`、`/api/mcp/oauth/callback`、`/api/skills*`（目录安装）。
- M4：`POST /api/sessions/main/handoff`、`/api/memory/*`；`/api/status` 增加 `context`、`memory`、`persona`。
- 分层记忆（2026-11-10）：`/api/memory/board`、`/api/memory/dream`；`/api/status` 的 `memory` 增加 `board`、`dream`，`context` 增加 `lastCompaction`。
- M5：其余全部（本页各表），`/api/status` 增加 `scheduler`；`/ws`、`/metrics`、控制台托管。
- 实际测试支持（M6 之后）：`/api/diagnostics`。
- 账号与供应商档案（M6 之后，2026-11-05）：`/api/setup`、`/api/auth/login` 的账号密码方式、`/api/auth/password`、`/api/accounts*`、`/api/providers*`；会话改为服务端存储（`v2.` cookie）；`/api/status` 增加 `setupRequired` 与 `provider.protocol`。
- M6：`POST /api/budget/release`、`/api/backups`；`BudgetStatus` 增加硬上限、扣住数与放行；`control.allowCidrs`；`/api/status` 的插件与 MCP 状态增加 `memoryBytes`。
