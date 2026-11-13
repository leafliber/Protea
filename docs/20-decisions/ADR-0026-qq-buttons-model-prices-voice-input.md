# ADR-0026：QQ 按钮走 markdown 消息；价格表覆盖主流模型并可自定义；语音输入

状态：Accepted · 日期：2026-11-13 · 相关：[ADR-0017](ADR-0017-qq-connector-and-qr-bot-creation.md) · [ADR-0021](ADR-0021-readable-approval-requests-and-delivery.md) · [../10-architecture/12-model-providers.md](../10-architecture/12-model-providers.md) §6 · [../10-architecture/08-event-source-plugins.md](../10-architecture/08-event-source-plugins.md) · [../30-specs/03-plugin-protocol.md](../30-specs/03-plugin-protocol.md) · [../30-specs/05-control-api.md](../30-specs/05-control-api.md)

## 背景

本地实例上发现的三个问题：

1. **QQ 选项按钮从没出现过。** 2026-11-12 的会话里，`chat_send` 带 3 个选项发到 QQ，接口返回了消息 id，主人回复"没收到"。原因是官方 SDK 的 `sendTextWithKeyboard` 在默认配置（`markdownSupport: false`）下发的是 `msg_type: 0` 纯文本加 `keyboard`，而 QQ 只在 markdown 消息（`msg_type: 2`）下面挂按钮，纯文本上的按钮会被直接丢掉，也不报错。插件因此以为按钮已经发出，不会退回编号列表，主人只看到一句"请选择："。审批请求走同一条路，也没有按钮，而且按钮路径不带"回复 approve / deny"的提示。腾讯自己的 openclaw-qqbot、Hermes Agent、AstrBot 都是 markdown 加 keyboard 一起发；没有自定义按钮权限的机器人会被明确拒绝（如 304057），而不是静默丢弃。
2. **价格只覆盖少数 Claude 模型。** 内置表只有 8 个 Claude 型号（还缺 Fable 5.2、Opus 4.6/4.7、Sonnet 4.6、Haiku 4.5，Sonnet 5.5 的缓存读价格也写错了），只认完全相同的模型名，所以 `anthropic/claude-sonnet-4.5`、带日期后缀的快照、云厂商前缀都匹配不上；OpenAI 风格的协议完全不用内置表；控制台里没有任何地方能填价格。本地实例的 glm 档案 7 天里有 251 次调用（约 1100 万缓存读 token）费用都记成 0，按美元设的每日预算对它不起作用。
3. **没有语音输入。** 主流 harness（OpenClaw、Hermes Agent、AstrBot、Open WebUI、LobeChat）都支持语音：网页上用 MediaRecorder 录音、上传给 OpenAI 兼容的转写接口；聊天平台的语音消息优先用平台自带的识别文字，没有时下载音频转写（QQ、微信是 SILK，要先解码）。

## 决策

### 1. QQ 按钮

- 带按钮的消息（单选选项、审批请求）一律用 `QQBot.send({ msgType: 2, markdown: { content }, keyboard })` 发送；`msg_seq` 由 SDK 自动生成。每个按钮带 `unsupport_tips`（旧客户端的提示）。
- 被拒绝时（没有按钮或 markdown 权限）照旧退回文字：选项变成编号列表，审批变成带"回复 approve / deny"的文字。只试一次，拒绝不算作被动回复失效。
- 多选仍然是编号列表（QQ 消息发出后不能修改，按钮做不出"选中/取消"的状态）。
- 测试用的假 QQ 服务端照真实平台的行为，丢掉纯文本消息上的按钮，所以测试能抓到这类错误。

### 2. 价格

- 价格仍然按档案配置：`providers.profiles.<id>.pricing` 的键可以是模型名，也可以带 `*` 通配（`glm-5.3*`）。字段是 `input`、`output`（必填）、`cacheRead`（不填按输入价）、`cacheWrite`（不填按 Claude 的规则：5 分钟缓存 1.25 倍输入，1 小时 2 倍）和 `tiers`（提示超过 `above` token 后换一组价格）。货币只用美元（主人的选择）。
- 查找顺序：档案里同名的条目 → 规范化后的名字 → 最长的通配 → 内置表。规范化去掉路由的厂商路径（`anthropic/`）、云厂商前缀（`us.anthropic.`）、版本与日期后缀（`@20251101`、`-20251101`、`-2025-11-01`、`-v1:0`、`-latest`），Claude 的点号版本转成连字符。内置表只做精确匹配，不按前缀：`glm-5.3` 和 `glm-5.3-flash` 价格差将近十倍。
- 内置表覆盖 Claude 全系列与 OpenAI、DeepSeek、通义千问、Kimi、GLM、Gemini、MiniMax、xAI 的现行型号，价格是各厂商国际站的美元标价，核对日期记在 `PRICES_CHECKED`（2026-11-13）。DeepSeek 用高峰价（闲时半价），通义用国际站价格，隐式缓存命中按输入价的 20% 计。
- 两种 OpenAI 协议也用内置表。OpenRouter 在用量里报告实际扣费（`usage.cost`，美元额度），接口地址是 openrouter.ai 时采用它，优先级在自定义价格之后、内置表之前。
- 控制台「模型」页：每个档案列出当前角色用的和最近 7 天用过的模型，各自的价格与来源（自定义/内置/没有价格，以及 7 天内多少次调用因此没有计费）；编辑档案时有「价格」一节，空着就用内置价，占位符显示内置价。总览的"过去 24 小时花费"在有调用没有价格时变成提醒，链接到「模型」页；`protea status` 同样提示。

