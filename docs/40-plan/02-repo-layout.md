# 代码仓库结构

> 状态：Draft · 更新：2026-11-04 · 决策：[ADR-0001](../20-decisions/ADR-0001-typescript-node-runtime.md)

pnpm workspace，TypeScript ESM，Node 22。

```
Protea/
├── package.json                 workspace 根：build / typecheck / test / dev / protea
├── pnpm-workspace.yaml          packages/*、plugins/*、apps/*、examples/plugins/*；allowBuilds（better-sqlite3、esbuild）
├── Dockerfile                   镜像（M6）：builder → slim → full（默认）
├── .dockerignore
├── .github/workflows/ci.yml     CI（M6）：类型检查、测试、构建、pnpm audit；构建 full/slim 镜像、容器冒烟测试、Trivy 扫描
├── SECURITY.md                  漏洞报告渠道与响应时限（M6）
├── scripts/
│   ├── bundle-plugin.mjs        把进程外插件打包成单文件 dist/main.js（esbuild）
│   ├── container-smoke.sh       容器冒烟测试（M6）
│   ├── docker-build.sh          本地构建镜像并按版本与提交打标签（pnpm docker:build[:slim|:all]）
│   └── soak.mjs                 长稳测试：模拟来源 + 指标采样 + 增长报告（M6，无依赖）；--rate 0 只采样
├── tsconfig.base.json           各包共享的编译选项
├── tsconfig.json                全仓类型检查（paths 指向各包 src，noEmit）
├── vitest.config.ts             测试入口（alias 指向各包 src）
├── docs/                        设计文档
├── personas/default/            默认人格（SOUL.md、OPERATING.md、USER.md），首次启动复制到 /data/persona；memory/ 是记忆目录模板（INDEX.md）
├── packages/
│   ├── protocol/                @protea/protocol：事件、会话、控制 API、插件清单与协议的类型，事件 JSON Schema，JSON-RPC 对等端（rpc.ts，无运行时依赖）
│   ├── plugin-sdk/              @protea/plugin-sdk：definePlugin / runPlugin，测试用 FakeHost（@protea/plugin-sdk/testing）
│   ├── core/                    @protea/core：内核
│   │   ├── src/
│   │   │   ├── events/          校验（ajv）、门禁、主人映射、事件库、输出记录与对话历史、渲染
│   │   │   ├── scheduler/       批窗口与投递、抢占矩阵（preemption.ts）、风暴防护、老化、预算统计与强制执行（budget.ts）
│   │   │   ├── forks/           Fork 管理器（排队、让渡/恢复、检查点、重启恢复）与 fork_* 工具
│   │   │   ├── session/         主会话循环、转录与修复（含 thinking 截止标记）、启动对账、容量交接（handoff.ts）、回放的数据读取（replay-source.ts）
│   │   │   ├── context/         系统分段、运行时说明、环境提示模板、请求装配、工具搜索（tool-search.ts）、前缀指纹（prefix.ts）
│   │   │   ├── tools/           工具注册表、分发器、内核工具、外发限速（outbound.ts）
│   │   │   ├── providers/       Provider 接口、按角色路由（router.ts）、供应商档案与预设（profiles.ts）、工厂与连接测试（factory.ts）、anthropic、OpenAI Chat / Responses（openai.ts、http.ts）、echo、scripted、价格表、秘密扫描包装（redact.ts）、录制与回放（recorder.ts）
│   │   │   ├── plugins/         PluginHost（生命周期、监督、事件网关）、清单与发现、子进程运行时、一致性检查、开发加载器
│   │   │   ├── permissions/     权限策略、审批、审计、权限守卫、approval_request 工具
│   │   │   ├── mcp/             MCP 客户端管理器（连接、监督、工具命名与注册、资源与 prompts、OAuth）
│   │   │   ├── skills/          SKILL.md 解析、Skills 注册表与目录段、skill_load / skill_read
│   │   │   ├── persona/         人格文件加载与热重载、可选钩子（hooks.*）
│   │   │   ├── memory/          记忆存储（memory 工具命令面）、FTS5 索引、memory / memory_search / memory_recent
│   │   │   ├── config/          默认值、层叠加载、环境变量映射、秘密、旧供应商写法的迁移（legacy.ts）
│   │   │   ├── auth/            控制台账号（scrypt）、会话、设置码（accounts.ts）
│   │   │   ├── db/              SQLite 打开与内嵌迁移（含迁移前快照）、仓储（batches/usage/kv/sessions/tool_stats）
│   │   │   ├── observability/   pino 日志（TTY 美化 + 运行目录 JSON）、内存日志缓冲与查询（logs.ts）、Prometheus 指标（metrics.ts）、关停记录与崩溃报告（run-dir.ts）、追踪日志（trace.ts）
│   │   │   ├── backup.ts        在线备份、Git 备份、恢复（M6）
│   │   │   ├── diagnostics.ts   诊断包：日志、事件库元数据、用量、实时状态（protea diag）
│   │   │   └── util/            时间与时区、id、中止、错误、CIDR（cidr.ts）、子进程环境与资源上限（child-process.ts）
│   │   └── test/                单元、组件、属性测试与测试夹具（含可编排的 MCP 测试服务器与假 OAuth 服务器）
│   └── control/                 @protea/control：Hono HTTP API（app.ts、ops.ts）、鉴权、账号、初始化与会话 cookie（auth.ts）、供应商（providers.ts）、地址白名单（allow.ts）、SSE/WS 共用的总线投影（stream.ts）、WebSocket（ws.ts）、控制台托管（static.ts）
├── plugins/
│   ├── console/                 进程内连接器：控制台输入、con_send 输出、审批请求显示
│   ├── cron/                    进程内来源：日程与 sleep_until
│   ├── telegram/                进程外连接器（protea.plugin.json + src/ + test/，含模拟 Bot API）
│   ├── webhook/                 进程外来源：/hooks/<name>
│   ├── filewatch/               进程外来源：监视 /data/inbox
│   ├── rss/                     进程外来源：RSS / Atom 订阅
│   ├── imap/                    进程外来源：IMAP 邮箱（imapflow + mailparser；测试用假 IMAP 服务器）
│   └── shell/                   进程外工具：sh_run（工作区、超时、输出截断、环境白名单；默认不启用，M6）
├── skills/                      内置 Skills（protea-self-ops、daily-brief、memory-hygiene）
├── apps/
│   ├── daemon/                  组装 Core + 控制平面 + 内置插件；单实例锁；离线回放（replay.ts）；端到端与安全检查清单测试
│   ├── cli/                     `protea` 命令（serve 直接启动守护进程；dev-plugin 本地运行插件；logq、migrate、healthcheck、backup、restore、replay 直接用数据目录（admin.ts）；其余经 HTTP API / SSE / WebSocket）
│   └── web/                     @protea/web：网页（Vite + React；App.tsx 登录与路由，pages/Chat.tsx 是对话窗口（#/），Console.tsx 是控制台外壳（#/console/…），pages/ 其余每页一个文件，components/ 通用组件、图标与 JSON Schema 表单，live.ts 是唯一的 WebSocket 连接）
├── sdks/python/protea_plugin/   Python 插件 SDK（宿主放进 Python 插件的 PYTHONPATH）
├── examples/plugins/            py-notes（Python）、ts-notes（TypeScript）示例插件与一致性探针
└── docker/
    ├── entrypoint.sh            容器入口：准备 /data、降权、迁移、exec 守护进程（M6）
    ├── docker-compose.yml       示例部署，tls 档带 Caddy（M6）
    ├── Caddyfile
    └── observability/           Prometheus 抓取配置与 Grafana 示例面板（M5）
```

