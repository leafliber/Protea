# 规范：进程外插件协议

> 状态：Draft · 更新：2026-11-03 · 设计：[../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md)

## 1. 传输

- 子进程 stdin/stdout，**NDJSON**（每行一个 JSON-RPC 2.0 消息，UTF-8，`\n` 结尾）。stderr 作为原始日志捕获（级别 `debug`）。
- 请求可双向；通知（无 `id`）用于高频单向消息。
- 单条消息上限 4 MB；附件走 `blob/*`。
- 协议版本在 `initialize` 协商：`{ protocolVersion: 1 }`。

## 2. 握手

```
host → plugin : initialize { protocolVersion, pluginId, config, dataDir, timezone, hostCapabilities, modelFacts, levelCap, allowedTriggers }
plugin → host : result { protocolVersion, capabilities: { tools, events, envPrompt, runPhase, settled, shutdownVerify }, displayName? }
host → plugin : start {}
plugin → host : result {}
```

`initialize` 超时 20 s → 启动失败。

## 3. 方法（host → plugin）

| 方法 | 参数 | 返回 |
|---|---|---|
| `initialize` | 见上 | capabilities |
| `start` | `{}` | `{}` |
| `stop` | `{ reason, deadlineMs }` | `{}`（超时则 SIGTERM → SIGKILL） |
| `config/changed` | `{ patch, full }` | `{}` |
| `tools/list` | `{}` | `{ tools: ToolDecl[] }` |
| `tools/call` | `{ callId, name, input, context: { sessionId, batchLevel, correlation } }` | `{ text, blobs?, failed?, partial?, endsTurn?, meta? }` |
| `tools/cancel` | `{ callId }`（通知） | — |
| `env/prompt` | `{ language }` | `{ vars: object \| null }` |
| `events/settled` | `{ events: [{cursor, outcome}] }`（通知） | — |
| `run/phase` | `{ phase, turn, tool? }`（通知，需 capability） | — |
| `health` | `{}` | `{ ok: boolean, detail? }` |
| `shutdown/verify` | `{ language }` | `{ snapshot: object }` |

`ToolDecl`：`{ name, description, inputSchema, flags?: { endsTurn?, barrierAfter?, interruptible?, readOnly?, sideEffect? }, timeoutMs? }`

## 4. 方法（plugin → host）

| 方法 | 参数 | 返回 |
|---|---|---|
| `events/push` | `EventInput` + `{ trigger? }` | `{ cursor, effectiveLevel, effectiveTrigger, deduped }` |
| `events/pushDeferred` | `{ stub: EventInput 省略 text, trigger, renderTimeoutMs }` | `{ cursor }`；投递时宿主回调 `events/render { cursor }` → `{ text \| null }` |
| `events/pushCandidate` | `{ raw: object, candidates: EventInput[], trigger }` | `{ cursor }`；投递时回调 `events/choose { cursor }` → `{ index \| null }` |
| `events/withdraw` | `{ cursor }` | `{ ok }` |
| `events/promote` | `{ cursor, trigger }` | `{ ok, effectiveTrigger }` |
| `events/query` | `{ filter, limit }` | `{ events }`（仅本插件来源） |
| `blob/put` | `{ mime, name?, base64 }` 或分块 | `{ handle }` |
| `blob/get` | `{ handle }` | `{ mime, base64 }` |
| `log` | `{ level, msg, fields }`（通知） | — |
| `usage/report` | `{ service, units, cost? }`（通知） | — |
| `kv/get` / `kv/set` / `kv/delete` | `{ key, value? }` | |
| `owner/resolve` | `{ senderKey }` | `{ role: 'owner' \| 'unknown' }` |
| `secrets/exists` | `{ name }` | `{ exists }`（值永不返回；值在启动时经环境变量注入） |

## 5. 错误

JSON-RPC 标准错误码 + 自定义：`-32001 LevelExceeded`、`-32002 TriggerNotAllowed`、`-32003 Deduped`（警告级）、`-32004 ToolNotFound`、`-32005 Cancelled`、`-32006 Draining`。

## 6. 生命周期与信号

- 宿主每 `healthcheck.intervalMs` 发 `health`；连续 3 次超时 → 视为 crashed。
- `stop` 后插件应在 `deadlineMs` 内退出进程；否则 SIGTERM，再 5 s SIGKILL。
- 插件不得向 stdout 写非协议内容。

## 7. 参考实现

`@protea/plugin-sdk`（TypeScript）与 `protea-plugin`（Python，`pip install protea-plugin`）。两者都提供 `FakeHost` 用于测试。
