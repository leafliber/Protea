# 部署

> 状态：Accepted（M6）· 更新：2026-11-10 · 决策：[ADR-0007](../20-decisions/ADR-0007-single-image-with-node-and-python.md)、[ADR-0009](../20-decisions/ADR-0009-single-uid-with-process-limits.md)、[ADR-0013](../20-decisions/ADR-0013-sandboxed-shell-and-in-container-browser.md)

> **实现状态（M6）**：`Dockerfile`（仓库根目录，full 与 slim 两个目标）、`docker/entrypoint.sh`、`docker/docker-compose.yml` 与 `docker/Caddyfile`；CLI 的 `migrate`、`healthcheck`、`backup`、`restore`、`replay`；`scripts/container-smoke.sh`（容器冒烟测试）与 `scripts/soak.mjs`（长稳测试）；`.github/workflows/ci.yml` 构建两种镜像、跑冒烟测试并用 Trivy 扫描。镜像还没有发布到镜像仓库，需要自己构建。

## 1. 单镜像

一个镜像包含：守护进程、内置插件、默认人格与 Skills、控制台静态文件、CLI，以及运行社区 MCP 服务器所需的运行时。

| 目标 | 内容 | 磁盘占用 | 压缩后（下载量） |
|---|---|---|---|
| `full`（默认） | Node 22、npm/npx、Python 3.13、uv/uvx、git、ripgrep、jq、curl、openssh-client、tini | 约 550 MB | 约 170 MB |
| `slim` | Node 22、npm/npx、tini（不能跑 `uvx` 型 MCP 服务器与 Python 插件） | 约 345 MB | 约 95 MB |
| `browser` | `full` + Chromium、中文字体与固定版本的 Playwright MCP（内置浏览器） | 约 1.4 GB（arm64，2026-11-10） | — |

沙箱容器不需要单独的镜像，用 `full` 或 `browser` 都可以。

```bash
docker build -t protea .                       # full
docker build -t protea:slim --target slim .    # slim
docker build -t protea:browser --target browser .  # 带 Chromium
```

多阶段构建（`Dockerfile`）：

1. `builder`（`node:22-trixie-slim` + 编译工具）：`pnpm fetch`（只依赖锁文件，代码变化时复用这一层）→ `pnpm install --offline` → `pnpm build`（含插件打包与控制台）→ `pnpm --filter @protea/cli deploy --prod` 得到只含生产依赖的 `/app`；删掉 TypeScript 源文件、source map、其他平台的原生二进制与 better-sqlite3 的 SQLite 源码。
2. `assets`：内置的进程外插件（每个插件只保留清单、`dist/`、`config.schema.json`、`ENV_PROMPT.md`、`skills/`）、默认人格、内置 Skills、Python 插件 SDK、控制台构建产物，放在 `/app/assets`（`PROTEA_ASSETS_DIR`）。
3. `slim`：`node:22-trixie-slim` + tini；先 `apt-get upgrade` 带入基础镜像发布后的 Debian 安全更新（CI 的 Trivy 只放过没有修复的漏洞，2026-11-08 的 zlib1g 就是有修复而镜像没带），npm 升级到较新的版本（基础镜像自带的 npm 依赖里有已知漏洞），删除不用的 corepack 与 yarn。
4. `full`：在 `slim` 上加 apt 包（同样先 `apt-get upgrade`）与 uv 的官方镜像里的 `uv`、`uvx`。

测得的体积比原目标（full ≤ 450 MB、slim ≤ 200 MB）大：Node 22 的 Debian 基础镜像本身就有约 270 MB，Python 与 git（连带 perl）约 160 MB，uv 约 45 MB，应用本身约 47 MB。体积按镜像各层未压缩大小相加（`docker history`）；Docker Desktop 的 containerd 存储在 `docker images` 里显示的数字更大，因为它同时算了压缩的层与解开的快照。原目标按压缩后的下载量看是满足的。 CI（amd64，`docker image inspect` 的 `Size`）在 219b0b1 上测得 full 457 MB、slim 268 MB（2026-11-09）；本机 arm64 构建的数字另算。

## 2. 运行

```bash
docker run -d --name protea \
  -v protea-data:/data \
  -p 127.0.0.1:7788:7788 \
  --stop-timeout 40 \
  --restart unless-stopped \
  protea
```

