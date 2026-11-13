# 模型提供方

> 状态：Accepted（M0–M6；供应商档案 2026-11-05）· 更新：2026-11-12

## 1. 抽象

```ts
interface Provider {
  id: string;
  modelFor(role: ModelRole): string;
  health(): { ready: boolean; problem?: string };   // 例如缺少 API key
  // 内部总是流式；完成后返回完整消息。失败抛 ProviderError{kind: retryable|fatal|overflow|config}
  generate(req: ProviderRequest, opts: { signal: AbortSignal; onText?: (delta: string) => void }): Promise<ProviderResponse>;
  supportsToolSearch?(role): boolean;                // M3
  contextWindow?(role): number | undefined;          // M4：输入上限
  countTokens?(req, { signal }): Promise<number | undefined>;   // M4：精确输入 token
  listModels?(signal): Promise<string[]>;            // 控制台的模型列表
}

type ModelRole = 'main' | 'fork' | 'cheap';
```

`ProviderRequest` 是 Provider 无关的中间表示（系统分段、消息、工具、effort）；每个 Provider 把它映射到自家 API，并自行决定缓存断点的位置。消息内容块采用 **Anthropic Messages 的块形态作为规范形态**：转录按原样存储并回传（思考块、未来的新块类型都能原样往返），其他协议从这一形态映射。Core 只依赖这个接口（P2：模型可换）。

守护进程只有一个 Provider：`ProviderRouter`（`packages/core/src/providers/router.ts`）。它按请求的角色找到供应商档案（`providers.roles.<role>`，否则 `providers.default`），把请求交给那个档案的实现，并在响应里标上 `provider`（档案 id，"model call" 日志行里可见）。档案的实现在第一次用到时创建；档案设置变了就重建，存入或删除密钥后 `refresh()` 全部重建，所以改供应商不用重启，进行中的请求用旧实例跑完。路由器外面依次包着录制、脱敏（I-7）与追踪（[15-observability.md](15-observability.md) §2.1）。

实现：`AnthropicProvider`（`anthropic` 协议）、`OpenAiChatProvider` 与 `OpenAiResponsesProvider`（`openai.ts`）、`EchoProvider`（离线开发：对主人的 `chat.message` 调用 `chat_send` 回显，对运维注入用正文回显）、`ScriptedProvider`（测试用）。工厂 `providerForProfile()` 按协议选择；密钥由 `createProvider()` 从秘密存储读出，只进 HTTP 客户端的请求头。

## 2. 模型角色分配

| 角色 | Claude 档案的默认模型 | 用途 | 思考 / 努力 |
|---|---|---|---|
| `main` | `claude-opus-5-5` | 主会话 | 自适应思考；effort 按批等级：L1 `medium`（延迟优先）、L2 `high`、L3 `high` |
| `fork` | `claude-sonnet-5-5` | 后台 Fork、例程 | 自适应；effort `high` |
| `cheap` | `claude-haiku-5-5` | 交接笔记、候选事件压缩、分类 | effort `low`/`medium` |
| `judge` | 跟随主模型 | auto 权限模式下审核工具调用（[ADR-0015](../20-decisions/ADR-0015-permission-modes-and-auto-review.md)） | effort `medium` |

每个档案有自己的 `models.<role>` 与 `effort`；角色还可以整体换到另一个档案（`providers.roles`），例如主会话用 Claude、轻量任务用本机模型。主人想要最强模型时把 Claude 档案的 `main` 换成 `claude-fable-5-1`（注意其定价与"思考始终开启"的差异）。

## 3. 供应商档案与协议

档案在 `config.yaml` 的 `providers.profiles.<id>`（完整键见 [../30-specs/04-config-reference.md](../30-specs/04-config-reference.md)）；密钥是秘密，默认名 `PROVIDER_<ID>_API_KEY`，不写进配置文件。推荐在控制台的「模型」页（或 `protea providers set`）管理：选厂商预设 → 填地址、密钥、模型 → "测试连接"（一个最多 256 个输出 token 的小请求）→ 保存。

