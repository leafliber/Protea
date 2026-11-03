# 规范：事件信封 Schema

> 状态：Draft · 更新：2026-11-03 · 设计：[../10-architecture/02-event-model.md](../10-architecture/02-event-model.md)

## 1. JSON Schema（插件推送时的输入形态）

Core 分配的字段（`cursor`、`run`、`receivedAt`）不在输入中。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://protea.dev/schemas/event-input.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["type", "ts", "level", "trigger", "text"],
  "properties": {
    "type":        { "type": "string", "pattern": "^[a-z0-9-]+\\.[a-z0-9_.-]+$", "maxLength": 128 },
    "ts":          { "type": "string", "format": "date-time" },
    "origin":      { "type": "string", "enum": ["external", "internal"], "default": "external" },
    "level":       { "type": "integer", "minimum": 0, "maximum": 4 },
    "trigger":     { "type": "string", "enum": ["debounce", "flush", "preempt", "interrupt", "piggyback", "store"] },
    "text":        { "type": "string", "maxLength": 65536 },
    "senderKey":   { "type": "string", "maxLength": 256 },
    "tags":        { "type": "array", "items": { "type": "string", "maxLength": 64 }, "maxItems": 32 },
    "meta":        { "type": "object" },
    "blobs":       { "type": "array", "items": { "$ref": "#/$defs/blobRef" }, "maxItems": 16 },
    "dedupeKey":   { "type": "string", "maxLength": 256 },
    "correlation": { "type": "string", "maxLength": 256 },
    "ephemeral":   { "type": "boolean", "default": false },
    "expiresAt":   { "type": "string", "format": "date-time" }
  },
  "$defs": {
    "blobRef": {
      "type": "object",
      "required": ["handle", "mime"],
      "properties": {
        "handle": { "type": "string", "pattern": "^blob:[a-f0-9]{64}$" },
        "mime":   { "type": "string" },
        "name":   { "type": "string" },
        "size":   { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

## 2. 存储形态（Core 补全后）

在输入字段之上增加：

| 字段 | 类型 | 说明 |
|---|---|---|
| `cursor` | integer | 全局序号 |
| `run` | string | 运行 ID（ULID） |
| `receivedAt` | date-time | Core 收到时间 |
| `source` | string | 插件 ID（由宿主根据连接填入，插件不可自报） |
| `effLevel` | integer | 门禁后的等级（通常等于 `level`） |
| `effTrigger` | string | 门禁/预算/老化后的实际模式 |
| `state` | enum | `pending / archived / delivering / delivered / withdrawn / expired / discarded` |
| `senderRole` | `owner` \| `unknown` | 有 `senderKey` 时由 Core 的身份映射得出；渲染为 `sender="owner"` 或 `sender="unknown:<senderKey>"` |
| `batchId` | string | 选入的批（`delivering` 之后） |

## 3. 校验与门禁顺序

1. Schema 校验（失败 → `rejected`，返回错误给插件）。
2. `source` 填入；`origin: internal` 非内核来源 → 降为 `external` + 警告。
3. `level` > 清单 `level` 上限 → 降到上限 + 警告事件。
4. L1 且 `owner/resolve(senderKey) ≠ owner` → 降到 L2。
5. `trigger` ∉ 等级允许集合 → 降到允许集合中最强者。
6. 预算门禁（可能降 trigger）。
7. 去重：`(source, dedupeKey)` 命中 → 返回已有游标，不新建。
8. 事务写入，分配 `cursor`。

## 4. 类型命名约定

插件事件：`<source>.<noun>[.<verb>]`，如 `telegram.message`、`telegram.message.edited`、`cron.tick`、`webhook.github.push`、`imap.mail.received`。

Core 事件：`source` 固定为 `core`，`type` 以子系统为前缀，如 `daemon.started`、`session.round_limit`、`model.error`、`fork.completed`、`approval.decided`、`budget.exhausted`。

## 5. 示例

```json
{
  "type": "telegram.message",
  "ts": "2026-11-03T09:12:03+08:00",
  "level": 1,
  "trigger": "flush",
  "text": "Message from owner in private chat (msg 1832):\n帮我看看明天日程",
  "senderKey": "telegram:12345",
  "dedupeKey": "update:884213",
  "meta": { "chatId": 12345, "messageId": 1832 },
  "tags": ["dm"]
}
```
