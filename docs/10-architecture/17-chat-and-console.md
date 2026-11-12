# 对话与控制台

> 状态：Accepted · 更新：2026-11-11 · 决策：[ADR-0012](../20-decisions/ADR-0012-chat-platforms-and-operator-console.md) · [ADR-0018](../20-decisions/ADR-0018-rich-chat-content-and-widget-sandbox.md)

## 1. 划分

| | 对话 | 控制台 |
|---|---|---|
| 定位 | 主人和助理说话的通道 | 运行过程的完整观察面 |
| 输入 | 主人的消息（`chat.message` 事件） | 运维注入（`console.message`，不进对话） |
| 输出 | 只有模型调用 `chat_send` 的内容 | 所有事件、用户输入、每次调用的上下文、思考、正文、工具调用与结果、发出的消息、调度动作 |

```
主人 ─▶ 平台（webchat / telegram / …）─ chat.message（source = 平台 id）─▶ 网关 / 调度 ─▶ 主会话
主会话 ─ chat_send { platform, text } ─▶ 对话中枢 ─ 路由 ─▶ 平台.send ─▶ 主人
                                          └─ outputs + plugin.output ─▶ 对话窗口 / 运行流
主会话（请求 / 增量 / 回复 / 工具调用）─ 总线 ─▶ 运行流
```

## 2. `chat_send`

```json
{
  "platform": "webchat",
  "text": "…（Markdown）",
  "reply_to": "可选，平台的消息 id",
  "images": ["charts/spend.png", "blob:…"],
  "choices": { "options": [{ "label": "周五下午", "detail": "15:00" }, { "label": "下周一" }], "multiple": false },
  "widget": { "title": "支出与预算", "code": "<div>…</div><script>…</script>" },
  "final": true
}
```

- `final: true` 表示这条消息是本回合最后一件事：发送成功后回合立刻结束，不再为看回执多调用一次模型（[ADR-0020](../20-decisions/ADR-0020-fork-reuse-client-tool-search-final-reply.md)）。不带时照旧继续（先回一句再接着干活）。对话窗口在本批已经送达过回复后，不为"只是在看回执"的那一轮显示思考提示，页头写"收尾中…"；确实在用工具时照常显示。
- `text` 之外的三项（`images`、`choices`、`widget`）都是可选的，只有平台声明了对应能力才能用（§3）；`chat_send` 的 schema 里只出现至少有一个运行中的平台声明了的字段。
- **能力不匹配时不改写**：调用带了平台没有声明的字段，回执失败并说明（如 `telegram does not show choices; put the options in the text`），没有消息发出。
- 工具描述里有一行按声明生成的平台能力（`webchat: full Markdown, …, images, choices, widget; telegram: plain text, up to 3500 characters a message`），模型据此决定写什么，新平台不用在提示词里再写一遍。
- `images`：工作区路径或 blob 句柄，和 `view_image` 同一套解析；最多 `vision.maxImagesPerMessage` 张。
- `choices`：2–6 项，`label` 不超过 40 字符、不以 `/` 或空白开头（聊天平台用 `/approve <id>` 做审批）、互不相同。答案不阻塞这次调用，之后作为普通的 `chat.message` 到达（§3）。
- `widget`：一段 HTML 或 SVG 片段，存进 `widgets` 表（内容寻址），只在网页的沙箱外壳里运行（[14-security-and-permissions.md](14-security-and-permissions.md) §8）。回执前检查大小、外部资源引用和内联脚本的语法（只编译不执行），有问题时回执失败并指出原因。`chat.widgets: false` 关掉它。

- `platform` 必填，没有默认值。schema 里是正在运行的平台的枚举；平台启停时工具随之更新。没有平台在运行时不注册这个工具。
- 只发给主人。发给第三方（例如 Telegram 群）仍是平台自己的工具，默认走审批。
- 回执可验证：成功时给平台的消息 id；平台没准备好时返回失败和原因；写错平台时校验错误里列出可选值。
- 标志 `sideEffect`、`barrierAfter`，默认策略 `allow`。出站限流按 `platform` 计（`pluginHost.outboundPerMinute`），和该平台的其他工具共享额度。
- 模型怎么选：回复时用事件的 `source`；主动发起时用 `<status/>` 的 `last_chat`（主人最近写消息的、正在运行的平台）。

实现：`packages/core/src/chat/hub.ts`（`ChatHub`）。工具的 owner 是 `chat`。

## 3. 平台契约

**入站**：主人的对话消息用类型 `chat.message`，`source` 是平台 id；`correlation` 放平台的消息 id，可作 `reply_to`。身份仍由 `owner.identities` 判定。非主人或非私聊的消息保持平台自己的类型，不算对话。

**出站**：

