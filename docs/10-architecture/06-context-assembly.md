# 上下文装配

> 状态：Draft · 更新：2026-11-03

## 1. 目标

把"人格 + 插件环境提示 + 能力目录 + 历史 + 新事件"装配成一次 Provider 请求，满足三个约束：

1. **缓存稳定**：Anthropic 提示缓存是前缀匹配；任何靠前的字节变化都会让其后全部失效。稳定内容在前、易变内容在后。
2. **历史只追加**：不改写已有消息（保留思考要求）。
3. **无语义**：Core 只拼接人格与插件给的片段，不生成描述性文字（固定的结构标签除外）。

## 2. 请求布局

```
┌─ tools[]                 ← 稳定排序（内核 → 插件按 ID → MCP 按 server/tool）；变化只在回合边界
├─ system: [
│    seg:identity          ← persona/SOUL.md
│    seg:operating         ← persona/OPERATING.md（含权限策略摘要、事件格式说明）
│    seg:owner             ← persona/USER.md
│    seg:env:<plugin>…     ← 各插件 envPrompt（按插件 ID 排序）
│    seg:skills-catalog    ← Skills 目录（name + description），按 name 排序
│    seg:memory-index      ← memory/INDEX.md（人格维护；变动较少）
│  ]  ← 末尾放 cache_control 断点 #1
├─ messages: [
│    …历史（append-only）…  ← 自动缓存 / 断点 #2 放在上一批末尾
│    user: <events batch=…>…</events><status …/>   ← 本批事件 + 动态状态块（最后）
│  ]
└─ output_config / thinking / fallbacks（见 12）
```

**与 Cortico 的差异**：Cortico 的 `sessionHead()` 放在 system 与历史之间、每次请求重建；Protea 把动态内容（时间、预算、pending 计数）放在**最后一条 user 消息的 `<status>` 块**里。代价是模型要在历史末尾看状态，收益是整段历史都能命中缓存。

## 3. 系统前缀分段

人格提供有序的命名分段（`systemSegments()`），Core 原样拼接。每段是一个独立的 `text` block，便于单独加 `cache_control`。内置分段来源：

| 分段 | 来源 | 变化频率 | 热更新 |
|---|---|---|---|
| `identity` | `persona/SOUL.md` | 极低 | 文件变化 → 下一回合边界生效（M4） |
| `runtime` | Core 唯一拥有的固定说明（英文）：事件格式、origin 语义、"纯文本不会送达任何人"、时区 | 极低 | 随版本 |
| `operating` | `persona/OPERATING.md` | 低 | 同 identity |
| `owner` | `persona/USER.md` | 低 | 同上 |
| `env:<plugin>` | 插件 `envPrompt()` 模板 + `envPromptVars()` | 低（插件启停时） | 插件生命周期事件 → 回合边界重建 |
| `env:mcp:<server>` | MCP 服务器配置里的 `envPrompt`（M3） | 低（服务器启停时） | 服务器状态变化 → 回合边界重建 |
| `skills-catalog` | Skills 注册表（M3） | 低 | 目录文本变化 → 回合边界重建 |
| `memory-index` | `memory/INDEX.md`，包在 `<memory_index path="/memories/INDEX.md">` 里（M4） | 中 | 文件变化 → 回合边界重建 |

