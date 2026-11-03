# Protea 设计文档

> 状态：Draft v0.5（M0–M4 已实现，相关文档已与代码同步）· 更新：2026-11-03 · 语言：中文（代码标识符与文件名为英文）

本目录是 Protea 的完整设计与实施计划。文档按"从愿景到落地"的顺序编号，建议首次阅读按下面的顺序。

## 阅读路线

| 想了解 | 从这里开始 |
|---|---|
| 这是什么、不是什么 | [00-overview/01-vision-and-scope.md](00-overview/01-vision-and-scope.md) |
| 关键术语 | [00-overview/02-glossary.md](00-overview/02-glossary.md) |
| 我们坚持的原则 | [00-overview/03-design-principles.md](00-overview/03-design-principles.md) |
| 与 Cortico 的关系 | [00-overview/04-reference-cortico.md](00-overview/04-reference-cortico.md) |
| 整体架构一张图 | [10-architecture/01-system-overview.md](10-architecture/01-system-overview.md) |
| 事件怎么流动、怎么抢占 | [10-architecture/02-event-model.md](10-architecture/02-event-model.md) → [04-scheduling-and-preemption.md](10-architecture/04-scheduling-and-preemption.md) |
| 怎么写一个插件 / 接 MCP / 加 Skill | [07-plugin-system.md](10-architecture/07-plugin-system.md) · [09-mcp-integration.md](10-architecture/09-mcp-integration.md) · [10-skills.md](10-architecture/10-skills.md) |
| 怎么部署 | [16-deployment.md](10-architecture/16-deployment.md) |
| 为什么这样决定 | [20-decisions/README.md](20-decisions/README.md) |
| 接口与格式的精确定义 | [30-specs/](30-specs/) |
| 做到哪一步、下一步做什么 | [40-plan/01-roadmap.md](40-plan/01-roadmap.md) |

## 目录结构

```
docs/
├── README.md                          本文件：导航与约定
├── 00-overview/                       愿景、术语、原则、参考
│   ├── 01-vision-and-scope.md
│   ├── 02-glossary.md
│   ├── 03-design-principles.md
│   └── 04-reference-cortico.md
├── 10-architecture/                   架构设计（每个子系统一篇）
│   ├── 01-system-overview.md          总体架构、组件、进程模型、数据流
│   ├── 02-event-model.md              事件信封、起源、等级、投递模式
│   ├── 03-event-store-and-bus.md      事件存储、游标、回放、投影
│   ├── 04-scheduling-and-preemption.md 处理等级、批处理、抢占、饥饿防护、预算
│   ├── 05-sessions-and-agent-loop.md  主会话、Fork、回合、工具循环、交接
│   ├── 06-context-assembly.md         上下文装配与缓存稳定性
│   ├── 07-plugin-system.md            插件种类、清单、生命周期、隔离、热插拔
│   ├── 08-event-source-plugins.md     事件源/连接器契约与内置清单
│   ├── 09-mcp-integration.md          MCP 客户端管理与对外暴露
│   ├── 10-skills.md                   Skills 格式、渐进披露、热加载
│   ├── 11-memory-and-persona.md       记忆布局、记忆工具、人格
│   ├── 12-model-providers.md          模型提供方抽象与 Anthropic 实现
│   ├── 13-control-plane.md            HTTP API、WebSocket、CLI、控制台
│   ├── 14-security-and-permissions.md 身份、权限策略、审批、秘密、沙箱
│   ├── 15-observability.md            日志、指标、追踪、运行目录
│   └── 16-deployment.md               单镜像、卷、启动顺序、升级、备份
├── 20-decisions/                      架构决策记录（ADR）
│   ├── README.md                      ADR 索引与模板
│   ├── ADR-0001-typescript-node-runtime.md
│   ├── ADR-0002-event-log-as-source-of-truth.md
│   ├── ADR-0003-own-agent-loop-over-agent-sdk.md
│   ├── ADR-0004-priority-levels-and-delivery-modes.md
│   ├── ADR-0005-plugin-isolation-out-of-process.md
│   ├── ADR-0006-sqlite-single-store.md
│   ├── ADR-0007-single-image-with-node-and-python.md
│   └── ADR-0008-append-only-history-and-handoff.md
├── 30-specs/                          精确规范（Schema、协议、配置、API）
│   ├── 01-event-envelope-schema.md
│   ├── 02-plugin-manifest.md
│   ├── 03-plugin-protocol.md
│   ├── 04-config-reference.md
│   ├── 05-control-api.md
│   ├── 06-storage-schema.md
│   └── 07-skill-format.md
└── 40-plan/                           实施计划
    ├── 01-roadmap.md                  里程碑与验收标准
    ├── 02-repo-layout.md              代码仓库结构
    ├── 03-testing-strategy.md
    ├── 04-risks-and-open-questions.md
    └── 05-conventions.md              开发与文档规范
```

## 文档约定

- **状态标记**：每篇文档开头标注 `状态：Draft | Review | Accepted | Superseded`。架构文档在对应里程碑实现后转为 Accepted。
- **规范性用语**：`必须 / 禁止 / 应当 / 可以` 分别对应 RFC 2119 的 MUST / MUST NOT / SHOULD / MAY。
- **术语**：首次出现的术语链接到 [术语表](00-overview/02-glossary.md)；中文术语后括注英文标识符，代码中一律使用英文标识符。
- **决策**：任何改变架构文档中"必须/禁止"条款的变更，先写 ADR，再改文档。
- **示例**：规范文档中的 JSON / YAML / TypeScript 示例是规范的一部分，与正文冲突时以正文为准并提 issue。
