# 参考：Cortico 的设计与 Protea 的取舍

> 状态：Draft · 更新：2026-11-03
> 来源：[Pal-AI-Lab/Cortico](https://github.com/Pal-AI-Lab/Cortico)（MIT）README、PHILOSOPHY.md、docs/worlds.md、docs/sessions.md、docs/personas.md、docs/extensions.md（2026-11 读取）。

Cortico 是一个"围绕事件流设计的 Agent Harness"，面向持续运行、接受混合实时输入的人格机器人（AI 主播、陪伴等）。Protea 的目标场景不同（云端个人助理），但其内核结构高度可借鉴。本文记录我们**采纳什么、改造什么、放弃什么**，避免后续讨论反复回到"Cortico 是怎么做的"。

## Cortico 的四层结构

| 层 | 职责 | Protea 对应 |
|---|---|---|
| Core | 会话生命周期、事件流、模型调用；无语义 | `Core`（同） |
| Persona | 上下文合成、认知循环、记忆协议 | `Persona`（简化，见下） |
| Memory | 人格的权威内部状态 | `Memory`（同） |
| World | 外部环境的隔离边界：事件摄入、工具声明、环境提示 | `Plugin`（`source` / `connector` / `tool` 种类） |
| Bot | 一个 Persona + 一组 World 的装配 | `AssistantProfile` |

## 采纳（基本原样）

1. **事件信封字段**：`cursor / run / type / ts / source / origin / tags / text / senderKey / meta / blobs / ephemeral`。Protea 增加 `level`、`trigger`、`dedupeKey`、`correlation`。
2. **投递模式**：`debounce / flush / preempt / interrupt / piggyback / deliver:false`。Protea 保留全部语义，把 `deliver:false` 改名为 `store`。
3. **回合边界规则**：新事件只在"全部工具返回后"或"模型调用被取消后"进入上下文。
4. **preempt 与 interrupt 的区分**：preempt 只取消尚无外部输出且无工具在跑的模型调用；interrupt 总是取消，保留已外化输出，向 `interruptible` 工具发信号并记录部分回执。
5. **RunPhase**：`idle / delivering / model / tools / backoff / handoff`。
6. **主会话 + Fork**：恰有一个常驻、接收事件的主会话；Fork 固定端点与模型，独立工具循环。
7. **工具标志**：`endsTurn / barrierAfter / interruptible`；工具名全局唯一，短前缀约定（`tg_`、`gh_`）。
8. **环境提示与工具描述的分工**：环境提示讲"何时用、跨工具协调、约束"；工具描述讲"参数、行为、回执"；两者不得重复。
9. **append-only 会话文件与启动修复规则**：尾行无换行时的截断/补全；孤儿工具结果移入转录并记录；缺失结果以占位回执补齐。
10. **交接（handoff）而非原地编辑历史**：容量触发 → 人格决定保留的尾部与笔记 → 重建前缀 → 重置会话。这与 Claude 5 系列"保留思考（preserved thinking）要求历史只追加"的约束天然一致。
11. **配置热更新约定**：共享配置引用、使用时读取、`x-hot: false` 标记需重建的项。
12. **扩展清单的契约版本**：按种类独立的 `api` 版本号，不匹配则拒绝加载。
13. **哲学**：为未来模型设计、最小先验干预、诚实认识论、记忆即人格、默认不作为。

## 改造

| Cortico | Protea | 原因 |
|---|---|---|
| 事件没有显式优先级，只有投递模式 | 事件源声明 **处理等级 L0–L4**，模式受等级约束，调度器按等级做抢占、老化与预算 | 个人助理的来源重要性差异巨大，需要可配置、可审计的优先级，而不是让每个 World 自行决定是否 interrupt |
| World 在进程内动态 import（Minecraft 例外为子进程） | 插件**默认进程外**（JSON-RPC over stdio），进程内仅限内核自带 | 热插拔与故障隔离 |
| 扩展安装后需重启才加载 | 安装/启用/禁用/重载/卸载**全部运行时完成** | 用户需求 G3 |
| `sessionHead()` 位于系统前缀与历史之间、每次请求重建 | 动态状态块放在**最新一批事件消息的末尾**（或 `clear_at` 的会话中系统消息） | 放在历史之前会让历史的提示缓存全部失效；Anthropic 的前缀缓存要求易变内容靠后 |
| Provider 基于 OpenAI Responses 协议 | Provider 抽象 + **Anthropic Messages API 为默认实现**（自适应思考、提示缓存、服务端回退、流式） | 面向 Claude 5 系列优化；其他协议通过 Provider 插件接入 |
| 没有 MCP / Skills 概念 | **MCP 客户端管理器**与 **Skills 注册表**为内核能力层的一等公民 | 用户需求 G4/G5 |
| Persona 是 TypeScript 类（钩子丰富） | Persona 主要是**文件**（`SOUL.md` 等）+ 少量可选钩子；复杂行为用 Skills 表达 | 个人用户更可能改 Markdown 而不是改代码；符合"语言即代码"的方向 |
| 面向人格机器人（主播、陪伴） | 面向**个人助理**：主人身份、审批、预算、审计是内核能力 | 场景不同 |

## 放弃

- Minecraft / Bilibili / QQ 等 World：不在 Protea 范围；社区可作为插件实现。
- llama.cpp 本地运行时管理：v1 不做本地推理。
- WebUI 多语言与扩展市场：v1 控制台只做运维最小集；扩展分发走容器卷与 Git。

## 兼容性考虑

Cortico 有 `world-compatibility.md` 描述"其他架构挂载 World 的兼容级别"。Protea 的插件协议在字段命名上尽量与 Cortico 的 World 契约对齐（事件字段、投递模式、工具标志），使得一个薄适配层即可把 Cortico World 包装为 Protea 进程外插件。这不是 v1 承诺，记录在 [../40-plan/04-risks-and-open-questions.md](../40-plan/04-risks-and-open-questions.md)。
