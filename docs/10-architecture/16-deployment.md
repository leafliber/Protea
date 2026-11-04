# 部署

> 状态：Draft · 更新：2026-11-03 · 决策：[ADR-0007](../20-decisions/ADR-0007-single-image-with-node-and-python.md)

## 1. 单镜像

一个镜像包含：守护进程、内置插件、默认人格与 Skills、控制台静态文件、CLI，以及运行社区 MCP 服务器所需的运行时。

```
ghcr.io/<org>/protea:<version>        ← 默认（full）：Node 22 + Python 3.12 + uv + git + rg + jq + curl
ghcr.io/<org>/protea:<version>-slim   ← 仅 Node（无法运行 uvx 型 MCP 服务器）
```

多阶段构建：`builder`（pnpm install + build + 控制台打包）→ `runtime`（`node:22-bookworm-slim` + apt 安装 python3/uv/tini/git 等 + 复制 `dist/`）。镜像体积目标：full ≤ 450 MB，slim ≤ 200 MB。

## 2. 运行

```bash
docker run -d --name protea \
  -v protea-data:/data \
  -p 7788:7788 \
  -e PROTEA_ADMIN_TOKEN=... \
  -e ANTHROPIC_API_KEY=... \
  --stop-timeout 40 \
  --restart unless-stopped \
  ghcr.io/<org>/protea:0.1.0
```

`docker-compose.yml` 示例随仓库提供（含可选的 Caddy 反向代理与 TLS）。

### 2.1 进程树与信号

- `tini` 为 PID 1，转发 SIGTERM，回收僵尸。
- 守护进程收到 SIGTERM 后进入排空（[04-scheduling-and-preemption.md](04-scheduling-and-preemption.md) §8），最长 `shutdown.graceMs`（默认 25 s）；`--stop-timeout` 必须大于它。
- 子进程（插件、MCP）由守护进程停止；守护进程退出时 `tini` 清理残留。

### 2.2 用户与权限

- 镜像内用户 `protea`（uid 1000）运行守护进程；`plugin`（uid 1001）运行插件与 `shell` 工具（可通过 `PROTEA_SINGLE_USER=1` 关闭以简化权限问题）。
- `/data` 由入口脚本在启动时 `chown`（仅首次或权限不符时）。

## 3. 数据卷布局

```
/data
├── config.yaml              ← 主配置（首次启动写入带注释的模板；控制台写入时保持注释与顺序）
├── protea.lock              ← 单实例锁（pid 文件；进程已死则自动接管）
├── secrets/                 ← 秘密文件（0600）
├── protea.db (+ -wal, -shm) ← SQLite
├── sessions/                ← 转录与检查点
├── memory/                  ← 记忆
├── persona/                 ← 人格
├── plugins/                 ← 用户插件
├── plugin-data/<id>/        ← 插件私有数据
├── skills/                  ← 用户 Skills
├── workspace/               ← shell 工具与 MCP roots 的工作区
├── blobs/                   ← 附件
├── cache/                   ← npx/uvx/pip 缓存（可清理）
├── overrides/               ← 环境提示等覆盖
└── runs/<runId>/            ← 日志与诊断
```

只有 `/data` 需要持久化；备份 = 停止写入（或用 SQLite 在线备份 API）后复制整个目录。

## 4. 配置层叠

优先级从低到高：

1. 镜像默认（`/app/config.default.yaml`）
2. `/data/config.yaml`
3. 环境变量 `PROTEA_*`（`PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500` 这类双下划线路径）
4. 控制台/CLI 的运行时覆盖（写回 `/data/config.yaml`，带来源标记）

热更新：配置文件被监视；热项立即生效，非热项触发相关组件重建或提示重启。详见 [../30-specs/04-config-reference.md](../30-specs/04-config-reference.md)。

## 5. 启动顺序

```
entrypoint.sh
 ├─ 准备 /data 目录与权限
 ├─ 迁移：SQLite schema 版本检查与升级（向前兼容；不自动降级）
 └─ exec tini -- node apps/daemon
      ├─ 加载配置（层叠）与秘密
      ├─ 打开 Event Store；转录修复
      ├─ 启动控制平面（此时 /healthz 可用；/readyz 未就绪）
      ├─ 加载人格与 Skills 注册表
      ├─ 启动 Provider
      ├─ 启动插件（并行；失败不阻塞其他）与 MCP 服务器
      ├─ 恢复被暂停的 Fork
      ├─ 调度器开始投递（pending 事件按游标继续）
      └─ 记录 L4 piggyback 事件 `daemon.started`（随下一批送达模型，不单独唤醒）
```

## 6. 云端注意事项

- **出站为主**：Telegram 长轮询、IMAP、RSS、Anthropic API 都只需出站；没有 Webhook 时可以不暴露任何入站端口，控制台通过 SSH 隧道访问。
- **控制台**：守护进程在同一端口的 `/` 托管构建好的控制台（镜像里的 `apps/web/dist`，`PROTEA_WEB_DIR` 可改），用管理员令牌登录。
- **监控**：Prometheus 抓 `/metrics`，用只读令牌（秘密 `PROTEA_READONLY_TOKEN`）作 Bearer；示例抓取配置与 Grafana 面板在仓库的 `docker/observability/`。
- **TLS**：需要公网访问控制台或 Webhook 时，用 Caddy/Traefik 做反向代理与自动证书；Protea 自身不终止 TLS。
- **资源**：最小 1 vCPU / 1 GB；MCP 服务器多时建议 2 GB。SQLite 与转录增长缓慢（每天几十 MB 量级，视事件量）。
- **时区**：`TZ` 环境变量；事件 `ts` 一律带时区偏移。
- **时钟**：VPS 时钟漂移会影响 cron 与 `sleep_until`；建议开启 NTP。

## 7. 升级

1. 拉新镜像，`docker compose up -d`（或 `docker stop` → `run`）。
2. 启动时自动做数据库迁移；迁移失败则进程退出并保留原文件，日志给出回滚指引。
3. 插件契约版本（`api`）提升时，不兼容的插件进入 `invalid`，控制台提示升级；上一版本契约通过 shim 兼容一个大版本。
4. 回滚：换回旧镜像；若数据库已被新版本迁移且不向后兼容，从备份恢复（发布说明会明确标注"不可回滚的迁移"）。

## 8. 备份与恢复

- `protea backup --to <dir|git-url>`：SQLite 在线备份 + `sessions/ memory/ persona/ skills/ plugins/ config.yaml`（不含 `secrets/`、`cache/`）。
- 恢复：把备份放回 `/data`，重设秘密，启动。
- 建议：每日备份到对象存储 + `persona/` `memory/` 推送到私有 Git（可审阅记忆变化）。

## 9. 开发环境

- 本地：`pnpm dev` 以热重载启动守护进程，`/data` 指向 `./.dev-data`；控制台先 `pnpm build` 一次，或用 `pnpm web` 起 Vite 开发服务器（把 `/api` 与 `/ws` 转给 `PROTEA_URL`，默认 `http://127.0.0.1:7788`）。
- 容器内调试：`docker exec -it protea protea status`。
- 插件开发：`protea dev-plugin ./my-plugin`，或在控制台把插件目录挂到 `/data/plugins` 后使用"重载"。
