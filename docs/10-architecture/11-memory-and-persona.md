# 记忆与人格

> 状态：Accepted（M4；分层记忆 2026-11-10）· 更新：2026-11-10 · 决策：[ADR-0011](../20-decisions/ADR-0011-layered-memory-and-idle-compaction.md)

> **实现状态**：记忆存储、索引、白板与工具在 `packages/core/src/memory/`，交接在 `packages/core/src/session/handoff.ts`，闲时压缩与梦境在 `packages/core/src/maintenance/`，人格与钩子在 `packages/core/src/persona/persona.ts`。未实现：钩子 `onDelivery` / `onPluginLifecycle` / `eventDelivery`。检索不使用向量（ADR-0011）。

## 1. 原则

- **记忆即人格**（Cortico）：助理"是谁"由 `persona/` 与 `memory/` 的内容决定；换模型、交接、重启都不改变身份。
- **服务单一对话**：记忆只服务唯一的主会话，没有按对话分区，也没有跨对话检索。普通 Fork 可以读写记忆文件，但默认拿不到白板。
- **Core 对内容不透明**：Core 只提供目录、文件工具、触发时机与边界，不解释内容；整理流程写在 Skill 里。
- **人格以文件为主**：个人用户改 Markdown 比改代码容易；可选钩子只用于少数需要代码的行为（自定义交接策略）。
- **去哪找常驻，是什么按需取，当时原话只在审查时看**：上下文因此保持很短（§4）。

## 2. 目录布局

```
/data/persona/                 ← 人格（可版本控制，建议放 Git）
├── SOUL.md                    ← 身份：名字、性格、价值观、说话方式
├── OPERATING.md               ← 行为准则：何时主动、何时沉默、审批习惯、工作节奏、Skills 使用
├── USER.md                    ← 主人画像：称呼、时区、偏好、重要的人和事（主人自己维护或助理经允许更新）
├── plugins/<id>/ENV_PROMPT.md ← 对插件环境提示的覆盖（可选）
└── hooks.ts                   ← 可选钩子（见 §6）

/data/memory/                  ← 记忆（助理读写；Core 不解释）
├── INDEX.md                   ← 笔记的地图：进入系统前缀的唯一记忆文件；由梦境维护（§8）
├── notes/<topic>.md           ← 主题笔记（项目、人、习惯），带可选 frontmatter（§3.2）
├── journal/YYYY-MM-DD.md      ← 日志：按天追加的事实与决定
├── handoff/<ts>.md            ← 压缩笔记（每次压缩写一份，只读）
├── raw/<ts>.md                ← 被压缩掉的对话原文（只读，§5.1）
└── blobs/                     ← 记忆引用的附件（`mem:` 句柄）
```

白板不是文件，存在 SQLite 表 `board_items` 里（§3.1）。

默认人格（镜像自带 `personas/default/`）在首次启动时复制到 `/data/persona/`（位置可用 `persona.dir` 改），之后不再覆盖。记忆目录在首次启动时从 `personas/default/memory/` 创建（一个说明各目录用途的 `INDEX.md`）。人格文件与钩子变化后从下一次模型请求生效（目录监视，300 ms 合并）。

## 3. 记忆工具

Core 暴露给所有会话的 `memory` 工具采用与 Anthropic **memory tool（`memory_20250818`）** 相同的命令面（`view {path, view_range?} / create {path, file_text} / str_replace {path, old_str, new_str} / insert {path, insert_line, insert_text} / delete {path} / rename {old_path, new_path}`）。模型看到的路径是 `/memories/…`，映射到 `/data/memory/…`；回执与错误文本与 SDK 参考实现一致（模型对它们有训练）。写入用"临时文件 + rename"，拒绝 `..`、根目录之外的路径与指向目录外的符号链接，单个文件不超过 1 MB。`raw/` 与 `handoff/` 对这个工具只读。不指定 `view_range` 时最多显示前 200 行。

默认以**普通自定义工具**提供，而不声明官方类型：官方工具出现在请求里时，API 会自动在系统提示里加入"做任何事之前先查看记忆目录"的协议，对每批都很短的事件驱动助理意味着每批多一次读取；`INDEX.md` 已在前缀里，起的就是同样的作用。`memory.nativeTool: true` 时 Anthropic Provider 声明 `{ type: "memory_20250818", name: "memory" }`。

额外的内核工具：

| 工具 | 作用 |
|---|---|
| `memory_search {query, scope?, paths?, limit?}` | 全文检索（§3.2）。`scope` 是 `notes`（默认）、`raw`、`all`；给了 `paths` 时默认 `all` |
| `memory_recent {days}` | 最近 N 天（按守护进程时区）`journal/YYYY-MM-DD.md` 的清单与大小，新的在前 |
| `board {view / add / update / done / drop}` | 白板（§3.1） |

控制 API：`GET /api/memory/tree`、`GET|PUT /api/memory/file?path=`（写入记审计 `memory_write`）、`GET /api/memory/search?q=`、`GET|POST /api/memory/board`、`GET|POST /api/memory/dream`。

