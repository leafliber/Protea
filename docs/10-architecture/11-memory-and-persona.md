# 记忆与人格

> 状态：Accepted（M4）· 更新：2026-11-03

> **实现状态（M4）**：记忆存储、索引与工具在 `packages/core/src/memory/`（`store.ts`、`fts.ts`、`tools.ts`），交接在 `packages/core/src/session/handoff.ts`，人格与钩子在 `packages/core/src/persona/persona.ts`。未实现：向量检索、`protea backup`、钩子 `onDelivery` / `onPluginLifecycle` / `eventDelivery`。

## 1. 原则

- **记忆即人格**（Cortico）：助理"是谁"由 `persona/` 与 `memory/` 的内容决定；换模型、交接、重启都不改变身份。
- **Core 对内容不透明**：Core 只提供目录、文件工具与钩子，不解释内容。
- **人格以文件为主**：个人用户改 Markdown 比改代码容易；可选钩子只用于少数需要代码的行为（自定义交接策略）。

## 2. 目录布局

```
/data/persona/                 ← 人格（可版本控制，建议放 Git）
├── SOUL.md                    ← 身份：名字、性格、价值观、说话方式
├── OPERATING.md               ← 行为准则：何时主动、何时沉默、审批习惯、工作节奏、Skills 使用
├── USER.md                    ← 主人画像：称呼、时区、偏好、重要的人和事（主人自己维护或助理经允许更新）
├── plugins/<id>/ENV_PROMPT.md ← 对插件环境提示的覆盖（可选）
└── hooks.ts                   ← 可选钩子（见 §6）

/data/memory/                  ← 记忆（助理读写；Core 不解释）
├── INDEX.md                   ← 记忆索引：进入系统前缀的唯一记忆文件；助理负责保持简短
├── journal/YYYY-MM-DD.md      ← 日志：按天追加的事实与决定
├── notes/<topic>.md           ← 主题笔记（项目、人、习惯）
├── handoff/<ts>.md            ← 交接笔记（容量交接时写入）
├── tasks.md                   ← 待办/跟踪中的事（结构自由）
└── blobs/                     ← 记忆引用的附件（`mem:` 句柄）
```

默认人格（镜像自带 `personas/default/`）在首次启动时复制到 `/data/persona/`（位置可用 `persona.dir` 改），之后不再覆盖。记忆目录在首次启动时从 `personas/default/memory/` 创建（一个说明各目录用途的 `INDEX.md`）。人格文件与钩子变化后从下一次模型请求生效（目录监视，300 ms 合并）。

## 3. 记忆工具

Core 暴露给所有会话的 `memory` 工具采用与 Anthropic **memory tool（`memory_20250818`）** 相同的命令面（`view {path, view_range?} / create {path, file_text} / str_replace {path, old_str, new_str} / insert {path, insert_line, insert_text} / delete {path} / rename {old_path, new_path}`）。模型看到的路径是 `/memories/…`，映射到 `/data/memory/…`；回执与错误文本与 SDK 参考实现一致（模型对它们有训练）。写入用"临时文件 + rename"，拒绝 `..`、根目录之外的路径与指向目录外的符号链接，单个文件不超过 1 MB。

默认以**普通自定义工具**提供，而不声明官方类型：官方工具出现在请求里时，API 会自动在系统提示里加入"做任何事之前先查看记忆目录"的协议，对每批都很短的事件驱动助理意味着每批多一次读取；`INDEX.md` 已在前缀里，起的就是同样的作用。`memory.nativeTool: true` 时 Anthropic Provider 声明 `{ type: "memory_20250818", name: "memory" }`。

额外的内核工具：

| 工具 | 作用 |
|---|---|
| `memory_search {query, paths?, limit?}` | 全文检索：SQLite FTS5，trigram 分词（中文不需要分词也能匹配）；每个词都要出现，引号保留短语；短于 3 个字的词按子串过滤；`paths` 可以是目录、文件或 glob（相对 `/memories`）。索引在启动时与目录同步，记忆工具的写入立即更新，主人直接改文件由目录监视补上；`blobs/` 与隐藏文件不进索引。v2 增加向量检索（sqlite-vec） |
| `memory_recent {days}` | 最近 N 天（按守护进程时区）`journal/YYYY-MM-DD.md` 的清单与大小，新的在前 |

控制 API：`GET /api/memory/tree`、`GET|PUT /api/memory/file?path=`（写入记审计 `memory_write`）、`GET /api/memory/search?q=`。

写入规则（由 `OPERATING.md` 约定，而非 Core 强制）：事实进 journal；稳定结论进 notes；INDEX.md 只放"去哪找"的指针。`memory-hygiene` Skill 提供整理流程。

## 4. 记忆与上下文

- 进入系统前缀的只有 `INDEX.md`（`memory-index` 段，系统前缀的最后一段，包在 `<memory_index path="/memories/INDEX.md">` 里；超过 32 000 字符时截断并提示精简，[06-context-assembly.md](06-context-assembly.md) §3）。它一变，系统前缀就变：缓存从这一段起失效一次，此前的 thinking 块不再回传（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8.1），所以 `OPERATING.md` 要求少改它。
- 其他内容由模型按需 `view`/`memory_search`。
- 每个批的 `<status>` 块不含记忆内容。

## 5. 交接笔记（handoff）

容量交接时（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8）：

1. 默认策略：用 `cheap` 模型（effort 取 `providers.anthropic.effort.cheap`，输出上限 `context.handoff.notesMaxTokens`）对即将丢弃的历史生成 `handoff/<UTC 时间>Z.md`。输入是丢弃部分的纯文本渲染（工具结果截断、thinking 不进入，超过 `notesInputTokens` 时先丢最早的部分）**加上一份交接笔记**，要求保留其中仍然有效的条目，因此多次交接后早先的约定不会丢。笔记分节：In progress、Commitments、Owner's recent instructions、Pending、Facts worth keeping。模型失败或拒答时写"机械笔记"（最后 20 条文本原样）。文件开头记录来源转录、丢弃与保留的消息数和上一份笔记的路径。路径加到 `INDEX.md` 末尾的 `## Recent handoffs` 列表（保留最近 `recentInIndex` 条，默认 5）。
2. 保留尾部：从一个"事件消息"（不含工具结果的 user 消息）开始，取最近不超过 `keepRatio × softTokens`（默认 1/3）的消息；正在运行的批总是完整保留。尾部消息**去掉 thinking 块**后复制（thinking 块绑定原对话，见 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8）。手动交接和 Provider 报"输入过长"后的交接只保留正在运行的批（或最近一批）。
3. 新会话的首条 user 消息是 `internal` 事件 `session.handoff`（`store` 模式记入事件库，正文说明丢弃了多少条、笔记在哪），其后才是尾部，模型据此决定是否读取笔记。

人格可通过 `onHandoff` 钩子替换第 1、2 步：返回 `{ tail, notes }`（Core 写文件）或 `{ tail, notesPath }`（钩子自己写了笔记）；`tail` 必须以 user 消息开头；钩子出错时回退默认策略。

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
- 备份建议：`/data/persona` 与 `/data/memory` 定期推送到私有 Git 仓库：`protea backup --to <git-url>`（M6；同时推送 `config.yaml` 与 `skills/`，便于审阅记忆的变化），数据库与转录用目录备份（[16-deployment.md](16-deployment.md) §8）。
