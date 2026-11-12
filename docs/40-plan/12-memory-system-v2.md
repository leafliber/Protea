# 记忆系统第二次重构：实测问题与方案

> 状态：Accepted（已实现，真实模型下的质量待 T11 实测）· 更新：2026-11-12 · 决策：[ADR-0024](../20-decisions/ADR-0024-resident-memory-and-chunked-search.md) · 设计：[11-memory-and-persona.md](../10-architecture/11-memory-and-persona.md) · 前一次：[07-memory-system-redesign.md](07-memory-system-redesign.md)

不考虑向前兼容：目录、工具命令、配置项直接改名，不留别名。

## 1. 依据

- 代码：`packages/core/src/memory/`、`session/handoff.ts`、`maintenance/`、`context/segments.ts`、`skills/memory-dream/`。
- 本地容器 `protea-protea-1` 的三天运行（2026-11-10 至 11-12）：4 段主会话转录共 47 批、3 次压缩、3 次梦境、`/data/memory` 的全部文件、守护进程日志。模型是 `glm-5.3-flash`（main、fork、cheap 同一个）。
- 参照：Claude Code、Codex CLI、OpenClaw 的记忆机制（§3）。

## 2. 实测发现

| # | 现象 | 证据 | 根因 |
|---|---|---|---|
| 1 | 常驻层里没有主人画像 | 前缀的 `owner` 段仍是占位文本 "Nothing is recorded about the owner yet"。助理写不了 `/data/persona/USER.md`，自己建了 `/memories/persona/USER.md`（1166 字节），它从不进前缀 | 画像只能由主人手写，助理没有可写的常驻位置 |
| 2 | `INDEX.md` 过期 | 5 篇笔记只列了 2 篇，缺 `notes/channels.md` 和 `notes/projects/dida365.md`；文件自 11-10 起没变过 | 索引靠梦境手写。11-11 的梦境 `create` 报 "already exists"，回合用完也没改成 |
| 3 | 梦境不可靠，Core 不验收 | 11-11：20 回合用完，自述 "not finished"。11-12：6 回合、14 次 `view`、0 次写入、没有结尾文本，仍记为 `completed` 并推进水位。当天定下的 Notion 日记、每日天气两项约定都没进笔记 | 每次从头读整个目录，回合花在定向上；成功只看 Fork 状态 |
| 4 | 闲时压缩连续失败 | 11-12 03:38–05:13（UTC）9 次放弃。每次约 32k 输入、8000 输出、耗时约 160 秒，`stop: max_tokens` 且没有正文 | 思考占满了 `notesMaxTokens`（8000）；固定 10 分钟重试，没有退避，也不换模型 |
| 5 | 检索基本没被用 | 47 批里只发起过 1 次 `memory_search`，0 命中：查询 `plugin 插件 config.yaml 类型` 要求四个词同时出现 | 每个词都必须命中；模型主要靠前缀和压缩笔记，而索引又是过期的 |
| 6 | 写入命令不顺手 | 约 60 次写入里 5 次失败：当天 journal 不存在时 `view`/`insert` 报错、`insert_line` 越界、路径少了开头的 `/`。追加日志是最频繁的写入（20 次 `insert`） | 沿用 `memory_20250818` 的命令面，没有追加和覆盖 |
| 7 | 长期约定没有固定位置 | "每晚 23:00 一起写日记并记到 Notion，标题格式…"、"图片一律走 QQ"、"凭据不进聊天" 只在压缩笔记的 Commitments 节和 journal 里 | 压缩笔记每次由 cheap 模型转述一遍，转述几次就可能丢；进笔记要等梦境，而梦境没做 |
| 8 | 笔记里有不该记的内容 | `notes/environment.md` 7.4 KB，大半是 `self_status` 能查到的运行状态和更正历史；journal 有重复条目 | 没有"什么不该记"的规则，也没有机械检查 |
| 9 | 检索按文件返回 | `raw/` 单个文件 77–132 KB，命中只给一个 120 字符的片段；FTS 表里正文存了两份（`body` 和 `body_text`） | 索引以文件为单位 |
| 10 | 日期和梦境时间按 UTC | `daemon.timezone` 没有设置。梦境的 03:30 实际是北京时间 11:30；journal 按 UTC 分日，主人的"今天"跨两个文件 | 时区未设置时不提示 |

运行良好、保留不动的部分：白板（13 次写入无失败）、闲时压缩的时机策略、索引延迟发布、`raw/` 存档、FTS5 加 CJK 二元组、助理在对话中随手写 journal（内容质量高，带 ID 和时间）。

