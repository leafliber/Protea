# Protea

Protea 是一个 **24/7 常驻、事件流驱动、可热插拔** 的云端个人助理 harness：

- 一切输入皆为事件：聊天消息、定时器、Webhook、邮件、RSS、文件变化……由 **事件源插件** 产生，带有 **处理等级**，高等级事件可 **抢占** 正在进行的模型回合。
- 一个常驻的主会话负责"感知—思考—行动"，可派生后台 Fork 会话处理长任务。
- 能力通过 **MCP 服务器** 与 **Skills（SKILL.md）** 扩展，均支持运行时热插拔。
- **单镜像 Docker 部署**，所有状态落在一个 `/data` 卷里。

设计参考了 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 的事件流 harness 思想，完整设计见 [docs/README.md](docs/README.md)，进度见 [路线图](docs/40-plan/01-roadmap.md)。

## 当前状态：M0 内核骨架

已可运行：事件库与门禁、批窗口调度、主会话代理循环（Claude，流式 + 自适应思考 + 提示缓存）、append-only 转录与崩溃恢复、console 与 cron 两个内置插件、HTTP 控制 API（含 SSE 实时流）与 CLI。抢占、插件热插拔、MCP、Skills、记忆、控制台与 Docker 镜像按路线图在 M1–M6 实现。

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
