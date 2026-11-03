# 记忆与人格

> 状态：Draft · 更新：2026-11-03

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

默认人格（镜像自带 `personas/default/`）在首次启动时复制到 `/data/persona/`，之后不再覆盖。

## 3. 记忆工具

Core 暴露给所有会话的记忆工具采用与 Anthropic **memory tool（`memory_20250818`）** 相同的命令面（`view / create / str_replace / insert / delete / rename`），后端是 `/data/memory`。这样做的好处：Claude 系列模型对这套命令有原生训练；Provider 支持时可直接声明官方工具类型，不支持时 Core 以普通自定义工具提供相同语义。

额外的内核工具：

| 工具 | 作用 |
|---|---|
| `memory_search {query, paths?}` | 全文检索（SQLite FTS5 索引，文件变化时增量更新）；v2 增加向量检索（sqlite-vec） |
| `memory_recent {days}` | 最近 N 天日志的清单 |

写入规则（由 `OPERATING.md` 约定，而非 Core 强制）：事实进 journal；稳定结论进 notes；INDEX.md 只放"去哪找"的指针。`memory-hygiene` Skill 提供整理流程。

## 4. 记忆与上下文

- 进入系统前缀的只有 `INDEX.md`（`memory-index` 段，[06-context-assembly.md](06-context-assembly.md) §3）。
- 其他内容由模型按需 `view`/`memory_search`。
- 每个批的 `<status>` 块不含记忆内容。

## 5. 交接笔记（handoff）

容量交接时（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §8）：

1. 默认策略：用 `cheap` 模型对即将丢弃的历史生成 `handoff/<ts>.md`，内容限定为：正在进行的事、未完成的承诺、主人最近的指示、需要跟进的审批/Fork；并把文件路径追加到 `INDEX.md` 的"最近交接"小节。
2. 保留尾部：最近 `keepRatio`（默认 1/3 的 `softTokens`）的消息原样进入新会话。
3. 新会话的首条 user 消息是 `internal` 事件 `handoff.completed {notes: "memory/handoff/<ts>.md"}`，模型据此决定是否读取笔记。

人格可通过钩子替换第 1、2 步。

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

钩子在守护进程内以**进程内**方式加载（需信任），文件变化后在回合边界热重载；加载失败回退到默认实现并告警。

## 7. 主人画像与隐私

- `USER.md` 可能包含敏感信息；它进入系统前缀，因此也会进入 Provider 请求。主人应知晓并可选择把敏感部分放进 `notes/` 由模型按需读取。
- 记忆目录不被任何插件访问（I-7 的推广）；控制台的记忆浏览需要管理员令牌。
- 备份建议：`/data/persona` 与 `/data/memory` 定期推送到私有 Git 仓库（`protea backup` 子命令，M6）。
