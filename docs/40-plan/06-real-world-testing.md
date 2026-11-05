# 实际测试指南

> 状态：Draft · 更新：2026-11-05

M0–M6 的验收里，有几项必须用真实条件才能复核：真实 API key、真实网络、真实账号，或长时间运行。它们统一放到实际使用场景里做。本文给出每一项的步骤、通过标准，以及要记录和导出什么，方便事后对照日志分析。

## 1. 准备

### 1.1 构建镜像并启动单容器

```bash
pnpm docker:build          # = scripts/docker-build.sh full；slim 用 pnpm docker:build:slim，两者 pnpm docker:build:all
```

镜像标签：`protea:latest`、`protea:<版本>`、`protea:<版本>-<提交>`（工作区有未提交改动时带 `-dirty`）；slim 是 `protea:slim` 等。提交号写在镜像标签 `org.opencontainers.image.revision` 里，诊断包的 `system.json` 也会记下镜像种类。

```bash
docker run -d --name protea -v protea-data:/data -p 127.0.0.1:7788:7788 --stop-timeout 40 --restart unless-stopped protea:latest
```

### 1.2 管理员账号与模型供应商

第一次启动时守护进程在容器日志里打印一次性设置码：

```bash
docker logs protea
```

打开 http://127.0.0.1:7788/ ，用设置码创建管理员账号，接着在引导里选供应商、填接口地址、API Key 与模型，点"测试连接"，保存后立即生效（不用重启）。API Key 存为秘密 `PROVIDER_<ID>_API_KEY`，不进配置文件、环境变量与日志。

只用命令行也可以（密码与 Key 不回显）：

```bash
docker exec -it protea protea setup --user admin
```

```bash
docker exec -it protea protea providers set anthropic --key-stdin
```

`docker exec protea protea providers` 显示各档案是否就绪；`protea status` 的 provider 一行不再显示 `not ready` 即可。CLI 用的 API 令牌在 `/data/secrets/PROTEA_ADMIN_TOKEN`（容器里的 CLI 自动读取）。

### 1.3 实际测试期间建议的记录设置

```bash
docker exec protea protea config set observability.recordProvider responses
```

录下每次模型调用的响应（`runs/<id>/provider.jsonl`），出问题时可以用 `protea replay` 离线重放那一段，不再花钱。改完要重启。排查和事件内容有关的问题时，可以临时打开 `observability.logEventText`（追踪日志带上事件正文），查完关掉。

日志轮转默认每个文件 50 MB、每次运行保留 4 个旧文件（`observability.logRotateMb` / `logRotateKeep`），长时间运行不会占满数据卷。

### 1.4 每项测试结束后导出诊断包

```bash
docker exec protea protea diag --since 24h
```

```bash
docker cp protea:/data/exports/<名字> .
```

也可以在控制台"日志 → 导出诊断包"里选好范围直接下载。默认只含元数据（日志、事件元数据、用量与缓存命中率、批、审计、实时状态与指标），不含对话内容与秘密；和回答质量有关的项目加 `--content`（事件正文与交接笔记），需要重放时再加 `--recordings`。内容说明见 [../10-architecture/15-observability.md](../10-architecture/15-observability.md) §8。

## 2. 复核清单

| # | 来源 | 内容 | 需要 |
|---|---|---|---|
| T1 | M0 | 连续 100 次推送，缓存命中率 ≥ 80% | API key（约 100 次主模型调用，数美元） |
| T2 | M3 | 真实 MCP 服务器：≤ 10 s 可调用；fetch 的调用结果 | 正常网络（本机 fake-IP DNS 不跑） |
| T3 | M4 | 多次交接后仍能答对"我们昨天说好的三件事" | API key，跨天使用 |
| T4 | M5 | Prometheus 抓取与 Grafana 面板 | Docker |
| T5 | M6 | GitHub Actions 首次运行（**已通过**：2026-11-04，run 41873125001，check 与两个镜像任务全绿） | GitHub |
| T6 | M2 | Telegram 真实机器人 | 机器人令牌 |
| T7 | M2 | IMAP 真实邮箱 | 邮箱与应用专用密码 |
| T8 | M6 | 长时间运行：内存是否封顶（风险 R10）、存储增长 | 实际使用数天到 30 天 |
| T9 | M0/M6 | 真实模型下的重启恢复：回合中途 `docker restart`，批续跑、副作用不重复 | API key |
| T10 | 账号与供应商 | 首次设置、账号登录；Anthropic 以外的供应商（OpenAI 兼容）跑通对话与工具调用；按角色分配 | 至少一个第三方 API key（或本机 Ollama） |

### T1 · 缓存命中率

用 Anthropic 档案（Claude）测；其他供应商的缓存由服务端自动决定，命中率只作记录。

```bash
for i in $(seq 1 100); do docker exec protea protea events push "第 $i 条：请只回复收到" --timeout 120; done
```

