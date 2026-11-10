# ADR-0009：插件与守护进程同用一个用户，靠资源上限与工作区约束

状态：Accepted · 日期：2026-11-04 · 相关：[../10-architecture/14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §6、[../10-architecture/16-deployment.md](../10-architecture/16-deployment.md) §2.2、[ADR-0005](ADR-0005-plugin-isolation-out-of-process.md)

## 背景

原设计让守护进程以 `protea`（uid 1000）运行，插件、MCP 服务器与 `shell` 工具以另一个更低权限的用户 `plugin`（uid 1001）运行。要做到这一点，守护进程启动子进程时必须切换用户，也就是需要 `CAP_SETUID`/`CAP_SETGID`：要么守护进程以 root 运行，要么给 Node 进程额外的能力。两者都违背"容器里不跑 root"。

另外，插件需要读写 `/data/plugin-data/<id>`，MCP 服务器需要 `/data/workspace` 与 `/data/cache`。分成两个用户后，这些目录的属主与权限位要逐个维护，用户把目录挂进来或从备份恢复后很容易出错。

## 决策

- 守护进程、插件、MCP 服务器与 `shell` 工具都以同一个非 root 用户运行（镜像里是 `protea`，uid 1000）。入口脚本在 root 下只做一件事：把 `/data` 交给这个用户，然后用 `setpriv` 降权。`docker exec` 进来的 CLI 也会按 `PROTEA_RUN_AS` 自己降权，写出的文件属主不变。
- 用三层约束代替用户隔离：
  1. **环境**：子进程只拿到最小环境、清单声明的秘密与非秘密的缓存/代理变量（M2/M3 已有）；`shell` 工具的命令连这些都要过白名单，HOME 指向工作区。
  2. **资源**：每个插件和 stdio MCP 服务器的进程树都有内存上限（`pluginHost.limits.memoryMb`，默认 512 MB，超过就按崩溃处理并重启）与文件描述符上限（`openFiles`，默认 1024，启动前用 `ulimit` 设置）。
  3. **权限策略**：有第三方或系统副作用的工具默认 `ask`（`sideEffectTools`、MCP 的低信任或破坏性工具）；`shell` 工具默认不启用。
- 容器层的约束交给部署：`docker-compose.yml` 示例给出 `mem_limit`、`pids_limit`、`cap_drop: [ALL]`（只加回入口脚本需要的几项，以及 tini 转发信号要用的 `KILL`）与 `no-new-privileges`。

## 备选方案

- **守护进程以 root 运行，子进程降到 uid 1001**：隔离最好，但守护进程本身的任何漏洞都变成 root 权限。
- **给 Node 加 `CAP_SETUID`**：能力会被所有子进程继承，必须额外处理；复杂度高，收益有限。
- **每个插件一个容器（sidecar）**：真正的隔离，但与单镜像部署（[ADR-0007](ADR-0007-single-image-with-node-and-python.md)）冲突；作为高级部署模式留到以后。
- **cgroup 限制每个子进程**：容器内非 root 用户通常没有 cgroup 写权限；进程树内存采样在任何环境都能用。

## 后果

- 一个被攻破的插件能读写守护进程能读写的所有文件，包括 `/data/secrets`。这是已知的残余风险：只安装可信的插件，必要时用只读挂载或 sidecar 部署隔离。
- 内存上限是采样实现（默认 15 s 一次），不是硬限制；短时间的尖峰可能先触发容器的 OOM。容器级的 `mem_limit` 仍然需要。
- 以后若要恢复用户隔离，只需在 `PluginHost` 与 `McpManager` 生成子进程时传 `uid/gid`（守护进程以 root 运行的部署可选），接口不变。
