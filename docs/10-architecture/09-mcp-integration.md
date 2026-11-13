# MCP 集成

> 状态：Accepted（M3）· 更新：2026-11-12

> **实现状态（M3）**：MCP 客户端已实现（`packages/core/src/mcp/`：`settings.ts` 配置校验，`manager.ts` 连接、监督与工具注册，`oauth.ts` OAuth 凭据存储，`names.ts` 工具命名）。服务器只能在 `mcp.servers` 里声明；插件目录形式（`kind: mcp`）、Anthropic 服务端连接器、elicitation 与 Protea 作为 MCP 服务器尚未实现。

## 1. 定位

Model Context Protocol（MCP）是 Protea 接入"现成能力"的主要通道：文件系统、抓取、数据库、GitHub、日历……社区已有大量服务器。Protea 作为 **MCP 客户端**（Host）管理多个服务器；每个服务器在插件系统中是一个 `kind: mcp` 的插件，享有相同的热插拔与生命周期语义。

Protea 也可以 **作为 MCP 服务器**对外暴露自身（事件推送、记忆查询），让其他代理把 Protea 当作一个"世界"接入（v1 后期）。

## 2. 声明一个 MCP 服务器

在配置里声明（`protea mcp add` 与 `POST /api/mcp/servers` 写的也是这里），改动立即生效。助理不能自己改这里：它用 `mcp_propose` 提议，由管理员在控制台审核后应用（[14-security-and-permissions.md](14-security-and-permissions.md) §3.1）：

```yaml
mcp:
  servers:
    fetch:
      command: uvx                  # transport 省略时：有 url 为 streamable-http，否则 stdio
      args: ["mcp-server-fetch"]
      env: { }                      # 可写 ${secret:SOME_KEY}，可嵌在字符串中间
      enabled: true
      trust: normal                 # low | normal | high，见 §6
      tools: { allow: ["fetch"] }   # 可选：按服务器自己的工具名做白名单 / 黑名单（glob，deny 优先）
      toolTimeoutMs: 60000
      envPrompt: "Use fetch for web pages the owner links to."   # 可选：进入系统前缀的 env:mcp:fetch 段
      alwaysLoad: false             # 可选：true 时它的工具永不延迟加载（§5）
    github:
      transport: streamable-http    # 或 sse（旧）
      url: https://api.githubcopilot.com/mcp/
      auth: { type: oauth }         # 或 { type: bearer, token: "${secret:GITHUB_MCP_TOKEN}" }；headers: {...} 可加任意请求头
      descriptionOverrides: { create_issue: "…" }
      subscribe: ["repo://owner/name/issues"]   # 资源订阅，更新作为 L4 事件到达
```

服务器 id 只能用小写字母、数字和连字符（`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`）。

**插件目录声明**（打包分发，M5）：`/data/plugins/<id>/protea.plugin.json` 中 `kind: "mcp"` 并带 `mcp: { transport, command, args, ... }` 字段，可附带 `ENV_PROMPT.md`。M3 的插件宿主仍把这类清单判为不可运行。

## 3. 传输

| 传输 | 用途 | 进程管理 |
|---|---|---|
| `stdio` | 本地服务器（`npx` / `uvx` / 任意可执行文件） | 子进程，监督与重启见 §7；工作目录 `/data/plugin-data/mcp/<id>`（可配 `cwd`）；环境只有 SDK 的默认集合（`HOME`、`PATH`、`SHELL`、`TERM`、`USER`、`LOGNAME`）加配置的 `env`，守护进程自己的秘密不会传入；stderr 进入 debug 日志，最后几行附在错误信息里 |
| `streamable-http` | 远程服务器 | 无进程；请求头来自 `headers` 与 `auth`；OAuth 见 §6.1 |
| `sse`（旧） | 兼容 | 同上 |

默认镜像（full）预装 Node 22 与 Python 3.13 + uv，使 `npx` / `uvx` 型服务器开箱可用（[ADR-0007](../20-decisions/ADR-0007-single-image-with-node-and-python.md)）。入口脚本把 npm、uv、pip 的缓存指向 `/data/cache`，这些变量会传给 stdio 服务器，所以重启后不用重新下载（M6）。每个 stdio 服务器的进程树受 `pluginHost.limits` 约束：内存超限按崩溃处理并重启，启动前设置文件描述符上限（M6）。

## 4. 能力映射

