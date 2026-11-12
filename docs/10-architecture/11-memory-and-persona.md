# 记忆与人格

> 状态：Accepted（M4；分层记忆 2026-11-10；常驻记忆与分块检索 2026-11-12）· 更新：2026-11-12 · 决策：[ADR-0011](../20-decisions/ADR-0011-layered-memory-and-idle-compaction.md) · [ADR-0024](../20-decisions/ADR-0024-resident-memory-and-chunked-search.md)

> **实现状态**：记忆存储、分块索引、使用记录、常驻层、白板与工具在 `packages/core/src/memory/`，交接在 `packages/core/src/session/handoff.ts`，闲时压缩与梦境在 `packages/core/src/maintenance/`，人格与钩子在 `packages/core/src/persona/persona.ts`。未实现：钩子 `onDelivery` / `onPluginLifecycle` / `eventDelivery`。检索不使用向量（ADR-0011）。

## 1. 原则

- **记忆即人格**（Cortico）：助理"是谁"由 `persona/` 与 `memory/` 的内容决定；换模型、交接、重启都不改变身份。
- **服务单一对话**：记忆只服务唯一的主会话，没有按对话分区，也没有跨对话检索。普通 Fork 可以读写记忆文件，但默认拿不到白板。
- **Core 对内容不透明**：Core 只提供目录、文件工具、触发时机、边界和机械检查（字符上限、`summary` 是否存在、梦境是否写了东西），不解释内容；整理流程写在 Skill 里。
- **常驻的少而硬**：每次请求都带的只有主人画像、长期约定和笔记索引，各有硬上限；其余按需取。
- **去哪找常驻，是什么按需取，当时原话只在审查时看**：上下文因此保持很短（§4）。

## 2. 目录布局

```
/data/persona/                 ← 人格（可版本控制，建议放 Git）
├── SOUL.md                    ← 身份：名字、性格、价值观、说话方式
├── OPERATING.md               ← 行为准则：何时主动、何时沉默、审批习惯、工作节奏、记忆怎么写
├── plugins/<id>/ENV_PROMPT.md ← 对插件环境提示的覆盖（可选）
└── hooks.ts                   ← 可选钩子（见 §6）

/data/memory/                  ← 记忆（助理读写；Core 不解释）
├── core/
│   ├── owner.md               ← 主人画像：全文常驻，上限 2000 字符
│   ├── rules.md               ← 长期约定、纠正与教训：全文常驻，上限 4000 字符
│   └── .history/              ← 上面两个文件每次改动前的版本（各保留 20 份，隐藏）
├── notes/<topic>.md           ← 主题笔记（项目、人、习惯），frontmatter 的 summary 必填（§3.2）
├── notes/archive/             ← 已结束的笔记，索引里只占一行
├── journal/YYYY-MM-DD.md      ← 日志：按天追加的事实与决定（守护进程时区）
├── handoff/<ts>.md            ← 压缩笔记（每次压缩写一份，只读）
├── raw/<ts>.md                ← 被压缩掉的对话原文（只读，§5.1）
└── blobs/                     ← 记忆引用的附件（`mem:` 句柄）
```

白板不是文件，存在 SQLite 表 `board_items` 里（§3.1）；检索索引在 `memory_files` / `memory_chunks`，使用记录在 `memory_access`。

默认人格（镜像自带 `personas/default/`，只有 `SOUL.md` 与 `OPERATING.md`）在首次启动时复制到 `/data/persona/`（位置可用 `persona.dir` 改），之后不再覆盖。记忆目录在首次启动时创建为空目录；`core/` 由第一次写入创建。人格文件与钩子变化后从下一次模型请求生效（目录监视，300 ms 合并）。

`core/` 里只能有 `owner.md` 与 `rules.md`；工具写别的文件会被拒绝。主人画像不再放在人格目录：它由助理随时维护，主人在控制台或直接改文件。

## 3. 记忆工具

Core 暴露给所有会话的 `memory` 工具是一组普通的文件操作：

