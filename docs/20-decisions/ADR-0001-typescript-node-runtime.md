# ADR-0001：语言与运行时选择 TypeScript + Node.js 22

状态：Accepted · 日期：2026-11-03 · 相关：[../40-plan/02-repo-layout.md](../40-plan/02-repo-layout.md)

## 背景

需要选择内核语言。候选：TypeScript（Node 22）、Python（3.12 asyncio）、Go。考量点：MCP 与 Anthropic SDK 的成熟度、异步 I/O、插件生态、与参考实现 Cortico 的对齐、单镜像体积、热重载能力。

## 决策

内核、内置插件、插件 SDK、控制台、CLI 全部使用 **TypeScript**，运行于 **Node.js 22**（ESM），包管理 **pnpm workspace**。插件协议语言无关，并提供 Python 版薄 SDK。

理由：

1. MCP 官方参考实现与 TypeScript SDK 最完整；Anthropic TypeScript SDK 一等支持流式、工具运行器、beta 特性。
2. Cortico 是 TypeScript，概念与类型可直接对照，降低参考成本。
3. 事件流/流式输出/子进程监督是 Node 的强项；单线程事件循环简化了"主会话串行"的不变量。
4. 控制台（React）与守护进程同语言，类型可共享。
5. 镜像：`node:22-bookworm-slim` 基础小；Python 作为运行社区 MCP 服务器的附加运行时装入。

## 备选方案

- **Python**：生态广（IMAP、科学计算），Anthropic/MCP SDK 也完善；但 asyncio 子进程与流式处理的工程体验稍弱，控制台需另选技术栈。保留为插件语言。
- **Go**：单二进制、资源占用低；但 Anthropic/MCP SDK 成熟度与社区插件生态不及前两者，热重载需自建。

## 后果

- 需要 Node 22.12+；镜像含 Node。M0 在 Node 26、TypeScript 7、`@anthropic-ai/sdk` 1.3 上实现并测试。
- 进程内插件只能是 TS/JS；其他语言一律进程外（这与 ADR-0005 一致）。
- 团队需遵守 ESM、严格 TS 配置（`strict`, `noUncheckedIndexedAccess`）。