### 3. 语音输入

- 新配置段 `speech`：任何 OpenAI 兼容的 `POST {baseUrl}/audio/transcriptions`（multipart `file` + `model`，可带 `language`）。预设：硅基流动 SenseVoice（国内可直连）、OpenAI、Groq、本机 Whisper（speaches / faster-whisper-server）、自定义。密钥存为秘密 `SPEECH_API_KEY`。控制台「模型」页的"语音转文字"卡片设置、测试（发一秒静音）与关闭。
- 核心的 `SpeechService` 做转写：SILK（QQ、微信的语音，带或不带腾讯的 0x02 前缀）用 `silk-wasm` 解码成 WAV 再发送；其他格式原样发送（浏览器的 WebM/Opus 或 MP4、Telegram 的 OGG）。日志只记来源、字节数、耗时和字数，不记文字。
- 网页聊天的输入框加麦克风按钮（主人的选择是两种都要）：**点按**开始录音，再点一次结束，文字放进输入框，看过再发；**按住**说话，松开直接发送，移出按钮再松开取消。录音最长 2 分钟。浏览器只在 https 或 localhost 下允许使用麦克风，其他情况按钮会说明原因。
- 插件协议新增 `speech/status`（`{ ready }`，下载音频前先问）和 `speech/transcribe`（`{ dataBase64, mime, language? }` → `{ ok, text, ms }` 或 `{ ok: false, code, error }`；`not_configured` 不算错误）。TypeScript SDK 是 `host.speech.ready()` / `host.speech.transcribe()`，Python SDK 是 `speech_ready()` / `speech_transcribe()`。
- 连接器：只转写主人私聊里的语音，陌生人和群里的语音不送去转写。转写结果写成 `[voice] <文字>`。
  - QQ：设置了转写就用 QQ 给的 WAV 副本（`voice_wav_url`），没有再用 SILK 原件；失败或没设置时用 QQ 自带的识别文字（`asr_refer_text`）。
  - 微信：设置了转写就下载语音（AES 解密后的 SILK，由核心解码）。微信自带的识别文字对非普通话常常不准，只作兜底。
  - Telegram：没有平台自带的文字，语音、音频与圆形视频都靠转写；没设置时写明"没有设置语音转文字"。
- 说出来的话不会被当成审批答复或命令（`/approve`、"同意"、模式命令、停止词）：识别错一个字就可能批准不该批准的操作。微信以前会把语音自带的文字当成审批答复，这次一并改掉。

## 备选方案

- **QQ 打开 SDK 的 `markdownSupport`**：所有普通回复都会变成 markdown 消息，没有 markdown 权限的机器人连普通文字都发不出去；只给带按钮的消息用 markdown，影响最小。
- **按钮消息里同时附编号列表**，防止按钮再次被静默丢弃：markdown 加 keyboard 被拒绝时会报错、会退回文字，不会静默丢弃；附上列表在能显示按钮时是重复内容。
- **内置表按前缀匹配**：一个家族里不同后缀价格差别很大（`-flash`、`-mini`、`-pro`），前缀匹配会悄悄算错；需要一组模型同价时由主人写通配。
- **从 OpenRouter 或 LiteLLM 的公开价格表实时取价**：要求服务器能访问境外地址，价格还会随时间变化、不可复现；内置表加核对日期加自定义更可控。
- **人民币价格自动按汇率折算**：主人选择只用美元。
- **网页用浏览器自带的 Web Speech API**：Chrome 的实现把音频发给 Google，国内不可用；统一走配置好的转写服务，表现一致。
- **在插件里解码 SILK**：插件打包时 `silk-wasm` 是外部依赖、镜像里没有，而且 QQ、微信要各做一遍；放在核心只做一次，守护进程在镜像里带完整的 `node_modules`。

## 后果

- 机器人有按钮权限时，QQ 的选项与审批请求才会显示按钮。没有权限的机器人收到的是编号列表和文字提示，和修复前想要的回退一致。真实账号上的验证见实测清单 T15。
- 内置价格会过期：Gemini 4 与 Gemini 3.6/3.8 Flash、通义 qwen3.7-plus 的折扣都已宣布调价。更新时改 `packages/core/src/providers/pricing.ts` 与 `PRICES_CHECKED`。已有的、没有价格的历史调用不会补算费用；滚动 24 小时的预算一天后自然恢复正常。
- 转写服务的费用不计入用量表与预算（按秒计费，和 token 不同）。
- 核心新增依赖 `silk-wasm`（MIT，约 290 KB，含 wasm）。
- 插件协议多了两个方法，SDK、FakeHost、一致性检查都已跟上；按 ADR-0022 不考虑旧插件。
