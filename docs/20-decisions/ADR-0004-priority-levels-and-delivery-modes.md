# ADR-0004：处理等级 L0–L4 × 投递模式

状态：Accepted · 日期：2026-11-03 · 相关：[../10-architecture/02-event-model.md](../10-architecture/02-event-model.md) · [../10-architecture/04-scheduling-and-preemption.md](../10-architecture/04-scheduling-and-preemption.md)

## 背景

Cortico 用投递模式（debounce/flush/preempt/interrupt/piggyback）表达"事件如何进入会话"，但没有显式优先级：是否抢占由每个 World 自行决定。个人助理场景下来源数量多、重要性悬殊，需要一个操作员可配置、内核可强制、模型可感知的优先级体系，同时保留投递模式的细粒度语义。

## 决策

采用 **两维模型**：

- **等级（level）**：L0 critical · L1 interactive · L2 reactive · L3 scheduled · L4 ambient。由插件清单声明上限，事件可用更低等级。等级决定：批窗口、允许的投递模式集合、抢占能力、老化上限、预算池。
- **投递模式（trigger）**：沿用 Cortico 的六种语义。

抢占规则：只能自高向低；同级仅显式 `interrupt`；L3/L4 永远不能抢占；越权请求降级并告知。L1 仅限经身份验证的主人。

## 备选方案

- **只有数值优先级（如 0–100）**：表达力强但难以配置与解释；预算池、老化等参数需要分桶，等价于回到等级。
- **只有投递模式（Cortico 原样）**：插件自决抢占，无法防止失控或恶意来源；无预算分池。
- **每来源一个队列 + 加权公平调度**：适合吞吐型系统，但助理需要的是"主人优先"的硬优先级，不是公平。

## 后果

- 插件作者需要理解等级语义；文档提供选择指南。
- 等级默认参数需要在真实使用中调优；全部可配置。
- 等级概念在 MCP 服务器信任等级上有命名歧义（待决问题）。
