# ADR-0007：单镜像内置 Node 与 Python/uv

状态：Accepted · 日期：2026-11-03 · 相关：[../10-architecture/16-deployment.md](../10-architecture/16-deployment.md)

## 背景

用户要求单镜像部署。社区 MCP 服务器一半以上以 `npx`（Node）或 `uvx`（Python）形式分发；Skills 的脚本也常用 Python。只含 Node 的镜像会让"5 分钟接入一个 MCP 服务器"的目标落空。

## 决策

默认镜像（`full`）包含：Node 22、Python + uv、git、ripgrep、jq、curl、tini。提供 `slim` 变体（仅 Node）给不需要 Python 的用户。`npx`/`uvx` 的缓存目录指向 `/data/cache`，首次下载后持久化。

**M6 实现**：基础镜像是 `node:22-trixie-slim`（Debian 13），所以 Python 是发行版的 3.13（原写 3.12）；uv 0.9 取自官方镜像；另加 openssh-client（Git 备份与 `git@` 安装）。

不内置：浏览器（Playwright）、Docker CLI、编译工具链。需要时由用户基于 `full` 自建派生镜像（文档提供模板）。

## 备选方案

- 仅 Node：镜像小，但 MCP 生态覆盖不足。
- 多容器（Protea + MCP sidecars）：隔离更好，但与单镜像目标冲突；仍可作为高级部署模式文档化。

## 后果

- 镜像体积：full 约 550 MB（压缩后约 170 MB），slim 约 345 MB（压缩后约 95 MB）。需要镜像扫描与定期基础镜像更新：CI 用 Trivy 阻断高危且有修复的漏洞。M6 时基础镜像自带的 npm 依赖里就有这类漏洞，镜像里因此升级了 npm 并替换了它捆绑的 undici。
- `uvx`/`npx` 首次运行需要网络；离线环境需预热缓存。
