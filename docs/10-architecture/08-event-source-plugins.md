# 事件源插件

> 状态：Draft（`webhook`、`telegram`、`filewatch` 已在 M2 实现）· 更新：2026-11-03

本文描述 `source` 与 `connector` 两类插件的契约与最佳实践，并列出 v1 内置来源。通用插件机制见 [07-plugin-system.md](07-plugin-system.md)。

## 1. 事件源的职责

1. **观察**外部世界，把变化转成事件：只报告已发生的事实，不做推断（P4）。
2. **声明等级上限与允许的投递模式**（清单），并为每个事件选择不高于上限的等级与模式。
3. **提供幂等键**（`dedupeKey`），让重启与重连不产生重复。
4. **提供稳定的 senderKey**，让 Core 做身份映射（谁是主人）。
5. **处理 settled 回调**：已读标记、重试、清理。
6. 连接器额外：**声明出口工具**，并把工具回执写得可验证（例如返回平台消息 ID）。

事件源**不**负责：决定模型是否响应（P5）、访问记忆、调用其他插件、绕过 Core 直接写存储。

## 2. 等级选择指南

| 情况 | 等级 | 模式 | 备注 |
|---|---|---|---|
| 主人在私聊里说话 | L1 | `flush`（默认）/ `preempt`（主人连续发多条时第一条用 preempt） | 只有 owner/resolve 返回 `owner` 时才可用 L1 |
| 主人说"停"、"等一下" | L1 | `interrupt` | 连接器可用简单规则识别停止词；不确定则 `preempt` |
| 群聊里 @ 助理 | L2 | `flush` | 非主人 @ 时也是 L2 |
| 群聊普通消息 | L4 | `piggyback` 或 `store` | 模型需要时用 `events_query` 看 |
| Webhook：CI 失败、告警 | L2 | `flush` | |
| Webhook：普通推送 | L3 | `debounce` | |
| 日历提醒（到点） | L2 | `flush` | |
| 定时任务 | L3 | `debounce` | |
| RSS、日志、指标 | L4 | `piggyback` | |
| 文件变化 | L3/L4 | `debounce` | 短时间大量变化应合并为候选事件 |

## 3. 文本规范

- `text` 是模型看到的全部内容。写法：**事实 + 必要引用**，不加评价。例如：

  ```
  Message from owner in private chat (msg 1832, reply to 1830):
  帮我看看明天日程
  ```

- 长内容（邮件正文、网页）**不要**整段放进事件；放摘要或前 N 行 + 句柄，让模型通过工具取全文。建议上限 2 KB。
- 结构化数据放 `meta`，若模型需要再由来源决定写入 `text`。
- 附件通过 `blob/put` 获得句柄，放入 `blobs`。

## 4. 连接器的出口工具

- 命名：`<前缀>_<动作>`，前缀 2–4 字符（`tg_`、`sl_`、`gh_`）。
- 回执：成功返回平台可验证的标识（消息 ID、URL）；失败 `{ failed: true, text }`。
- `interruptible`：长时间上传类工具应当声明并响应取消。
- `barrierAfter`：发消息类工具通常声明，避免并行发送导致乱序。
- 副作用：所有出站工具在清单 `sideEffectTools` 中列出；默认策略 `allow`（给主人发）/ `ask`（给第三方发），详见 [14-security-and-permissions.md](14-security-and-permissions.md)。

给主人的对话不用自己的工具：声明 `chat` 后由 `chat_send` 路由过来，见 [17-chat-and-console.md](17-chat-and-console.md) §3。上面的规则针对其余出口（发给第三方、表情回应等）。

## 5. 环境提示（ENV_PROMPT.md）

讲三件事：何时用这个插件、跨工具协调、约束。不要重复工具描述。示例（Telegram）：

```
## Telegram
You reach the owner through Telegram. {{#if ownerChatId}}The owner's private chat is {{ownerChatId}}.{{/if}}
Reply with chat_send (platform "telegram") when a message warrants a response; it is fine to stay silent on low-value messages.
Long messages: split at ~3500 characters. Use tg_react for lightweight acknowledgement instead of a text reply.
```

