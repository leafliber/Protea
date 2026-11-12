# Skills

> 状态：Accepted（M3）· 更新：2026-11-03 · 规范：[../30-specs/07-skill-format.md](../30-specs/07-skill-format.md)

> **实现状态（M3）**：注册表、目录段、`skill_load` / `skill_read`、热加载、本地安装与 3 个内置 Skill 已实现（`packages/core/src/skills/`，内置 Skill 在仓库的 `skills/`）。`shell` 工具（执行 Skill 脚本）、Git 安装、例程以 Skill 为 Fork 目标、描述诊断尚未实现。

## 1. 定位

Skill 是"按需加载的做事方法"：一个目录，核心是 `SKILL.md`，可附脚本、参考资料、模板。Protea 兼容 **Agent Skills** 开放格式（Claude Code / Claude.ai 使用的同一格式），使现有 Skills 可直接复用。

Skills 与 MCP 的分工：MCP 提供**能力**（能做什么），Skills 提供**方法**（怎么做好）。一个 Skill 常常是"用这几个 MCP 工具按这个流程做某事"的说明。

注意区分：Anthropic API 的 "Skills"（随代码执行容器使用的 `container.skills`）是服务端功能，与本文无关；Protea 的 Skills 在本地渐进加载。

## 2. 格式（摘要）

```
/data/skills/weekly-report/
├── SKILL.md            ← 必需：YAML frontmatter + Markdown 正文
├── scripts/            ← 可选：可执行脚本（由 shell 工具运行）
├── references/         ← 可选：按需读取的资料
└── assets/             ← 可选：模板、图片
```

```markdown
---
name: weekly-report
description: 每周一生成上周工作周报：汇总 GitHub 活动、日历与记忆中的笔记，输出 Markdown 并发给主人。当主人要求"周报"或例程 weekly-report 触发时使用。
allowed-tools: mcp__github__*, memory_read, chat_send
metadata:
  level: 3
  version: 1.2
---

# 周报流程
1. ...
```

- `name`：目录名一致，`[a-z0-9-]+`。
- `description`：**触发条件 + 做什么**，≤ 1024 字符；它是模型在目录中看到的唯一信息，质量决定 Skill 是否被正确触发。
- `allowed-tools`（可选）：加载该 Skill 后建议的工具子集；Core 不强制（回执里列为"Suggested tools"），以后在 Fork 中可用作 `tools` 过滤。
- `metadata.level`（Protea 扩展，可选）：该 Skill 运行时的建议等级（用于派生 Fork）。
- `metadata.requires-tools`（Protea 扩展，可选）：所需工具（名称或 glob）都存在时才进入目录，例如内置的 `memory-dream` 需要 `memory`、`memory_search` 与 `board`。

## 3. 渐进式披露

| 层级 | 内容 | 何时进入上下文 | 大小 |
|---|---|---|---|
| L1 目录 | 所有 Skill 的 `name` + `description` | 始终（系统前缀 `skills-catalog` 段） | ~100 token / Skill |
| L2 正文 | `SKILL.md` 全文 + 目录内文件清单 | 模型调用 `skill_load {name}` | < 5000 token 建议 |
| L3 资源 | `references/*`、`scripts/*` | 模型用 `skill_read {name, path}` 按需读取（限制在 Skill 目录内，最多 256 KB）；执行脚本需要 `shell` 工具（未实现） | 不限 |

`skill_load` 的回执是工具结果，进入历史（只追加）；同一会话重复加载同一 Skill 且内容未变时，回执只返回"已在本会话加载（工具调用 id）"以节省 token；内容变了则重新给出正文并注明"已更新"。主会话的加载记录存在 kv 表里，重启后仍有效；换转录（M4 交接）时清空。

## 4. 注册表与热加载

- 扫描目录：`<assets>/skills/*`（内置，镜像里是 `/app/skills`）→ `/data/skills/*`（用户）→ 已启用插件目录下的 `skills/*`（清单字段 `skills` 可改目录）→ MCP prompts（只读、虚拟）。同名后者覆盖前者，并在列表里给出警告。
- 文件监视：`/data/skills` 有变化（300 ms 去抖）、插件或 MCP 服务器状态变化时重新扫描；目录文本变了才重建系统前缀，在**下一回合边界**生效（缓存失效一次），没变则前缀不动。
- 校验失败（无 frontmatter、YAML 错误、name 缺失/不合法/与目录名不一致、description 为空、目录里没有 SKILL.md）→ 不注册，`protea skills` 与 `/api/skills` 显示原因。
- 目录分段按 `name` 排序，保证字节稳定；它是系统前缀的最后一段（在各 `env:*` 段之后）。
- 启用/禁用只改 `skills.disabled`（写回 `config.yaml`），不删文件。

## 5. 执行脚本（未实现）

Skill 的脚本通过内核 `shell` 工具在容器内执行（受限用户、工作目录 `/data/workspace`、超时、输出截断）。镜像提供 Node、Python、常用 CLI（`rg`、`jq`、`curl`、`git`）；Skill 需要额外依赖时在 `SKILL.md` 中说明安装命令，由模型在首次使用时执行（受 `shell` 的策略约束）。

## 6. 与人格的关系

人格的 `OPERATING.md` 可以引用 Skills（"周一早上运行 weekly-report"），例程事件源可以把 Skill 名作为 Fork 目标（`routine: { skill: 'weekly-report', cron: '0 9 * * 1' }`），Fork 启动时自动 `skill_load`。

## 7. 控制台

- 列表：名称、描述、来源（内置/用户/插件/MCP）、状态（listed / hidden / disabled / invalid）、加载次数与最近加载时间（M3：`protea skills`、`GET /api/skills`）。
- 操作：启用/禁用、查看正文与文件、从本地目录安装、删除用户 Skill（M3：CLI 与 API）；从 Git URL 安装（M5）。
- 诊断：description 过长/过短、与其他 Skill 描述高度相似（触发歧义）的提示（M5）。

## 8. 内置 Skills（M3）

| Skill | 用途 |
|---|---|
| `protea-self-ops` | 让助理知道如何用 `self_status`、`events_query`、`schedule_*`、`fork_*` 与审批管理自己 |
| `daily-brief` | 晨报流程模板（与 cron 的 morning-brief 例程配合） |
| `memory-dream` | 整理记忆目录：把长期约定和主人画像并入 `core/`、把日志和压缩笔记折叠进笔记、补齐 summary 与关键词、合并去重、清理白板；每天由 Core 派生的 Fork 运行（[11-memory-and-persona.md](11-memory-and-persona.md) §8）；`requires-tools: memory memory_search board` |