| 命令 | 作用 |
|---|---|
| `read {path, range?}` | 列目录（两层），或带行号显示文件；不给 `range` 时一次 200 行，回执说明还剩多少行、下一段的 `range` |
| `write {path, text}` | 创建或整体覆盖 |
| `append {path, text}` | 追加到末尾，文件不存在时创建；保证一行一条 |
| `edit {path, old, new}` | 替换唯一的一处原文；找不到或不唯一时说明在哪几行 |
| `move {from, to}` | 移动文件或目录 |
| `delete {path}` | 删除文件或目录 |

路径接受 `/memories/x`、`memories/x`、`x` 三种写法，映射到 `/data/memory/x`。写入用"临时文件 + rename"，拒绝 `..`、根目录之外的路径与指向目录外的符号链接，单个文件不超过 1 MB。规则：

- `raw/` 与 `handoff/` 对这个工具只读；隐藏路径（任一段以 `.` 开头）不可写。
- `core/owner.md`、`core/rules.md` 超过上限的写入被拒绝，什么都不写，回执给出字数与上限，要求重写得更短；成功写入的回执带"已用/上限"字数。两个文件不能被移动或删除。每次改动前的内容存进 `core/.history/`。
- `notes/` 下的 `.md` 文件写入后必须有 frontmatter 的 `summary`，否则拒绝并给出格式（这样索引才能列出它）。主人和 Core 自己的写入（控制台、交接）不受这条限制，但同样受 `core/` 上限约束。
- 批里有主人以外的人发来的事件时，写 `core/` 需要主人批准（§7）。

`memory` 不再沿用 Anthropic `memory_20250818` 的命令面，也没有"声明官方工具类型"的选项：实测里失败的写入都出在 `insert` 与"文件必须先存在"上，追加日志又是最常见的写入。

额外的内核工具：

| 工具 | 作用 |
|---|---|
| `memory_search {query, scope?, paths?, limit?}` | 全文检索（§3.2）。`scope` 是 `notes`（默认）、`raw`、`all`；给了 `paths` 时默认 `all` |
| `board {view / add / update / done / drop}` | 白板（§3.1） |

列最近几天日志用 `read /memories/journal`。

控制 API：`GET /api/memory/tree`、`GET|PUT /api/memory/file?path=`（写入记审计 `memory_write`；`core/` 与 `notes/` 的修改在主会话空闲时进入系统前缀）、`GET /api/memory/search?q=&scope=`、`GET /api/memory/overview`、`GET /api/memory/history?path=core/…`、`GET|POST /api/memory/board`、`GET|POST /api/memory/dream`（[05-control-api.md](../30-specs/05-control-api.md)）。

写入习惯（由 `OPERATING.md` 约定，Core 只做上面的机械检查）：正在进行的事上白板；事实用 `append` 进当天 journal；主人说"以后都""别再"或纠正助理时，当场写进 `core/rules.md`；关于主人的稳定信息进 `core/owner.md`；稳定结论进 `notes/`；工具能查到的运行状态、被更正过的旧说法、秘密不记。

### 3.1 白板

三个区：`goals`（目标，少而稳定）、`todo`（待办，可带 `due`，等待别人回复也算）、`notes`（给自己的注意事项）。每条一行，上限 500 字符；整块上限 60 条、6000 字符（`memory.board`）。已关闭的条目保留在表里供审查。

写操作只回一行收据（含修订号与各区条数），只有 `view` 回整块，否则频繁更新会撑长历史。

白板**不进系统前缀**（否则每改一次就让整段对话的缓存失效），也不做"只发一次、不落转录"的临时注入（那会破坏 thinking 块的前缀绑定）。模型通过三条都写入转录的路径看到它：

1. 每次压缩后新对话的首条消息；
2. 批开始时，若主会话以外的来源（主人、Fork）改过白板，事件消息里带一份完整白板；为空也渲染，清空才可见；
3. 模型自己操作时的工具收据。

"这个对话已经看到哪个版本"记录在显示白板的那条转录消息上，所以重启后不会重复显示。普通 Fork 默认没有 `board`，派生时显式列出才有（梦境就是这样）。

### 3.2 分层检索