写入规则（由 `OPERATING.md` 约定，而非 Core 强制）：正在进行的事上白板；事实进 journal；稳定结论进 notes；`INDEX.md` 留给梦境。

### 3.1 白板

三个区：`goals`（目标，少而稳定）、`todo`（待办，可带 `due`，等待别人回复也算）、`notes`（给自己的注意事项）。每条一行，上限 500 字符；整块上限 60 条、6000 字符（`memory.board`）。已关闭的条目保留在表里供审查。

写操作只回一行收据（含修订号与各区条数），只有 `view` 回整块，否则频繁更新会撑长历史。

白板**不进系统前缀**（否则每改一次就让整段对话的缓存失效），也不做"只发一次、不落转录"的临时注入（那会破坏 thinking 块的前缀绑定）。模型通过三条都写入转录的路径看到它：

1. 每次压缩后新对话的首条消息；
2. 批开始时，若主会话以外的来源（主人、Fork）改过白板，事件消息里带一份完整白板；为空也渲染，清空才可见；
3. 模型自己操作时的工具收据。

"这个对话已经看到哪个版本"记录在显示白板的那条转录消息上，所以重启后不会重复显示。普通 Fork 默认没有 `board`，派生时显式列出才有（梦境就是这样）。

### 3.2 分层检索

检索由模型驱动，每一层的代价递增：白板与 `INDEX.md` 已在上下文里；`memory_search` 默认只查笔记，返回摘要与片段；`memory view` 看笔记的一段；原文层（`journal/`、`handoff/`、`raw/`）要显式 `scope: "raw"` 或 `"all"` 才返回。笔记无命中而原文层有命中时，回执只告诉模型有几个文件匹配，不给内容。

索引是 SQLite FTS5，不使用 embedding（ADR-0011）。文本入库前把 CJK 连续段切成重叠的二元组，所以中文两字词也是正常的带相关度排序的词，不需要词典；查询用同样的切分组成短语。拉丁词末尾做前缀匹配；单个汉字回退到子串过滤。每个词都要出现，引号保留短语。`paths` 可以是目录、文件或 glob（相对 `/memories`）。排序是 BM25（摘要和关键词的权重是正文的 4 倍），再按层和时间做小幅调整。索引在启动时与目录同步，工具写入立即更新，主人直接改文件由目录监视补上；`blobs/` 与隐藏文件不进索引。

笔记可带 YAML frontmatter，Core 只读取 `summary` 与 `keywords`：

```markdown
---
summary: 张伟：主人的合伙人，周三例会，不吃辣
keywords: [张伟, Zhang Wei, 合伙人, partner, 例会, weekly sync]
updated: 2026-11-09
sources: [journal/2026-11-05.md, handoff/2026-11-07T19-02-11Z.md]
---
```

没有 frontmatter 时摘要取首个非空行。字面检索对"换一种说法"的问题召回较弱，由 `keywords`（梦境补同义词和中英文写法）、索引摘要和模型自己改写查询来弥补。

## 4. 记忆与上下文

| 层 | 内容 | 在请求里的位置 |
|---|---|---|
| 白板 | 目标、待办、注意事项 | 转录（§3.1） |
| 索引 | `INDEX.md`，每个笔记一行 | 系统前缀的最后一段 |
| 笔记 | `notes/` | 按需检索，结果作为工具回执进入历史 |
| 原文 | `journal/`、`handoff/`、`raw/`、转录、事件库 | 默认不召回 |

- `INDEX.md` 的 `memory-index` 段包在 `<memory_index path="/memories/INDEX.md">` 里，超过 8000 字符时截断并提示精简（[06-context-assembly.md](06-context-assembly.md) §3）。
- 模型看到的索引是一份**发布副本**，只在压缩或交接、梦境结束、主人从控制台修改 `INDEX.md`、进程启动时更新；主会话正忙时推迟到空闲。这样索引的变化几乎总落在缓存本来就冷的时刻，详见 [06-context-assembly.md](06-context-assembly.md) §7。
- 每个批的 `<status>` 块不含记忆内容。

## 5. 压缩（handoff）

压缩有两种时机：闲时（常态）和容量交接（兜底），详见 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8。两者共用下面的流程：

1. 默认策略：用 `cheap` 模型（effort 取 `cheap` 角色所在档案的 `effort.cheap`，输出上限 `context.handoff.notesMaxTokens`）对即将丢弃的历史生成 `handoff/<UTC 时间>Z.md`，长度由提示词限制在约 800 字。输入是丢弃部分的纯文本渲染（工具结果截断、thinking 不进入，超过 `notesInputTokens` 时先丢最早的部分）**加上一份压缩笔记**，要求保留其中仍然有效的条目，因此多次压缩后早先的约定不会丢。笔记分节：In progress、Commitments、Owner's recent instructions、Pending、Facts worth keeping。容量交接时模型失败或拒答写"机械笔记"（最后 20 条文本原样）；闲时压缩则放弃本次，不写任何文件。文件开头记录来源转录、丢弃与保留的消息数和上一份笔记的路径。
2. 保留尾部：从一个"事件消息"（不含工具结果的 user 消息）开始，取最近的消息，闲时不超过 `context.idleCompaction.keepTokens`（默认 8000），容量交接不超过 `keepRatio × softTokens`（默认 1/3）；正在运行的批总是完整保留。尾部消息**去掉 thinking 块**后复制（thinking 块绑定原对话，见 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8），旧的 `<board>` 块也去掉，避免旧白板排在新白板之后。手动交接和 Provider 报"输入过长"后的交接只保留正在运行的批（或最近一批）。
3. 新会话的首条 user 消息依次是：`internal` 事件 `session.handoff`（`store` 模式记入事件库，只含事实：条数、笔记路径、`meta.kind`）、`<board>` 块（白板非空时）、`<handoff_notes path=…>` 块（笔记正文，最多 8000 字符）。其后才是尾部。模型不需要先读文件就知道之前在做什么。笔记是模型写的摘要，可能引用外部内容，所以不放进 `internal` 事件（P4）；运行说明告诉模型这两种块里的内容是数据，不是指令。