- **首次启动**：没有管理员账号时，守护进程把一次性设置码打印到容器日志：`docker logs protea`（或 `docker exec protea protea setup`）。打开控制台，用设置码创建管理员账号，接着在引导里选模型供应商（Anthropic、OpenAI、DeepSeek、通义千问、Kimi、GLM、OpenRouter、Ollama 或任何 OpenAI / Anthropic 兼容接口），填地址、API Key 与模型，测试连接后保存。供应商立即生效，不用重启；以后在「模型」页增加、切换或按角色分配。不开浏览器也可以：`docker exec -it protea protea setup --user admin`，再 `docker exec -it protea protea providers set deepseek --model deepseek-chat --key-stdin`。
- 也可以完全用环境变量配置供应商（自动化部署），见 [../30-specs/04-config-reference.md](../30-specs/04-config-reference.md) §3；密钥用 `PROVIDER_<ID>_API_KEY` 或 `PROTEA_SECRET_PROVIDER_<ID>_API_KEY`（`docker inspect` 看得到环境变量，存成秘密更好）。2026-11-05 之前的 `ANTHROPIC_API_KEY` 文件在启动时自动改名并配好 `anthropic` 档案。
- 本地构建：`pnpm docker:build`（`scripts/docker-build.sh`），标签 `protea:latest`、`protea:<版本>`、`protea:<版本>-<提交>`；slim 用 `pnpm docker:build:slim`。
- API 令牌（CLI、脚本、Prometheus）不设置时自动生成并写入 `/data/secrets/PROTEA_ADMIN_TOKEN`；容器里的 CLI 自动读取它。控制台用账号登录，令牌只在恢复时用（登录页"改用 API 令牌登录"）。忘记密码：`docker exec -it protea protea accounts passwd <用户名>`。
- 控制台在 `http://127.0.0.1:7788/`；不在本机时用 SSH 隧道或下面的 Caddy。
- 其他秘密：`docker exec -i protea protea secrets set TELEGRAM_BOT_TOKEN`（从 stdin 读），或环境变量 `PROTEA_SECRET_<NAME>`。

`docker/docker-compose.yml`：

```bash
cd docker && docker compose up -d                                   # 只监听 127.0.0.1:7788
PROTEA_DOMAIN=protea.example.com docker compose --profile tls up -d   # 加 Caddy，自动证书，443
```

示例里给出了推荐的容器限制：`mem_limit: 1g`、`cpus: 1`、`pids_limit: 512`、`cap_drop: [ALL]`（只加回入口脚本需要的 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`SETUID`、`SETGID`，以及让 PID 1 的 tini 能把 SIGTERM 转给 uid 1000 进程的 `KILL`）、`no-new-privileges`、`stop_grace_period: 40s`、日志轮转。秘密放在同目录的 `secrets.env`（可选）。

**沙箱（助理的 shell）**：

```bash
cd docker && docker compose --profile sandbox up -d   # 加上 sandbox 容器
docker compose exec protea protea sandbox run 'id'    # 确认连得上
```

然后启用 `shell` 插件。沙箱容器运行 `protea sandbox serve`：没有 `/data`，只在自己的网络 `sandbox-net` 上，和主容器共享三个卷——`protea-workspace`（两边的工作区）、`protea-browser-files`（浏览器的文件，沙箱只读）、`sandbox-run`（unix socket，主容器只读）。它自己的 `sandbox-home` 保存装过的包与 shell 状态。沙箱的出站不受限，要限制就在部署层加防火墙或出口代理。

**内置浏览器**：

```bash
cd docker && docker compose -f docker-compose.yml -f docker-compose.browser.yml up -d --build
docker compose exec protea protea mcp preset browser
```

覆盖文件把主服务换成 `browser` 镜像，内存 4 GB、`pids_limit` 1024、`shm_size` 1 GB，并加上 `seccomp-chromium.json`（Docker 默认配置加上 Chromium 沙箱需要的 `clone`、`unshare`、`setns`、`chroot` 的命名空间用法）。启用浏览器后主容器的最低配置是 4 GB（浏览器条目自己的上限是 3072 MB）。用 `docker run` 部署时自己加 `--security-opt seccomp=…`、`--shm-size`、`--memory`、`--pids-limit`。