**重建代价**：任何分段变化都会让该分段之后的缓存失效，并且此前的 thinking 块从此不再回传（它们绑定旧前缀，[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8.1）。因此变动频繁的内容（记忆索引）放在最后一段；真正高频的内容（今天的待办）不进前缀，而是由模型通过 `memory` 工具按需读取。人格钩子 `systemSegments({ defaults })` 可以改写主会话的分段（M4）。

### 3.1 环境提示模板

每个插件有 `ENV_PROMPT.md`，支持三层覆盖（后者整体替换前者）：插件自带 → 人格目录 `persona/plugins/<id>/ENV_PROMPT.md` → 数据卷 `/data/overrides/plugins/<id>/ENV_PROMPT.md`。模板语法只有三条规则：`{{var}}` 替换、`{{#if var}}…{{/if}}`、`{{#each list}}…{{/each}}`。

## 4. 工具表

- 工具定义按"内核 → 插件（按 ID）→ MCP（按 server、tool；资源工具 `mcp_resource_*` 在最前）"排序后序列化，保证字节稳定。
- 工具表只在**回合边界**生效：插件/MCP 的增删直接改工具表，而每个模型请求都在回合边界（批开始或工具结果之后）组装，所以变化总在下一回合出现，进行中的请求不受影响（M3 实现；没有单独的"待应用"队列）。
- 工具数量超过 `context.toolSearch.threshold`（默认 40）时，启用 Provider 的**工具搜索**：MCP 工具标记 `defer_loading: true`（每个服务器最常用的 `keepPerServer` 个除外），模型按需搜索加载。工具搜索是追加式的，不破坏缓存前缀（[12-model-providers.md](12-model-providers.md) §4）。实现：`packages/core/src/context/tool-search.ts`。
- 工具描述由插件/MCP 提供；Core 只加命名空间前缀，不改写描述。

## 5. 事件渲染

见 [02-event-model.md](02-event-model.md) §7。规则：

- 一批 → 一条 `user` 消息；多个 `<event>` 按游标排序。
- `external` 事件的文本原样放入 `<event>` 内；Core 不转义语义，但会转义会破坏标签结构的字符。
- 附件（`blobs`）渲染为 `image` / `document` content block（受 Provider 接受的 MIME 类型约束，由 `modelFacts.accepts` 给出）；不接受的类型只给出句柄文本。
- `<status>` 块固定字段：`now`、`phase`、各等级 pending 数（`pending_l0..4`）；可选字段：各等级预算余量（`budget_lN="82%"`，仅在设置了 `budget.dailyUsd` 时出现）、活跃 Fork 数（`forks="2"`，为 0 时省略）。
- Fork 的请求用另一个固定前缀：identity → Fork 运行时说明 → owner，所有 Fork 共用，工具表是该 Fork 允许的子集（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §5.1）。

## 6. 会话中系统消息

需要在不重建前缀的情况下给模型操作性指令时（例如"回合上限将至，请收尾"、"你刚被打断"），Core 使用 **会话中系统消息**（`{"role":"system"}` 追加在 `messages` 末尾；Claude Opus 5 / 5.5、Fable 5 / 5.1、Sonnet 5.5、Haiku 5.5 支持），而不是改 `system` 字段。对单回合提醒使用 `clear_at: "next_user_message"`（beta），避免累积。Provider 不支持时回退为 user 消息里的 `<system-reminder>` 文本块。

## 7. 缓存断点

- 断点 #1：system 最后一段之后（显式 `cache_control`）。
- 断点 #2：顶层自动缓存（请求顶层的 `cache_control`）覆盖对话尾部；不支持的平台改为手动放在上一批最后一条消息。
- TTL 默认 `1h`（`providers.anthropic.cacheTtl`）：个人助理的批次之间常隔 5–60 分钟，5 分钟 TTL 会频繁冷启动。两个断点使用同一 TTL。
- 稳定性有自动化测试：连续 100 次推送中，每个请求的 system 与 tools 字节相同，消息序列（按内容块展开）是上一个请求的严格前缀（`invariants.test.ts`）。
- 验证：`usage.cache_read_input_tokens` 连续为 0 → 控制台告警"缓存未命中"，并列出最近一次前缀 diff（哪一段变了）。

## 8. 容量估算

每次请求前估算输入 token：上一次响应的 usage 加上之后消息的本地估算，接近阈值（90 %）时用 Provider 的 `count_tokens` 求精确值；批开始时超过 `softTokens`、任何请求前超过 `hardTokens` 则进入交接（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8）。当前估算与阈值见 `/api/status` 的 `context` 字段（控制台的"上下文占用环"在 M5）。可选的服务端压缩（`context.compaction`）只用于主会话请求。
