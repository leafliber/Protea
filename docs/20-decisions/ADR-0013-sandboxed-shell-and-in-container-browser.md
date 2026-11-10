# ADR-0013：shell 进独立沙箱容器，浏览器作为 MCP 服务器留在主容器

状态：Accepted · 日期：2026-11-10 · 相关：[../40-plan/08-sandbox-browser-vision.md](../40-plan/08-sandbox-browser-vision.md) · [ADR-0009](ADR-0009-single-uid-with-process-limits.md)（本决策修订其中 `shell` 工具的部分）· [ADR-0007](ADR-0007-single-image-with-node-and-python.md) · [../10-architecture/14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §6

## 背景

主人要求助理能自己调用两样东西：隔离的持久 shell 环境，和自动控制的浏览器。

现有的 `sh_run`（内置插件 `shell`）两样都不满足：每次调用是全新的 `sh -c`，只有文件留下来；命令和守护进程是同一个用户（ADR-0009），能读 `/data/secrets`、改 `config.yaml` 与数据库、杀掉守护进程。它靠"默认不启用 + 每次审批"兜底。

在主容器里做不出真正的隔离：守护进程没有任何 capability，Docker 默认的 seccomp 又禁止创建 user namespace，bubblewrap 这类沙箱用不了；Landlock 只管文件、依赖内核版本，而且挡不住同一用户之间的 `kill`。

## 决策

- **shell 在独立的沙箱容器里运行。** 沙箱容器用同一个镜像（`full`），命令是 `protea sandbox serve`；它不挂 `/data`，和主容器不在同一个网络里。主容器里的 `shell` 插件是它的客户端，经共享卷里的 unix socket 通信。守护进程不管理容器，也不挂 `docker.sock`；沙箱由 Compose 的 `sandbox` 档启动。
- **两边只共享工作区。** 主容器的 `/data/workspace` 与沙箱的 `/workspace` 是同一个卷，用来交换文件；守护进程的运行不依赖其中任何内容，主容器里读它的代码把它当不可信输入（不跟出界的符号链接，不递归 `chown`）。
- **浏览器的文件目录单独成卷，沙箱只读。** 否则沙箱可以在里面放一个指向 `/data/secrets` 的符号链接，等主容器里的浏览器写截图或上传文件时顺着它走——这是沙箱到主容器唯一直接的文件通路，所以从结构上堵死。socket 所在的卷在主容器里也是只读。
- **"持久"分三层。** 文件与装好的包在沙箱自己的卷上；会话状态（当前目录、环境变量、函数）在每条命令之后快照、下一条之前恢复，每条命令仍在自己的进程组里运行；长时间运行的命令作为受管的后台任务，结束时以事件通知主会话。
- **`shell` 插件的后端默认是 `sandbox`。** 今天的行为保留为 `backend: local`，必须显式选择；沙箱连不上时工具报错，不退回本地。
- **浏览器是主容器里的一个 stdio MCP 服务器**（Playwright MCP + 无头 Chromium），以可访问性快照为主操作页面。主容器要用浏览器时换用新的镜像目标 `browser`（`full` + Chromium + 字体）。
- **浏览器留在主容器的配套约束是必须项**：禁用在 Node 侧执行代码的工具（`browser_run_code_unsafe`）；本地文件访问限制在它自己的目录内（MCP roots 只给 `workspace/browser`，`file://` 打不开）；保住 Chromium 自带的沙箱（随仓库提供 seccomp 配置），退到 `--no-sandbox` 时控制台持续警告。
- **审批可以按时间窗授权。** 主人批准某次调用时可以附带时限，时限内同一工具族的调用不再逐次询问，照常审计。

## 备选方案

- **浏览器也放进沙箱容器**：隔离更好（Chromium 碰不到 `/data`），但要把 MCP 的 stdio 桥接过 socket，沙箱还要单独的大镜像。主人选择了主容器：浏览器只能通过固定的一组工具操作，风险比任意命令小一个量级，接入也简单。
- **容器内隔离（Landlock / bubblewrap）**：不增加容器，但默认 Docker 下 bubblewrap 不可用，Landlock 挡不住同用户的信号，效果取决于宿主内核。
- **挂 `docker.sock`，每次任务起一个容器**：守护进程等于拿到宿主的 root。
- **长驻的 bash 进程或 PTY 作为会话**：状态最完整，但超时只能杀掉整个会话，守护进程或沙箱重启后状态全丢；PTY 还要引入原生模块。快照方式在重启后仍然有效（P9）。
- **自研浏览器插件**：工具面可控，但页面快照与元素引用是最难的部分，Playwright MCP 已经做好，并且不需要视觉模型。
- **外部沙箱服务（E2B、Browserbase 等）**：违背"一个镜像、一个数据卷就能跑"。

## 后果

- 部署从一个容器变成"一个容器，外加可选的沙箱容器"；镜像目标从两个变成三个（`slim`、`full`、`browser`），CI 多构建并扫描一个。
- 启用浏览器后主容器需要约 2 GB 内存、更高的进程数上限和更大的 `/dev/shm`，1 vCPU / 1 GB 的最低配置只对不启用浏览器的部署成立。
- 已知的残余风险：
  - 沙箱是"助理的电脑"，被注入的模型可以使用里面的一切，也能经网络把上下文发出去；隔离保护的是 Protea 自己。
  - 浏览器和守护进程同一个用户、同一个网络命名空间：渲染器漏洞在 `--no-sandbox` 下可以直接读到 `/data`；浏览器够得到本机的控制面与局域网（控制面有登录保护；Playwright 的 origin 名单不是安全边界）。
  - 浏览器档案里的登录态等同于凭据，随 `plugin-data/` 进入备份。
- 浏览器只能上传它自己目录里的文件，shell 产生的文件要上传得先由主容器放进去；这是堵上面那条通路的代价。
- `/data/workspace` 改为独立的卷后，原数据卷里该目录下的文件会被遮住，升级时需要搬一次。
- 已启用 `shell` 而没有沙箱的实例升级后工具不可用，直到加上沙箱或显式写 `backend: local`。
- ADR-0009 关于插件与 MCP 服务器的部分不变；以后若要把其他插件也放进独立容器，沙箱代理的 socket 协议可以复用。