- **通过**：诊断包 `summary.json` 的 `usage.byRole.main.cacheHit` ≥ 0.8（`cacheHit` = 缓存读 / (输入 + 缓存读 + 缓存写)）。
- **逐次看**：`docker exec protea protea logq --q "model call"`，每行有 `cacheHit`、`inputTokens`、`cacheReadTokens`、`ms`。前一两次是写缓存，之后应接近 1。
- **导出**：`protea diag --since 2h`。

### T2 · 真实 MCP 服务器

```bash
time docker exec protea protea mcp add fetch -- uvx mcp-server-fetch
```

```bash
docker exec protea protea mcp tools fetch
```

```bash
docker exec protea protea events push "用 fetch 读取 https://example.com 并告诉我页面标题" --timeout 120
```

- **通过**：工具在 10 s 内出现（第一次含下载可能更久；`mcp rm` 后再加一次，看有缓存时的时间）；模型调用 `mcp__fetch__fetch` 成功并给出标题。M3 记录的问题是"fetch 的调用在 60 s 内没有拿到期望的结果"，这里要确认它在正常网络下是否复现。
- 自动化测试（在仓库里，正常网络下）：`PROTEA_REAL_MCP=1 pnpm vitest run apps/daemon/test/mcp-skills.e2e.test.ts`，它用脚本化的模型，不需要 API key。
- **看日志**：`protea logq --component mcp`；工具调用 `protea logq --q "tool done"`（`ms`、`failed`、`resultChars`）。
- **导出**：`protea diag --since 2h`。

### T3 · 交接后的连贯性

1. 为了在一天内触发几次交接，先调低阈值（热更新，不用重启）：`docker exec protea protea config set context.handoff.softTokens 30000`。
2. 第一天正常使用，中间明确约定三件事，例如"我们约定：一、……二、……三、……"。
3. 继续使用，直到 `protea status` 的 context 一行显示的转录序号增加了至少 3（如 `main.0004.jsonl`），或诊断包 `summary.json` 的 `handoffs` ≥ 3。
4. 第二天问："我们昨天说好的三件事是什么？"

- **通过**：答对三件事；`/data/memory/handoff/` 里最新的笔记仍保留这三项约定。
- **导出**：`protea diag --since 48h --content`（带事件正文与交接笔记）；想重放就加 `--recordings`。
- 测完把阈值改回：`protea config unset context.handoff.softTokens`。

### T4 · Prometheus 与 Grafana

1. 生成只读令牌，存为秘密 `PROTEA_READONLY_TOKEN`（`docker exec -i protea protea secrets set PROTEA_READONLY_TOKEN`），同一个值写进本机文件 `protea-readonly-token`。
2. 让 Prometheus 和 Protea 在同一个网络里：

```bash
docker network create protea-obs
```

```bash
docker network connect protea-obs protea
```

```bash
docker run -d --name prometheus --network protea-obs -p 127.0.0.1:9090:9090 -v "$PWD/docker/observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro" -v "$PWD/protea-readonly-token:/etc/prometheus/protea-readonly-token:ro" prom/prometheus
```

```bash
docker run -d --name grafana --network protea-obs -p 127.0.0.1:3000:3000 grafana/grafana
```

- **通过**：http://127.0.0.1:9090/targets 里 `protea` 是 UP；Grafana 加 Prometheus 数据源（`http://prometheus:9090`）后导入 `docker/observability/grafana-dashboard.json`，各面板有数据。
- 记录：截图，或面板里不显示的指标名。

### T5 · CI 首次运行

推送后在 GitHub 的 Actions 页面看 `ci` 工作流：`check`（typecheck、构建、测试、`pnpm audit`）与 `image`（full/slim 构建、容器冒烟测试、Trivy）都应通过。失败时把日志链接或失败步骤的输出带回来。

### T6 · Telegram

1. 用 @BotFather 建机器人，令牌存为秘密 `TELEGRAM_BOT_TOKEN`。
2. 启用插件并把自己登记为主人：`docker exec protea protea plugins enable telegram`；在 `config.yaml` 的 `owner.identities` 里加 `{ plugin: telegram, senderKey: "telegram:<你的 user id>" }`（user id 可以先发一条消息，再从 `protea events ls` 里看 senderKey）。
3. 验证：私聊消息是 L1 并得到回复；需要审批的操作（例如让它用 `tg_send_chat` 发到群里）会在 Telegram 里问你，回复 `/approve <id>` 或 `/deny <id>`；`stopWords` 里的词能打断回合；群里不 @ 机器人的消息只入库。
- **导出**：`protea diag --since 24h`；插件日志 `protea plugins logs telegram`。

### T7 · IMAP

