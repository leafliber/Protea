# ADR-0003：自研代理循环，Claude Agent SDK 仅作可选 Fork 执行器

状态：Accepted · 日期：2026-11-03 · 相关：[../10-architecture/05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) · [../10-architecture/12-model-providers.md](../10-architecture/12-model-providers.md)

## 背景

有四种构建方式：手写循环、Anthropic SDK 的 Tool Runner、Managed Agents（服务端托管）、Claude Agent SDK（Claude Code 作为库）。Protea 的核心需求是：事件在回合边界进入、抢占/中断、自定义上下文装配与缓存布局、交接式容量管理、插件工具与 MCP 的统一权限策略、Provider 可替换。

## 决策

**主会话与 Fork 使用自研循环**，直接基于 Anthropic Messages API（官方 TypeScript SDK，流式 + 手动工具分发）。原因：

1. 回合边界、抢占、`interruptible` 工具、审批挂起等语义需要对循环的完全控制；Tool Runner 的每回合钩子不足以表达"取消模型调用并合并批重请求"。
2. 上下文装配（分段前缀、事件渲染、状态块后置、工具搜索阈值）是 Protea 的核心差异点。
3. 权限策略与审计必须覆盖所有工具（插件、MCP、内核），不能被执行器内部的工具绕过。
4. Provider 抽象要求循环不绑定某家 SDK 的高层封装。

**Claude Agent SDK 作为可选的 Fork 执行器插件**（`fork.runner = 'claude-agent-sdk'`）：对编码/文件系统型长任务，直接复用其内建工具、子代理与压缩；Protea 只接收结果与进度。它运行在子进程中，受 Fork 的等级、预算与取消语义约束。

**Managed Agents** 不采用：它托管循环与沙箱，与"自己的数据卷、自己的插件进程、自己的权限层"目标不符；但 Provider 层保留未来把某类 Fork 交给它的可能。

## 备选方案

- 全部基于 Claude Agent SDK：最快出 demo，但事件/抢占语义需要绕过其循环，且 Provider 锁定。
- 全部基于 Tool Runner：节省部分循环代码，但取消/合并语义仍要自己做，收益小。

## 后果

- 需要自己实现并测试：流式解析、并行工具、取消、错误分类、缓存断点、容量计数。
- 必须跟踪 Anthropic API 的变化（beta 头、模型行为）；`12-model-providers.md` 维护一张"当前做法"表。