| 协议 | 端点 | 适用 | 支持的特性 |
|---|---|---|---|
| `anthropic` | `{baseUrl}/v1/messages`（官方 SDK） | Claude；其他厂商的"Anthropic 兼容"接口用 `anthropic.features: basic` | `full`：自适应思考、effort、提示缓存、拒答回退、工具搜索、精确计数、服务端压缩（§4）；`basic`：只发标准字段，历史里的思考块不回传 |
| `openai-chat` | `{baseUrl}/chat/completions`，SSE | OpenAI、DeepSeek、通义千问、Kimi、GLM、OpenRouter、Ollama、vLLM、LM Studio 等 | 工具即 function calling；服务端的自动前缀缓存（`cached_tokens` / `prompt_cache_hit_tokens` 记为缓存读）；可选推理强度 |
| `openai-responses` | `{baseUrl}/responses`，SSE，`store: false` | OpenAI 的新接口 | 同上；系统分段合成 `instructions`；服务端不保留任何东西，之前的推理项不回传 |
| `echo` | 无 | 离线开发、长稳测试 | 无（用量按长度估算） |

OpenAI 风格协议的映射（`toChatMessages` / `toResponsesInput`）：

- 系统分段拼成一条 system 消息（Responses 为 `instructions`）。
- `tool_result` 块变成 `role: tool` 消息（Responses 为 `function_call_output`），排在同一条用户消息的文本前面；内容是纯文本，出错的结果前缀 `Error: `。
- 图片：用户消息变成分段内容（`image_url` 的 data URL，Responses 为 `input_image`）。tool 消息只能是文本，所以回执里的图片放进随后的用户消息，每组前面有一行 `<tool_images call_id="…" count="N"/>`。没有图片时消息形态不变。
- 助手的 `tool_use` 变成 `tool_calls`（Responses 为 `function_call`），参数是 JSON 文本；`thinking`、`redacted_thinking`、服务端工具块不发送；Claude 的 `compaction` 块转成一段"之前对话的摘要"文本。
- 回复里的文本与工具调用转回规范块；参数不是 JSON 对象时变成 `{ _raw }`，由执行前的 schema 校验拒绝（模型看到错误后重试）。
- 停止原因：`tool_calls` → `tool_use`、`length` / `max_output_tokens` → `max_tokens`、`content_filter` → `refusal`，其余 `end_turn`。
- 用量：`prompt_tokens` 含缓存部分，所以输入 = prompt − cached，缓存读 = cached；服务端不报用量时按长度估算（预算与交接仍有依据）。费用按 §6 的价格查找（档案的 `pricing` 或内置表）计算。
- 不声明工具搜索（`supportsToolSearch` 为假）：延迟的工具走客户端模式（§5），请求里只有加载的工具与 `tool_search` / `tool_call`；不做精确计数（交接按估算）、`req.compaction` 被忽略。上下文窗口取 `contextWindow`，默认 128000。
- 错误：401/403 → `config`，404 → `fatal`，429 与 5xx/408/409、连接错误、超时 → `retryable`（先按 `maxRetries` 退避重试，尊重 `Retry-After`），400/413/422 且消息像"超出上下文" → `overflow`。

**视觉**（[ADR-0014](../20-decisions/ADR-0014-images-as-blob-references.md)）：档案的 `vision` 说明模型能否看图（布尔值或按角色；Anthropic 默认开，OpenAI 协议默认关）。转录只存 blob 引用，`ImageResolvingProvider` 是最内层的包装（脱敏 → 录制 → 解析图片 → 请求）：能看图的角色得到字节，其他角色得到一行占位文字，已过期的图片也是占位。同一段历史每次解析结果相同，前缀缓存不受影响。

**预设**（`PROVIDER_PRESETS`）：Anthropic、OpenAI（Responses）、DeepSeek、通义千问（阿里云百炼兼容模式）、Kimi（Moonshot）、智谱 GLM、OpenRouter、Ollama（本机，无密钥）、Anthropic 兼容接口、自定义。预设只给协议与地址（Claude 另给模型）；地址是写作时各厂商文档的默认值，以厂商文档为准。其他厂商的模型名不预设（会过时），用"获取模型列表"（`GET {baseUrl}/models`）选。

