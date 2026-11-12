# 架构决策记录（ADR）

> 格式：标题 · 状态 · 日期 · 背景 · 决策 · 备选 · 后果。状态：Proposed → Accepted → Superseded / Deprecated。

| 编号 | 标题 | 状态 |
|---|---|---|
| [ADR-0001](ADR-0001-typescript-node-runtime.md) | 语言与运行时：TypeScript + Node.js 22 | Accepted |
| [ADR-0002](ADR-0002-event-log-as-source-of-truth.md) | 事件日志作为唯一事实源 | Accepted |
| [ADR-0003](ADR-0003-own-agent-loop-over-agent-sdk.md) | 自研代理循环，Claude Agent SDK 仅作可选 Fork 执行器 | Accepted |
| [ADR-0004](ADR-0004-priority-levels-and-delivery-modes.md) | 处理等级 L0–L4 × 投递模式 | Accepted |
| [ADR-0005](ADR-0005-plugin-isolation-out-of-process.md) | 插件默认进程外隔离，JSON-RPC over stdio | Accepted |
| [ADR-0006](ADR-0006-sqlite-single-store.md) | SQLite 单文件存储 + 文件目录 | Accepted |
| [ADR-0007](ADR-0007-single-image-with-node-and-python.md) | 单镜像内置 Node 与 Python/uv | Accepted |
| [ADR-0008](ADR-0008-append-only-history-and-handoff.md) | 历史只追加，容量以交接处理 | Accepted |
| [ADR-0009](ADR-0009-single-uid-with-process-limits.md) | 插件与守护进程同用一个用户，靠资源上限与工作区约束 | Accepted |
| [ADR-0010](ADR-0010-accounts-and-provider-profiles.md) | 控制台账号与设置码初始化；模型供应商档案 | Accepted |
| [ADR-0011](ADR-0011-layered-memory-and-idle-compaction.md) | 分层记忆、闲时压缩与每日整理，不使用 embedding | Accepted |
| [ADR-0012](ADR-0012-chat-platforms-and-operator-console.md) | 对话走平台中枢（`chat_send` 必须指定平台），控制台只观察与注入 | Accepted |
| [ADR-0013](ADR-0013-sandboxed-shell-and-in-container-browser.md) | shell 进独立沙箱容器，浏览器作为 MCP 服务器留在主容器（修订 ADR-0009 的 `shell` 部分） | Accepted |
| [ADR-0014](ADR-0014-images-as-blob-references.md) | 图片以 blob 引用进入转录，发请求时才解析 | Accepted |
| [ADR-0015](ADR-0015-permission-modes-and-auto-review.md) | 权限模式（ask / auto / bypass / locked）与 auto 判断模型 | Accepted |
| [ADR-0016](ADR-0016-wechat-and-plugin-sign-in.md) | 微信连接器基于官方包，插件登录成为通用能力 | Accepted |
| [ADR-0017](ADR-0017-qq-connector-and-qr-bot-creation.md) | QQ 连接器基于官方 SDK，扫码创建机器人在插件内实现 | Accepted |
| [ADR-0018](ADR-0018-rich-chat-content-and-widget-sandbox.md) | 对话内容走 Markdown，附件、选项与小组件是平台声明的能力；小组件在不透明源的沙箱里运行（修订 ADR-0014 的 blob 读取权限） | Accepted |
| [ADR-0019](ADR-0019-capability-change-requests.md) | 助理对 MCP 服务器、Skills、插件的改动只能提议，由管理员人工审核后由 Core 应用 | Accepted |
| [ADR-0020](ADR-0020-fork-reuse-client-tool-search-final-reply.md) | Fork 汇报后待命可复用；Provider 不能搜索工具时由客户端延迟加载；回复可以直接结束回合 | Accepted |
| [ADR-0021](ADR-0021-readable-approval-requests-and-delivery.md) | 授权请求按"人读的样子"生成，助理可以选择发到哪个平台 | Accepted |
| [ADR-0022](ADR-0022-no-backward-compatibility-before-launch.md) | 上线前不做向前兼容，只用最合适的方案（上线时必须被取代） | Accepted |
| [ADR-0023](ADR-0023-plugin-tools-on-demand.md) | 插件工具也可以按需加载，按插件配置；元工具改名为 `tool_search` / `tool_call`（修订 ADR-0020 的命名） | Accepted |

新增 ADR：复制 `ADR-0000-template.md`（见下），编号递增，提交 PR 时在此表登记。

## 模板

```markdown
# ADR-XXXX：<标题>

状态：Proposed · 日期：YYYY-MM-DD · 相关：<文档链接>

## 背景
## 决策
## 备选方案
## 后果
```
