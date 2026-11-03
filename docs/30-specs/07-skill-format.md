# 规范：Skill 格式

> 状态：Draft · 更新：2026-11-03 · 设计：[../10-architecture/10-skills.md](../10-architecture/10-skills.md)

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
| `metadata` | 否 | 任意键值；Protea 识别 `level`（1–4）、`version`、`author`、`tags` |

正文：Markdown，建议 ≤ 5000 token；超出时 `skill_load` 回执会附带警告，不截断。

## 3. 目录条目渲染

`skills-catalog` 段中每个 Skill 一行：

```
- weekly-report: 每周一生成上周工作周报……（来源: user）
```

按 `name` 排序；禁用的 Skill 不出现。

## 4. `skill_load` 回执

```
# Skill: weekly-report (user, v1.2)
<SKILL.md 正文>

## Files
scripts/collect.py (3.1 KB)
references/format.md (1.0 KB)
```

同一会话重复加载同一 Skill：`Skill weekly-report already loaded at #<cursor>; re-read with memory_view if needed.`

## 5. 校验错误

| 错误 | 处理 |
|---|---|
| 缺少 frontmatter / name / description | 不注册；控制台显示 |
| name 与目录不一致 | 不注册 |
| description 超长 | 截断到 1024 并警告 |
| 与另一来源同名 | 后扫描的覆盖，记录警告 |