检索由模型驱动，每一层的代价递增：白板、常驻文件与笔记索引已在上下文里；`memory_search` 默认只查笔记，返回文件、摘要和最多三处命中的行号范围；`memory read` 按行号看一段；原文层（`journal/`、`handoff/`、`raw/`）要显式 `scope: "raw"` 或 `"all"` 才返回。笔记无命中而原文层有命中时，回执只告诉模型有几个文件匹配，不给内容。

**索引按块**。文件在标题、存档里的消息头（`--- assistant ---`）处切开；一块超过约 1200 字符后在下一个空行或列表项处切开（journal 的每条记录因此各成一块），超过 3000 字符时强制切开。frontmatter 不进任何块，文件的 `summary` 与 `keywords` 属于第一块。检索结果给出块的行号范围，片段从文件按行号读，表里不存整篇正文。

**分词**不用 embedding（ADR-0011）。文本入库前把 CJK 连续段切成重叠的二元组，所以中文两字词是正常的带相关度排序的词，不需要词典；另有一列单独存每个 CJK 字，单字查询（含长词中间的字）也能命中。查询时一个词按文字切开：拉丁词保持短语并做前缀匹配，CJK 段变成二元组短语，单个汉字查单字列，各部分都要出现。

**查询语义**：不要求所有词都命中。先按文件包含的查询词数排序，再按 BM25（摘要和关键词的权重是正文的 4 倍）加层与时间的小幅调整排序；只命中部分词的结果标明命中了哪几个。引号里的短语和 `+词` 必须出现。`paths` 可以是目录、文件或 glob（相对 `/memories`）。索引在启动时与目录同步，工具写入立即更新，主人直接改文件由目录监视补上；`blobs/` 与隐藏文件不进索引。

笔记的 frontmatter（Core 只读取 `summary` 与 `keywords`）：

```markdown
---
summary: 张伟：主人的合伙人，周三例会，不吃辣
keywords: [张伟, Zhang Wei, 合伙人, partner, 例会, weekly sync]
updated: 2026-11-09
sources: [journal/2026-11-05.md, handoff/2026-11-07T19-02-11Z.md]
---
```

字面检索对"换一种说法"的问题召回较弱，由 `keywords`（梦境根据"没有结果的检索"补同义词和中英文写法）、排序不要求全部命中、模型自己改写查询来弥补。

### 3.3 使用记录

`memory_access` 记录每次检索（查询词、找到几个文件、找到了哪些）、每次读文件和每次写入，带会话 id，保留 90 天。它有三个用处：梦境据此知道哪些笔记长期没被主会话读到、哪些检索什么也没找到；梦境的验收用它数 Fork 写了几次；控制台显示使用情况。统计只算主会话，梦境自己的大量读取不算。

## 4. 记忆与上下文

| 层 | 内容 | 在请求里的位置 |
|---|---|---|
| 白板 | 目标、待办、注意事项 | 转录（§3.1） |
| 常驻 | `core/owner.md`、`core/rules.md`、由 Core 生成的笔记索引 | 系统前缀的最后三段 |
| 笔记 | `notes/` | 按需检索，结果作为工具回执进入历史 |
| 原文 | `journal/`、`handoff/`、`raw/`、转录、事件库 | 默认不召回 |

- 三个分段（[06-context-assembly.md](06-context-assembly.md) §3）：`owner` 与 `rules` 包在 `<memory_file path="/memories/core/…" chars="…" limit="…">` 里；`memory-index` 包在 `<memory_index root="/memories">` 里。文件为空时对应分段不出现。
- **笔记索引由 Core 生成**：`notes/` 下每个文件一行 `- <路径> — <summary>`，按路径排序；`notes/archive/` 只占一行（文件数）。超过 6000 字符时，`notes/` 下的子目录各变成一行（文件数与前几个文件名），再超过就截断并说明还有几行。这是结构包装，Core 不写自己的话（P1）。没有 `summary` 的笔记用首行代替，并列入检查结果。
- 模型看到的常驻层是一份**发布副本**，只在压缩或交接、梦境通过验收、主人从控制台修改 `core/` 或 `notes/`、进程启动时更新；主会话正忙时推迟到空闲。助理自己在对话里的修改当时已经在转录里，所以等到下次压缩才进前缀，缓存不受影响。运行说明告诉模型这一点。
- 每个批的 `<status>` 块不含记忆内容。

