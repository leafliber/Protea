# 能力变更审核、MCP 按需加载、Fork 复用与七项修复：方案

> 状态：Accepted（2026-11-12 实现；真实模型下的表现待 T17 实测）· 更新：2026-11-12 · 决策：[ADR-0019](../20-decisions/ADR-0019-capability-change-requests.md) · [ADR-0020](../20-decisions/ADR-0020-fork-reuse-client-tool-search-final-reply.md) · 相关：[05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) §3、§5 · [09-mcp-integration.md](../10-architecture/09-mcp-integration.md) §5 · [12-model-providers.md](../10-architecture/12-model-providers.md) §5 · [13-control-plane.md](../10-architecture/13-control-plane.md) · [14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §3.1 · [17-chat-and-console.md](../10-architecture/17-chat-and-console.md)

> 2026-11-12 修订：按需加载已推广到插件工具，元工具与系统段改名为 `tool_search` / `tool_call` / `tool-catalog`，`keepPerServer` 改为 `keepPerOwner`（[ADR-0023](../20-decisions/ADR-0023-plugin-tools-on-demand.md)）。下文保留当时的名字。

本文是实施前定下的方案，保留原样供对照；精确形态以架构与规范文档为准，实施中和方案不一样的地方记在最后一节。


## 背景

七个问题，三个是界面小修（1、6、7），一个是界面 + 回合语义（5），三个是新设计（2、3、4）。摸底后的结论先放这里：

| # | 问题 | 现状（已核实） |
|---|---|---|
| 1 | 图片打开不够大、不能缩放 | 是 bug：放大层的 `<img>` 渲染在 `.blob-images` 里面，`.blob-images img`（max 320×240，`styles.css:2829`）与 `.lightbox img`（`:2236`）权重相同且写在后面，所以"放大"后仍是缩略图尺寸。另外本来就没有缩放/拖动 |
| 2 | 助理改 MCP/插件/skill，全部人工审核 | 助理现在没有任何能改这三者的工具；现有审批只针对"工具调用"，只存输入哈希和 400 字摘要，能被自动审核、时限授权、bypass 放行，不适合做这件事 |
| 3 | MCP 按需加载 | 已经有一版，但只对 Anthropic 官方接口 + Claude 4.5+ 生效（`defer_loading` + 服务端 tool search）。`anthropic-compatible`（例如火山方舟）和两种 OpenAI 协议下 `supportsToolSearch` 为假，所有工具全量发送。且阈值按"工具总数 > 40"算，一个浏览器 MCP（约 20 个大 schema）触发不了 |
| 4 | 多用异步子 agent，可复用，休眠后回收 | Fork 完成即终态、转录关闭，没有任何"继续发任务"的入口；提示里只有一句"可以用 fork_spawn" |
| 5 | 回答完又"思考" | 回复是 `chat_send` 工具调用，它不结束回合，循环必然再调一次模型（看工具回执、决定还有没有事）。对话页在这一轮显示"正在思考…"。这一轮绝大多数时候什么都不做，但每次回复都多花一次模型调用 |
| 6 | 导航顺序 | `Console.tsx:42` `CONSOLE_GROUPS`「能力」组：模型、插件、MCP、Skills、记忆与人格 |
| 7 | 隐藏 disabled 插件 | 插件页与总览只是给一个灰色徽标，照常列出 |

七项一次做完。

---

## 1. 图片查看器（修 bug + 缩放）

新增共用组件 `apps/web/src/components/Lightbox.tsx`，用 `createPortal` 挂到 `document.body`（脱离 `.blob-images` 的层叠，也不受抽屉 z-index 影响）：

- 默认"适应窗口"：按原始尺寸显示，超出则缩到 96vw × 92vh 内。
- 滚轮/触控板以指针为中心缩放（10%–800%），拖动平移，双指捏合；双击在"适应 ↔ 100%"间切换。
- 顶部工具条：−、百分比、+、适应、1:1、新标签打开、✕；键盘 `Esc` / `+` / `-` / `0`。点背景关闭，点图片不关闭；打开时锁定页面滚动。
- `images.tsx` 的 `BlobImages` 与 `rich/Diagram.tsx` 的"放大"都改用它（图表传入 SVG 内容，同一套缩放/平移）。
- 删掉 `.lightbox img` 的旧规则，新样式放在 `.lightbox-*` 下，不再与 `.blob-images img` 冲突。

## 5. "回答完又思考"

**它在做什么**：`chat_send` 返回后的那一轮模型调用，用来确认是否还有后续动作，通常直接结束回合。不是记忆整理，也不是模型的思考内容（思考内容只在控制台运行流里）。

两处一起改：

1. **省掉多余的一轮**：`chat_send` 增加可选参数 `final: boolean`（"这条消息是本回合最后一件事"）。为真且发送成功时，处理函数返回 `endsTurn: true`（`ToolOutcome.endsTurn` 已支持，`dispatcher.ts:233`），回合立刻结束，行为与 `idle` 相同（到期事件留给下一批）。`runtime-notes.ts` 那句"Plain text … call chat_send"补一句说明 `final`。不设 `final` 时行为不变（还要继续干活的场景）。
   - `packages/core/src/chat/hub.ts`（schema + `send()` 返回值）、`context/runtime-notes.ts`。
2. **对话页不再显示这一轮**：`Chat.tsx` 里，本批已经送达过回复且没有草稿时，`phase === 'model'` 不再显示"正在思考…"气泡；只有 `tools`（确实在干活）才显示"正在使用工具…"。页头状态在这段时间显示"收尾中…"。

## 6. 导航顺序

`CONSOLE_GROUPS`「能力」组改为：插件、MCP、Skills、模型、记忆与人格。同步 `docs/10-architecture/13-control-plane.md:101` 的文字。路由不依赖顺序，无其他影响。

## 7. 隐藏已禁用插件

- `Plugins.tsx`：默认不显示 `enabled === false` 的插件；标签栏右侧加开关「显示已禁用（N）」，选择记在 `localStorage`。各标签的计数只数显示出来的。全部被隐藏时的空状态提示"有 N 个已禁用的插件"并给出同一个开关（否则没法重新启用）。
- `Overview.tsx`「插件与 MCP」卡片：不再列出已禁用的插件。
- 只动界面；`/api/plugins` 与 `self_status` 不变。

---

## 2. 能力变更请求（助理提议，人工审核后由系统应用）

不复用工具审批，新增独立的"变更请求"对象。理由：必须永不自动通过；审核人要看到完整内容和差异；通过后由系统应用，不需要模型"用同样的输入再调一次"。

**助理侧工具**（core 注册，本身无副作用，只是提交请求）：

| 工具 | 动作 |
|---|---|
| `mcp_propose` | `add` / `update` / `remove` / `enable` / `disable`，带服务器定义 |
| `skill_propose` | `add` / `update` / `remove` / `enable` / `disable`，内容来自内联的 SKILL.md（可带附属文件）或工作区目录 |
| `plugin_propose` | `install` / `update` / `remove` / `enable` / `disable` / `configure`，来源为工作区目录、git 或 tarball |
| `change_status` / `change_withdraw` | 查看、撤回自己提交的请求 |

每个提议必须带 `reason`。返回"变更请求 cN 已提交，等待主人在控制台审核，尚未生效"。

**提交时**：立即校验（复用 `normalizeMcpServer`、skill 解析、插件清单校验），把要安装的字节**暂存**到 `<data>/changes/<id>/`（来源经 `util/fetch-source.ts` 取回）并记 sha256，审核看到的就是将被应用的那一份。`update` 记录当时的基线哈希。MCP 的 bearer token 只接受 `${secret:NAME}` 引用，助理不能提交明文凭据，也不能写秘密库。待审请求上限 20 个，7 天过期。

**审核（只能人工）**：

- 只接受控制 API 上已登录的管理员账号（控制台、`protea changes approve|reject`）。**不**接受聊天里的 `/approve`、插件 RPC、自动审核模型、时限授权；`bypass` 模式也不跳过。
- 通过时：核对暂存内容哈希与基线（基线变了 → 标记 `stale`，要求重新提议），然后调用现有的应用函数（`putMcpServer` / `setMcpEnabled`、`skills.install/uninstall` / `setSkillEnabled`、`plugins.install/uninstall/enable/disable` / `setPluginConfig`）。`PluginHost.install` 加 `replace` 选项以支持更新（保留配置与数据）。
- 结果以 L1 内部事件 `change.decided` 告诉助理（通过并已应用 / 应用失败及原因 / 被拒及审核备注），助理再转告主人。全程写审计。

**存储**：迁移 10 新表 `change_requests`（id `cN`、kind、action、target、payload JSON、digest、base_hash、reason、state `pending|applied|rejected|failed|stale|expired|withdrawn`、session/batch、时间、decided_by、note、error）。

**控制台**：

- 「审批」页新增标签「能力变更」：列表 + 审核弹窗。弹窗内容：提议理由、来自哪一批（可跳转）；MCP 显示前后配置的行级差异、引用的秘密是否已设置；Skill 显示 SKILL.md 差异与文件列表；插件显示清单要点（类型、工具、有副作用的工具、配置项）、文件树与文件内容、来源地址与提交号，并提示"安装插件等同于在守护进程里运行代码"。按钮：同意并应用 / 拒绝（可填备注）。行级差异自己写一个小的 LCS，不引依赖。
- 侧栏「审批」的角标计入待审变更；MCP / Skills / 插件页顶部有"N 个待审核的变更"提示条；对话页出现一张"助理提交了变更，去审核"的卡片（只有跳转，不能在卡片上直接同意）。

**涉及文件**：新 `packages/core/src/changes/{service,tools,stage}.ts`；`db/migrations.ts`；`packages/protocol/src/control.ts`（`ChangeRequestInfo`、WS topic `change`）；`packages/control/src/{app,auth,stream}.ts`；`apps/daemon/src/daemon.ts`（接线）；`apps/cli/src/main.ts`；`apps/web/src/pages/Approvals.tsx` + 新 `components/Diff.tsx`、`Console.tsx`、`Mcp.tsx`、`Skills.tsx`、`Plugins.tsx`、`Chat.tsx`；`skills/protea-self-ops/SKILL.md` 增加"改自己的能力"一节。

**已知边界（不在本轮改）**：`shell` 插件设成 `backend: local` 时命令以守护进程身份运行，可以直接写 `/data`，这是 ADR-0013 已写明的风险；默认的沙箱后端碰不到配置和 skills 目录。

---

## 3. MCP 按需加载：补上"客户端模式"

**主流做法（2026-11 查证）**：

- Anthropic API：工具带 `defer_loading: true` + tool search 工具（已 GA），发现的工具以 `tool_reference` 追加在对话里，缓存前缀不变。Protea 已按这个实现。
- OpenAI Responses：`{"type":"tool_search"}` + `defer_loading`，仅 gpt-5.4 及以后的官方端点。
- Claude Code：默认把全部 MCP 工具延迟，只留工具名与服务器说明；有按服务器的 `alwaysLoad`。
- 不支持上述原生机制的端点（兼容接口、本地模型）：通行做法是"元工具"——只暴露搜索与调用两个固定工具，schema 按需以文本返回（lazy-mcp、pmcp 等网关都是这个模式）。

**结论**：主流有实现，方向没问题；Protea 缺的是原生机制不可用时的回退。本轮补"客户端模式"，原生模式保持不变。

**设计**：`ToolExposure`（`context/tool-search.ts`）按角色选模式——Provider 支持原生搜索用 `native`（现状），否则用 `client`：

- 被延迟的 MCP 工具**不进** `tools` 数组；每个服务器调用最多的 `keepPerServer` 个仍原生加载（现有逻辑）。
- 多出两个固定工具（只在 client 模式且确有延迟工具时出现）：
  - `mcp_search { query?, server? }`：返回匹配工具的名称、描述、完整输入 schema（默认 5 个，可到 20）。
  - `mcp_call { name, arguments }`：调用被延迟的工具。在 `ToolDispatcher` 入口**改写成真实工具名**再走校验、权限、审批、审计、统计、Fork 的 `allowed` 检查，所以权限模型不变。
- 系统前缀加一个 `mcp-catalog` 段：每个服务器一行说明 + 被延迟的工具名清单。说明取 MCP `initialize` 返回的 `instructions`（新采集，截到 400 字），模型据此判断"需要这类能力时去搜"。
- `tools` 数组在整个对话里不变，schema 作为工具回执追加进历史 → 任何 Provider 的前缀缓存都不被打破，交接后自然清掉。这是选它而不是"激活后把定义注入 tools"的原因：后者每激活一次整段历史缓存失效一次。

**触发条件与开关**：

- `context.toolSearch.thresholdTokens`（新，默认 8000）：MCP 工具定义估算超过它，**或**工具总数超过 `threshold`（40）时启用。这样单个浏览器 MCP 也会被延迟。
- `mcp.servers.<id>.alwaysLoad: true`（新）：该服务器的工具永不延迟。
- `mode: never` 仍可整体关闭。

**不做**：OpenAI 官方 Responses 的原生 `tool_search`。它只对 gpt-5.4+ 官方端点有效，这里没有真实端点可验证；OpenAI 协议先走客户端模式。

**涉及文件**：`context/tool-search.ts`、`context/settings.ts`、`context/segments.ts`（catalog 段）、`tools/dispatcher.ts` + `tools/types.ts`（`redirect`）、`mcp/manager.ts`（`instructions`、两个工具）、`mcp/settings.ts`、`config/{types,defaults,load}.ts`、`forks/fork-manager.ts`（Fork 首条消息列出它可搜的延迟工具）、`Mcp.tsx`（显示延迟状态、`alwaysLoad` 开关）。

---

## 4. 子 agent：多用、可复用、空闲后回收

**复用**：Fork 增加非终态 `idle`（待命）。

- 完成目标后不再直接进 `completed`，而是：照常发 `fork.completed` 事件（文本末尾注明"可在 HH:MM 前用 fork_send 继续交给它"），转录保持打开，状态变 `idle`。只有 `reportTo: 'main'` 的 Fork 待命，记忆整理（dream）那种照旧直接结束。
- 新工具 `fork_send { id, message }`：
  - 对 `idle` 的 Fork：把消息追加为新的用户消息，轮数预算按"每次任务"重新计，重新排队运行。上下文（读过的文件、浏览器里的状态）和提示缓存都还在。
  - 对运行中的 Fork：消息进收件箱，在下一个工具边界并入（中途补充信息）；若它正好收尾，则接着处理而不进待命。
  - 转录估算超过上下文窗口一半时拒绝复用，提示新开一个。
- **回收**：`scheduler.forks.idleTtlMs`（默认 30 分钟）内没有新任务 → 关闭转录、标 `completed`。待命数超过 `scheduler.forks.maxIdle`（默认 4）时回收最久没用的。`fork_cancel` 或控制台「回收」可立即回收。待命的 Fork 不占 `maxConcurrent`，不计入 `<status forks>`，重启后保留并按剩余时间继续计时。
- `sessions.state` 是无约束的文本列，不需要迁移；`FORK_STATES` 加 `idle`，`isForkTerminal` 不变。

**引导主会话多用**（人格文件只在首次启动时复制，改默认人格到不了现有实例，所以主要放在 Core 自带的三处）：

- `runtime-notes.ts`：把那一句扩成事实陈述——本批运行期间新消息要等；超过几步的工作（检索、浏览、多步命令、长文阅读）可以交给 fork 后台做，自己保持可回应；完成的 fork 会待命一段时间，后续相关工作用 `fork_send` 交回同一个。
- `fork_spawn` / `fork_send` 的工具描述：何时新开、何时复用、有副作用的工具要在 `tools` 里点名。
- `skills/protea-self-ops/SKILL.md`「Background work」一节重写。
- `personas/default/OPERATING.md` 加「Delegation」一段（新实例生效）。现有实例的 `/data/persona/OPERATING.md` 不会自动更新，需要时在控制台「记忆与人格」里手动加上这一段。

**涉及文件**：`forks/fork-manager.ts`、`forks/tools.ts`、`packages/protocol/src/session.ts`、`config/{types,defaults,load}.ts`、`tools/kernel.ts`（`self_status` 的 forks 行）、`maintenance/dream.ts`（确认不受影响）、`packages/control/src/ops.ts`（回收）、`apps/web/src/pages/Sessions.tsx`（待命徽标、剩余时间、回收按钮）。

---

## 文档

- 新 ADR：`ADR-0019`（能力变更请求与人工审核）、`ADR-0020`（Fork 待命复用；MCP 客户端模式延迟加载；`chat_send.final`）。
- 新 `docs/40-plan/10-capability-changes-lazy-mcp-fork-reuse.md`（本方案）。
- 同步：架构 05（Fork 生命周期、回合结束）、09 §5、12 §5、13（导航、API）、14（变更审核）、17（对话页）；规范 04（新配置键）、05（`/api/changes`）、06（迁移 10）；路线图。

## 验证

- `pnpm typecheck`、`pnpm test` 全绿，新增测试：
  - `packages/core/test/changes.test.ts`：提议校验、暂存与哈希、基线漂移、只能人工决定（guard / judge / grant / bypass 都不放行）、应用成功与失败的事件。
  - `tool-search.test.ts` 增补：client 模式下 `tools` 数组稳定、`mcp_call` 按真实工具名走权限与审计、token 阈值、`alwaysLoad`、缓存模拟（搜索与调用不改变前缀指纹）。
  - `forks.test.ts` 增补：完成 → 待命 → `fork_send` 复用 → TTL 回收、`maxIdle`、运行中补充消息、重启恢复、dream 不待命。
  - `chat` 相关测试：`final: true` 以 `ends_turn` 结束且只有一轮；失败的发送不结束回合。
  - `apps/daemon/test`：经控制 API 走一遍"提议 → 审核 → 应用"（MCP 与 skill），以及非管理员、聊天命令无法决定。
  - `apps/web/test`：行级差异、插件过滤、"回复后不显示思考"的判定函数。
- 界面在真实 Chrome（headless）里走一遍：图片放大后的尺寸与缩放/拖动、图表放大、导航顺序、已禁用插件开关、变更审核弹窗、对话页回复后的状态。
- 真实模型下的效果（`final` 是否被正确使用、client 模式下模型会不会先搜再调、是否更愿意用 fork）在这里测不了，留到真实环境实测（[06-real-world-testing.md](06-real-world-testing.md) T17）。

## 定下的几处默认

- 审核入口只有控制台和 CLI，聊天里不能同意。
- 客户端延迟加载用"搜索 + 代理调用"两个元工具，不用"激活后注入定义"。
- Fork 待命 30 分钟、最多 4 个。
- 已禁用插件默认隐藏，带开关。
- `chat_send.final` 由模型自己决定是否设置，不强制。

## 实施中的差异

- **插件更新没有给 `PluginHost.install` 加 `replace` 选项**。更新由变更请求的应用步骤完成：停用 → 卸载（保留数据）→ 安装 → 恢复配置 → 按原样启用。宿主的安装语义不变。
- **插件安装通过后默认启用**（与控制台安装一致），启动失败写在结果里。
- **审核弹窗里看文件**是一个只在待审期间可用的接口 `GET /api/changes/:id/file`；请求结束后暂存文件删除，记录里只留文件清单。
- **`alwaysLoad` 的切换**是两个动作 `POST /api/mcp/servers/:id/always-load` 与 `/on-demand`，切换会重启这个服务器。
- **Fork 的可搜工具清单**写在它的首条消息里（Fork 的系统前缀由所有 Fork 共用）。
- **图片打开时的大小**：大图缩到窗口内；小图放大到填满窗口，但不超过原始大小的 2 倍；图表填满窗口的 90%。
- **待审请求上限与过期时间**是常量（20 个、7 天），没有做成配置项。
- **变更请求的摘要是英文**（它也写进给助理的事件里）；控制台另用中文标题（"新增 MCP 服务器 fetch"）。