宿主不允许非特权用户命名空间时（部分内核的 `kernel.apparmor_restrict_unprivileged_userns=1` 等），Chromium 的沙箱建不起来，可以 `protea mcp preset browser --no-sandbox`，控制台会持续警告。

### 2.1 进程树与信号

```
tini (PID 1, root)
 └─ protea-entrypoint (sh)            ← root：准备 /data；然后 setpriv 降为 uid 1000 重新执行自己
     └─ node protea serve (uid 1000)  ← exec，tini 的 SIGTERM 直接到这里
         ├─ 插件进程（node / python）
         └─ stdio MCP 服务器（npx / uvx …）
```

- 守护进程收到 SIGTERM 后进入排空（[04-scheduling-and-preemption.md](04-scheduling-and-preemption.md) §8），最长 `daemon.shutdown.graceMs`（默认 25 s），然后停 MCP 服务器与插件、写 `shutdown.json`。`--stop-timeout`（compose 的 `stop_grace_period`）必须大于它，示例用 40 s。空闲时 `docker stop` 不到 1 s 完成。
- 子进程由守护进程停止；守护进程退出后 tini 回收残留的进程。

### 2.2 用户与权限

- 守护进程、插件、MCP 服务器与 `shell` 工具都以用户 `protea`（uid/gid 1000，`PROTEA_RUN_AS=1000:1000`）运行，不再单独设插件用户（[ADR-0009](../20-decisions/ADR-0009-single-uid-with-process-limits.md)）。
- 入口脚本以 root 启动时：`/data` 的属主不是 1000 才 `chown -R`，然后 `setpriv --reuid --regid --init-groups` 降权。以 `--user 1000:1000` 启动时跳过这一步，此时 `/data` 必须已经可写，否则直接报错退出。`PROTEA_ALLOW_ROOT=1` 关闭降权（不建议）。
- `docker exec protea protea …` 默认以 root 进来，CLI 会按 `PROTEA_RUN_AS` 自己降权，所以 `protea backup` 写出的文件仍属于 `protea`。
- 插件与 MCP 服务器的进程树受 `pluginHost.limits`（内存、文件描述符）约束（[14-security-and-permissions.md](14-security-and-permissions.md) §6）。

### 2.3 健康检查

镜像的 `HEALTHCHECK` 每 30 s 运行一次 `protea healthcheck`（启动宽限 40 s，超时 5 s，连续 3 次失败为 unhealthy）：它按 `control.listen`（或 `PROTEA_URL`）请求本机的 `/healthz`。`/readyz`（Provider、插件、MCP、SQLite 写锁、投递未暂停）供编排层判断是否就绪，见 [15-observability.md](15-observability.md) §5。

### 2.4 镜像里的环境变量

| 变量 | 值 | 作用 |
|---|---|---|
| `PROTEA_DATA_DIR` | `/data` | 数据目录 |
| `PROTEA_ASSETS_DIR` | `/app/assets` | 内置插件、人格、Skills、控制台 |
| `PROTEA_RUN_AS` | `1000:1000` | 入口脚本与 CLI 降权的目标 |
| `PROTEA_IMAGE` | `full` / `slim` | 镜像变体（只用于诊断） |
| `TZ` | `UTC` | 默认时区（`daemon.timezone` 未设时用它） |
| `npm_config_cache`、`UV_CACHE_DIR`、`UV_TOOL_DIR`、`UV_PYTHON_INSTALL_DIR`、`PIP_CACHE_DIR` | `/data/cache/...` | 入口脚本设置；插件、MCP 服务器与 `shell` 工具会继承（这些变量不是秘密） |

## 3. 数据卷布局

