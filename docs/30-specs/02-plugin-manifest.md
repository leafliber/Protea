# 规范：插件清单（protea.plugin.json）

> 状态：Accepted（M2）· 更新：2026-11-03 · 实现：`packages/core/src/plugins/manifest.ts` · 设计：[../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md)

## 1. 字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string `^[a-z0-9][a-z0-9-]{1,31}$` | 是 | 全局唯一；配置组 `plugins.<id>` |
| `kind` | `source \| connector \| tool \| mcp \| skill \| provider` | 是 | |
| `api` | integer | 是 | 契约版本；当前 `1` |
| `version` | semver | 是 | 插件自身版本 |
| `displayName` | string | 否 | 控制台显示 |
| `description` | string | 否 | |
| `runtime.exec` | string | source/connector/tool 必需 | 可执行文件（`node`、`python3`、绝对路径） |
| `runtime.args` | string[] | 否 | |
| `runtime.cwd` | string | 否 | 相对插件目录 |
| `runtime.env` | object | 否 | 额外的环境变量；值中的 `${pluginDir}`、`${dataDir}` 被替换为插件目录与插件数据目录 |
| `runtime.dev` | `{ exec?, args? }` | 否 | 开发模式下内置插件改用的命令（例如 `{"args": ["src/main.ts"]}`，直接跑源码） |
| `runtime.inproc` | boolean | 否 | 保留给编译进守护进程的插件；在清单里写 `true` 会被判为 `invalid` |
| `level` | 1–4 | source/connector 必需 | 可声明的最高等级；`tool` 插件要推事件时也用它（如 `shell` 的 3） |
| `triggers` | string[] | 否 | 允许申请的投递模式；默认按等级表 |
| `tools` | string[] | 否 | 声明的工具名；运行时 `tools/list` 返回的名称若不在此列表 → 警告但生效 |
| `sideEffectTools` | string[] | 否 | 默认策略 `ask` 的工具 |
| `secrets` | string[] | 否 | 需要注入的秘密名；缺任何一个插件都不启动 |
| `optionalSecrets` | string[] | 否 | 有值就注入，没有也能启动（登录后才有的凭据） |
| `configSchema` | path | 否 | JSON Schema；支持 `x-hot: false`、`x-secret: true` 扩展关键字 |
| `envPrompt` | path | 否 | 默认 `ENV_PROMPT.md` |
| `skills` | path | 否 | 插件自带 Skills 目录，默认 `skills/`；必须在插件目录内。插件启用时其中的 Skills 进入目录（M3） |
| `chat` | object | 否 | 仅 `connector`：声明为对话平台，`{ displayName?, markdown?: none\|basic\|full, maxChars? }`。插件还须在 `initialize` 时声明能力 `chat` 并实现 `chat/send`（[17-chat-and-console.md](../10-architecture/17-chat-and-console.md) §3） |
| `login` | object | 否 | `{ method: "qr" }`：操作员可以在控制台登录这个插件。插件还须声明能力 `login` 并实现 `login/*`（[03-plugin-protocol.md](03-plugin-protocol.md) §3） |
| `healthcheck.intervalMs` / `timeoutMs` | integer | 否 | 默认 30000 / 5000 |
| `resources.maxMemoryMb` / `maxCpu` / `maxFds` | number | 否 | 默认 256 / 1.0 / 256 |
| `mcp` | object | kind=mcp 必需 | `{ transport, command, args, env, url, auth, tools: { allow, deny } }` |
| `locales` | object | 否 | `displayName`/`description` 的多语言 |
| `homepage` / `repository` / `license` | string | 否 | |

## 2. 校验规则

- `kind=skill` 的清单可省略（目录含 `SKILL.md` 即可）；存在时只允许 `id/kind/api/version/displayName`。插件宿主只运行 `source`、`connector`、`tool`；其他 kind 判为 `invalid`（附说明）。M3 的 MCP 服务器在 `config.yaml` 的 `mcp.servers` 里声明，`kind: mcp` 清单留到 M5；Skills 直接放进 `/data/skills/<name>/` 或插件的 `skills/`，不需要清单。
- `tools` 中每个名称必须匹配 `^[a-z0-9]{2,4}_[a-z0-9_]+$` 且前缀在插件内一致；与已加载插件、内核工具冲突 → `invalid` 并给出冲突方。
- `level` 为 0 → `invalid`。
- `runtime.inproc: true` → `invalid`（进程内插件由守护进程在代码中注册）。
- `configSchema` 必须位于插件目录内且能编译；配置在启动前与每次变更时按它校验。
- `api` 不等于当前或上一版本 → `invalid`（上一版本通过 shim 加载并警告）。
- 未知字段 → 警告并忽略。

## 3. 配置 Schema 扩展关键字

| 关键字 | 含义 |
|---|---|
| `x-hot: false` | 变更需要重建插件（自动触发 reload） |
| `x-secret: true` | 值来自秘密库（表单显示为"选择秘密"） |
| `x-ui: { widget, group, order }` | 控制台表单提示 |

## 4. 一致性检查探针（可选）

插件目录里的 `protea.conformance.json` 供 `protea dev-plugin <dir> --check` 使用：

```json
{
  "config": {},
  "calls": [{ "tool": "nts_add", "input": { "text": "buy milk" }, "expect": "added note 1" }],
  "cancel": { "tool": "nts_wait", "input": { "seconds": 20 } },
  "events": 1
}
```

声明了 `chat` 或 `login` 的插件总要检查清单与能力位是否同时存在；探针里写 `"chat": { "text": "…" }` 时还会真的调用一次 `chat/send`（会发出消息，所以是可选的）。`calls` 依次调用并检查输出包含 `expect`；`cancel` 的调用在 200 ms 后被取消，应以部分结果返回；`events` 是这些调用至少应推送的事件数。

## 5. 示例

见 [../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md) §3。
