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
Approvals: the owner replies "/approve <id>" or "/deny <id>"; those replies arrive as approval.decided events.
```

## 6. v1 内置来源清单

| ID | kind | 等级上限 | 说明 | 里程碑 |
|---|---|---|---|---|
| `console` | source | L1 | 运维注入（控制台运行流、`protea events push`）；没有回复工具 | M0，2026-11-10 收窄 |
| `webchat` | connector（对话平台） | L1 | 网页对话窗口与 `protea chat` | 2026-11-10 |
| `cron` | source | L3 | cron 表达式与一次性定时（`sleep_until`、`schedule_create` 的后端）；支持例程派生 | M0 |
| `internal` | source | L0 | Core 专用：生命周期、预算、抢占通知 | M0 |
| `webhook` | source | L2 | HTTP 入站（`/hooks/<name>`），签名校验（GitHub/通用 HMAC/token） | M2 ✓ |
| `telegram` | connector（对话平台） | L1 | Bot API 长轮询（无需入站端口）；owner 由用户 id 映射 | M2 ✓ |
| `filewatch` | source | L3 | 监视 `/data/inbox` 等目录 | M2 ✓ |
| `rss` | source | L4 | 定时抓取，按条目去重 | M3 ✓ |
| `imap` | source | L2 | IDLE/轮询；邮件到达事件 + `mail_fetch` 工具 | M3 ✓ |
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
