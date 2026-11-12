# ADR-0020：Fork 汇报后待命可复用；Provider 不能搜索工具时由客户端延迟加载；回复可以直接结束回合

状态：Accepted · 日期：2026-11-12 · 相关：[../40-plan/10-capability-changes-lazy-mcp-fork-reuse.md](../40-plan/10-capability-changes-lazy-mcp-fork-reuse.md) · [../10-architecture/05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) §3、§5 · [../10-architecture/12-model-providers.md](../10-architecture/12-model-providers.md) §5 · [../10-architecture/09-mcp-integration.md](../10-architecture/09-mcp-integration.md) §5 · [ADR-0003](ADR-0003-own-agent-loop-over-agent-sdk.md) · [ADR-0008](ADR-0008-append-only-history-and-handoff.md)

> 修订：客户端模式的元工具与系统段已改名并推广到插件工具（`mcp_search` → `tool_search`，`mcp_call` → `tool_call`，`mcp-catalog` → `tool-catalog`，`keepPerServer` → `keepPerOwner`），见 [ADR-0023](ADR-0023-plugin-tools-on-demand.md)。下文保留当时的名字。

三个互不依赖的决定，都是为了少做重复的事：少一轮没有内容的模型调用，少一次从头开始的子任务，少发用不到的工具定义。

## 背景

1. **回复之后总有一轮空转。** 回复是 `chat_send` 工具调用，它不结束回合，循环必然再调用一次模型去看回执。这一轮多数时候什么都不做，但每次回复都多一次调用，对话窗口在这段时间显示"正在思考…"。
2. **Fork 用完即弃。** Fork 汇报后就是终态，转录关闭。主会话想让它接着做相关的事，只能新开一个，把上下文重新讲一遍。
3. **延迟加载只对一家 Provider 有效。** 工具搜索依赖 Anthropic 接口的 `defer_loading` 与服务端搜索工具；兼容接口和 OpenAI 协议下所有 MCP 工具定义每次请求都全量发送。启用条件只看工具总数（40），一个浏览器 MCP（二十来个定义很大的工具）触发不了。

## 决策

### 1. `chat_send` 可以声明这是本回合最后一件事

- `chat_send` 增加可选参数 `final`。为真且发送成功时回合立刻结束（批的结束原因 `ends_turn`），和 `idle` 一样：到期事件留在队列里，马上开始下一批。发送失败时不结束。
- 不强制：还要继续干活的回复不带 `final`，行为不变。
- 对话窗口在本批已经送达过回复之后，不再为"只是在看回执"的那一轮显示思考提示；确实在用工具时仍然显示。

### 2. Fork 汇报后待命，在期限内可以接着派活

- 新的非终态 `idle`：Fork 写完最终消息后照常以 `fork.completed` 汇报，然后保留转录待命。只有向主会话汇报的 Fork 待命；`reportTo: none` 的（夜间整理）照旧直接结束。
- 新工具 `fork_send { id, message }`：待命的 Fork 把消息当作下一件工作（`<followup>` 块，轮数重新计），转录接着用，所以读过的内容和提示缓存都在；还在运行的 Fork 在下一个边界读到它（`<message>` 块），用来补充或纠正。
- 回收：待命超过 `scheduler.forks.idleTtlMs`（默认 30 分钟）或待命数超过 `scheduler.forks.maxIdle`（默认 4，最久的先走）→ 关闭转录，状态 `completed`，不再汇报。`fork_cancel` 与控制台可以立即回收。
- 待命的 Fork 不占并发名额，不算进行中的工作，重启后保留，时间从进入待命时算起。
- 转录估算超过上下文窗口的一半时不再复用，回执让主会话新开一个：Fork 没有交接机制。
- 引导放在 Core 自带的文字里（运行时说明、`fork_spawn` / `fork_send` 的描述、`protea-self-ops` skill）：人格文件只在首次启动时复制，改默认人格到不了已有的实例。

### 3. Provider 不能搜索时，延迟的工具由两个固定的元工具到达

- `ToolExposure` 按角色选模式：Provider 能搜索 → `native`（原有做法不变）；不能 → `client`。
- `client` 模式下，延迟的 MCP 工具不进请求的 `tools`，多出两个工具：`mcp_search`（返回匹配工具的名称、描述、完整输入 schema）与 `mcp_call`（按全名调用）。它们只在确有工具被延迟时出现。
- `mcp_call` 在分发入口被改写成对真实工具的调用：输入校验、权限策略、审批、审计、调用统计、Fork 的工具清单都按真实工具走。权限模型没有新的入口。
- 系统前缀多一段 `mcp-catalog`：每个服务器一行说明（取自 MCP `initialize` 的 `instructions`，截断）与被延迟的工具名。
- 启用条件增加按大小判断：MCP 工具定义的估算 token 超过 `context.toolSearch.thresholdTokens`（默认 8000），或工具总数超过 `threshold`。`mcp.servers.<id>.alwaysLoad` 让一个服务器的工具永不延迟。

## 备选方案

- **回复后强制结束回合**：助理先回一句"我去查"再接着干活的用法就没有了。
- **只在界面上隐藏那一轮**：调用还在花钱。
- **Fork 完成后保留转录，复用时新开一个 Fork 并把旧转录作为种子**：缓存前缀不同，等于重读一遍；也多一套"种子"机制。
- **Fork 永不回收**：转录文件句柄与上下文无限增长，而 Fork 没有交接。
- **客户端模式下"激活后把工具定义注入 `tools`"**：调用方式和原生一样，但 `tools` 在前缀最前面，每激活一次整段历史的缓存失效一次。元工具让 `tools` 在整个对话里不变，schema 作为工具回执追加进历史（ADR-0008 的只追加），交接后自然清掉。
- **在 Anthropic 兼容接口上也发 `defer_loading`**：多数兼容实现不认，会直接拒绝请求。
- **实现 OpenAI Responses 的原生 `tool_search`**：只对官方端点的新模型有效，这里没有可验证的环境；OpenAI 协议先走客户端模式。

## 后果

- 一次普通问答从两次模型调用变成一次（前提是模型用了 `final`；真实模型下的使用率待实测）。
- `FORK_STATES` 多了 `idle`；会话表的 `state` 是文本列，不需要迁移。指标把 Fork 第一次进入待命算作它的完成。
- `client` 模式下第一次用某个延迟工具要多一轮（先搜再调），之后 schema 留在历史里。弱一些的模型可能直接猜参数：输入不合 schema 时回执会列出错误，模型可以改正。
- 被延迟的服务器的 `instructions` 进入系统提示。它和工具描述一样来自服务器，是主人加进来的东西；截到 400 字。
- 现有实例升级后，只要 MCP 工具定义超过 8000 token 就会开始延迟加载，系统前缀与工具表变化一次（一次缓存失效）。
