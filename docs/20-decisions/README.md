# 架构决策记录（ADR）

> 格式：标题 · 状态 · 日期 · 背景 · 决策 · 备选 · 后果。状态：Proposed → Accepted → Superseded / Deprecated。

| 编号 | 标题 | 状态 |
|---|---|---|
| [ADR-0001](ADR-0001-typescript-node-runtime.md) | 语言与运行时：TypeScript + Node.js 22 | Accepted |
| [ADR-0002](ADR-0002-event-log-as-source-of-truth.md) | 事件日志作为唯一事实源 | Accepted |
| [ADR-0003](ADR-0003-own-agent-loop-over-agent-sdk.md) | 自研代理循环，Claude Agent SDK 仅作可选 Fork 执行器 | Accepted |
| [ADR-0004](ADR-0004-priority-levels-and-delivery-modes.md) | 处理等级 L0–L4 × 投递模式 | Accepted |
| [ADR-0005](ADR-0005-plugin-isolation-out-of-process.md) | 插件默认进程外隔离，JSON-RPC over stdio | Accepted |
| [ADR-0006](ADR-0006-sqlite-single-store.md) | SQLite 单文件存储 + 文件目录 | Accepted |
| [ADR-0007](ADR-0007-single-image-with-node-and-python.md) | 单镜像内置 Node 与 Python/uv | Accepted |
| [ADR-0008](ADR-0008-append-only-history-and-handoff.md) | 历史只追加，容量以交接处理 | Accepted |
| [ADR-0009](ADR-0009-single-uid-with-process-limits.md) | 插件与守护进程同用一个用户，靠资源上限与工作区约束 | Accepted |
| [ADR-0010](ADR-0010-accounts-and-provider-profiles.md) | 控制台账号与设置码初始化；模型供应商档案 | Accepted |

新增 ADR：复制 `ADR-0000-template.md`（见下），编号递增，提交 PR 时在此表登记。

## 模板

```markdown
# ADR-XXXX：<标题>

状态：Proposed · 日期：YYYY-MM-DD · 相关：<文档链接>

## 背景
## 决策
## 备选方案
## 后果
```