| | 进程内插件 | 进程外插件 |
|---|---|---|
| 声明 | 插件对象的 `chat` 字段 | 清单的 `chat` 块加能力位 `chat` |
| 发送 | `chat.send(req)` | 宿主到插件的 RPC `chat/send` |
| 草稿 | 读总线记录 `chat.draft`（网页），或 `chat.draft(d)` | 宿主到插件的通知 `chat/draft`（能力位 `chatDrafts`） |
| SDK | — | TS：`definePlugin({ chat: { send, draft? } })`、`chatAnswer()`；Python：覆盖 `on_chat_send`、`on_chat_draft`，`chat_answer()` |

平台声明自己显示什么，声明了就要做到：

| `chat` 块的键 | 含义 | 声明了就要做到 |
|---|---|---|
| `markdown` | `none` / `basic` / `full` | — |
| `maxChars` | 单条消息的上限 | 超长自己分段 |
| `images` | 能发图片 | `chat/send` 带 `images`，用 `blob/get` 取字节 |
| `choices` | 能显示可点的选项 | 把答案推回来，让旧选项失效 |
| `widgets` | 能显示小组件，或给出打开它的入口 | `chat/send` 带 `widget: { id, title, url? }`；`url` 是网页里的单独页面，配置了 `control.publicUrl` 才有 |
| `drafts` | `{ minIntervalMs? }`：能边写边显示 | **必须能撤回**已经显示的预览 |

**答案怎么回来**：主人点了选项，平台推一条普通的 `chat.message`，`text` 是所选的内容，`meta.answer = { to: <chat/send 的 callId>, labels: [...] }`。核心不解释它，只带进对话历史供界面标出"已选"。一个平台上只有最新的一组选项有效：主人发了别的消息，或助理又发了新的一组，旧的就失效；平台应当撤掉失效的控件，撤不掉的必须丢弃过期的点击。

清单和能力位必须同时存在，否则不注册（日志告警，`protea dev-plugin --check` 报失败）。记录由中枢做，插件不用管。

示例：`examples/plugins/ts-chat` 是一个把对话写进两个文件的最小平台，声明并实现全部能力，端到端测试用它验证进程外的整条路径。

接入新平台：写一个连接器插件并在清单里加 `chat`；把主人的私聊推成 `chat.message`；实现 `chat/send`；在 `owner.identities` 里加上主人在该平台的 `senderKey`。Core、网页和控制台都不用改。

内置平台：

- `webchat`（`plugins/webchat`，进程内）：网页对话窗口与 `protea chat`。声明了全部能力（`markdown: full`、图片、选项、小组件、草稿）。输入走 `POST /api/chat/messages`；发送只需成功，中枢存下并发布，窗口据此显示，主人不在线时留在历史里。待定的授权请求在窗口里是带按钮的卡片（读 `/api/approvals`）；对话历史里只留两行记录：请求了什么、结果如何。
- `telegram`（`plugins/telegram`，进程外）：主人私聊是 `chat.message`，`telegram.edited`、他人消息和群消息保持原类型；`tg_send_chat`、`tg_react` 不变。
- `wechat`（`plugins/wechat`，进程外）：扫码登录，主人私聊是 `chat.message`，其余是 `wechat.message` 且只存储。机器人不能先开口，窗口关闭时 `chat_send` 返回失败回执（[08-event-source-plugins.md](08-event-source-plugins.md) §6.3）。
- `qq`（`plugins/qq`，进程外）：扫码即创建机器人并登录，主人私聊是 `chat.message`，其余是 `qq.message`。打开 `groups` 后，@机器人的群消息会投递，并可用 `qq_group_reply` 回群（默认需要审批）。和微信一样不能指望先开口，被拒时 `chat_send` 返回失败回执。声明了图片、选项和草稿：选项是按钮（QQ 不让发按钮时改成编号列表），草稿用 QQ 的私聊流式消息；不声明小组件（[08-event-source-plugins.md](08-event-source-plugins.md) §6.4）。

Protea 自己发给主人的通知（`ChatHub.notifyOwner`）先发到主人最近写消息的平台，失败后依次尝试其他运行中的平台。`chat_send` 不做这种回退：平台由模型指定。

## 4. 控制台

侧边栏按"先回答现在需要我做什么"分组（2026-11-12）：

| 分组 | 页面 |
|---|---|
| — | 总览：最上面是"需要你处理"（待确认的操作、能力变更、异常的插件或 MCP、模型未就绪、预算告警、投递暂停），然后是四个数字、正在进行的事和接下来的定时任务 |
| 待办 | 审批（等你确认 / 能力变更 / 处理记录）、定时任务 |
| 观察 | 运行流、会话、日志 |
| 能力 | 插件、MCP、Skills、模型、记忆与人格 |
| 系统 | 权限（模式、工具规则、暂时不再询问、审计记录）、配置 |

只有等待决定的数量才显示徽标。侧边栏可以收成图标栏。旧地址（`approvals?tab=grants|audit`、`config?tab=permissions`）自动跳到权限页。

