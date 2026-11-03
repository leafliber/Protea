# 模型提供方

> 状态：Draft · 更新：2026-11-03

## 1. 抽象

```ts
interface Provider {
  id: string;
  modelFor(role: ModelRole): string;
  health(): { ready: boolean; problem?: string };   // 例如缺少 API key
  // 内部总是流式；完成后返回完整消息。失败抛 ProviderError{kind: retryable|fatal|overflow|config}
  generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse>;
  // 计划中（M4）：facts(role)（上下文窗口、MIME 等）与 countTokens(req)
}

type ModelRole = 'main' | 'fork' | 'cheap';
```

`ProviderRequest` 是 Provider 无关的中间表示（系统分段、消息、工具、effort）；每个 Provider 把它映射到自家 API，并自行决定缓存断点的位置。消息内容块采用 **Anthropic Messages 的块形态作为规范形态**：转录按原样存储并回传（思考块、未来的新块类型都能原样往返），其他 Provider 从这一形态映射。Core 只依赖这个接口（P2：模型可换）。

内置实现：`anthropic`（默认）、`echo`（离线开发：对 console 消息调用 `con_send` 回显，`providers.default: echo` 开启）、`ScriptedProvider`（测试用）。

## 2. 模型角色分配

| 角色 | 默认模型 | 用途 | 思考 / 努力 |
|---|---|---|---|
| `main` | `claude-opus-5-5` | 主会话 | 自适应思考；effort 按批等级：L1 `medium`（延迟优先）、L2 `high`、L3 `high` |
| `fork` | `claude-sonnet-5-5` | 后台 Fork、例程 | 自适应；effort `high` |
| `cheap` | `claude-haiku-5-5` | 交接笔记、候选事件压缩、分类 | effort `low`/`medium` |

全部可在 `providers.anthropic.models.<role>` 覆盖。主人想要最强模型时把 `main` 换成 `claude-fable-5-1`（注意其定价与"思考始终开启"的差异）。

## 3. Anthropic 实现要点

基于官方 `@anthropic-ai/sdk`（TypeScript，当前 1.3.x，使用 beta 命名空间以便传 `fallbacks`）。

| 方面 | 做法 |
|---|---|
| 流式 | 一律 `messages.stream()`；`finalMessage()` 取完整消息；工具输入开启 `eager_input_streaming: true` 并在执行前按 schema 校验 |
| 思考 | `thinking: { type: 'adaptive' }`；`output_config.effort` 按角色/等级设置；`display: 'omitted'`（默认），控制台调试模式切 `summarized` |
| 历史回传 | assistant 消息的 `content` **原样**追加（含 thinking 块）；绝不编辑既有回合（preserved thinking） |
| 提示缓存 | 断点见 [06-context-assembly.md](06-context-assembly.md) §7；监控 `usage.cache_read_input_tokens` |
| 会话中系统消息 | 操作性提醒用 `{"role":"system"}` 追加到 `messages`；单回合提醒用 `clear_at: "next_user_message"`（beta `mid-conversation-system-clear-at-2026-08-21`） |
| 工具搜索 | 工具数超阈值时声明 `tool_search_tool_regex_20251119`，其余工具 `defer_loading: true`；搜索工具本身与内核工具不延迟 |
| 拒答回退 | 默认开启 `betas: ['server-side-fallback-2026-07-01']` + `fallbacks: 'default'`；`stop_reason: 'refusal'` 仍到达时记 `internal` 事件并结束回合 |
| 强制工具 | 不使用 `tool_choice: any/tool`（Opus 5.5 / Sonnet 5.5 / Fable 5.1 返回 400）；需要结构化结果时用 `output_config.format` 或 `strict: true` |
| 容量 | 请求前 `messages.countTokens`；超限走交接；可选 `compact-2026-01-12` 服务端压缩作为交接前的第一道（需原样回传 compaction 块） |
| 上下文编辑 | 可选 `context-management-2025-06-27` 的 `clear_tool_uses_20250919` 清理旧工具结果（只对 Fork 默认开启；主会话默认关，因为它改变了"只追加"的字节前缀会影响缓存命中的推理，需实测） |
| 错误 | 最具体优先：`NotFoundError` → `RateLimitError`（退避、让渡 Fork 容量）→ `APIStatusError` → `APIConnectionError`；进入 `backoff` 阶段 |
| 认证 | 秘密 `ANTHROPIC_API_KEY`（环境变量或 `/data/secrets/`）；缺失时守护进程照常启动，`/readyz` 报告原因，批次以 `model_error` 结束 |
| 超时 | 主会话单次请求 10 min（TS SDK 单位毫秒）；Fork 可更长 |

