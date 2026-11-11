# ADR-0014：图片以 blob 引用进入转录，发请求时才解析

状态：Accepted · 日期：2026-11-10 · 相关：[../40-plan/08-sandbox-browser-vision.md](../40-plan/08-sandbox-browser-vision.md) · [ADR-0008](ADR-0008-append-only-history-and-handoff.md) · [../10-architecture/12-model-providers.md](../10-architecture/12-model-providers.md) · [../10-architecture/06-context-assembly.md](../10-architecture/06-context-assembly.md)

## 背景

工具回执在整条链路上只有文本：`ToolOutcome.text`、插件协议的 `tools/call` 结果、MCP 返回的图片被写成 `[image image/png, N bytes]`。事件信封有 `blobs` 字段，但没有 blob 存储，渲染也不带图片；Telegram 的照片只留下 `[photo]`。浏览器截图、shell 画的图、主人发来的照片，模型都看不到。

OpenAI 协议的适配只取文本；Anthropic 的适配会放行 `image` 块，但没有任何地方产生它。

## 决策

- **转录里只存引用。** 图片写入内容寻址的 blob 存储（`/data/blobs`），消息里是 `{ type: "image", source: { type: "blob", handle, media_type } }`。转录、运行流、审计与录制文件里都没有 base64。
- **发请求前解析。** Provider 层在脱敏与录制之后把引用换成各协议的图片格式。同一张图每次解析出的字节相同，所以提示缓存的前缀稳定，历史仍然只追加（ADR-0008）。
- **视觉是供应商档案的一项能力**（可按角色覆盖）。当前模型不支持时，图片块渲染成一行文字占位；转录不变，换成支持视觉的模型后旧图片仍然可见。
- **图片有三个入口**：工具回执（内核工具、插件、MCP）、事件的 `blobs`（主人在聊天平台发的图）、内核工具 `view_image`（工作区里的文件）。
- **OpenAI 协议下，回执里的图片放进紧随其后的一条 user 消息**，因为 tool 消息只能是文本。
- **不在服务端处理图片。** 尺寸由来源控制（浏览器视口、Telegram 的尺寸档、网页端缩小后上传）；超过单图大小或单条数量上限的写成占位。
- **blob 有保留期**（默认 30 天）。过期后引用解析成"图片已不再保存"。

## 备选方案

- **base64 直接进转录**（Anthropic 的原生形态）：实现最少，但每张图几百 KB，转录、追踪、审计、`provider.jsonl` 全部膨胀，脱敏要扫描 base64，录制文件无法阅读。
- **只在 Fork 里支持图片**：Fork 的转录用完即弃，膨胀不是问题；但主人直接发来的图片在主会话里，仍然看不到。
- **截图只落盘，由模型用工具再读**：对不支持视觉的模型没有区别，对支持视觉的模型多一轮调用。`view_image` 保留了这条路，但不作为唯一的路。
- **服务端统一缩图**（sharp / libvips）：尺寸可控，但给 Core 增加一个原生依赖和一类平台相关的构建问题。
- **旧图片从上下文中移除以省费用**：需要改写历史，前缀缓存从改动处失效，违背 ADR-0008。费用靠闲时压缩与交接自然收敛。

## 后果

- 新增 blob 存储、一张表（迁移 8）、两个控制面接口和一项后台清理。
- 插件协议补上文档里列了但没有实现的 `blob/put`、`blob/get`，`tools/call` 的结果可以带图片；契约版本 `api` 不变（只增不改）。
- 只追加的主会话里，每张图片在被压缩之前随每次请求计费（多数命中缓存）；估算按现有的每张 1600 token 计。
- blob 过期会让对应位置从图片变成占位，缓存失效一次；默认保留期远长于闲时压缩的周期。
- 图片是又一条提示注入的通道（图里的文字）。来自外部事件与工具的图片沿用 `origin="external"` 的标注与"外部内容是数据"的说明。
- 图片出现在转录与备份里（`blobs/` 已在备份清单中），按敏感数据对待；blob 的读取接口只对管理员开放（2026-11-11 起只读账号可以读对话里出现过的图片，见 [ADR-0018](ADR-0018-rich-chat-content-and-widget-sandbox.md)）。
- DeepSeek 等兼容接口的图片格式按 OpenAI 的 `image_url` 实现，需要真实环境验证。