## 6. v1 内置来源清单

| ID | kind | 等级上限 | 说明 | 里程碑 |
|---|---|---|---|---|
| `console` | source | L1 | 运维注入（控制台运行流、`protea events push`）；没有回复工具 | M0，2026-11-10 收窄 |
| `webchat` | connector（对话平台） | L1 | 网页对话窗口与 `protea chat` | 2026-11-10 |
| `cron` | source | L3 | cron 表达式与一次性定时（`sleep_until`、`schedule_create` / `schedule_update` 的后端）；任务可以暂停，控制台的「定时任务」页能新建、修改、立即运行和删除（操作者改动助理建的任务时推一条 L4 的 `schedule.changed`）；支持例程派生 | M0，2026-11-12 扩充 |
| `internal` | source | L0 | Core 专用：生命周期、预算、抢占通知 | M0 |
| `webhook` | source | L2 | HTTP 入站（`/hooks/<name>`），签名校验（GitHub/通用 HMAC/token） | M2 ✓ |
| `telegram` | connector（对话平台） | L1 | Bot API 长轮询（无需入站端口）；owner 由用户 id 映射 | M2 ✓ |
| `wechat` | connector（对话平台） | L1 | 官方 iLink 通道，扫码登录、长轮询（无需入站端口）；基于官方客户端 | 2026-11-10 |
| `qq` | connector（对话平台） | L1 | 官方 QQ 机器人，扫码即创建并登录；WebSocket 网关（无需入站端口）；基于官方 SDK；群消息可选 | 2026-11-11 |
| `filewatch` | source | L3 | 监视 `/data/inbox` 等目录 | M2 ✓ |
| `rss` | source | L4 | 定时抓取，按条目去重 | M3 ✓ |
| `imap` | source | L2 | IDLE/轮询；邮件到达事件 + `mail_fetch` 工具 | M3 ✓ |
| `dida365` | source+tool | L2 | 滴答清单 Open API：任务、清单、标签、评论、专注、习惯、倒数日的工具；可选的任务到期事件（轮询） | 2026-11-12 |
| `slack` / `discord` | connector | L1 | 社区实现优先 | M7+ |
| `caldav` | source+tool | L2 | 日历提醒事件 + 查询工具 | M7+ |

### 6.1 M2 内置插件的行为

**telegram**（秘密 `TELEGRAM_BOT_TOKEN`；在 `owner.identities` 加 `{ plugin: telegram, senderKey: "telegram:<你的用户 id>" }`）：
- 长轮询 `getUpdates`，每个更新先入库（`dedupeKey: update:<id>`），再把偏移量写入 kv，因此崩溃重启只会重读、不会丢；网络故障按 1 s→30 s 退避，遵守 `retry_after`。
- 主人私聊 → `chat.message`，L1 `flush`（编辑过的消息是 `telegram.edited`，其余见下，都用 `telegram.*` 类型）；消息正好是停止词（默认 `stop`、`wait`、`停`、`停下`、`等一下`、`别说了`，可配 `stopWords`）→ L1 `interrupt`；`/approve aN`、`/deny aN` → 审批决定，不产生消息事件；陌生人私聊 → L2 `flush`；群里 @机器人或回复机器人 → L2 `flush`；其他群消息 → L4 `store`（`groupMentionsOnly: false` 时为 L2）。
- 主人私聊的 chat id 从主人的第一条消息学到（或配置 `ownerChatId`）。对话平台：`chat_send` 的 `telegram`（发给主人，超过 3500 字符自动分段）。工具：`tg_send_chat`（发给其他聊天，默认需要审批）、`tg_react`。
- 配置：`apiBase`（`x-hot: false`）、`pollTimeoutSec`、`ownerChatId`、`stopWords`、`groupMentionsOnly`。