## 4. 工具搜索与缓存的配合

工具搜索把"加载工具定义"变成追加动作，因此 MCP 服务器增删造成的工具表变化对缓存前缀的影响被限制在"非延迟工具集合"内。策略：

- 非延迟集合 = 内核工具 + 所有插件工具 + 每个 MCP 服务器调用频次前 k（`context.toolSearch.keepPerServer`，默认 3）的工具。只有 MCP 工具会被延迟（M3）。
- 频次来自 `tool_stats` 表；某个服务器的前 k 名只在它的工具列表变化时重算，其他服务器的增删不会让它变化，避免前缀因调用次数波动而失效。
- 该集合的变化仍只在回合边界应用，并触发一次缓存失效（可接受）。延迟工具的增删不进入缓存前缀。
- 请求形态（Anthropic）：延迟的工具带 `defer_loading: true`，`tools` 末尾追加 `{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }`，无需 beta 头。模型的搜索结果（`server_tool_use` 与 `tool_search_tool_result` 块）原样留在历史里。
- 历史里一旦出现过工具搜索，之后的请求都保持声明搜索工具；搜索结果引用过、但已经消失的工具（服务器被移除）以占位定义保留（`defer_loading: true`，描述为"No longer available …"），否则 API 会因找不到被引用的工具而拒绝请求。
- `Provider.supportsToolSearch(role)` 报告能力：Anthropic Provider 对 Claude 4.5 及以后的模型为真；echo 与不支持的模型不延迟任何工具。Fork 的请求同样适用，只是工具集合是该 Fork 允许的子集。
- 验收用的缓存模拟见 `packages/core/test/tool-search.test.ts`：按"工具 → system → messages 的最长公共前缀、延迟工具不进前缀"计算，100 次推送、78 个 MCP 工具时为无 MCP 时的 98%。

## 5. 用量与成本

每次调用记录 `usage` 表：`input / output / cache_read / cache_write / thinking`（若有）token、模型、角色、会话、批等级、估算费用（按配置的价格表）。调度器用它做预算；控制台画"今日花费按等级"。

价格表随镜像发布并可覆盖（`providers.anthropic.pricing`），避免硬编码过期。

## 6. 拒答与安全分类器

Claude 5 系列可能以 `stop_reason: 'refusal'` 结束（HTTP 200）。处理：

1. 服务端回退已开启时，多数情况已由备用模型完成；`usage` 中记录实际模型。
2. 仍然拒答：追加一条 `internal` 事件 `model.refused {category}`，结束本回合；不自动重试同一请求。
3. 控制台显示拒答计数；连续拒答触发告警。

## 7. 其他 Provider（插件）

`openai-compat`（Responses 或 Chat Completions 协议）作为 `kind: provider` 插件在 M7 提供，用于接入本地或第三方模型。它不保证思考/缓存/工具搜索等特性；`facts()` 如实报告，Core 据此关闭相应优化（P2：妥协是回退，不是语义）。

## 8. 测试

- 录制/回放 Provider 层（`ProviderRecorder`）：把真实响应录成夹具，单元测试不打网络。
- 契约测试：对每个 Provider 实现跑同一组用例（流式、工具、取消、错误分类、计数）。
- 每周一次的"真网"冒烟测试（CI 可选），覆盖新模型 ID 与 beta 头是否仍有效。
