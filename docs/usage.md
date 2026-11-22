# Protea 使用指南

先启动实例、创建管理员并连接模型。下文以 Docker Compose 为例，从仓库根目录运行命令。用 `docker run` 启动时，可用 `docker exec protea protea` 执行 CLI 子命令，交互输入用 `docker exec -it protea protea`，复制文件用 `docker cp`。本地开发时，使用 `PROTEA_DATA_DIR=.dev-data pnpm protea`。 [快速开始](../README.md#快速开始)

## 接入聊天平台

网页版对话随服务启动。你可以在控制台的「插件」页管理 Telegram、微信和 QQ。在相应聊天平台收到工具调用的审批请求时，可回复 `/approve <id>` 或 `/deny <id>`。助理提出的 MCP、Skill 或插件变更需要在「审批 → 能力变更」中审核。 [对话与控制台](10-architecture/17-chat-and-console.md) · [能力变更审批](20-decisions/ADR-0019-capability-change-requests.md)

### Telegram

用 `@BotFather` 创建机器人，把令牌写入秘密库。CLI 会提示从标准输入读取。

```bash
docker compose -f docker/docker-compose.yml exec protea protea secrets set TELEGRAM_BOT_TOKEN
```

在 `config.yaml` 的 `owner.identities` 中合并下面的条目，将 `123456789` 换成自己的 Telegram 用户 ID。如果没有 ID，可以启用插件后私聊机器人，再从控制台的事件详情查看该消息的 `senderKey`。

```yaml
owner:
  identities:
    - plugin: telegram
      senderKey: "telegram:123456789"
```

```bash
docker compose -f docker/docker-compose.yml exec protea protea plugins enable telegram
```

### 微信和 QQ

在控制台的「插件」页启用 `wechat` 或 `qq`，点对应插件的「登录」并扫码。凭据保存在秘密库，扫码者会登记为该渠道的所有者。

终端也可以扫码登录。以下以微信为例，接入 QQ 时用 `qq` 替换 `wechat`。

```bash
docker compose -f docker/docker-compose.yml exec protea protea plugins enable wechat
docker compose -f docker/docker-compose.yml exec protea protea plugins login wechat
```

QQ 可接入已有机器人。将 App ID 配置为 `plugins.qq.config.appId`，把 AppSecret 存为秘密 `QQ_APP_SECRET`。需要在群聊接收提及机器人的消息时，将插件配置的 `groups` 设为 `true`。群聊回复默认需要审批。

微信 iLink 和 QQ 的消息发送受平台回复窗口约束。要定时主动发送重要提醒，可选择网页或 Telegram。 [微信与 QQ 平台说明](10-architecture/08-event-source-plugins.md#63-微信)

## 滴答清单

滴答清单是可选插件。从仓库根目录安装依赖并打包，再复制到运行中的容器。

```bash
pnpm install --frozen-lockfile
node scripts/pack-plugin.mjs optional-plugins/dida365
docker compose -f docker/docker-compose.yml cp dist/plugins/dida365 protea:/tmp/dida365
docker compose -f docker/docker-compose.yml exec protea protea plugins install /tmp/dida365 --disabled
```

在滴答清单的「设置 → 账户 → API Token」创建个人令牌，然后保存凭据并启用插件。

```bash
docker compose -f docker/docker-compose.yml exec protea protea secrets set DIDA365_TOKEN
docker compose -f docker/docker-compose.yml exec protea protea plugins enable dida365
```

你可以在控制台配置时区、到期提醒和工具组。TickTick 国际版的 `apiBase` 为 `https://api.ticktick.com`。部署升级时，可重新打包并安装插件。卸载时使用 `--keep-data` 可保留插件数据，重新安装后需要恢复插件配置。 [提醒与工具](10-architecture/08-event-source-plugins.md#65-滴答清单) · [可选插件的安装与升级](20-decisions/ADR-0025-optional-plugins.md)

## 添加 MCP 和 Skills

在控制台的「MCP」页配置本地或远程服务器。CLI 中，本地服务器通过 stdio 启动，`--` 后填写启动命令。下面的示例需要包含 `uvx` 的 full 镜像。

```bash
docker compose -f docker/docker-compose.yml exec protea protea mcp add fetch -- uvx mcp-server-fetch
```

远程服务器通过 `protea mcp add <id> --http <url>` 添加。需要授权时，可选择 `--oauth` 或用 `--bearer <秘密名>` 引用已保存的凭据。用 `protea mcp tools <id>` 查看工具。 [MCP 传输、鉴权与权限](10-architecture/09-mcp-integration.md)

Skill 是包含 `SKILL.md` 的目录。可在控制台管理 Skills，或用 `protea skills install <目录>` 安装，再用 `protea skills` 检查注册状态。 [Skill 格式](30-specs/07-skill-format.md) · [插件示例](../examples/plugins)

## 日常运维

```bash
docker compose -f docker/docker-compose.yml exec protea protea status
docker compose -f docker/docker-compose.yml exec protea protea backup --archive
docker compose -f docker/docker-compose.yml exec protea protea diag
```

- **模型和费用**。在控制台的「模型」页测试连接、按角色切换模型，以及配置语音转写和模型价格。 [模型供应商](10-architecture/12-model-providers.md)
- **记忆和个性**。在控制台的「记忆」页编辑 Markdown 记忆、查看历史版本，或调整人格文件。 [记忆与人格](10-architecture/11-memory-and-persona.md)
- **排查问题**。控制台的「日志」页可以导出诊断包。CLI 会打印诊断包在容器内的路径，用 `docker compose cp` 可复制到本机。公开分享前请检查凭据、对话内容及个人信息。 [诊断指南](40-plan/06-real-world-testing.md#3-日志在哪里怎么查)
- **远程访问和备份**。通过 SSH 隧道或 TLS 反向代理访问控制台，按部署文档配置持久卷与备份。 [部署文档](10-architecture/16-deployment.md)