## 5. 压缩（handoff）

压缩有两种时机：闲时（常态）和容量交接（兜底），详见 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8。两者共用下面的流程：

1. 默认策略：用 `cheap` 模型（闲时压缩失败后依次换成 `fork`、`main`，见 §5.2）对即将丢弃的历史生成 `handoff/<UTC 时间>Z.md`。请求固定用最低的 effort（`low`），输出上限 `context.handoff.notesMaxTokens`（默认 16000，包含思考），长度由提示词限制在约 800 字。输入依次是：`<memory_core>`（`core/` 两个文件的当前内容）、上一份压缩笔记、丢弃部分的纯文本渲染（工具结果截断、thinking 不进入，超过 `notesInputTokens` 时先丢最早的部分）。笔记分节：In progress、Commitments（有时间或期限的承诺）、Owner's recent instructions（这段时间的一次性要求）、Pending、Durable, not yet saved（应当长期有效、`core/` 里还没有的约定、偏好、纠正和教训，梦境优先处理）、Facts worth keeping。`core/` 已有的内容不复述；上一份笔记里仍然有效的条目保留，因此多次压缩后早先的约定不会丢。容量交接时模型失败或拒答写"机械笔记"（最后 20 条文本原样）；闲时压缩则放弃本次，不写任何文件。文件开头记录来源转录、丢弃与保留的消息数和上一份笔记的路径。
2. 保留尾部：从一个"事件消息"（不含工具结果的 user 消息）开始，取最近的消息，闲时不超过 `context.idleCompaction.keepTokens`（默认 8000），容量交接不超过 `keepRatio × softTokens`（默认 1/3）；正在运行的批总是完整保留。尾部消息**去掉 thinking 块**后复制（thinking 块绑定原对话，见 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8），旧的 `<board>` 块也去掉，避免旧白板排在新白板之后。手动交接和 Provider 报"输入过长"后的交接只保留正在运行的批（或最近一批）。
3. 新会话的首条 user 消息依次是：`internal` 事件 `session.handoff`（`store` 模式记入事件库，只含事实：条数、笔记路径、`meta.kind`）、`<board>` 块（白板非空时）、`<handoff_notes path=…>` 块（笔记正文，最多 8000 字符）。其后才是尾部。模型不需要先读文件就知道之前在做什么。笔记是模型写的摘要，可能引用外部内容，所以不放进 `internal` 事件（P4）；运行说明告诉模型这两种块里的内容是数据，不是指令。交接后常驻层随之发布。

人格可通过 `onHandoff` 钩子替换第 1、2 步：返回 `{ tail, notes }`（Core 写文件）或 `{ tail, notesPath }`（钩子自己写了笔记）；`tail` 必须以 user 消息开头；钩子出错时回退默认策略。

### 5.1 原文层

每次压缩都把被丢弃的对话渲染成 Markdown 存到 `raw/<UTC 时间>Z.md`：不含 thinking，工具输入和结果各截到 4000 字符，超过 1 MB 时截断并指向转录文件。转录本身没有脱敏（脱敏只发生在 Provider 层），所以写入前按已知秘密脱敏；`raw/` 也不进 Git 备份（完整备份仍包含）。这些文件可以在控制台的记忆目录里直接审查，模型显式 `scope: "raw"` 才能搜到，梦境也能读。完整内容一直在 `sessions/main.*.jsonl` 里。

### 5.2 闲时压缩失败

实测里笔记模型的思考占满了输出上限，连续九次没写出笔记（[12-memory-system-v2.md](../40-plan/12-memory-system-v2.md) §2）。除了提高上限、降低 effort，闲时压缩失败后：

