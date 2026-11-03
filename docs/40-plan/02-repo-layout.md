# 代码仓库结构

> 状态：Draft · 更新：2026-11-03 · 决策：[ADR-0001](../20-decisions/ADR-0001-typescript-node-runtime.md)

pnpm workspace，TypeScript ESM，Node 22。

```
Protea/
├── package.json                 workspace 根：build / typecheck / test / dev / protea
├── pnpm-workspace.yaml          含 allowBuilds（better-sqlite3、esbuild 的安装脚本）
├── tsconfig.base.json           各包共享的编译选项
├── tsconfig.json                全仓类型检查（paths 指向各包 src，noEmit）
├── vitest.config.ts             测试入口（alias 指向各包 src）
├── docs/                        设计文档
├── personas/default/            默认人格（SOUL.md、OPERATING.md、USER.md），首次启动复制到 /data/persona
├── packages/
│   ├── protocol/                @protea/protocol：事件、会话、控制 API 的类型与事件 JSON Schema（无运行时依赖）
│   ├── core/                    @protea/core：内核
│   │   ├── src/
│   │   │   ├── events/          校验（ajv）、门禁、主人映射、事件库、渲染
│   │   │   ├── scheduler/       批窗口与投递、抢占矩阵（preemption.ts）、风暴防护、老化、预算统计（budget.ts）
│   │   │   ├── forks/           Fork 管理器（排队、让渡/恢复、检查点、重启恢复）与 fork_* 工具
│   │   │   ├── session/         主会话循环、转录与修复、启动对账
│   │   │   ├── context/         系统分段、运行时说明、环境提示模板、请求装配
│   │   │   ├── tools/           工具注册表、分发器、内核工具
│   │   │   ├── providers/       Provider 接口、anthropic、echo、scripted、价格表
│   │   │   ├── plugins/         进程内插件宿主（M2 增加进程外监督与协议）
│   │   │   ├── persona/         人格文件加载
│   │   │   ├── config/          默认值、层叠加载、环境变量映射、秘密
│   │   │   ├── db/              SQLite 打开与内嵌迁移、仓储（batches/usage/kv/sessions）
│   │   │   ├── observability/   pino 日志（TTY 美化 + 运行目录 JSON）
│   │   │   └── util/            时间与时区、id、中止、错误
│   │   └── test/                单元、组件、属性测试与测试夹具
│   └── control/                 @protea/control：Hono HTTP API 与 SSE
├── plugins/
│   ├── console/                 进程内连接器：控制台输入、con_send 输出
│   └── cron/                    进程内来源：日程与 sleep_until
├── apps/
│   ├── daemon/                  组装 Core + 控制平面 + 内置插件；单实例锁；崩溃端到端测试
│   └── cli/                     `protea` 命令（serve 直接启动守护进程，其余经 HTTP API）
└── (计划) packages/plugin-sdk, packages/plugin-sdk-py, apps/web, docker/, examples/, tests/e2e
```

## 包依赖方向

`protocol` ← `core` ← {`control`, 内置插件} ← `daemon` ← `cli`；`core` 不依赖 `control`、`daemon` 或任何插件。M2 起第三方插件只依赖 `plugin-sdk` 与 `protocol`；`web` 只依赖 `protocol` 的类型。

## 构建与运行

- 开发：`pnpm dev`（tsx 直接运行源码，数据目录 `.dev-data`）；`pnpm protea <命令>` 调用 CLI。
- 测试：`pnpm test`；类型检查：`pnpm typecheck`。
- 构建：`pnpm build` 按依赖拓扑顺序对每个包运行 `tsc`，产物在各包 `dist/`，`node apps/cli/dist/main.js serve` 即可运行。

## 命名

- 包：`@protea/<name>`；内置插件 `@protea/plugin-<id>`。
- 事件类型、工具名、配置键：见各规范。
- 文件：kebab-case；类型 PascalCase；常量 UPPER_SNAKE。