1. 邮箱的应用专用密码存为秘密 `IMAP_PASSWORD`；配置 `plugins.imap.config` 的 `host`、`user`（其余默认），启用插件。
2. 给自己发一封普通邮件和一封带 `List-Unsubscribe` 的群发邮件。
- **通过**：普通邮件 1 分钟内（IDLE）成为 L2 事件，群发邮件是 L4；`important` 里的发件人总是 L2。
- **导出**：`protea diag --since 24h`。

### T8 · 长时间运行

正常使用数天到 30 天（1 vCPU / 1 GB 的成功标准）。同时在宿主机上只采样、不推事件：

```bash
docker exec protea cat /data/secrets/PROTEA_ADMIN_TOKEN > protea-token
```

```bash
node scripts/soak.mjs --url http://127.0.0.1:7788 --token-file protea-token --hours 168 --rate 0 --sample 300 --out observe.jsonl
```

- **通过**：第一天之后 RSS 与 V8 堆的增长 < 5 %/天（报告里的 `rssGrowthPctPerDay`、`heapGrowthPctPerDay`）；数据库增长与事件量相符（约 1 KB/事件）。
- M6 的短程测试里堆是平的、RSS 约 +9 MB/h（原生内存，风险 R10）。如果实际使用中 RSS 一直涨：先给容器加 `-e MALLOC_ARENA_MAX=2` 重跑一段对比。
- **导出**：`observe.jsonl`，加 `protea diag --since 168h`。

### T9 · 真实模型下的重启恢复

推一条需要多轮工具调用的消息（例如让它用 fetch 读两个页面再总结），在它进行中执行 `docker restart protea`。

- **通过**：重启后同一个批续跑并给出回复；已经执行过的副作用（例如已发出的消息）不重复；上一个运行目录有 `shutdown.json`，里面记着关停时有一个没跑完的批。
- **导出**：`protea diag --since 1h --runs 2`。

### T10 · 首次设置与多供应商

1. 新的数据卷启动：`docker logs protea` 里有设置码；控制台显示初始化页。用错的设置码应被拒绝；正确的建好账号后，设置码作废（`secrets/PROTEA_SETUP_CODE` 消失），重启不再打印。
2. 退出后用账号密码登录；输错 10 次后被限流一分钟。
3. 在「模型」页添加一个 OpenAI 兼容供应商（例如 DeepSeek、通义千问、Kimi、GLM，或本机 Ollama：地址 `http://host.docker.internal:11434/v1`、勾"无需密钥"）。先"获取模型列表"，再"测试连接"，保存并设为默认。
4. 推一条需要工具的消息（例如"记住我喜欢喝乌龙茶，然后告诉我你记下了"）：应当调用记忆工具并回复。
5. 把"轻量"角色指到另一个档案（例如本机模型），让上下文交接发生一次（同 T3 调低 `softTokens`），确认交接笔记由那个档案生成（`logq --q "model call"` 的 `provider` 字段）。
6. 换回 Claude 作为默认，继续对话：之前由其他模型产生的历史应当照常工作。

- **通过**：以上都成立；日志里没有 API Key 与设置码（`docker logs protea` 的设置码横幅除外）。
- **看日志**：`protea logq --q "model call"`（每行有 `provider`、`model`、token 与 `cacheHit`）；`protea logq --q "provider"`（档案保存、连接测试）；`protea logq --level warn`。
- **导出**：`protea diag --since 2h`；对话质量相关的问题加 `--content`。

## 3. 日志在哪里、怎么查

- 容器标准输出：`docker logs protea`（JSON 行；compose 示例里做了轮转）。
- 运行目录：`/data/runs/<运行 id>/log.jsonl`（含 `log.N.jsonl` 轮转文件）、`shutdown.json`、`crash/`、`provider.jsonl`（录制时）。
- 常用查询（容器里，`docker exec protea protea …`）：
  - `logs --since 15m --follow`：实时跟随；
  - `logq --q "model call"`：每次模型调用的 token、缓存命中、耗时；
  - `logq --q "tool not run"`、`logq --q "tool held by the permission policy"`：没执行的工具调用及原因；
  - `logq --level warn --all`：所有运行里的警告与错误；
  - `events ls`、`batches`、`batches show <id>`：事件与批。
- 追踪日志各行的字段见 [../10-architecture/15-observability.md](../10-architecture/15-observability.md) §2.1。

## 4. 结果怎么回报

每一项回一行，附上诊断包：

| # | 结论 | 日期 | 镜像（`protea:<版本>-<提交>`） | 诊断包 | 备注 |
|---|---|---|---|---|---|
| T1 | 通过 / 不通过 / 部分 | | | protea-diag-….tar.gz | 例如 cacheHit = 0.86 |

不通过时，备注写下现象和大概时间，诊断包的时间范围要覆盖那个时间。回答质量相关的问题（T3）用 `--content` 导出。结论会写回路线图对应里程碑的验收项。