## 3. 与主流 harness 的对照

2026-11-12 查证，来源见 §8。

| 方面 | Claude Code | Codex CLI | OpenClaw | Protea 现状 | 本方案 |
|---|---|---|---|---|---|
| 常驻内容 | `CLAUDE.md`，加自动记忆的 `MEMORY.md` 索引（前 200 行或 25 KB） | `AGENTS.md`（32 KiB），加 `memory_summary.md`（截到 2500 token） | `SOUL.md`、`USER.md`（4000 字符）、`MEMORY.md`；单文件 20000、合计 60000 字符 | `USER.md`（主人手写）加 `INDEX.md`（梦境手写） | 助理可写、有硬上限的 `core/`，加 Core 生成的索引 |
| 谁来写 | 主 agent 在对话中写；索引超限时 harness 在工具回执里要求重写 | 全部在后台：先逐个会话提取，再合并；主 agent 只能在主人明说"记住"时留一条便条 | 主 agent 写当天笔记；压缩前有一个静默的冲刷回合；`MEMORY.md` 只由 dreaming 写 | 主 agent 写 journal；梦境折叠成笔记 | 不变，另外让长期约定可以当场写进 `core/` |
| 条目格式 | 每条一个文件，frontmatter 带类型 | 整理后的 Markdown 手册加逐会话摘要 | 自由 Markdown 加按天的笔记 | 自由 Markdown，frontmatter 可选 | `summary` 必填，Core 检查 |
| 检索 | 不用 embedding，读索引后按需读文件 | 不用 embedding，列出、读取、搜索文件 | FTS5 BM25 加向量，400 token 分块；没有 embedding 时退回纯关键词 | FTS5，按文件，全部词必须命中 | FTS5，分块，按命中词数排序 |
| 整理与遗忘 | 官方文档没有记载后台整理，也没有衰减 | 合并阶段按引用次数排序，30 天没被用到的不再入选 | dreaming 按召回次数、不同查询数等门槛提升；重写丢失超过 25% 的旧条目就退回为只追加，并保存改写前的版本 | 每日梦境，不验收 | 增量输入、Core 验收、记录召回情况、保存 `core/` 的历史版本 |
| 来源管控 | 无 | 用过 MCP 或联网的会话可排除在外 | 每条记忆记录来源；群里非主人的内容和联网结果不会被提升，也不会自动注入 | 无 | 批内有第三方事件时，写 `core/` 需要审批 |

五家（另含 Hermes、Letta）的共同点：常驻部分有硬上限，只放最要紧的内容；其余按需读取；整理在后台进行；记忆是数据，不是指令。Protea 缺的是"助理可写的常驻部分"、"不会过期的索引"和后台整理的可靠性。Hermes 的两点与 Protea 的缓存约束正好一致：常驻记忆在会话开始时冻结成快照；写入超限直接报错，让模型当场精简。

## 4. 方案

### 4.1 目录

```
/data/persona/            SOUL.md、OPERATING.md、plugins/、hooks.ts（USER.md 移走）
/data/memory/
├── core/
│   ├── owner.md          主人画像，全文常驻，上限 2000 字符
│   ├── rules.md          长期约定、纠正和教训，全文常驻，上限 4000 字符
│   └── .history/         两个文件改动前的版本，各 20 份
├── notes/**/*.md         主题笔记，按需读取；frontmatter 的 summary 必填
├── journal/YYYY-MM-DD.md 按天追加（守护进程时区）
├── handoff/、raw/        只读记录
└── blobs/
```

删除 `INDEX.md` 和 `persona/USER.md`。四层变成：白板 → 常驻（`core/` 加生成的索引）→ 笔记 → 原文。

### 4.2 常驻记忆 `core/`

- 两个文件全文进系统前缀，取代 `owner` 段和 `memory-index` 段里手写的部分。助理和主人都能改。
- Core 只做机械检查：写入后超过上限就拒绝，回执给出当前字符数和上限，由模型自己精简。
- 沿用现有的延迟发布：对话中的修改在压缩、梦境结束、主人从控制台修改、进程启动时进入前缀。修改当时已经在转录里，模型看得到，缓存不受影响。
- `rules.md` 收纳发现 7 里的内容：主人定下的长期做法、纠正过的错误、踩过的坑。有期限的承诺仍然上白板。
- Fork 的前缀带 `core/owner.md`，不带 `rules.md` 和索引（与现在带 `USER.md` 一致）。
- **来源管控**：`core/` 进入系统前缀，所以一条被诱导写入的"约定"会长期生效。写 `core/` 时按 `events.sender_role` 检查当前批：批里有第三方事件（群里的其他人、外部来源）时走审批，只有主人和内部事件时直接写。落地为工具规格的 `askWhen`，由权限守卫当作主人写的 `ask` 处理（任何模式下都只交给主人）；梦境 Fork 直接写，其他 Fork 写 `core/` 都要批准。
- **历史版本**：`core/` 的每次改动把改写前的内容存到 `core/.history/`，保留最近 20 份，控制台可以对比和恢复。梦境精简 `core/` 出错时也靠它恢复。