**webhook**：配置 `hooks: [{ name, verify: github | hmac-sha256 | token | none, secret: "${secret:NAME}", header?, level?, trigger?, maxTextChars? }]`（`x-hot: false`）。事件类型 `webhook.<name>`；GitHub 事件（push、pull_request、issues、issue_comment、workflow_run、release、ping）写成一行事实描述并附截断的负载，其他请求附前 2000 字符；`dedupeKey` 取 `X-GitHub-Delivery` / `X-Request-Id` / `Idempotency-Key`，否则取请求体哈希。默认 L2 `flush`（L3 用 `debounce`）。返回 202 `{cursor, deduped}`；校验失败 401，不入库。

**filewatch**：配置 `paths`（默认 `["inbox"]`，相对数据目录）、`debounceMs`（默认 2 s）、`level`（3 或 4）、`ignore`（默认跳过点文件、`*~`、`*.tmp`、`*.part`、`*.swp`）。一段安静期内的所有变化合并成一个 `filewatch.changed` 事件（列出 `+` 新增、`~` 修改、`-` 删除及大小）；停机期间的变化在启动时补报（快照存 kv）。工具 `fw_list`、`fw_read`（只读，限制在被监视的目录内）。

### 6.2 M3 内置来源

**rss**：配置 `feeds: [{ url, name?, intervalMin?, level? }]`、`intervalMin`（默认 30）、`level`（4 = `piggyback`，默认；3 = `debounce`）、`firstRunItems`（默认 3）、`maxItemsPerPoll`（默认 10）、`timeoutSec`。解析 RSS 2.0、Atom、RSS 1.0（RDF）；用 `ETag` / `Last-Modified` 做条件请求。每个新条目一个 `rss.item` 事件（标题、链接、发布时间、去掉 HTML 的摘要前 400 字符），`dedupeKey` 由订阅名与条目 id 派生，按发布时间从旧到新推送；某个订阅第一次读取时只报最新 `firstRunItems` 条，其余记为已读。已读集合（每个订阅最多 1000 个）在事件入库后才写入 kv，崩溃重启只会重报、不会丢。工具 `rss_feeds`（每个订阅的状态与最近错误）、`rss_items`（最近条目）。

**imap**（秘密 `IMAP_PASSWORD`）：配置 `host`、`port`（993）、`secure`（true；false 时服务器提供 STARTTLS 才升级）、`user`、`mailbox`（`INBOX`）、`mode`（`idle` 默认，或 `poll` + `pollSec`）、`level`（默认 2）、`bulkLevel`（默认 4）、`important`（地址或 `@域名`，始终用 `level`）、`snippetChars`（500）、`rejectUnauthorized`。邮箱以只读方式打开（EXAMINE），不会把邮件标为已读。第一次连接只记录邮箱当前的 UID 位置；之后每封新邮件一个 `mail.received` 事件（发件人、主题、日期、收件人、正文开头、附件清单；`senderKey: mail:<地址>`，`dedupeKey: msg:<uidvalidity>:<uid>`）；邮件列表与自动邮件（`List-*`、`Precedence: bulk|list|junk`、`Auto-Submitted`）用 `bulkLevel`。位置在事件入库后才前移；`UIDVALIDITY` 变了就从当前末尾重新开始。连接断开后按 5 s 到 5 min 的退避重连，并补报期间到达的邮件；邮件服务器不可达不影响插件的健康检查（插件自己重连，不会被宿主当作崩溃重启）。工具 `mail_fetch {uid}`（完整正文，默认截断到 20000 字符）、`mail_search {from?, subject?, since?, unseen?}`。发件地址不能证明身份，邮件事件不会成为 L1。

### 6.3 微信

