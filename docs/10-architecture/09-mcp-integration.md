# MCP 集成

> 状态：Draft · 更新：2026-11-03

## 1. 定位

Model Context Protocol（MCP）是 Protea 接入"现成能力"的主要通道：文件系统、抓取、数据库、GitHub、日历……社区已有大量服务器。Protea 作为 **MCP 客户端**（Host）管理多个服务器；每个服务器在插件系统中是一个 `kind: mcp` 的插件，享有相同的热插拔与生命周期语义。

Protea 也可以 **作为 MCP 服务器**对外暴露自身（事件推送、记忆查询），让其他代理把 Protea 当作一个"世界"接入（v1 后期）。

## 2. 声明一个 MCP 服务器

两种方式，等价：

**配置内声明**（最常见，控制台表单生成）：

```yaml
mcp:
  servers:
    fetch:
      transport: stdio
      command: uvx
      args: ["mcp-server-fetch"]
      env: { }                      # 可引用秘密：${secret:SOME_KEY}
      enabled: true
      level: 2                      # 该服务器工具默认的"副作用等级"（见 §6）
      tools:                        # 可选：白名单 / 黑名单
        allow: ["fetch"]
    github:
      transport: streamable-http
      url: https://api.githubcopilot.com/mcp/
      auth: { type: oauth }         # 或 { type: bearer, token: "${secret:GITHUB_MCP_TOKEN}" }
      enabled: true
```

**插件目录声明**（打包分发）：`/data/plugins/<id>/protea.plugin.json` 中 `kind: "mcp"` 并带 `mcp: { transport, command, args, ... }` 字段，可附带 `ENV_PROMPT.md` 为该服务器的工具提供"何时使用"的环境提示（MCP 协议本身没有这个概念，这是 Protea 的补充）。

## 3. 传输

| 传输 | 用途 | 进程管理 |
|---|---|---|
| `stdio` | 本地服务器（`npx` / `uvx` / 任意可执行文件） | PluginHost 以子进程启动，监督、心跳、重启退避；工作目录 `/data/plugin-data/mcp/<id>`；`npx`/`uvx` 缓存在 `/data/cache` |
| `streamable-http` | 远程服务器 | 无进程；连接池、重连、OAuth（授权码流程由控制台引导主人完成，令牌存秘密库） |
| `sse`（旧） | 兼容 | 同上，标记为 deprecated |

镜像内预装 Node 22 与 Python 3.12 + uv，使 `npx` / `uvx` 型服务器开箱可用（[ADR-0007](../20-decisions/ADR-0007-single-image-with-node-and-python.md)）。

## 4. 能力映射

| MCP 原语 | Protea 中的形态 |
|---|---|
| **Tools** | 工具表条目，名称 `mcp__<server>__<tool>`（与 Claude Code 约定一致）；描述与 schema 原样；`annotations.readOnlyHint` → 可并行；`destructiveHint` → 默认策略 `ask` |
| **Resources** | 内核工具 `mcp_resource_list {server}` / `mcp_resource_read {server, uri}`；资源订阅更新 → L4 `internal`？否：资源更新来自外部，作为 `external` L4 事件 `mcp.<server>.resource_updated` |
| **Prompts** | 作为**只读 Skill** 注入 Skills 目录（`mcp:<server>/<prompt>`），`skill_load` 时调用 `prompts/get` |
| **Sampling**（服务器请求模型） | v1 拒绝（返回错误），记录警告；未来可在策略允许下用 `cheap` 模型满足 |
| **Elicitation**（服务器向用户提问） | 转为审批/提问事件发给主人（L1 `internal` `mcp.elicitation`），答复后回传 |
| **Roots** | 向服务器声明 `/data/workspace` 为根 |
| **Logging** | 服务器日志进入结构化日志，带 `mcp=<server>` 字段 |

## 5. 工具表与缓存

- 服务器连接/断开、`notifications/tools/list_changed` 都只在**回合边界**应用到工具表（[06-context-assembly.md](06-context-assembly.md) §4）。
- MCP 工具数量通常很大。超过阈值时，MCP 工具优先被标记 `defer_loading: true`，由 Provider 的工具搜索按需加载；每个服务器的"前 k 个常用工具"（按历史调用频次）保持非延迟。
- 工具描述过长（> 2 KB）的服务器在控制台给出提示；Core 不改写描述（P1），但允许操作员为单个工具配置 `descriptionOverride`。

## 6. 权限与等级

- 每个服务器有默认策略：`readOnlyHint` 工具 `allow`；其余按服务器配置 `level`：L1/L2 服务器的副作用工具 `ask`，L3+ `allow`（这里 "level" 表示信任等级，不是事件等级；命名待定，见待决问题）。
- 单个工具可在 `permissions.tools` 中覆盖。
- 远程服务器的 OAuth 令牌、API Key 全部走秘密库；请求头中的值在日志里脱敏。

## 7. 健康与故障

- stdio 服务器：`initialize` 握手超时 20 s 视为启动失败；运行中每 30 s `ping`；连续 3 次失败 → 重启（退避）。
- 工具调用超时默认 60 s（可按工具配置），超时回执 `failed: timeout`，服务器不重启。
- 服务器崩溃时正在进行的工具调用返回 `failed: server exited`；模型可重试。
- 控制台显示每个服务器的状态、工具数、最近错误、平均延迟。

## 8. 可选：Anthropic 服务端 MCP 连接器

对 `streamable-http` 服务器，可配置 `mode: remote-passthrough`：Core 不自己连接，而是在请求中声明 `mcp_servers` + `mcp_toolset`（beta `mcp-client-2025-11-20`），由 Anthropic 侧调用。优点：减少本地连接管理；缺点：无法套用 Protea 的权限策略与审计（工具在服务端执行）。因此默认关闭，只对只读服务器建议开启。

## 9. Protea 作为 MCP 服务器（M7）

暴露：

- `protea_push_event`（工具）：外部代理向 Protea 推送事件（等级上限 L2，需 token）。
- `protea_memory_search`（工具，只读）。
- `protea://events/{cursor}`、`protea://memory/{path}`（资源）。

传输：Streamable HTTP，挂在控制平面 `/mcp`，鉴权与控制 API 相同。

## 10. 测试

- 使用官方 MCP TypeScript SDK 的测试服务器 + 自建"坏服务器"（握手超时、工具抛错、list_changed 风暴）验证健康与隔离。
- 工具命名空间冲突、defer_loading 阈值、回合边界应用的测试属于上下文装配套件。