### 4.3 索引由 Core 生成

- 前缀里的索引段由 Core 从 `notes/` 的 frontmatter 生成，每个文件一行 `- <path> — <summary>`，按目录分组。超过 6000 字符时改为每个目录一行（文件数加前几个文件名）。
- 这是结构化包装，不产生语义内容，符合 P1；`summary` 仍由模型或主人写。
- 生成的索引同样延迟发布。梦境不再负责重写索引。

### 4.4 工具

`memory` 改成各家模型都熟悉的文件操作，去掉 `memory_20250818` 的命令面和 `memory.nativeTool` 配置：

| 命令 | 作用 |
|---|---|
| `read {path, range?}` | 列目录，或带行号显示文件 |
| `write {path, text}` | 创建或整体覆盖 |
| `append {path, text}` | 追加到末尾，文件不存在时创建 |
| `edit {path, old, new}` | 替换唯一的一处 |
| `move {from, to}`、`delete {path}` | 不变 |

- 路径接受 `/memories/x`、`memories/x`、`x` 三种写法。
- 写 `notes/` 下的文件时没有 `summary` 就拒绝并说明格式。
- 删除 `memory_recent`（`read /memories/journal` 就是它）。`memory_search` 和 `board` 保留。

### 4.5 检索

仍然不用 embedding（ADR-0011 的决定不变）。

- **分块索引**：在标题和存档的消息头处切块，块长到约 1200 字符后在空行或列表项处切开（journal 因此按条目切块）。另存一列单字，单字查询可命中长词中间的字。命中返回 `path:起始行-结束行`、摘要和片段，同一文件最多 3 块。表里不再存整篇正文，片段按行号从文件读。
- **查询语义**：默认按命中词数和 BM25 排序，不要求全部命中；引号里的短语和 `+词` 必须出现。回执写明每条命中了哪些词。
- **召回日志**：新表 `memory_access`，记录每次检索的查询、命中的文件，以及每次 `read` 和写入。它有两个用途：梦境据此知道哪些笔记长期没被读、哪些查询没有命中（该补 `keywords`）；控制台显示记忆的使用情况。
- 检索接口留一个替换点，以后要加向量检索时不动工具层。控制 API 的检索接受 `scope`。

### 4.6 压缩

- **输出预算**：`notesMaxTokens` 提到 16000，笔记请求固定用最低的 effort。发现 4 的直接原因就是思考占满了上限。
- **失败处理**：重试间隔按 10、20、40 分钟退避；同一段内容连续失败 3 次后依次换成 `fork`、`main` 角色；都失败时发一条 L3 事件，等对话有新内容再试。
- **提示词**：输入里加上 `core/` 的内容。已经在 `core/` 里的约定不再复述；新出现的长期约定写进单独的 `Durable, not yet saved` 一节，梦境优先处理这一节。Commitments 只留有期限的承诺。

### 4.7 梦境

- **增量输入**：Core 把上次成功以来变化过的文件清单、`core/` 的用量、检查结果（缺 `summary`、单个笔记超过 8 KB）、召回统计放进 Fork 的初始上下文，省掉定向回合。
- **验收**（机械）：有结尾文本（`ForkInfo` 新增 `unfinished` 标记没有最终消息或用完回合的结束），至少有一次写入（按使用记录数），`core/` 不超限。不满足记为失败，原因写进 `DreamStatus.rejected`，不推进水位，按现有规则计入连续失败。
- **回合与模型**：新增 `memory.dream.maxTurns`，默认 40，不受 `scheduler.forks.maxTurns` 限制（`ForkRequest.uncapped`，只有 Core 自己用）。`memory.dream.model` 默认改为 `main`，每天一次，质量比成本要紧。
- **Skill 调整**：去掉重写 `INDEX.md` 的步骤；新增把长期约定并入 `core/rules.md`、把画像并入 `core/owner.md`、超限时精简；新增"不该记什么"：能用工具查到的运行状态、已经被更正的旧说法。