**wechat**（决策见 [ADR-0016](../20-decisions/ADR-0016-wechat-and-plugin-sign-in.md)；秘密 `WECHAT_BOT_TOKEN` 和主人身份由扫码登录写入）：
- 协议由腾讯的 `@tencent-weixin/openclaw-weixin` 实现。启动时 `notifystart`，长轮询 `getupdates`，事件入库后才把 `get_updates_buf` 写入 kv，崩溃重启只会重读；停止时 `notifystop`。网络或服务错误先等 2 s，连续 3 次后等 30 s。
- 主人私聊 → `chat.message`，L1 `flush`；消息正好是停止词 → L1 `interrupt`；`/approve aN`、`/deny aN`、`/mode` 与 Telegram 相同，不产生消息事件。非主人的私聊和带 `group_id` 的消息 → `wechat.message`，L4 `store`，不唤醒模型。`dedupeKey` 是 `msg:<message_id>`。
- 内容：图片解密后存 blob（只取主人的），失败时退回文字占位；语音用微信的转写文字，没有转写时占位；文件和视频只有占位；引用的内容拼进正文。
- 对话平台：`chat_send` 的 `wechat`，发给主人，超过 4000 字符自动分段，`reply_to` 忽略，文本经官方的 Markdown 过滤。**机器人不能先开口**：发送要带主人最新一条消息的 `context_token`。没有 token、`ret=-2`（回复窗口关闭）时都返回失败回执，模型应改走其他平台。社区实测称窗口约 24 小时、每条入站后最多约 10 条回复，没有官方说明，代码不依赖这些数字。
- 会话过期（`errcode -14`）：收发暂停 1 小时后重试，健康检查报告原因，推一条 L2 的 `wechat.session_expired`（每次过期只推一次）。
- 配置：`apiBase`、`cdnBase`（均 `x-hot: false`，测试用）、`stopWords`。

### 6.4 QQ

**qq**（决策见 [ADR-0017](../20-decisions/ADR-0017-qq-connector-and-qr-bot-creation.md)；秘密 `QQ_APP_SECRET` 和主人身份由扫码登录写入，也可以手动配置 `appId` 加秘密接入已有机器人）：
- 协议由腾讯的 `@tencent-connect/qqbot-nodejs` 实现：取 access token 并自动刷新，连 WebSocket 网关（心跳、断线重连）。网关会话存 kv，重启后 RESUME，平台补发期间的消息。连接失败从 5 s 退避到 5 min。
- 扫码：插件生成密钥、创建绑定任务，把 `connect.html` 链接作为二维码交给控制台。主人用手机 QQ 扫码确认后，平台建好机器人；插件用密钥解开 AppSecret，调用 `login/complete`。二维码过期自动换新，最多 3 张；8 分钟没完成算超时。
- 主人私聊 → `chat.message`，L1 `flush`；消息正好是停止词 → L1 `interrupt`；`/approve aN`、`/deny aN`、`/mode` 与微信相同，不产生消息事件。非主人私聊 → `qq.message`，L4 `store`。群消息：`groups` 关（默认）时 L4 `store`；开时 @机器人的群消息 → `qq.message`，L2 `flush`，其余 L4 `store`。频道消息 L4 `store`。`dedupeKey` 是 `msg:<id>`；消息按到达顺序逐条处理。
- 内容：主人的图片下载后存 blob，失败时附一行说明；别人的图片只有 `[image]` 占位；语音用 QQ 的转写；文件和视频只有占位；引用的内容拼进正文；表情转成文字。
- 对话平台：`chat_send` 的 `qq`，纯文本（`markdown: none`），超过 5000 字符自动分段，`reply_to` 忽略。回复带主人最新一条消息的 msg_id（被动回复）；被拒后改发不带 msg_id 的消息，再被拒就返回失败回执，模型应改走其他平台。还没收到过主人的消息时直接返回"不能先开口"。
- 回复带的东西（[17-chat-and-console.md](17-chat-and-console.md) §2–§3）：
  - **图片**：文字之后逐张上传（`/v2/users/{openid}/files`）再发富媒体消息，同样先试被动回复。每张图算一条回复，占被动回复的额度。
  - **选项**：单选发成内联按钮（回调型，`data` 是 `choice:<序号>`），主人按下后插件 5 秒内确认（`/interactions/{id}`），推一条带 `meta.answer` 的 `chat.message`；别人或群里按的确认为"无权限"，过期的确认为"失败"。没有选项文字的回复里，按钮跟在最后一段文字上。QQ 拒绝按钮时（很多机器人没有这项权限）只试这一次，不影响被动回复，改发编号列表；多选总是编号列表。主人回复编号（多选用空格或逗号隔开）或原样的标签就是回答；主人发别的消息，选项就失效。打开的选项存 kv（`choices`），重启后按钮仍然有效。
  - **草稿**：用 QQ 的私聊流式消息（`stream_messages`，同一条消息原地改写），间隔 500 ms，只在主人最新一条消息 4.5 分钟内开始（QQ 要求 5 分钟内）；正式发送时把同一条流式消息写完，图片和选项接在后面。撤回草稿时把流式消息改成"（这条回复没有写完，已撤回）"并结束它（流式消息不能删除）。QQ 不让流式时，第一帧就失败，回复整条发送。流式写到一半失败时，已经显示的部分留在那里，回复另发一条，主人会看到两条。
  - **小组件**：不声明。QQ 不能运行 HTML；把网页里小组件页面的链接发过去，又要在 q.qq.com 上把地址加进白名单，没有验证过。
