# 事件源插件

> 状态：Draft · 更新：2026-11-03

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

## 5. 环境提示（ENV_PROMPT.md）

讲三件事：何时用这个插件、跨工具协调、约束。不要重复工具描述。示例（Telegram）：

```
## Telegram
You reach the owner through Telegram. {{#if ownerChatId}}The owner's private chat is {{ownerChatId}}.{{/if}}
Reply with tg_send when a message warrants a response; it is fine to stay silent on low-value messages.
Long messages: split at ~3500 characters. Use tg_react for lightweight acknowledgement instead of a text reply.
Approvals: the owner replies "/approve <id>" or "/deny <id>"; those replies arrive as approval.decided events.
```

## 6. v1 内置来源清单

| ID | kind | 等级上限 | 说明 | 里程碑 |
|---|---|---|---|---|
| `console` | connector | L1 | 控制台/CLI 输入输出；开发与运维必备 | M0 |
| `cron` | source | L3 | cron 表达式与一次性定时（`sleep_until`、`schedule_create` 的后端）；支持例程派生 | M0 |
| `internal` | source | L0 | Core 专用：生命周期、预算、抢占通知 | M0 |
| `webhook` | source | L2 | HTTP 入站（`/hooks/<name>`），签名校验（GitHub/通用 HMAC） | M2 |
| `telegram` | connector | L1 | Bot API 长轮询（无需入站端口）；owner 由 chat id 映射 | M2 |
| `filewatch` | source | L3 | 监视 `/data/inbox` 等目录 | M2 |
| `rss` | source | L4 | 定时抓取，按条目去重 | M3 |
| `imap` | source | L2 | IDLE/轮询；邮件到达事件 + `mail_fetch` 工具 | M3 |
| `slack` / `discord` | connector | L1 | 社区实现优先 | M7+ |
| `caldav` | source+tool | L2 | 日历提醒事件 + 查询工具 | M7+ |

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

Python 版本只是协议实现不同：`protea_plugin.Plugin` 基类 + 同名方法。

## 8. 测试要求

每个内置来源必须有：

- 协议级测试：用 `@protea/plugin-sdk/testing` 的 `FakeHost` 验证推送的事件信封合法、等级不越权、`dedupeKey` 稳定。
- 重放测试：录制一段真实输入（脱敏）→ 回放 → 事件序列快照一致。
- 故障测试：外部服务不可用时插件不崩溃、退避重连、心跳保持。