### 4.8 时区

`daemon.timezone` 没有设置时，启动日志告警，控制台首页提示设置。不新增配置项。本地容器现在就应设成 `Asia/Shanghai`。

### 4.9 控制台

记忆页增加"概况"（默认页）：`core/` 两个文件的用量、编辑入口和历史版本恢复、生成的索引预览、检查结果、召回统计、最近一次梦境的验收结果；原来的"记忆"改名"文件"。首页在时区未设置、每日整理停用时提示。

## 5. 不做的事

| 候选 | 理由 |
|---|---|
| 向量检索 | 主人明确不要（ADR-0011）。5 篇笔记的规模下瓶颈在查询语义和索引过期，不在召回方式 |
| 每批开始自动召回笔记 | ADR-0011 已否决。先上召回日志，有"该查没查"的数据后再议。到时优先考虑 OpenClaw 的触发词做法：条目自带触发词，来消息时做字面匹配，不调用模型，每批最多带 3 条 |
| 把 journal 改为后台从转录提取（Codex 的做法） | 现在助理当场写的 journal 质量高；事后由便宜模型提取会丢 ID 和细节 |
| 压缩前让主会话先做一轮记忆冲刷（OpenClaw 的做法） | 压缩笔记的 `Durable` 一节加 `core/` 已覆盖这个用途，不必多一个回合 |
| 按对话或群分区的记忆 | 单一主会话的前提不变 |
| 删除 `raw/`，改为直接索引转录 | 主人 11-10 决定保留可读存档；分块索引已解决检索粒度 |

## 6. 实施

一次完成，按依赖排序：

1. 迁移：新建 `memory_chunks`（FTS）和 `memory_access`，删除旧的 `memory_fts`；启动时重建索引。
2. `MemoryStore` 新命令面、路径归一、`core/` 上限与历史版本、`summary` 检查；`core/` 写入接入权限检查。
3. `MemoryIndex` 分块、新查询语义、召回日志。
4. `SystemSegments`：`core` 段和生成的索引段；发布逻辑从 `INDEX.md` 改为 `core/` 加索引。
5. `handoff.ts`：预算、退避、换角色、提示词。
6. `DreamRunner`：增量输入、验收、`maxTurns`；改写 `memory-dream` Skill。
7. 默认人格：`OPERATING.md` 的 Memory 一节；删除 `USER.md` 和整个 `personas/default/memory/` 模板（记忆目录首次启动时为空，`core/` 由第一次写入创建）。
8. 控制 API 和记忆页。
9. 文档：改写 `11-memory-and-persona.md`、`06-context-assembly.md` 的分段表，新增 ADR（取代 ADR-0011 里索引与工具两条）。

本地容器的数据手工迁移一次：`/data/memory/persona/USER.md` 的内容并入 `core/owner.md`，Commitments 里的长期约定写入 `core/rules.md`，删除 `INDEX.md`。

测试：`memory.test.ts`、`memory-layers.test.ts` 按新命令面重写；新增分块检索、上限拒绝、索引生成、压缩退避、梦境验收的用例；`memory-layers.e2e.test.ts` 覆盖"写 `core/` → 压缩 → 新前缀里出现"。真实模型下的质量仍归 T3、T11。

## 7. 主人的决定（2026-11-12）

按推荐选项实施：

1. `USER.md` 从人格移到 `memory/core/owner.md`，由助理维护、主人可改（不保留两处画像）。
2. 梦境默认模型从 `fork` 改为 `main`。
3. `memory` 工具不再与 `memory_20250818` 保持一致；`memory.nativeTool` 与工具规格的 `providerType` 一并删除。

## 8. 查证来源

- OpenClaw：[memory](https://docs.openclaw.ai/concepts/memory)、[memory-search](https://docs.openclaw.ai/concepts/memory-search)、[dreaming](https://docs.openclaw.ai/concepts/dreaming)、[memory-provenance](https://docs.openclaw.ai/concepts/memory-provenance)、[compaction](https://docs.openclaw.ai/concepts/compaction)
- Claude Code：[memory](https://code.claude.com/docs/en/memory)、[sub-agents](https://code.claude.com/docs/en/sub-agents)；Claude API：[memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Codex：[memories](https://learn.chatgpt.com/docs/customization/memories)、[codex-rs/memories/README.md](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)
- Hermes：[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)；Letta：[memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- 未能从官方来源确认：Claude Code 的后台提取与 auto-dream（只见于第三方文章，[07](07-memory-system-redesign.md) 引用的那篇即是）。