- 工具 `qq_group_reply {message_id, text}`（只在 `groups` 开时提供，默认需要审批）：在群里回复一条投递过的 @消息。
- 网关拒绝（不可恢复的关闭码，如 4914 机器人下线或仅沙箱可用、4915 被封禁）：不再重连，健康检查报告原因，推一条 L2 的 `qq.connection_refused`，同一次拒绝只推一次。
- 配置：`appId`、`groups`（均 `x-hot: false`）、`stopWords`；`apiBase`、`tokenBase`、`bindBase`（`x-hot: false`，测试用）。

### 6.5 滴答清单

**dida365**（秘密 `DIDA365_TOKEN`：滴答清单 设置 → 账户 → API Token 创建的个人令牌，作为 Bearer 发送；官方文档 <https://developer.dida365.com/docs#/openapi>）：
- 不实现 OAuth：个人令牌是文档推荐的个人用法，免去注册应用和回调地址。`apiBase` 默认 `https://api.dida365.com`，TickTick 国际版改成 `https://api.ticktick.com`，接口相同。
- 工具（前缀 `dida_`，27 个，覆盖文档里除撤销令牌之外的全部接口）：
  - 总是提供：`dida_status`（检查令牌、账户时区、提醒状态）、`dida_delete {type: task|comment|project|project_group|focus}`（能删什么取决于开了哪些工具组）。
  - `tasks`：`dida_task_undone`（≤14 天内未完成）、`dida_task_filter`、`dida_task_search`、`dida_task_completed`、`dida_task_get`（可带评论）、`dida_task_create`、`dida_task_update`、`dida_task_complete`（一个走单个接口，多个按 50 个一批）、`dida_task_move`、`dida_task_batch`、`dida_task_assign`（`assignee: null` 取消指派）、`dida_comment_add`。
  - `projects`：`dida_project_list`（含清单分组）、`dida_project_get`（看板列、未完成任务、成员）、`dida_project_save`、`dida_group_save`、`dida_column_save`；`tags`：`dida_tag_list`、`dida_tag_create`；`focus`：`dida_focus_list`、`dida_focus_create`；`habits`：`dida_habit_list`（分组、打卡记录）、`dida_habit_save`、`dida_habit_checkin`；`countdowns`：`dida_countdown_list`。
  - 只读工具标 `readOnly`；其余标 `sideEffect` 并列入清单的 `sideEffectTools`，默认要审批，并各自声明 `approval`（中英文标题、最关键的输入与其余字段，[ADR-0021](../20-decisions/ADR-0021-readable-approval-requests-and-delivery.md)），授权请求里能直接看出要新建、修改或删除的是什么。
