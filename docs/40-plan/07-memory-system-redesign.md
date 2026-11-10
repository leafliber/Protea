# 记忆系统重构：要求与落地

> 状态：Accepted（已实现，真实模型下的质量待 T3、T11 实测）· 更新：2026-11-10 · 决策：[ADR-0011](../20-decisions/ADR-0011-layered-memory-and-idle-compaction.md) · 设计：[11-memory-and-persona.md](../10-architecture/11-memory-and-persona.md)

| 要求 | 落地 |
|---|---|
| 1 服务单一对话 | 记忆只服务主会话，没有分区；白板默认不给 Fork |
| 2 闲时自动压缩 | 维护模块每 60 秒检查，空闲时压缩（[05](../10-architecture/05-sessions-and-agent-loop.md) §8） |
| 3 长期记忆分层检索 | 白板 → 索引 → 笔记 → 原文，代价逐层递增（[11](../10-architecture/11-memory-and-persona.md) §3.2） |
| 4 保留原文供审查、一般不召回 | `journal/`、`handoff/`、`raw/`、转录都保留；`memory_search` 默认不返回，只报告有几个文件匹配（[11](../10-architecture/11-memory-and-persona.md) §5.1） |
| 5 自动整理（梦境） | 每日 Fork 运行 `memory-dream`（[11](../10-architecture/11-memory-and-persona.md) §8） |
| 6 不引入 embedding | FTS5 + CJK 二元组 + 关键词 |
| 7 可被工具更新的白板 | `board` 工具，分目标、待办、注意事项（[11](../10-architecture/11-memory-and-persona.md) §3.1） |
| 8 上下文不宜长 | 低水位 32k，上限 80k，压缩后保留 8k，索引上限 8000 字符 |
| 9 兼顾各厂商前缀缓存 | 只依赖"前缀精确匹配 + 只追加 + 有寿命"（[06](../10-architecture/06-context-assembly.md) §7） |

## 主人的决定（2026-11-10）

- 上下文预算：低水位 32k，上限 80k。
- 白板分区：目标、待办、注意事项。
- 梦境模型：`fork` 角色。
- 原文保留：压缩时另存可读的 Markdown。

## 升级注意

- 迁移 7 会重建检索索引，下次启动时自动重新索引全部记忆文件。
- 已部署实例的 `/data/persona/OPERATING.md` 是首次启动时复制的，不会更新；未自定义时用新的默认文件替换。旧的 `tasks.md` 需要时可让助理搬到白板。
- 现有 `INDEX.md` 里的 `## Recent handoffs` 不再更新，第一次梦境会移除。
- `context.handoff.recentInIndex` 已移除；配置里残留也不影响启动。

## 查证来源

- DeepSeek：[KV cache](https://api-docs.deepseek.com/guides/kv_cache)、[Context Caching 公告](https://api-docs.deepseek.com/news/news0802)
- OpenAI：[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- 阿里云百炼：[Context Cache](https://help.aliyun.com/en/model-studio/context-cache)
- Claude Code 梦境（第三方资料）：[Auto Dream](https://claudefa.st/blog/guide/mechanics/auto-dream)
