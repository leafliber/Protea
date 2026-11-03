# 规范：插件清单（protea.plugin.json）

> 状态：Draft · 更新：2026-11-03 · 设计：[../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md)

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
| `runtime.inproc` | boolean | 否 | 仅内置插件允许 `true` |
| `level` | 1–4 | source/connector 必需 | 可声明的最高等级 |
| `triggers` | string[] | 否 | 允许申请的投递模式；默认按等级表 |
| `tools` | string[] | 否 | 声明的工具名；运行时 `tools/list` 返回的名称若不在此列表 → 警告但生效 |
| `sideEffectTools` | string[] | 否 | 默认策略 `ask` 的工具 |
| `secrets` | string[] | 否 | 需要注入的秘密名 |
| `configSchema` | path | 否 | JSON Schema；支持 `x-hot: false`、`x-secret: true` 扩展关键字 |
| `envPrompt` | path | 否 | 默认 `ENV_PROMPT.md` |
| `skills` | path | 否 | 插件自带 Skills 目录，默认 `skills/` |
| `healthcheck.intervalMs` / `timeoutMs` | integer | 否 | 默认 30000 / 5000 |
| `resources.maxMemoryMb` / `maxCpu` / `maxFds` | number | 否 | 默认 256 / 1.0 / 256 |
| `mcp` | object | kind=mcp 必需 | `{ transport, command, args, env, url, auth, tools: { allow, deny } }` |
| `locales` | object | 否 | `displayName`/`description` 的多语言 |
| `homepage` / `repository` / `license` | string | 否 | |

## 2. 校验规则

- `kind=skill` 的清单可省略（目录含 `SKILL.md` 即可）；存在时只允许 `id/kind/api/version/displayName`。
- `tools` 中每个名称必须匹配 `^[a-z0-9]{2,4}_[a-z0-9_]+$` 且前缀在插件内一致；与已加载插件、内核工具冲突 → `invalid` 并给出冲突方。
- `level` 为 0 → `invalid`。
- `runtime.inproc: true` 且插件不在 `/app/plugins` → `invalid`。
- `api` 不等于当前或上一版本 → `invalid`（上一版本通过 shim 加载并警告）。
- 未知字段 → 警告并忽略。

## 3. 配置 Schema 扩展关键字

| 关键字 | 含义 |
|---|---|
| `x-hot: false` | 变更需要重建插件（自动触发 reload） |
| `x-secret: true` | 值来自秘密库（表单显示为"选择秘密"） |
| `x-ui: { widget, group, order }` | 控制台表单提示 |

## 4. 示例

见 [../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md) §3。
