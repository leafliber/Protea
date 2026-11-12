# ADR-0019：助理对自己能力的改动只能提议，由管理员人工审核后由 Core 应用

状态：Accepted · 日期：2026-11-12 · 相关：[../40-plan/10-capability-changes-lazy-mcp-fork-reuse.md](../40-plan/10-capability-changes-lazy-mcp-fork-reuse.md) · [../10-architecture/14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §3.1 · [../10-architecture/13-control-plane.md](../10-architecture/13-control-plane.md) · [ADR-0015](ADR-0015-permission-modes-and-auto-review.md) · [ADR-0013](ADR-0013-sandboxed-shell-and-in-container-browser.md)

## 背景

主人想在对话里让助理新增或修改 MCP 服务器、Skills 和插件。这三样决定助理能做什么、听谁的话：一个 MCP 服务器是一条在容器里运行的命令或一个能收到数据的远程地址，一个 skill 是进入上下文的指令，一个插件是和守护进程一起运行的代码。助理此前没有任何能改它们的工具。

现有的审批（`ask` 策略）不适合承担这件事：它针对一次工具调用，只存输入的哈希和 400 字的摘要；`auto` 模式下由判断模型放行，时限授权和 `bypass` 也能放行；通过后要模型用同样的输入再调用一次。

## 决策

- **新增"变更请求"对象**，和工具审批分开。助理的工具（`mcp_propose`、`skill_propose`、`plugin_propose`）只登记请求，不改任何东西；另有 `change_status`、`change_withdraw`。
- **只有管理员能决定，只有一条路**：控制 API 的 `POST /api/changes/:id/decide`（控制台与 `protea changes`）。聊天命令、插件 RPC、判断模型、时限授权、权限模式（包括 `bypass`）都到不了这里，只读角色被拒绝。
- **通过后由 Core 应用**，用的是控制台自己改这三样时的同一组函数，结果（已应用、应用失败、已过时、被拒绝及备注）作为 L1 内部事件 `change.decided` 告诉助理。助理不需要、也不能自己再做一次。
- **审核看到的就是将被应用的**：请求登记时，要安装的文件立即取回并复制到 `<data>/changes/<id>/`，记下整棵树的摘要；应用前核对摘要。请求登记后再改工作区里的原件不会进来。
- **基线变了就不应用**：登记时记下目标当前状态的哈希；决定时目标已经被改过（例如主人在控制台改了同一个服务器）→ 状态 `stale`，什么都不做，让助理重新提议。
- **凭据不进提议**：MCP 的 bearer token、OAuth client secret 只接受 `${secret:NAME}` 引用；助理没有写秘密库的工具。审核页面标出还没有值的秘密。
- **来源受限**：skill 的内容来自提议里的文本或工作区目录；插件来自工作区目录或 `https://` 的 git / tarball。其他协议（`ssh`、`file`、`git`）只有管理员自己安装时可用，因为提议的来源在任何人看到之前就会被取回。
- 同一个目标同一时间只有一个待审请求；待审请求最多 20 个；7 天不决定就过期。

## 备选方案

- **把这些工具设为固定的 `ask`**（ADR-0015 的做法）：时限授权仍然先于固定的 `ask` 生效；审批记录里没有完整内容，审核人看不到 SKILL.md 的全文或插件的文件；通过后还要模型原样重发一遍很长的输入。
- **让助理直接写 `/data/skills` 或 `config.yaml`**：没有审核点。沙箱后端本来就碰不到这些路径。
- **阻塞式工具调用，等人决定**：主人可能几小时后才看；阻塞的调用挡住抢占，重启会丢。
- **在聊天里用 `/approve` 决定**：聊天里看不到完整内容，而且一条被注入的消息只要让主人回一句话就够了。
- **通过后由助理自己应用**：应用的内容就不再保证是审核过的那一份。

## 后果

- 迁移 10：表 `change_requests`。旧镜像不能再打开升级后的数据库。
- 审计多了两类记录：`change_requested`、`change_decided`。
- 助理的工具表多 5 个工具（Fork 默认不带）。
- 对话里新增插件要分两步：助理先在工作区写好并自测，再提议；主人在控制台看文件、同意。安装后默认启用，启动失败会写在结果里。
- **没有被这个机制覆盖的路径**：`shell` 插件设为 `backend: local` 时，命令以守护进程的身份运行，可以直接写 `/data`（ADR-0013 已写明）。要让"全部经过审核"成立，shell 必须用沙箱后端（默认）。
- 插件更新的实现是"停用 → 卸载（保留数据）→ 安装 → 恢复配置 → 按原样启用"，中途失败会停在中间状态，结果里写明原因。