```
/data
├── config.yaml              ← 主配置（首次启动写入带注释的模板；控制台写入时保持注释与顺序）
├── protea.lock              ← 单实例锁（pid 文件；进程已死则自动接管）
├── secrets/                 ← 秘密文件（0600）；mcp-oauth/ 存 MCP OAuth 令牌
├── protea.db (+ -wal, -shm) ← SQLite
├── sessions/                ← 主会话转录（main.NNNN.jsonl）、交接笔记、forks/
├── memory/                  ← 记忆
├── persona/                 ← 人格
├── plugins/                 ← 用户插件
├── plugin-data/<id>/        ← 插件私有数据；plugin-data/mcp/<id>/ 是 stdio MCP 服务器的工作目录
├── skills/                  ← 用户 Skills
├── workspace/               ← MCP roots 的工作区；Compose 部署里是与沙箱共享的卷（内容不可信）
│   └── browser/             ← 浏览器的截图、PDF、下载；Compose 部署里是沙箱只读的卷
├── blobs/                   ← 图片（ADR-0014）
├── cache/                   ← npm/uv/pip 缓存、backup-git/（Git 备份的工作副本）；可以清空
├── overrides/               ← 环境提示等覆盖
├── backups/                 ← protea backup 的默认位置；迁移前的快照；restore 移开的旧文件
├── replays/                 ← protea replay 的离线目录
└── runs/<runId>/            ← 日志、关停记录、崩溃报告、provider.jsonl（录制模式）
```

需要持久化的是 `/data`；Compose 部署里另有 `protea-workspace`、`protea-browser-files` 与 `sandbox-home`。

## 4. 配置层叠

优先级从低到高：

1. 内置默认（代码里的 `defaultConfig()`）
2. `/data/config.yaml`
3. 环境变量 `PROTEA_*`（`PROTEA_SCHEDULER__LEVELS__1__DEBOUNCE_MS=500` 这类双下划线路径）
4. 控制台/CLI 的修改（写回 `/data/config.yaml`）

热更新：配置文件被监视；热项立即生效，非热项提示重启。详见 [../30-specs/04-config-reference.md](../30-specs/04-config-reference.md)。

## 5. 启动顺序

```
tini → protea-entrypoint
 ├─ （root）准备 /data 与权限 → setpriv 降为 protea
 ├─ 创建 cache/、workspace/；设置缓存环境变量
 ├─ protea migrate：数据库比镜像新 → 退出；有待执行的迁移 → 先用 SQLite 在线备份
 │    快照到 /data/backups/protea-v<旧版本>-<时间>.db，再在事务里迁移（失败回滚，文件不变）
 └─ exec protea serve
      ├─ 加载配置（层叠）与秘密；日志的秘密过滤从这里开始
      ├─ 打开 Event Store；转录修复
      ├─ 启动插件（并行；失败不阻塞其他）与 MCP 服务器（后台）
      ├─ 启动控制平面（此时 /healthz 可用）
      ├─ 记录 L4 piggyback 事件 `daemon.started`
      ├─ 调度器开始投递（pending 事件按游标继续；被中断的批先续跑）
      └─ 恢复被暂停的 Fork
```

## 6. 云端注意事项

- **出站为主**：Telegram 长轮询、IMAP、RSS、Anthropic API 都只需出站；没有 Webhook 时可以不暴露任何入站端口，控制台通过 SSH 隧道访问。
- **微信**：长轮询同样只需出站，要能访问 `ilinkai.weixin.qq.com` 和 `novac2c.cdn.weixin.qq.com`，扫码时服务端可能重定向到其他主机。
- **QQ**：WebSocket 网关只需出站，要能访问 `bots.qq.com`（token）、`api.sgroup.qq.com`（API 与网关地址）、网关的 WebSocket 地址、`q.qq.com`（扫码）以及图片 CDN。
- **TLS**：需要公网访问控制台或 Webhook 时，用 Caddy/Traefik 做反向代理与自动证书（compose 的 `tls` 档）；Protea 自身不终止 TLS。
- **地址白名单**：`control.allowCidrs` 限制能访问控制平面的地址（回环总是允许，`/hooks/*` 不受限）。经反向代理时守护进程看到的是代理的地址，白名单应设在代理上。
- **监控**：Prometheus 抓 `/metrics`，用只读令牌（秘密 `PROTEA_READONLY_TOKEN`）作 Bearer；示例抓取配置与 Grafana 面板在 `docker/observability/`。
- **资源**：最小 1 vCPU / 1 GB；MCP 服务器多时建议 2 GB。守护进程常驻内存约 130 MB，其中约 60 MB 是 Node 程序文件的映射，V8 堆约 35 MB（M6 长稳测试的负载下，见 [../40-plan/01-roadmap.md](../40-plan/01-roadmap.md) M6）；每个 Node 插件进程约 50 MB。
- **时区**：`TZ` 环境变量；事件 `ts` 入库时一律写成该时区的本地时间加偏移。
- **时钟**：VPS 时钟漂移会影响 cron 与 `sleep_until`；建议开启 NTP。