| MCP 原语 | Protea 中的形态 |
|---|---|
| **Tools** | 工具表条目，名称 `mcp__<server>__<tool>`（与 Claude Code 约定一致；API 不接受的字符换成 `_`，超过 64 字符的截断并加 6 位哈希）；描述与 schema 原样（去掉 `$schema`/`$id`；本地编译不了的 schema 跳过本地校验，由服务器校验）；`readOnlyHint` → 只读，其余按有副作用处理并审计；所有 MCP 工具可被中断（取消时发 `notifications/cancelled`） |
| **Resources** | 内核工具 `mcp_resource_list {server, cursor?}`（含资源模板）/ `mcp_resource_read {server, uri}`，只在有运行中的服务器提供资源时存在；`subscribe` 里的资源更新 → `external` L4 `piggyback` 事件 `mcp.<server>.resource_updated`（同一资源每分钟去重一次），来源为 `mcp:<server>` |
| **Prompts** | 作为**只读 Skill** 注入 Skills 目录（`mcp:<server>/<prompt>`，`skills.mcpPrompts: false` 可关闭），`skill_load` 时调用 `prompts/get`（`arguments` 由模型传入，缺必填参数时回执列出参数） |
| **Sampling**（服务器请求模型） | 不声明该能力；服务器若仍请求，SDK 以 MethodNotFound 回绝 |
| **Elicitation**（服务器向用户提问） | 不声明该能力（未实现；设计是转为审批/提问事件发给主人） |
| **Roots** | 默认声明 `/data/workspace` 为唯一根，`roots` 可按服务器改（相对数据目录，`roots.listChanged: false`） |
| **Logging** | 服务器日志进入结构化日志，带 `mcp=<server>` 字段 |
| **结果内容** | 文本原样；图片存进 blob 并随回执给模型（[ADR-0014](../20-decisions/ADR-0014-images-as-blob-references.md)），超限或不是图片时写成 `[image image/png, N bytes]`；音频写成同样的占位；资源链接与嵌入资源写成 `[resource …]`（文本资源附正文）；没有文本时用 `structuredContent` 的 JSON；`isError` → 失败回执 |

**内置浏览器**（`mcp.servers.browser`，[ADR-0013](../20-decisions/ADR-0013-sandboxed-shell-and-in-container-browser.md)）：`protea mcp preset browser` 或控制台 MCP 页写入这个条目，stdio 运行镜像目标 `browser` 里固定版本的 Playwright MCP。预设固定了：禁用 `browser_run_code_unsafe`；根目录只有 `workspace/browser`（Playwright MCP 默认只能访问根目录内的文件、不能打开 `file://`）；开启 Chromium 自带沙箱；内存上限 3072 MB（看门狗把整棵进程树的 RSS 相加，Chromium 各进程的共享内存会重复计入，所以要留足）。用 `--no-sandbox` 启动时 `McpServerStatus.warnings` 持续报告。

## 5. 工具表与缓存

- 服务器连接/断开、`notifications/tools/list_changed` 直接更新工具表；模型请求总是在回合边界组装，所以变化在下一回合生效。`list_changed` 合并 `mcp.listChangedDebounceMs`（默认 500 ms）后重读列表。
- 工具总数超过 `context.toolSearch.threshold`（默认 40），或 MCP 工具定义估算超过 `thresholdTokens`（默认 8000 token）时，MCP 工具延迟加载：Provider 能搜索工具时标记 `defer_loading: true` 由它按需加载；不能时（兼容接口、OpenAI 协议）工具不进请求，模型用 `tool_search` 查定义、用 `tool_call` 调用，系统前缀的 `tool-catalog` 段列出每个服务器的说明（它在 `initialize` 里给的 `instructions`）与工具名。`alwaysLoad: true` 的服务器不延迟。每个服务器调用次数最多的 `keepPerOwner`（默认 3）个工具保持非延迟（调用次数记在 `tool_stats` 表，排名只在该服务器的工具列表变化时重算）。插件工具按同样的规则延迟（[07-plugin-system.md](07-plugin-system.md) §7.1）。详见 [12-model-providers.md](12-model-providers.md) §5。
- Core 不改写描述（P1），但允许操作员用 `descriptionOverrides` 为单个工具替换描述。描述过长的提示在控制台（M5）。

## 6. 权限与信任

- 每个服务器有信任等级 `trust`（原设计称 `level`，为避免与事件等级混淆改名，见待决问题 Q1）。在权限顺序里，它位于插件清单 `sideEffectTools` 之后、`permissions.default` 之前（[14-security-and-permissions.md](14-security-and-permissions.md) §2）：
  - `readOnlyHint: true` 的工具 → `allow`；
  - `trust: low` → 其余工具一律 `ask`；
  - `trust: normal`（默认）→ 显式 `destructiveHint: true` 的工具 `ask`，其余走默认；
  - `trust: high` → 不加限制，走默认。