- 下一次尝试的间隔按 `minIntervalMs`、两倍、四倍递增（默认 10、20、40 分钟），之后保持四倍。
- 连续失败 3 次换 `fork` 角色写笔记，再失败 3 次换 `main`。
- 9 次都失败：发一条 L3 事件 `memory.compaction_failed`（`piggyback`），不再尝试，直到对话变长。容量交接不受影响。
- 被更紧急的事件打断不算失败；任何一次交接（包括容量交接）都让计数归零。

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

## 7. 主人画像、来源管控与隐私

- `core/owner.md` 与 `core/rules.md` 进入系统前缀，因此也会进入 Provider 请求。敏感细节应放进 `notes/` 由模型按需读取；秘密不记（运行说明与 `OPERATING.md` 都这样要求，Provider 层另有脱敏）。
- **来源管控**：常驻文件每次请求都生效，一条被诱导写进去的"约定"会一直起作用。工具规格的 `askWhen`（[14-security-and-permissions.md](14-security-and-permissions.md)）对写 `core/` 的调用逐次判断：主会话的批里有主人以外的外部事件（`origin = external` 且 `sender_role` 不是 owner）时，这次调用必须由主人批准，任何权限模式下都不交给自动审查，`locked` 时直接拒绝；梦境 Fork 可以直接写；其他 Fork 写 `core/` 都要批准。批准后用同样的输入再调用一次即可。
- 每次改动 `core/` 前的版本留在 `core/.history/`，控制台可以查看和恢复。
- 记忆目录不被任何插件访问（I-7 的推广）；控制台的记忆浏览需要管理员令牌。
- `raw/` 里是完整对话，默认不进 Git 备份；白板与使用记录在数据库里，随完整备份保存。
- 备份建议：`/data/persona` 与 `/data/memory` 定期推送到私有 Git 仓库：`protea backup --to <git-url>`（M6；同时推送 `config.yaml` 与 `skills/`，便于审阅记忆的变化），数据库与转录用目录备份（[16-deployment.md](16-deployment.md) §8）。

## 8. 梦境（自动记忆整理）

每天到 `memory.dream.at`（默认 03:30，守护进程时区）之后，主会话空闲超过 30 分钟、预算允许，且有文件比上次**通过验收**的整理更新时，Core 派生一个 Fork 运行内置 Skill `memory-dream`。Core 只决定何时运行、告诉它变了什么、机械验收结果，做什么写在 Skill 里（P1）：把 `Durable, not yet saved` 与日志里的约定并入 `core/rules.md`、把画像并入 `core/owner.md`、超限时精简；把日志和压缩笔记折叠进笔记并写明来源；补齐 `summary` 和 `keywords`（包括"没有结果的检索"里的词）；合并重复、归档；清理白板；在当天日志里写一条整理记录。

- **增量输入**：Fork 的首条消息里有 `<memory_state>`：上次通过验收以来变化过的文件（最多 60 个）、`core/` 两个文件的用量、检查结果（缺 `summary`、超过 8 KB 的笔记、超限的常驻文件）、最近 30 天的使用情况（读过或找到的文件、从没被用到的笔记、没有结果的检索）。它不必先把整个目录读一遍。
- **验收**：Fork 结束时有自己的最终总结（没有总结或用完回合都不算）、至少写过一次记忆（按使用记录数）、`core/` 没有超限。不满足记为失败，原因写进状态的 `rejected`，不推进水位，第二天用同样的输入重来；计入连续失败。
- Fork 用 `memory.dream.model`（默认 `main`）、L4，最多 `memory.dream.maxTurns`（默认 40）回合，不受 `scheduler.forks.maxTurns` 限制；工具只有 `memory`、`memory_search`、`board`、`skill_load`，所以无法联系任何人；主会话运行紧急批时按现有规则让路。
- 不删除原文，只在日志里建议删除。
- Fork id 在派生时写入 kv，重启后能对账；每天最多一次，通过验收的那次自身的写入不算"有新内容"。
- 连续失败 3 次后停用并发一条 L2 事件；控制台的"立即整理"会重新启用。结果、未通过验收的原因和上次通过验收的时间在 `/api/memory/dream` 与控制台的记忆概况页可见。
