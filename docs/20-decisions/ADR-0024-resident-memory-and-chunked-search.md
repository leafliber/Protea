# ADR-0024：常驻记忆、生成的笔记索引、分块检索与验收的整理

状态：Accepted · 日期：2026-11-12 · 相关：[ADR-0011](ADR-0011-layered-memory-and-idle-compaction.md)（修订其中的索引、记忆工具与梦境部分）· [ADR-0022](ADR-0022-no-backward-compatibility-before-launch.md) · [../10-architecture/11-memory-and-persona.md](../10-architecture/11-memory-and-persona.md) · [../40-plan/12-memory-system-v2.md](../40-plan/12-memory-system-v2.md)

## 背景

本地容器运行三天（47 批、3 次压缩、3 次梦境）后的问题（详见 [12-memory-system-v2.md](../40-plan/12-memory-system-v2.md) §2）：

- 前缀里的主人画像是 `persona/USER.md` 的占位文本：助理写不了它，自己另建了一个不进前缀的文件。
- `INDEX.md` 由梦境手写，五篇笔记只列了两篇；梦境一次用完回合没做完，一次只读不写，都记为完成。
- 闲时压缩连续九次失败：笔记模型的思考占满了 8000 的输出上限，没有退避，也不换模型。
- 47 批只检索过一次，四个词必须同时出现，零命中。
- 写入失败都出在 `memory_20250818` 命令面上（`insert` 行号、文件必须先存在），而追加日志是最常见的写入。
- 主人定下的长期约定只存在于压缩笔记里，每次压缩被转述一遍。

参照 Claude Code、Codex、OpenClaw 等：常驻部分有硬上限、只放最要紧的；其余按需读取；整理在后台进行，并且要被检查。

## 决策

- **常驻记忆 `memory/core/`**：`owner.md`（2000 字符）与 `rules.md`（4000 字符）全文进系统前缀，助理与主人都能写；超限的写入被拒绝，回执要求重写得更短。`core/` 里只能有这两个文件，每次改动前的版本保留 20 份。`persona/USER.md` 删除。
- **笔记索引由 Core 生成**：从 `notes/` 的 frontmatter `summary` 生成，每个文件一行，超过 6000 字符时按目录折叠。删除 `INDEX.md`；`notes/` 的写入必须带 `summary`。生成是结构包装，不产生语义内容（P1）。
- **发布时机不变**：`owner`、`rules`、`memory-index` 三段放在前缀末尾，沿用 ADR-0011 的延迟发布；控制台对 `core/` 与 `notes/` 的修改在空闲时发布。
- **记忆工具改为通用文件操作**：`read / write / append / edit / move / delete`，路径写法放宽；删除 `memory_recent`、`memory.nativeTool` 与工具规格的 `providerType`。
- **检索分块、不要求全部命中**：按标题、存档消息和列表项切块，返回行号范围；按命中词数再按 BM25 排序；引号与 `+词` 必须出现；另存单字列，单字查询可命中长词中间的字。仍不用 embedding。
- **使用记录**：`memory_access` 记录检索、命中、读与写，供梦境、验收和控制台使用。
- **来源管控**：工具规格新增 `askWhen(input, ctx)`，权限守卫据此把单次调用改为必须由主人批准（任何模式下都不交给自动审查）。写 `core/` 时，主会话的批里有主人以外的外部事件、或写入来自梦境以外的 Fork，就要批准。
- **压缩**：笔记请求固定 `effort: low`，输出上限默认 16000；输入带上 `core/` 内容，新增 `Durable, not yet saved` 一节；闲时失败按 10、20、40 分钟退避，每 3 次失败依次换 `fork`、`main`，全部失败后发 L3 事件并等对话变长。
- **梦境**：Core 在首条消息里给出变化的文件、常驻用量、检查结果与使用统计；验收要求有最终总结、至少一次写入、`core/` 不超限，不满足不推进水位；默认 `main` 模型、40 回合（`memory.dream.maxTurns`，不受 `scheduler.forks.maxTurns` 限制）；Fork 信息新增 `unfinished` 标记没有最终消息的结束。
- **时区**：`daemon.timezone` 没有在配置或环境里设置时，启动告警，控制台首页提示。

## 备选方案

- 保留主人手写的 `USER.md`，另加助理可写的 `core/owner.md`：两处画像会互相矛盾。
- 向量检索：主人仍然不要（ADR-0011）。实测的瓶颈是查询语义和索引过期，不是召回方式。
- 每批自动召回笔记，或 OpenClaw 式的触发词注入：先有使用记录，看到"该查没查"的数据再议。
- 后台从转录提取 journal（Codex 的做法）：助理当场写的 journal 带 id 和时间，事后由便宜模型提取会丢细节。
- 压缩前让主会话先做一轮记忆冲刷（OpenClaw 的做法）：`Durable, not yet saved` 加 `core/` 已覆盖这个用途，不必多一个回合。
- 来源管控用专门的工具名加权限策略：策略只能按工具名判断，判断不了"这次写的是 `core/`、这一批里有谁"。

## 后果

- 前缀里的主人画像和长期约定由助理随时维护，同时受上限、来源管控和历史版本约束。
- 笔记索引不会再过期；没有 `summary` 的笔记写不进去。
- 已部署实例要手工迁移一次：把 `persona/USER.md` 和助理自建的画像并入 `memory/core/owner.md`，长期约定写进 `core/rules.md`，删除 `memory/INDEX.md`；`config.yaml` 里的 `memory.nativeTool` 删除。迁移 12 会重建检索索引。
- 梦境默认用 `main` 模型，每天一次的成本更高；质量比成本要紧。
- 真实模型下的质量仍归 T3、T11 实测。
