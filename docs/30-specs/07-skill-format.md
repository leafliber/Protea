# 规范：Skill 格式

> 状态：Accepted（M3）· 更新：2026-11-03 · 设计：[../10-architecture/10-skills.md](../10-architecture/10-skills.md)

兼容 Agent Skills 开放格式；本文只列出 Protea 识别的字段与约束。

## 1. 目录

```
<name>/
├── SKILL.md          必需
├── scripts/          可选，可执行
├── references/       可选
└── assets/           可选
```

## 2. SKILL.md frontmatter

| 字段 | 必需 | 约束 |
|---|---|---|
| `name` | 是 | `^[a-z0-9][a-z0-9-]{0,63}$`，与目录名一致 |
| `description` | 是 | 1–1024 字符；应包含触发条件与产出 |
| `license` | 否 | |
| `allowed-tools` | 否 | 以空格或逗号分隔的工具名或 glob |
| `metadata` | 否 | 任意键值；Protea 识别 `level`（1–4，其他值警告并忽略）、`version`、`requires-tools`（空格/逗号分隔或列表；所需工具都存在时才进目录）、`author`、`tags` |

正文：Markdown，建议 ≤ 5000 token（按 ASCII 约 4 字符 1 token、CJK 1 字符 1 token 估算）；超出时扫描给出警告，`skill_load` 回执末尾附带警告，不截断。

## 3. 目录条目渲染

`skills-catalog` 段中每个 Skill 一行：

```
# Skills

Skills are instructions for particular kinds of work. When a task matches a skill's description, call skill_load with its name before you start and follow what it says. Files a skill refers to can be read with skill_read.

- weekly-report: 每周一生成上周工作周报…… (source: user)
- mcp:github/review-pr: Review a pull request. (source: mcp)
```

按 `name` 排序；描述中的换行压成空格；禁用的、`requires-tools` 不满足的 Skill 不出现；一个都没有时不输出该段。

## 4. `skill_load` 回执

```
# Skill: weekly-report (user, v1.2)
<SKILL.md 正文（frontmatter 之后）>

## Files
references/format.md (1.0 KB)
scripts/collect.py (3.1 KB)

Read these with skill_read {"name": "weekly-report", "path": "<file>"}.

Suggested tools: mcp__github__*, tg_send
```

`## Files` 只在有其他文件时出现（按路径排序，跳过点文件，最多 100 个）；`Suggested tools` 只在声明了 `allowed-tools` 时出现。

同一会话重复加载同一 Skill 且内容未变：`Skill weekly-report is already loaded in this session (tool call <id>); follow the instructions there.` 内容变了：标题行末尾加 ` — updated since it was last loaded`，给出新正文。

MCP prompt 型 Skill：`# Skill: mcp:<server>/<prompt> (mcp prompt)` 后接 `prompts/get` 的描述与消息（`[user]` / `[assistant]` 分段）；缺少必填参数时失败回执列出参数。

`skill_read {name, path}`：返回 Skill 目录内的文本文件（最多 256 KB，超出部分注明截断）或子目录的文件清单；目录外的路径（含符号链接指出去的）、二进制文件返回失败回执。

## 5. 校验错误

| 错误 | 处理 |
|---|---|
| 缺少 frontmatter / YAML 无效 / name / description | 不注册；`protea skills` 与 `/api/skills` 显示原因 |
| name 不合法或与目录不一致 | 不注册 |
| 目录里没有 SKILL.md（内置与用户目录） | 不注册（插件的 `skills/` 下忽略） |
| description 超长 | 截断到 1024 并警告 |
| 与另一来源同名 | 后扫描的覆盖，记录警告 |
| `metadata.level` 不在 1–4 | 忽略并警告 |