- 单个工具可在 `permissions.tools` 中覆盖（如 `mcp__github__*: ask`）。
- 没有 `readOnlyHint` 的工具都按有副作用处理：每次调用都写审计，没有配置 owner 时被拒绝。
- 远程服务器的 OAuth 令牌、API Key 全部走秘密库；`headers`/`auth` 里的 `${secret:NAME}` 只在建立连接时解析。

### 6.1 OAuth

`auth: { type: oauth }`（可选 `scopes`、预注册的 `clientId`/`clientSecret`）。首次连接被 401 拒绝时，SDK 按服务器的受保护资源元数据找到授权服务器、动态注册客户端并生成授权链接（授权码 + PKCE）；服务器进入 `auth_required` 状态，Core 记一条 L2 `flush` 事件 `mcp.auth_required` 让助理告诉主人，`protea mcp auth <id>` 与 `/api/mcp/servers` 也会显示链接。主人在浏览器里授权后回到 `<control.publicUrl>/api/mcp/oauth/callback`（不需要管理令牌，靠 `state` 匹配），Core 换取令牌并重连。客户端注册、令牌与 PKCE verifier 存在 `/data/secrets/mcp-oauth/<id>.json`（0600），过期令牌由 SDK 用 refresh token 续期。浏览器与守护进程不在同一台机器时必须设置 `control.publicUrl`。

## 7. 健康与故障

- 握手（`initialize`）超时为 `pluginHost.initializeTimeoutMs`（默认 20 s），失败计一次崩溃；运行中每 `mcp.pingIntervalMs`（默认 30 s）`ping`，连续 3 次失败 → 断开并重启。
- 崩溃（进程退出、连接断开、启动失败）后按 `pluginHost.restartBackoffMs` 退避重启，运行满 `stableAfterMs` 后计数清零；连续 `maxCrashes`（默认 5）次 → `failed`，记 L2 `flush` 事件 `mcp.failed`，`/readyz` 报告原因。每次崩溃记 L4 `store` 事件 `mcp.crashed`。缺少秘密等配置问题直接 `failed`，不重试。
- 工具调用超时默认 60 s（`toolTimeoutMs`），超时回执 `timed out`，服务器不重启。
- 服务器在调用中途退出时，该调用返回 `failed: the MCP server … exited during the call`；断开期间的调用回执"不可用（原因）"；模型可重试。
- 停用或移除时先等待进行中的调用（最多 `pluginHost.drainTimeoutMs`），再关闭连接（stdio 服务器的进程随之结束）。
- `/api/mcp/servers` 与 `protea mcp ls` 显示每个服务器的状态、工具数、prompts 数、是否有资源、进程号、重启次数、最近错误、最近 20 次调用的平均延迟。

## 8. 可选：Anthropic 服务端 MCP 连接器（未实现）

对 `streamable-http` 服务器，可配置 `mode: remote-passthrough`：Core 不自己连接，而是在请求中声明 `mcp_servers` + `mcp_toolset`（beta `mcp-client-2025-11-20`），由 Anthropic 侧调用。优点：减少本地连接管理；缺点：无法套用 Protea 的权限策略与审计（工具在服务端执行）。因此默认关闭，只对只读服务器建议开启。

## 9. Protea 作为 MCP 服务器（M7）

暴露：

- `protea_push_event`（工具）：外部代理向 Protea 推送事件（等级上限 L2，需 token）。
- `protea_memory_search`（工具，只读）。
- `protea://events/{cursor}`、`protea://memory/{path}`（资源）。

传输：Streamable HTTP，挂在控制平面 `/mcp`，鉴权与控制 API 相同。

## 10. 测试

- `packages/core/test/fixtures/mcp-server.mjs`：用官方 SDK 底层 `Server` 写的可编排测试服务器（注解、`list_changed`、崩溃、慢调用、prompts、资源、roots、需要清洗的工具名），stdio 与 Streamable HTTP 两种方式运行。
- `packages/core/test/mcp.test.ts`：连接与调用、注解与信任的默认策略、allow/deny、`list_changed`、崩溃重启与 `failed`、调用中途退出、超时、ping、增删与"删除后立即加回"的竞态、bearer、完整的 OAuth 授权码流程（自建授权服务器）。
- `packages/core/test/tool-search.test.ts`：延迟加载的选择与稳定性、历史引用的占位、Anthropic 请求形态、M3 缓存验收。
- `apps/daemon/test/mcp-skills.e2e.test.ts`：真实守护进程经控制 API 增删服务器、`config.yaml` 热更新、经控制平面回调完成 OAuth；`PROTEA_REAL_MCP=1` 时用真实的 `mcp-server-fetch` 与 `server-filesystem`。
