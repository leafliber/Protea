# Protea

[![CI](https://github.com/leafliber/Protea/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/leafliber/Protea/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

Protea 基于 Cortico 项目的事件流设计开发，是一个可以自行部署、持续运行的个人 AI 助理。 [Cortico 项目](https://github.com/Pal-AI-Lab/Cortico) · [设计说明](docs/00-overview/04-reference-cortico.md)

聊天、定时任务、邮件、RSS 和 Webhook 都进入同一条事件流。助理按优先级处理事件，可以把耗时工作交给后台会话，让主会话继续响应新的消息。

## 主要功能

- **多渠道对话**。在网页、Telegram、微信或 QQ 与助理交流。网页支持图片和语音输入，语音转写服务可在控制台配置。
- **主动跟进**。用定时任务或接入的事件源触发工作。会话和事件保存在本地，守护进程重启后可以继续处理待办事件。
- **自选模型**。连接 Anthropic、OpenAI、Ollama 或兼容服务，按需为主会话、后台会话和轻量任务选择不同模型。
- **持久记忆与扩展**。记忆以 Markdown 保存，可在控制台编辑。支持运行中添加插件、MCP 服务器和 Skills，并通过权限策略审批工具调用及助理提出的能力变更。
- **集中管理**。在 Web 控制台查看定时任务、审批、日志、模型用量和费用估算，也可以通过 CLI 运维和备份。

## 快速开始

安装 Docker 后即可运行已发布的镜像。镜像支持 `linux/amd64` 和 `linux/arm64`。 [GitHub Packages](https://github.com/leafliber/Protea/pkgs/container/protea)

```bash
docker run -d --name protea \
  -v protea-data:/data \
  -p 127.0.0.1:7788:7788 \
  --stop-timeout 40 \
  --restart unless-stopped \
  ghcr.io/leafliber/protea:0.1.0
docker logs protea
```

1. 打开 [http://127.0.0.1:7788/](http://127.0.0.1:7788/)，用日志里的**一次性设置码**创建管理员账号。
2. 在向导中选择模型供应商，填写模型、服务地址和所需凭据，测试连接后保存。
3. 在对话窗口发一条消息。右上角的「控制台」可以管理模型、事件、插件和定时任务。

应用数据持久化在 Docker 卷中。部署文档涵盖 Compose、TLS、沙箱、内置浏览器、升级和备份。 [部署文档](docs/10-architecture/16-deployment.md)

## 本地开发

准备好 Node.js 22.13 或更高版本，并使用 `package.json` 指定的 pnpm 11.3.0。需要安装 pnpm 时可运行 `npm install -g pnpm@11.3.0`。然后在仓库根目录执行以下命令。

```bash
git clone https://github.com/leafliber/Protea.git
cd Protea
pnpm install --frozen-lockfile
pnpm --filter @protea/web... build
PROTEA_CONTROL__LISTEN=127.0.0.1:7788 pnpm dev
```

首次启动时，终端会打印设置码。仍然访问 [http://127.0.0.1:7788/](http://127.0.0.1:7788/) 完成设置。要在无 API Key 的环境验证消息链路，可用下面的命令替代最后一步。Echo 供应商会回显消息。

```bash
PROTEA_CONTROL__LISTEN=127.0.0.1:7788 PROTEA_PROVIDERS__DEFAULT=echo pnpm dev
```

开发数据存放在 `.dev-data/`。启动命令、检查和提交流程见 [贡献指南](CONTRIBUTING.md)。

## 文档与社区

| 想做什么 | 从这里开始 |
| --- | --- |
| 接入聊天平台、滴答清单、MCP 或 Skills | [使用指南](docs/usage.md) |
| 部署、配置和备份 | [部署文档](docs/10-architecture/16-deployment.md) · [配置参考](docs/30-specs/04-config-reference.md) |
| 了解架构与路线图 | [文档索引](docs/README.md) · [路线图](docs/40-plan/01-roadmap.md) |
| 求助、报告故障或提出建议 | [获取帮助](SUPPORT.md) · [GitHub Issues](https://github.com/leafliber/Protea/issues) |
| 贡献代码或文档 | [贡献指南](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) |
| 私密报告漏洞 | [安全政策](SECURITY.md) |

维护者与贡献者见 GitHub。 [@leafliber](https://github.com/leafliber) · [贡献者](https://github.com/leafliber/Protea/graphs/contributors)

## 许可证

Protea 项目代码按 GNU Affero General Public License v3.0（`AGPL-3.0-only`）发布。 [许可正文](LICENSE)

第三方组件适用各自的许可证。 [QQ 插件第三方声明](plugins/qq/THIRD_PARTY_NOTICES.md) · [微信插件第三方声明](plugins/wechat/THIRD_PARTY_NOTICES.md)
