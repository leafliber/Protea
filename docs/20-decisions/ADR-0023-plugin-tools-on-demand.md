# ADR-0023：插件工具也可以按需加载，按插件配置；元工具改名为 `tool_search` / `tool_call`

状态：Accepted · 日期：2026-11-12 · 相关：[ADR-0020](ADR-0020-fork-reuse-client-tool-search-final-reply.md)（修订其中的客户端模式命名）· [ADR-0022](ADR-0022-no-backward-compatibility-before-launch.md) · [../10-architecture/12-model-providers.md](../10-architecture/12-model-providers.md) §5 · [../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md) §7.1

## 背景

工具搜索（[12](../10-architecture/12-model-providers.md) §5）只延迟 MCP 工具：`ToolSpec.deferrable` 只有 MCP 管理器会设，插件工具无论多少都随每次请求发送定义。插件装得多了以后，它们和 MCP 工具一样占前缀，却没有办法按需加载，也没有办法按插件选择。

客户端模式的两个元工具叫 `mcp_search` / `mcp_call`，系统段叫 `mcp-catalog`，`mcp_search` 的参数叫 `server`，`context.toolSearch.keepPerServer` 也按"服务器"命名。推广到插件后这些名字都不准确。

## 决策

1. **插件也是工具的"来源"**。延迟计划不再区分 MCP 和插件：凡是 `deferrable` 的工具都参与；每个来源（一个 MCP 服务器或一个插件）调用最多的 `context.toolSearch.keepPerOwner`（默认 3）个保持加载。内核工具始终加载。
2. **按插件配置 `plugins.<id>.alwaysLoad`**。`true`：工具始终加载；`false`：可以按需加载。不写时按种类取默认：
   - `connector` 与进程内插件（`console`、`webchat`、`cron`）**始终加载**：连接器的发送工具在每次回复的路径上，延迟了就每次多一轮搜索；进程内插件是内核的一部分。
   - `tool` 与 `source` **可以按需加载**。

   "可以按需加载"不等于"一定延迟"：只有在工具总数超过 `threshold` 或可延迟工具的定义超过 `thresholdTokens` 时才延迟，且每个插件常用的前 3 个仍然加载。所以工具不多于 3 个的插件实际不受影响。
3. **切换不重启插件**。工具表直接改它们的 `deferrable` 标记（`ToolRegistry.setDeferrable`），版本号随之变化，下一次请求按新计划组装，前缀缓存失效一次。改 `config.yaml` 热加载，或用 `POST /api/plugins/:id/always-load` · `/on-demand`、`protea plugins always-load|on-demand <id>`、插件页的按钮，后三者写回 `config.yaml`。MCP 服务器的 `alwaysLoad` 仍然会重启服务器（它的工具在连接时注册），这次不改。
4. **改名，不留别名**（[ADR-0022](ADR-0022-no-backward-compatibility-before-launch.md)）：
   - `mcp_search` → `tool_search`，参数 `server` → `source`（一个 MCP 服务器的 id 或一个插件的 id）。
   - `mcp_call` → `tool_call`；对始终加载的工具，拒绝的回执改为"它在你的工具表里，直接调用"。
   - 系统段 `mcp-catalog` → `tool-catalog`，标题"Tools on demand"；MCP 服务器一行写"MCP server, N tools, full name mcp__<server>__<tool>"，插件一行写"plugin, N tools"并列出工具全名。
   - `context.toolSearch.keepPerServer` → `keepPerOwner`。
5. **状态**：`PluginStatus` 增加 `alwaysLoad`（生效的值，已按种类取过默认）与 `deferredTools`（此刻被延迟的个数）。

**只做插件级开关，不做工具级**：常用的工具已经由"每个来源前 3 个"保住；工具级开关要给每个工具一个配置位置和界面，收益不大。

## 备选方案

- **所有插件一律可以按需加载**，和 MCP 一样。连接器的发送工具会被延迟，每次回复多一轮搜索，客户端模式下还要多读一遍 schema。
- **插件在清单里声明自己是否可延迟**。插件作者不知道这台机器上装了多少别的工具；这是操作员的选择。种类默认已经覆盖了作者想表达的那部分。
- **保留 `mcp_search` / `mcp_call` 的名字，只改描述**。名字会误导模型（"插件工具也要用 mcp_call 调？"），按 ADR-0022 不为兼容保留。

## 后果

- 工具多的插件是 `dida365`（`source`，27 个工具；写这条时还是内置插件，后来改成可选插件，见 ADR-0025）：启用它后工具总数超过 40，按默认配置它的工具除常用的 3 个外都按需加载；嫌搜索多一轮可以设 `plugins.dida365.alwaysLoad: true`，或用它自己的 `toolsets` 关掉用不到的组。其余内置插件工具很少（`shell` 6 个，其余不超过 2 个），实际不受影响。
- 插件的 `ENV_PROMPT` 本来就点了工具名，被延迟的插件工具不需要额外说明；但插件很多时 `env:<plugin>` 段本身也会变长，这次不处理。
- 已有开发实例：`config.yaml` 里的 `context.toolSearch.keepPerServer` 不再生效（被忽略，取默认 3），要改成 `keepPerOwner`。旧对话历史里的 `mcp_search` / `mcp_call` 调用对应的工具已不存在，模型会收到"没有这个工具"。
- 通过接口写回 `config.yaml` 时，插件的那一组总是带上 `enabled`（改配置也一样）：只写了 `alwaysLoad` 或 `config` 的一组会被读成「未启用」，下次热加载时会停掉原本默认运行的内置插件（`cron`、`console`、`webchat`）。
- 能力变更（`plugin_propose`）不包含 `alwaysLoad`：它是操作员的设置，不由助理提议。
