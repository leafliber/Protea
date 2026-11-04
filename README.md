# Protea

Protea 是一个 **24/7 常驻、事件流驱动、可热插拔** 的云端个人助理 harness：

- 一切输入皆为事件：聊天消息、定时器、Webhook、邮件、RSS、文件变化……由 **事件源插件** 产生，带有 **处理等级**，高等级事件可 **抢占** 正在进行的模型回合。
- 一个常驻的主会话负责"感知—思考—行动"，可派生后台 Fork 会话处理长任务。
- 能力通过 **MCP 服务器** 与 **Skills（SKILL.md）** 扩展，均支持运行时热插拔。
- **单镜像 Docker 部署**，所有状态落在一个 `/data` 卷里。

设计参考了 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 的事件流 harness 思想，完整设计见 [docs/README.md](docs/README.md)，进度见 [路线图](docs/40-plan/01-roadmap.md)。

## 当前状态：M6 单镜像与加固（v1.0 候选）

已可运行：
- **M0**：事件库与门禁、批窗口调度、主会话代理循环（Claude，流式 + 自适应思考 + 提示缓存）、append-only 转录与崩溃恢复、console 与 cron 两个内置插件、HTTP 控制 API（含 SSE 实时流）与 CLI。
- **M1**：抢占矩阵（`preempt` 取消模型调用并合并重发，`interrupt` 停止回合并保留部分回执）、抢占风暴冷却、老化、按等级的预算统计、后台 Fork（主人对话时自动让路，可在重启后续跑）。
- **M2**：进程外插件（JSON-RPC over stdio）的发现、监督与热插拔（安装/启用/禁用/重载/卸载，配置热更新）；TypeScript 与 Python 插件 SDK；内置 `telegram`、`webhook`、`filewatch`；工具权限策略、经 Telegram 或终端的审批流与审计。
- **M3**：MCP 客户端（stdio、Streamable HTTP、SSE；bearer 与 OAuth；运行中增删，工具名 `mcp__<服务器>__<工具>`）；工具很多时启用 Claude 的工具搜索，MCP 工具按需加载；Skills 注册表（`SKILL.md`，热加载、`skill_load`）与 3 个内置 Skills；内置来源 `rss`、`imap`。

- **M4**：记忆目录 `/data/memory`（`memory` 工具，命令面同 Claude 的 memory tool；全文检索 `memory_search`，中文可搜；`INDEX.md` 进系统前缀）；对话变长时自动交接（cheap 模型写交接笔记，新对话带着最近的消息继续）；人格文件与可选钩子热加载；所有发往模型的请求做秘密扫描。
- **M5**：Web 控制台（总览、事件流、会话、插件、MCP、Skills、审批、记忆与人格、配置、日志），不用 SSH 就能做 M0–M4 的所有操作；完整的控制 API 与 WebSocket；只读令牌；Prometheus 指标与 Grafana 示例面板；运行目录里的关停记录与崩溃报告；`protea logq` 等全套 CLI。
- **M6**：Docker 镜像（full 含 Python/uv，slim 只有 Node），非 root 运行、启动前自动迁移并快照数据库、健康检查；预算强制执行与全局硬上限（控制台可临时放行）；外发限速；内置 `shell` 工具（工作区、超时、输出截断、无秘密环境）；插件与 MCP 进程的内存与文件描述符上限；日志的秘密过滤；控制平面地址白名单；在线备份、恢复与 Git 备份；模型调用录制与离线回放；CI（测试、依赖审计、镜像构建、容器冒烟测试、Trivy）。

## 用 Docker 运行

镜像还没有发布，先在仓库里构建（`protea:latest` 是 full；`pnpm docker:build:slim` 构建只含 Node 的 `protea:slim`）：

```bash
pnpm docker:build
```

```bash
docker run -d --name protea -v protea-data:/data -p 127.0.0.1:7788:7788 --stop-timeout 40 --restart unless-stopped protea:latest
```

API key 存成秘密（从标准输入读取），然后重启一次让 Provider 读到它：

```bash
docker exec -i protea protea secrets set ANTHROPIC_API_KEY
```

```bash
docker restart protea
```

控制台在 http://127.0.0.1:7788/ ，管理员令牌：

```bash
docker exec protea cat /data/secrets/PROTEA_ADMIN_TOKEN
```

容器里的 CLI 直接可用，例如 `docker exec protea protea status`、`docker exec protea protea backup --archive`。出问题时导出诊断包（日志、事件元数据、用量与缓存命中率、实时状态；不含秘密与对话内容）：`docker exec protea protea diag`，再 `docker cp protea:/data/exports/<名字> .`，或在控制台"日志 → 导出诊断包"下载。需要真实条件的测试项见 [docs/40-plan/06-real-world-testing.md](docs/40-plan/06-real-world-testing.md)。带 Caddy 自动证书的 compose 示例、备份与恢复、升级与回滚见 [docs/10-architecture/16-deployment.md](docs/10-architecture/16-deployment.md)。

## 本地开发运行

需要 Node.js ≥ 22.12 与 pnpm。