## 7. 升级

1. 构建或拉取新镜像，`docker compose up -d`（或 `docker stop` → `docker rm` → `docker run`）。
2. 入口脚本的 `protea migrate` 在启动前迁移数据库，迁移前先快照；迁移失败时容器退出，日志给出回滚方法，原文件不变。
3. 插件契约版本（`api`）提升时，不兼容的插件进入 `invalid`，控制台提示升级。
4. 回滚：换回旧镜像。旧镜像看到更新的数据库会拒绝启动；此时用迁移前的快照或备份恢复（`protea restore`，或把快照复制回 `/data/protea.db`）。

## 8. 备份与恢复

```bash
docker exec protea protea backup --archive          # → /data/backups/protea-backup-<时间>.tar.gz
docker cp protea:/data/backups/protea-backup-….tar.gz .
docker exec protea protea backup --to git@github.com:me/protea-memory.git   # 只推 config.yaml、persona/、memory/、skills/
```

- 目录备份是在线的（守护进程运行时也安全）：SQLite 在线备份 API 的快照，加上 `config.yaml`、`sessions/`、`memory/`、`persona/`、`skills/`、`plugins/`、`plugin-data/`、`blobs/`、`overrides/`，以及记录版本、schema、文件数和数据库校验和的 `manifest.json`。**不含** `secrets/`、`cache/`、`backups/`、`replays/`；`workspace/` 与 `runs/` 要显式加 `--include-workspace`、`--include-runs`。
- 注意：转录与事件本身可能含有出现过的秘密值（它们只在发给模型和写日志时被过滤），备份文件要按含敏感数据对待。
- Git 备份用守护进程环境里的 SSH 密钥或 Git 凭据，每次有变化就提交一次（作者 `Protea <protea@localhost>`），便于审阅记忆的变化；数据库不进 Git。
- 恢复（守护进程必须停止）：

```bash
docker stop protea
docker run --rm -v protea-data:/data -v "$PWD":/restore protea restore /restore/protea-backup-….tar.gz --force
docker start protea
```

  `restore` 校验 manifest 的格式、schema 版本与数据库校验和；目标目录已有数据时必须加 `--force`，旧文件移到 `/data/backups/pre-restore-<时间>/`，不会删除。`secrets/` 保持原样；换了机器要重新设置秘密。
- 建议：每天一次目录备份复制到对象存储，`persona/` 与 `memory/` 推到私有 Git。

## 9. 开发与测试

- 本地：`pnpm dev` 以热重载启动守护进程，数据目录 `./.dev-data`；控制台先 `pnpm build` 一次，或 `pnpm web` 起 Vite 开发服务器。
- 沙箱与浏览器的冒烟测试：`scripts/sandbox-smoke.sh <browser 镜像>`：沙箱非 root、无 capability、看不到 `/data`、连不上控制面；shell 状态跨两边重启；工作区共享、浏览器目录只读；浏览器能开页面和截图，打不开本地文件，Chromium 自带沙箱开启。
- 容器冒烟测试：`scripts/container-smoke.sh <镜像>`：非 root、健康检查、控制台消息有回复、暂停投递后 `docker stop`/`start` 等待中的事件一个不少并在恢复后送达、有 `shutdown.json`、容器内备份且属主正确、入口脚本做了迁移。CI 对 full 与 slim 都跑。
- 长稳测试（可选；长时间运行主要靠实际使用中的指标观察）：`node scripts/soak.mjs --url … --token-file … --hours 72 --rate 2`，对使用 echo Provider 的实例持续推送混合等级的事件，按间隔采样 `/metrics`，结束时给出内存增长（%/天）、数据库增长与延迟 P95；超过 `--max-growth`（默认 5 %/天）时退出码为 1。
- 容器内调试：`docker exec -it protea protea status`、`docker exec -it protea sh`。
- 诊断包：`docker exec protea protea diag [--since 72h] [--content]`，再 `docker cp protea:/data/exports/<名字> .`；内容见 [15-observability.md](15-observability.md) §8。实际测试的步骤见 [../40-plan/06-real-world-testing.md](../40-plan/06-real-world-testing.md)。
- 插件开发：`protea dev-plugin ./my-plugin`，或把插件目录放进 `/data/plugins` 后在控制台"重载"。