## 包依赖方向

`protocol` ← `core` ← {`control`, 进程内插件} ← `daemon` ← `cli`；`core` 不依赖 `control`、`daemon` 或任何插件。进程外插件（内置的与第三方的）只依赖 `plugin-sdk` 与 `protocol`，并打包成单文件；`web` 只依赖 `protocol` 的类型。

## 构建与运行

- 开发：`pnpm dev`（`node --conditions=source --import tsx`，直接运行各包源码，无需构建；开发模式下内置插件也跑源码；数据目录 `.dev-data`）；`pnpm protea <命令>` 调用 CLI。各包 `exports` 带 `source` 条件指向 `src/index.ts`。
- 测试：`pnpm test`（不需要先构建）；类型检查：`pnpm typecheck`。
- 构建：`pnpm build` 按依赖拓扑顺序构建每个包：库用 `tsc` 输出到 `dist/`，进程外插件用 `scripts/bundle-plugin.mjs` 打包成 `dist/main.js`，控制台用 Vite 输出到 `apps/web/dist/`；`node apps/cli/dist/main.js serve` 即可运行。
- 控制台开发：`pnpm web`（Vite 开发服务器，把 `/api`、`/ws`、`/metrics` 转给 `PROTEA_URL`）；类型检查 `pnpm typecheck` 同时检查 `apps/web`（它有自己的 tsconfig：DOM、JSX、bundler 解析）。
- 插件开发：`pnpm protea dev-plugin <dir>`（交互）/ `--check`（一致性检查）。
- 镜像：`pnpm docker:build`（`scripts/docker-build.sh`，打 `latest`、版本与提交标签；`:slim`、`:all` 构建 slim 或两者），或直接 `docker build -t protea .`（`--target slim` 为只含 Node 的变体）；`scripts/container-smoke.sh protea` 跑容器冒烟测试（[../10-architecture/16-deployment.md](../10-architecture/16-deployment.md)）。

## 命名

- 包：`@protea/<name>`；内置插件 `@protea/plugin-<id>`。
- 事件类型、工具名、配置键：见各规范。
- 文件：kebab-case；类型 PascalCase；常量 UPPER_SNAKE。