- **定时任务**（`#/console/schedules`）：`cron` 插件的全部任务，可以新建、改、暂停、立即运行、删除，看最近的运行；`config.yaml` 里定义的只读。接口见 [05-control-api.md](../30-specs/05-control-api.md)。
- **运行流**（原事件流页，`#/console/events`）：同一条时间线上按类别显示用户输入、事件、模型请求的上下文摘要、思考（折叠）、正文（流式）、工具调用与结果、发出的消息、批与调度动作。顶部按类别筛选。输入框是运维注入。点批标记或 `?batch=<id>` 打开这一批的完整过程。
- **上下文**（会话页的标签，仅管理员）：下一次请求的系统段、工具、合并后的消息和 token 组成。
- **`console` 插件**：只有注入（`POST /api/events`、运行流输入框、`protea events push`），没有回复工具。模型的回应是正文，显示在运行流。

## 5. 运行流的数据

总线记录（WebSocket 分组 `trace`，页面打开时才订阅）：

| 记录 | 内容 |
|---|---|
| `model.request` | 回合、模型、上下文摘要（各系统段大小、工具数、消息数、估算 token、前缀是否变化） |
| `model.delta` | 正文与思考的增量，约 50 ms 合并一次，不落库，不进崩溃报告的总线记录 |
| `model.response` | 本回合完整内容（思考只给摘要、不带签名）、停止原因、用量 |
| `tool.call` | 开始（输入）与结束（耗时、是否出错、结果，最多 8000 字符）；被拒绝的调用也有；秘密值已脱敏 |

观察不改变运行：它不经过 `outputTap`，所以不算"外部输出"，模型调用仍可被抢占（[04-scheduling-and-preemption.md](04-scheduling-and-preemption.md)）。

历史：`GET /api/batches/:id/trace` 从转录（按批号，跨交接时跟到上一个文件并去掉复制的尾部）、`outputs` 和事件拼出步骤，不新增存储。转录文件被清理后这一批就没有步骤了。

### 回复草稿（流式）

主人看到的回复是 `chat_send` 的参数，不是模型正文，所以对话窗口读的不是 `model.delta`，而是 `chat_send` 的 `text` 增量：

- Provider 用 `onToolInput` 交出工具参数的 JSON 片段（Anthropic 的 `input_json_delta`、OpenAI Chat 的 `tool_calls`、Responses 的 `function_call_arguments.delta`）。
- `ChatDraftStream`（`packages/core/src/chat/draft.ts`）从未写完的 JSON 里取出 `platform` 和 `text`，约 50 ms 合并一次，发总线记录 `chat.draft`。`platform` 写完之前文字先压着。只有声明了 `drafts` 的平台才发，目前是 `webchat`、`qq` 与示例平台 `ts-chat`；Telegram 仍整条发送。只有主会话有草稿，Fork 发的消息整条显示。
- 草稿的 `pending` 列出已经开始写的结构化部分（`images`、`choices`、`widget`），窗口据此显示"正在生成小组件…"。
- **进程外平台**：清单声明 `chat.drafts` 并带能力位 `chatDrafts` 的平台从通知 `chat/draft` 收到草稿。和总线上的片段不同，它每次带到目前为止的全文，按平台声明的 `minIntervalMs` 合并（默认 1000，最小 250），因为多数平台对改消息有频率限制。结束只有两种：同一个 `callId` 的 `chat/send`（预览换成正式消息），或 `discarded`（撤掉预览）。没有显示过的草稿被撤回时平台不会收到任何东西。
- 结束：发送成功时，带同一 `callId` 的 `output` 替换草稿。模型调用被取消或重试、`chat_send` 被拒绝或失败、批结束时，`state: discarded` 撤回草稿。成功之后也会收到一条 `discarded`，客户端找不到这个草稿，直接忽略。
- 订阅：WebSocket 分组 `chat`，或 `/api/stream?drafts=1`。`protea chat` 只有标准输出是终端时才要草稿，接管道时仍是整条回复。
- 每个片段带 `offset`。中途打开页面或重连时，对不上的片段被忽略，等完整回复到达。
- 草稿不落库，不进崩溃报告的总线记录，也不算外部输出，模型调用仍可被抢占；被抢占时草稿从窗口消失，模型带着新事件重新回答。

## 6. 升级

- 启动时在 `kv`（`core` / `chat.split`）记下分界游标，分界之前的 `console` 对话继续算作 `webchat`。事件日志不改写，不需要数据库迁移，旧镜像仍能打开数据库。
- `owner.identities` 只写了 `console` 时，同样的发送者也算 `webchat` 的主人，并告警提示写进配置。
- 当前转录里还有 `con_send` 调用时，启动后做一次交接（`keep: 0`）。系统前缀变了，缓存会失效一次。
