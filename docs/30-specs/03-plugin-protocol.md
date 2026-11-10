# 规范：进程外插件协议

> 状态：Accepted（M2，部分方法见 §8）· 更新：2026-11-03 · 实现：`packages/protocol/src/rpc.ts`、`plugin.ts` · 设计：[../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md)

## 1. 传输

- 子进程 stdin/stdout，**NDJSON**（每行一个 JSON-RPC 2.0 消息，UTF-8，`\n` 结尾）。stderr 作为原始日志捕获（级别 `debug`）。
- 请求可双向；通知（无 `id`）用于高频单向消息。
- 单条消息上限 4 MB；附件走 `blob/*`。
- 协议版本在 `initialize` 协商：`{ protocolVersion: 1 }`。

## 2. 握手

```
host → plugin : initialize { protocolVersion, pluginId, config, dataDir, hostDataDir, timezone, language, hostCapabilities, modelFacts, levelCap, allowedTriggers }
plugin → host : result { protocolVersion, capabilities: { tools, events, envPrompt, runPhase, settled, shutdownVerify, approvals?, hooks?, chat?, login? }, displayName? }
host → plugin : tools/list {}            （capabilities.tools 为真时）
host → plugin : start {}
plugin → host : result {}
```

`initialize` 超时 20 s → 启动失败。`config` 中的 `${secret:NAME}` 已由宿主解析；`dataDir` 是插件的可写目录 `/data/plugin-data/<id>`，`hostDataDir` 是守护进程的数据目录（供 `filewatch` 之类监视共享目录的插件使用）。`capabilities.approvals` 表示能把审批请求送到主人（`approvals/request`）；`capabilities.hooks` 列出插件服务的 webhook 名，宿主把 `/hooks/<name>` 转给它（`http/request`），名单在启动时确定（对应配置应标 `x-hot: false`）。

## 3. 方法（host → plugin）

| 方法 | 参数 | 返回 |
|---|---|---|
| `initialize` | 见上 | capabilities |
| `start` | `{}` | `{}` |
| `stop` | `{ reason, deadlineMs }` | `{}`（超时则 SIGTERM → SIGKILL） |
| `config/changed` | `{ patch, full }` | `{}` |
| `tools/list` | `{}` | `{ tools: ToolDecl[] }` |
| `tools/call` | `{ callId, name, input, context: { sessionId, batchLevel, correlation } }` | `{ text, images?: [{ handle }], failed?, partial?, endsTurn?, meta? }` |
| `tools/cancel` | `{ callId }`（通知） | — |
| `env/prompt` | `{ language }` | `{ vars: object \| null }` |
| `events/settled` | `{ events: [{cursor, outcome}] }`（通知） | — |
| `run/phase` | `{ phase, turn, tool? }`（通知，需 capability） | — |
| `health` | `{}` | `{ ok: boolean, detail? }` |
| `shutdown/verify` | `{ language }` | `{ snapshot: object }` |
| `approvals/request` | `{ id, tool, summary, reason?, expiresAt }`（需 capability） | `{ delivered: boolean }` |
| `chat/send` | `{ text, replyTo?, sessionId?, batchId? }`（需 capability `chat` 与清单的 `chat` 块） | `{ ok, messageIds?, error? }` |
| `http/request` | `{ hook, method, path, query, headers, bodyBase64 }`（需 capability） | `{ status, headers?, body? }` |
| `login/start` · `login/status` · `login/cancel` | `{}`（需 capability `login` 与清单的 `login` 块） | `PluginLoginStatus`，立即返回 |
| `login/submit` | `{ code }` | `PluginLoginStatus` |

