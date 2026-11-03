# ADR-0005：插件默认进程外隔离，JSON-RPC over stdio

状态：Accepted · 日期：2026-11-03 · 相关：[../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md) · [../30-specs/03-plugin-protocol.md](../30-specs/03-plugin-protocol.md)

## 背景

热插拔要求"随时停止、替换、重启"一个扩展；故障隔离要求插件崩溃不影响内核；多语言要求协议而非 API 绑定。Cortico 在进程内动态 import World（Minecraft 例外为子进程），安装后需重启。

## 决策

- 插件（`source` / `connector` / `tool`）默认运行为**独立子进程**，与守护进程通过 **JSON-RPC 2.0 over stdio（NDJSON）** 通信；协议与 MCP 的 stdio 传输形态一致，便于复用传输代码。
- **进程内插件**只允许内核自带、随镜像发布的少量来源（`console`、`cron`、`internal`）与 Provider。
- MCP 服务器天然是子进程/远程服务。
- Skills 不运行，只是文件。
- 守护进程统一监督子进程：心跳、退避重启、资源上限、排空超时。

## 备选方案

- **Worker threads**：隔离弱（共享进程、崩溃仍可能拖垮）、仅 JS。
- **进程内动态 import + 热替换模块**：Node 的模块缓存与残留定时器/连接使"卸载"不可靠。
- **容器级隔离（每插件一个容器）**：隔离最强，但违背单镜像/单容器目标。
- **把插件做成 MCP 服务器**：MCP 缺少"推送事件"与生命周期回调语义；但我们让协议形态与 MCP 对齐以降低学习成本。

## 后果

- 每个插件一个进程，内存开销约 30–60 MB（Node）；资源受限机器上限制插件数量或使用 Python/Go 插件。
- 协议需要版本化（清单 `api`）与兼容 shim。
- 插件本地开发需要宿主模拟器（`protea dev-plugin`）。