- 时间：模型写日期（`2026-11-13`，全天）、墙上时间（`2026-11-13T15:00`，按 `timeZone` 解读，默认守护进程时区）或带偏移的时刻；插件换算成接口的 `yyyy-MM-dd'T'HH:mm:ssZ`（一律写 UTC）。读出的时间按同一时区显示，全天任务按任务自己的时区取日期。优先级用 `none|low|medium|high`（0/1/3/5），状态用 `open|completed|abandoned`（0/2/-1）。
- 修改任务先读后写：文档没说更新接口会不会清空请求里没有的字段，所以 `dida_task_update` 与 `dida_task_batch` 的 `update` 先取回任务，把可编辑字段全部带上再叠加改动（子任务按 id 保留原有字段）。项目、分组、看板列、习惯的修改只发改动的字段（文档把这些字段都列为可选）。
- 路径里的 id 逐段转义，不能拼出别的路径。错误回执写明状态码、接口返回的错误和处理提示（401 提示重新生成令牌），令牌不进回执和日志。清单名每 5 分钟缓存一次，只用来给列表加名字，读不到时只显示 id。
- 到期提醒（`reminders.enabled`，默认关）：Open API 没有推送，插件每 `intervalMin`（默认 5）分钟用 `task/filter` 读未完成任务。定时任务在开始时间（`leadMin` 可提前）报一条 `dida365.task_due`；全天任务在当天 `dailyAt`（默认 09:00）报；`overdue` 开时（默认）每天 `dailyAt` 之后报一条 `dida365.overdue`，列出更早日期仍未完成的任务（最多 20 条）。等级 `level`（默认 3 `debounce`；2 `flush`；4 `piggyback`），`projectIds` 可限定清单。`dedupeKey` 为 `due:<任务 id>:<时刻>` 与 `overdue:<日期>`，重复任务完成后滚到下一次会再报。第一次检查只划线、不补报；之后每次从上次完整检查的时刻接着看，停机或接口故障最多补一天；事件入库后才记为已报，检查整轮成功才前移，崩溃只会重报、不会漏。状态在 kv 的 `reminders`。
- 配置：`apiBase`、`timeZone`、`defaultProjectId`（新任务的默认清单，默认收集箱）、`toolsets`（`x-hot: false`）、`maxResults`（列表最多返回几条，默认 50）、`timeoutSec`、`reminders { enabled, intervalMin, leadMin, dailyAt, overdue, level, projectIds }`。

## 7. 编写一个最小事件源（TypeScript）

```ts
import { definePlugin } from '@protea/plugin-sdk';

export default definePlugin({
  id: 'ping',
  kind: 'source',
  async start(host) {
    this.timer = setInterval(async () => {
      await host.events.push({
        type: 'ping.tick',
        ts: new Date().toISOString(),
        level: 3,
        trigger: 'debounce',
        text: `ping tick ${Date.now()}`,
        dedupeKey: String(Math.floor(Date.now() / 60000)),
      });
    }, host.config.intervalMs ?? 60_000);
  },
  async stop() { clearInterval(this.timer); },
  tools: () => [],
  envPromptVars: () => null,
});
```

Python 版本只是协议实现不同：`protea_plugin.Plugin` 基类 + 同名方法（`start`、`stop`、`tools`、`env_prompt_vars` …），见 `examples/plugins/py-notes`。

## 8. 测试要求

每个内置来源必须有：

- 协议级测试：用 `@protea/plugin-sdk/testing` 的 `FakeHost` 验证推送的事件信封合法、等级不越权、`dedupeKey` 稳定（M2 的三个内置插件都有，见 `plugins/*/test`；Telegram 用模拟的 Bot API 服务器）。
- 重放测试：录制一段真实输入（脱敏）→ 回放 → 事件序列快照一致。
- 故障测试：外部服务不可用时插件不崩溃、退避重连、心跳保持。