`PluginLoginStatus`：`{ state: idle \| waiting \| scanned \| need_code \| connected \| already_bound \| failed, qr?, expiresAt?, message?, account? }`。`qr` 是二维码要编码的文本，由宿主绘制。登录在插件后台进行，成功后插件调用 `login/complete`。

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
| `blob/put` | `{ dataBase64, mime? }` | `{ handle, mime, size }`；只收图片（PNG、JPEG、WebP、GIF），类型按内容判断，上限 `vision.maxImageKb`，不是图片或超限时报 `InvalidParams` |
| `blob/get` | `{ handle }` | `{ dataBase64, mime, size }`；句柄是内容摘要，知道句柄的插件才读得到 |
| `log` | `{ level, msg, fields }`（通知） | — |
| `usage/report` | `{ service, units, cost? }`（通知） | — |
| `kv/get` / `kv/set` / `kv/delete` | `{ key, value? }` | |
| `owner/resolve` | `{ senderKey }` | `{ role: 'owner' \| 'unknown' }` |
| `secrets/exists` | `{ name }` | `{ exists }`（值永不返回；值在启动时经环境变量注入） |
| `permissions/mode` | `{ senderKey, mode?, forMs? }` | `PermissionModeInfo`；不带 `mode` 只读取。`senderKey` 必须是本插件映射的主人，否则 `Unauthorized`；不带 `forMs` 的 `mode` 写成基线，`bypass` 必须带 `forMs` |
| `login/complete` | `{ secrets: { NAME: value }, ownerSenderKey? }` | `{ ok }`；只在宿主发起的登录期间有效，否则 `-32007 Unauthorized`；秘密名必须在清单的 `secrets` 或 `optionalSecrets` 里。宿主存入秘密库，把 `ownerSenderKey` 写成本插件的主人（替换旧的），回复后重启插件 |
| `approvals/decide` | `{ id, decision: 'approve' \| 'deny', senderKey, grantMs? }` | `{ ok, state?, message? }`；`grantMs`：同意时还在这段时间内放行同一组工具（上限 `permissions.grantMaxMs`）；`senderKey` 必须解析为本插件的主人，否则 `-32007 Unauthorized` |

## 5. 错误

JSON-RPC 标准错误码 + 自定义：`-32001 LevelExceeded`、`-32002 TriggerNotAllowed`、`-32003 Deduped`（警告级）、`-32004 ToolNotFound`、`-32005 Cancelled`、`-32006 Draining`、`-32007 Unauthorized`、`-32008 Timeout`、`-32009 Closed`。

工具处理器抛错时，SDK 返回 `{ text, failed: true }`（失败回执），而不是协议错误；未知工具名返回 `-32004`。`events/push` 的门禁结果在返回值里：越权的等级与模式被降级（`effectiveLevel`、`effectiveTrigger`、`warnings`），schema 不合法时返回 `-32602`。

## 6. 生命周期与信号

- 宿主每 `healthcheck.intervalMs`（默认 30 s）发 `health`；连续 3 次超时 → 宿主 SIGKILL 并视为 crashed。`{ ok: false }` 只记警告，不算崩溃。
- `stop` 后插件应在 `deadlineMs` 内退出进程；否则 SIGTERM，再 5 s SIGKILL。
- 插件不得向 stdout 写非协议内容；SDK 把 `console.log` / `print` 重定向到 stderr，stderr 被宿主按 `debug` 级记录。
- 宿主关闭 stdin 时插件应退出。

## 7. 参考实现

`@protea/plugin-sdk`（TypeScript，含 `@protea/plugin-sdk/testing` 的 `FakeHost`）与 `protea_plugin`（Python，`sdks/python`；尚未发布到 PyPI，宿主把它放进 `PYTHONPATH`）。一致性检查：`protea dev-plugin <dir> --check`（`checkConformance()`）。

## 8. 实现状态（M2）

已实现：§2 握手；§3 全部方法外加 `approvals/request`、`http/request`；§4 的 `events/push`、`events/withdraw`、`events/promote`（仅 `flush` / `piggyback`，仅本插件的事件）、`events/query`（仅本插件来源）、`log`、`kv/*`、`owner/resolve`、`secrets/exists`、`approvals/decide`。

尚未实现：`events/pushDeferred`、`events/pushCandidate`（及其 `events/render` / `events/choose` 回调）、`usage/report`、分块消息。
