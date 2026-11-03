# Protea

Protea 是一个 **24/7 常驻、事件流驱动、可热插拔** 的云端个人助理 harness：

- 一切输入皆为事件：聊天消息、定时器、Webhook、邮件、RSS、文件变化……由 **事件源插件** 产生，带有 **处理等级**，高等级事件可 **抢占** 正在进行的模型回合。
- 一个常驻的主会话负责"感知—思考—行动"，可派生后台 Fork 会话处理长任务。
- 能力通过 **MCP 服务器** 与 **Skills（SKILL.md）** 扩展，均支持运行时热插拔。
- **单镜像 Docker 部署**，所有状态落在一个 `/data` 卷里。

设计参考了 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 的事件流 harness 思想，完整设计见 [docs/README.md](docs/README.md)，进度见 [路线图](docs/40-plan/01-roadmap.md)。

## 当前状态：M2 插件系统与热插拔

已可运行：
- **M0**：事件库与门禁、批窗口调度、主会话代理循环（Claude，流式 + 自适应思考 + 提示缓存）、append-only 转录与崩溃恢复、console 与 cron 两个内置插件、HTTP 控制 API（含 SSE 实时流）与 CLI。
- **M1**：抢占矩阵（`preempt` 取消模型调用并合并重发，`interrupt` 停止回合并保留部分回执）、抢占风暴冷却、老化、按等级的预算统计、后台 Fork（主人对话时自动让路，可在重启后续跑）。
- **M2**：进程外插件（JSON-RPC over stdio）的发现、监督与热插拔（安装/启用/禁用/重载/卸载，配置热更新）；TypeScript 与 Python 插件 SDK；内置 `telegram`、`webhook`、`filewatch`；工具权限策略、经 Telegram 或终端的审批流与审计。

MCP、Skills、记忆、控制台与 Docker 镜像按路线图在 M3–M6 实现。

## 快速开始

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
pnpm typecheck
```

```bash
pnpm build
```