```bash
pnpm install
```

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm dev
```

没有 API key 时可以用离线的 echo Provider 体验整条链路：

```bash
PROTEA_PROVIDERS__DEFAULT=echo pnpm dev
```

另开一个终端与助理对话、观察事件流：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea events push "明天早上 8 点提醒我带伞"
```

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea events tail
```

让主人的消息打断正在进行的回合（`interrupt`），或查看后台 Fork：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea events push "停下，先回答我" --trigger interrupt
```

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea forks
```

## 控制台

守护进程在同一端口托管 Web 控制台。先构建一次：

```bash
pnpm build
```

然后打开 http://127.0.0.1:7788/ ，用管理员令牌登录（在 `.dev-data/secrets/PROTEA_ADMIN_TOKEN`）。改控制台代码时用 Vite 开发服务器，它把 API 转给正在运行的守护进程：

```bash
pnpm web
```

不在本机访问时请放在 TLS 反向代理后面；控制台在明文 HTTP 的非本机地址上会一直显示提示。只给监控面板看的话，把一个值存为秘密 `PROTEA_READONLY_TOKEN`，它只能读。Prometheus 抓取 `/metrics`（需要令牌），示例配置与 Grafana 面板在 [docker/observability/](docker/observability/)。

常用的运维命令也都有 CLI：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea config set budget.dailyUsd 5
```

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea scheduler pause
```

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea logq --level warn --since 1h
```

预算用尽后，L2 事件只随别的批顺带送达，L3/L4 事件只入库；`budget.hardDailyUsd` 是 24 小时的总上限，到了之后只处理你的消息（L0/L1）。临时放行：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea budget release --hours 4
```

## 接入 Telegram

1. 用 @BotFather 创建机器人，把令牌存成秘密（文件权限 0600）：

```bash
mkdir -p .dev-data/secrets && printf '%s\n' '<bot token>' > .dev-data/secrets/TELEGRAM_BOT_TOKEN && chmod 600 .dev-data/secrets/TELEGRAM_BOT_TOKEN
```

2. 在 `.dev-data/config.yaml` 的 `owner.identities` 里加上你的 Telegram 用户 id（`telegram:<id>`），然后启用插件（不需要重启守护进程）：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea plugins enable telegram
```

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea plugins
```

需要审批的操作（例如 `tg_send_chat` 发到群里）会在 Telegram 里问你，回复 `/approve a1` 即可；也可以在终端运行 `protea approvals approve a1`。

## 接入 MCP 服务器

运行中添加，下一回合模型就能调用；`--` 之后是启动命令：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea mcp add fetch -- uvx mcp-server-fetch
```

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea mcp add files --trust low -- npx -y @modelcontextprotocol/server-filesystem /path/to/folder
```

远程服务器用 `--http <url>`，需要登录的加 `--oauth`（`protea mcp auth <id>` 打印授权链接）或 `--bearer <秘密名>`。`protea mcp ls`、`protea mcp tools <id>` 查看状态与工具，`protea mcp rm <id>` 移除。添加的服务器写进 `config.yaml` 的 `mcp.servers`，直接改文件也会立即生效。

`trust` 决定没有 `readOnlyHint` 的工具的默认策略：`low` 一律要审批，`normal`（默认）只有标了 `destructiveHint` 的要审批，`high` 不额外限制。

## Skills

Skill 是一个带 `SKILL.md` 的目录（Agent Skills 格式）。拷进 `.dev-data/skills/` 下一回合就出现在模型的目录里，模型用 `skill_load` 读取正文：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea skills
```

格式有问题的 Skill 不会注册，`protea skills` 会显示原因。MCP 服务器提供的 prompts 也会以 `mcp:<服务器>/<名字>` 出现在目录里。

## 记忆与人格

助理的记忆是 `.dev-data/memory/` 下的 Markdown 文件，模型用 `memory` 工具读写（路径写作 `/memories/...`），`INDEX.md` 每次请求都会带上，所以只放"去哪找"的指针。你也可以直接编辑这些文件，索引会跟上。

人格在 `.dev-data/persona/`：`SOUL.md`（是谁）、`OPERATING.md`（怎么做事）、`USER.md`（关于你）。改完从下一次模型请求生效。需要代码时可以加 `persona/hooks.mjs`（例如自定义交接），见 [docs/10-architecture/11-memory-and-persona.md](docs/10-architecture/11-memory-and-persona.md) §6。

对话超过 `context.handoff.softTokens`（默认 200k token）时会交接：较早的部分写成 `memory/handoff/` 下的笔记，新对话带着最近的消息继续。也可以在控制台的"会话"页手动触发，或者：

```bash
PROTEA_DATA_DIR=.dev-data pnpm protea sessions handoff
```

记忆与人格文件都能在控制台的"记忆与人格"页浏览和编辑。

## 写一个插件

参照 `examples/plugins/ts-notes`（TypeScript）或 `examples/plugins/py-notes`（Python），然后在本地运行与检查：

```bash
pnpm protea dev-plugin examples/plugins/py-notes --check
```

```bash
pnpm protea dev-plugin examples/plugins/ts-notes
```

## 开发

```bash
pnpm test
```

```bash
scripts/container-smoke.sh protea
```

```bash
pnpm typecheck
```

```bash
pnpm build
```