**没有供应商时**：默认配置里没有档案（`providers.default: null`）。守护进程照常启动，`/readyz` 与总览页报告"no model provider is configured"，批次以 `model_error` 结束；配置好后从下一次请求起生效。旧写法（`providers.anthropic`、秘密 `ANTHROPIC_API_KEY`）在启动时迁移成 `anthropic` 档案（`config/legacy.ts`）。

## 4. Anthropic 实现要点

基于官方 `@anthropic-ai/sdk`（TypeScript，当前 1.3.x，使用 beta 命名空间以便传 `fallbacks`）。

| 方面 | 做法 |
|---|---|
| 流式 | 一律 `messages.stream()`；`finalMessage()` 取完整消息；工具输入开启 `eager_input_streaming: true` 并在执行前按 schema 校验；工具输入的增量经 `onToolInput` 交给会话，用于聊天回复草稿（[17-chat-and-console.md](17-chat-and-console.md) §5） |
| 思考 | `thinking: { type: 'adaptive' }`；`output_config.effort` 按角色/等级设置；`display: 'omitted'`（默认），控制台调试模式切 `summarized` |
| 历史回传 | assistant 消息的 `content` **原样**追加（含 thinking 块）；绝不编辑既有回合（preserved thinking）。前缀变化后旧 thinking 块按截止标记不再发送，并带 `thinking.block_binding.prefix_mismatch_behavior: drop_block`（beta `thinking-binding-controls-2026-08-01`，`thinkingMismatch` 可改为 `error` 或关闭）兜底（M4，[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8.1） |
| 提示缓存 | 断点见 [06-context-assembly.md](06-context-assembly.md) §7；监控 `usage.cache_read_input_tokens` |
| 会话中系统消息 | 操作性提醒用 `{"role":"system"}` 追加到 `messages`；单回合提醒用 `clear_at: "next_user_message"`（beta `mid-conversation-system-clear-at-2026-08-21`） |
| 工具搜索 | 工具数超阈值时声明 `tool_search_tool_regex_20251119`，其余工具 `defer_loading: true`；搜索工具本身与内核工具不延迟 |
| 拒答回退 | 默认开启 `betas: ['server-side-fallback-2026-07-01']` + `fallbacks: 'default'`（Haiku 不支持，不发）；`stop_reason: 'refusal'` 仍到达时记 `internal` 事件并结束回合。输出中途回退时，最后一个 `fallback` 块之前的 thinking、`tool_use` 与没有配对结果的 `server_tool_use` 不进入转录（不回传）；费用按 `usage.iterations` 逐次以各自模型的价格计算（M4） |
| 强制工具 | 不使用 `tool_choice: any/tool`（Opus 5.5 / Sonnet 5.5 / Fable 5.1 返回 400）；需要结构化结果时用 `output_config.format` 或 `strict: true` |
| 容量 | 估算接近阈值时 `beta.messages.countTokens`；超限走交接；400 `prompt is too long` / 413 归为 `overflow`，交接后重试一次；上下文窗口：Claude 5 系列与 Opus/Sonnet 4.6+ 为 1M，其余 200k。可选 `compact-2026-01-12` 服务端压缩（`context.compaction.enabled`，默认关）作为交接前的第一道：主会话请求带 `context_management.edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value } }]`，compaction 块原样留在转录里回传（M4） |
| 记忆工具 | 普通自定义工具（`read / write / append / edit / move / delete`）；不再声明官方 `memory_20250818`（ADR-0024） |
| 输出上限 | `ProviderRequest.maxOutputTokens` 覆盖 `maxOutputTokens`（交接笔记用） |
| 上下文编辑 | 可选 `context-management-2025-06-27` 的 `clear_tool_uses_20250919` 清理旧工具结果（只对 Fork 默认开启；主会话默认关，因为它改变了"只追加"的字节前缀会影响缓存命中的推理，需实测） |
| 错误 | 最具体优先：`NotFoundError` → `RateLimitError`（退避、让渡 Fork 容量）→ `APIStatusError` → `APIConnectionError`；进入 `backoff` 阶段 |
| 认证 | 档案的密钥秘密（默认 `PROVIDER_<ID>_API_KEY`，环境变量或 `/data/secrets/`）；缺失时守护进程照常启动，`/readyz` 报告原因，批次以 `model_error` 结束 |
| 超时 | 主会话单次请求 10 min（TS SDK 单位毫秒）；Fork 可更长 |

## 5. 工具搜索与缓存的配合

工具搜索把"加载工具定义"变成追加动作，因此 MCP 服务器与插件增删造成的工具表变化对缓存前缀的影响被限制在"非延迟工具集合"内。策略：

- 可延迟的工具（`ToolSpec.deferrable`）：MCP 工具，`mcp.servers.<id>.alwaysLoad: true` 的服务器除外；插件工具，插件按 `plugins.<id>.alwaysLoad` 决定，不写时连接器与进程内插件始终加载、`tool` 与 `source` 插件可以延迟（[ADR-0023](../20-decisions/ADR-0023-plugin-tools-on-demand.md)，[07](07-plugin-system.md) §7.1）。内核工具从不延迟。
- 启用条件（`mode: auto`）：工具总数超过 `context.toolSearch.threshold`（40），**或** 可延迟工具定义的估算 token 超过 `thresholdTokens`（8000）。
- 非延迟集合 = 内核工具 + 不可延迟的工具 + 每个来源（一个 MCP 服务器或一个插件）调用频次前 k（`context.toolSearch.keepPerOwner`，默认 3）的工具。
- 频次来自 `tool_stats` 表；某个来源的前 k 名只在它的工具列表变化时重算，其他来源的增删不会让它变化，避免前缀因调用次数波动而失效。
- 该集合的变化仍只在回合边界应用，并触发一次缓存失效（可接受）。延迟工具的增删不进入缓存前缀。
- 请求形态（Anthropic）：延迟的工具带 `defer_loading: true`，`tools` 末尾追加 `{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }`，无需 beta 头。模型的搜索结果（`server_tool_use` 与 `tool_search_tool_result` 块）原样留在历史里。
- 历史里一旦出现过工具搜索，之后的请求都保持声明搜索工具；搜索结果引用过、但已经消失的工具（服务器被移除）以占位定义保留（`defer_loading: true`，描述为"No longer available …"），否则 API 会因找不到被引用的工具而拒绝请求。
- **客户端模式**（[ADR-0020](../20-decisions/ADR-0020-fork-reuse-client-tool-search-final-reply.md)）：角色的 Provider 不能搜索时（Anthropic 兼容接口、两种 OpenAI 协议、旧模型），延迟的工具不进 `tools`，多出两个固定工具：`tool_search {query?, source?, limit?}` 返回匹配工具的全名、描述与完整输入 schema（默认 5 个，最多 20），`source` 是一个 MCP 服务器或插件的 id；`tool_call {name, arguments}` 按全名调用。`tool_call` 在分发入口被改写成真实工具的调用，校验、权限、审批、审计、统计与 Fork 的工具清单都按真实工具走；对不可延迟的工具它拒绝并让模型直接调用。系统前缀多一段 `tool-catalog`：每个来源一行（MCP 服务器附它的说明，即 `initialize` 的 `instructions`，截到 400 字）与被延迟的工具名。`tools` 在整个对话里不变，schema 作为工具回执追加进历史，所以任何 Provider 的前缀缓存都不受搜索与调用影响；两个元工具只在确有工具被延迟时出现，随延迟计划变化一次。
- `Provider.supportsToolSearch(role)` 报告能力：Anthropic Provider 对 Claude 4.5 及以后的模型为真；echo 与不支持的模型走客户端模式。Fork 的请求同样适用，只是工具集合是该 Fork 允许的子集；客户端模式下 Fork 能查到、调到的只有它清单里的延迟工具，清单写在它的首条消息里。
- 验收用的缓存模拟见 `packages/core/test/tool-search.test.ts`：按"工具 → system → messages 的最长公共前缀、延迟工具不进前缀"计算，100 次推送、78 个 MCP 工具时为无 MCP 时的 98%。

## 6. 用量与成本

每次调用记录 `usage` 表：`input / output / cache_read / cache_write / thinking`（若有）token、模型、角色、会话、批等级、估算费用（按配置的价格表）。调度器用它做预算；控制台画"今日花费按等级"。

价格（[ADR-0026](../20-decisions/ADR-0026-qq-buttons-model-prices-voice-input.md)，`packages/core/src/providers/pricing.ts`）：

- 档案的 `pricing` 按模型名或带 `*` 的通配写价格（美元/百万 token）：`input`、`output`、`cacheRead`（不填按输入价）、`cacheWrite`（不填：5 分钟缓存 1.25 倍输入、1 小时 2 倍）、`tiers`（提示超过 `above` token 后的价格）。控制台「模型」页编辑档案时可以填。
- 查找顺序：同名条目 → 规范化后的名字 → 最长的通配 → 内置表。规范化去掉路由的厂商路径、云厂商前缀与日期/版本后缀，Claude 的点号版本转成连字符；内置表只精确匹配，不按前缀。
- 内置表随镜像发布：Claude 全系列与 OpenAI、DeepSeek、通义千问、Kimi、GLM、Gemini、MiniMax、xAI 的现行型号（国际站美元价，核对日期 `PRICES_CHECKED`）。两种 OpenAI 协议同样使用；OpenRouter 报告的实际扣费（`usage.cost`）排在自定义价格之后、内置表之前。
- 没有价格的调用不计费（预算按 0 计）。`/api/status` 的 `usage24h.unpricedCalls` 与「模型」页每个模型的"7 天内未计费次数"把它们标出来。

## 7. 拒答与安全分类器

Claude 5 系列可能以 `stop_reason: 'refusal'` 结束（HTTP 200）。处理：

1. 服务端回退已开启时，多数情况已由备用模型完成；`usage` 中记录实际模型。
2. 仍然拒答：追加一条 `internal` 事件 `model.refused {category}`，结束本回合；不自动重试同一请求。
3. 控制台显示拒答计数；连续拒答触发告警。

## 8. 其他 Provider（插件）

原计划在 M7 以 `kind: provider` 插件提供 `openai-compat`；现在 OpenAI Chat Completions 与 Responses 两种协议已内置（§3），因为它们只是 HTTP + SSE，放进进程外插件反而要把流式与取消再转一层协议。插件形式的 Provider 留给真正需要自带 SDK 或私有协议的情况。

## 9. 测试

- 录制/回放 Provider 层（M6，`packages/core/src/providers/recorder.ts`）：`ProviderRecorder` 包在真实 Provider 外、`RedactingProvider` 内，把每次调用的响应（`full` 模式还有请求）写到 `runs/<id>/provider.jsonl`；`RecordedProvider` 按角色依次回放这些响应，用于 `protea replay` 与不打网络的测试夹具。
- 协议测试：`packages/core/test/openai.test.ts` 用本地假服务器检查两种 OpenAI 协议的请求形态、流式拼接（分块的工具调用参数）、缓存用量、停止原因、重试与错误分类、模型列表与连接测试；`anthropic.test.ts` 同样覆盖 Anthropic。
- 档案与路由：`providers-accounts.test.ts`（默认值、校验、精简写回、旧写法迁移、按角色路由与重建）；端到端 `apps/daemon/test/setup-providers.e2e.test.ts` 在控制台 API 上建档案、存密钥，让一条消息经假的 OpenAI 兼容服务器得到回复。
- 每周一次的"真网"冒烟测试（CI 可选），覆盖新模型 ID 与 beta 头是否仍有效。