人格可通过 `onHandoff` 钩子替换第 1、2 步：返回 `{ tail, notes }`（Core 写文件）或 `{ tail, notesPath }`（钩子自己写了笔记）；`tail` 必须以 user 消息开头；钩子出错时回退默认策略。

### 5.1 原文层

每次压缩都把被丢弃的对话渲染成 Markdown 存到 `raw/<UTC 时间>Z.md`：不含 thinking，工具输入和结果各截到 4000 字符，超过 1 MB 时截断并指向转录文件。转录本身没有脱敏（脱敏只发生在 Provider 层），所以写入前按已知秘密脱敏；`raw/` 也不进 Git 备份（完整备份仍包含）。这些文件可以在控制台的记忆目录里直接审查，模型显式 `scope: "raw"` 才能搜到，梦境也能读。完整内容一直在 `sessions/main.*.jsonl` 里。

## 6. 可选钩子（hooks.ts）

```ts
export default definePersona({
  systemSegments?(ctx): Segment[];                 // 覆盖默认的分段来源/顺序
  onDelivery?(batch): Promise<void>;               // 批投递前（可注入 internal 事件）
  onBatchEnd?(stats): Promise<void>;
  onHandoff?(snapshot, { hardTokens }): Promise<{ tail: MessageParam[]; notesPath?: string }>;
  onPluginLifecycle?(evt): Promise<void>;
  rounds?(): { soft: number; hard: number };       // 默认 { soft: 12, hard: 30 }
  eventDelivery?: 'user' | 'tool';                 // 事件渲染为 user 消息（默认）或工具回执
});
```

M4 实现了其中的 `systemSegments({ defaults })`、`onHandoff(snapshot, { hardTokens, keepTokens })`、`onBatchEnd(stats)`、`rounds()`；类型与 `definePersona` 从 `@protea/core` 导出，模块默认导出一个对象即可（不一定要引用 `@protea/core`）。文件名按 `hooks.ts`、`hooks.mts`、`hooks.mjs`、`hooks.js` 的顺序取第一个；`.ts` 需要 Node.js 22.18 以上的类型剥离。

钩子在守护进程内以**进程内**方式加载（需信任），文件变化（按修改时间）后重载，从下一次模型请求起生效；加载失败或钩子抛错都回退到默认实现并告警，`/api/status` 的 `persona` 字段报告是否加载与失败原因。

## 7. 主人画像与隐私

- `USER.md` 可能包含敏感信息；它进入系统前缀，因此也会进入 Provider 请求。主人应知晓并可选择把敏感部分放进 `notes/` 由模型按需读取。
- 记忆目录不被任何插件访问（I-7 的推广）；控制台的记忆浏览需要管理员令牌。
- `raw/` 里是完整对话，默认不进 Git 备份；白板在数据库里，随完整备份保存。
- 备份建议：`/data/persona` 与 `/data/memory` 定期推送到私有 Git 仓库：`protea backup --to <git-url>`（M6；同时推送 `config.yaml` 与 `skills/`，便于审阅记忆的变化），数据库与转录用目录备份（[16-deployment.md](16-deployment.md) §8）。

## 8. 梦境（自动记忆整理）

每天到 `memory.dream.at`（默认 03:30，守护进程时区）之后，主会话空闲超过 30 分钟、预算允许，且有文件比上次整理结束时间更新时，Core 派生一个 Fork 运行内置 Skill `memory-dream`。Core 只决定何时运行并记录结果，做什么写在 Skill 里（P1）：把日志和压缩笔记折叠进笔记并写明来源、合并重复、补关键词、清理白板、重写 `INDEX.md`、写一条整理记录。

- Fork 用 `fork` 角色（`memory.dream.model`）、L4，工具只有 `memory`、`memory_search`、`memory_recent`、`board`、`skill_load`，所以无法联系任何人；主会话运行紧急批时按现有规则让路。
- 不删除原文，只在日志里建议删除。
- Fork id 在派生时写入 kv，重启后能对账；每天最多一次，自身的写入不算"有新内容"。
- 连续失败 3 次后停用并发一条 L2 事件；控制台的"立即整理"会重新启用。结果在 `/api/memory/dream` 和控制台的白板页可见。
