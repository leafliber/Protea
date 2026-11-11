# ADR-0017：QQ 连接器基于官方 SDK，扫码创建机器人在插件内实现

状态：Accepted · 日期：2026-11-11 · 相关：[../10-architecture/08-event-source-plugins.md](../10-architecture/08-event-source-plugins.md) §6.4 · [ADR-0016](ADR-0016-wechat-and-plugin-sign-in.md) · [ADR-0012](ADR-0012-chat-platforms-and-operator-console.md)

## 背景

主人想在 QQ 里和助理说话，并且像微信一样扫码即连。QQ 开放平台的官方机器人用 AppID 和 AppSecret 鉴权，通过 WebSocket 网关收消息，不需要入站端口；但按原来的流程，要先在 q.qq.com 注册开发者、手动建机器人、再把凭据抄过来。2026 年腾讯开放了快速创建通道：手机 QQ 扫码并确认后，平台直接建好机器人，把凭据交给发起方。OpenClaw 的官方插件 `@tencent-connect/openclaw-qqbot`、AstrBot 的"扫码一键创建"，以及 Hermes Agent、nanobot 都用这条通道。

可用的包和参考实现：

- `@tencent-connect/qqbot-nodejs`（MIT，腾讯）：协议层客户端。负责 token 刷新、WebSocket 网关（心跳、重连、RESUME）、消息与媒体发送，还有内容清洗中间件；API、token 服务的地址都可以覆盖。
- `@tencent-connect/qqbot-connector`（腾讯）：扫码建机器人。许可证是 UNLICENSED，代码经过混淆，域名写死在 `node:https` 调用里（测试接不了模拟服务），Promise 用法会把二维码打印到 stdout。
- `@tencent-connect/openclaw-qqbot`（MIT）：OpenClaw 的渠道插件，组合上面两个包，扫码人进白名单。
- QwenPaw 的 QQ 通道只支持手填 AppID 和 Client Secret。

扫码协议（读官方包得出，并对真实服务做过一次只建任务、不扫码的探测）：

1. `POST https://q.qq.com/lite/create_bind_task`，请求体 `{key}`，`key` 是发起方生成的 32 字节随机数（base64）。返回 `{retcode: 0, data: {task_id}}`。
2. 二维码内容是 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=…&_wv=2`。`source` 留空时，确认页把接入方显示为"第三方机器人"；要显示自己的名字得发邮件联系腾讯。
3. 每 2 秒 `POST /lite/poll_bind_result {task_id}`，`status` 取 0/1/2/3（NONE/PENDING/COMPLETED/EXPIRED）。实测：任务刚建好、还没人扫时就是 1，未知任务返回 3。所以 0 和 1 都只表示"等待中"，没有"已扫码"这个中间态。
4. 完成时返回 `bot_appid`、`bot_encrypt_secret` 和 `user_openid`（扫码人在这个机器人下的 openid）。`bot_encrypt_secret` 是 AES-256-GCM 密文：base64 编码的 IV（12 字节）+ 密文 + tag（16 字节），密钥是第 1 步的 `key`。

## 决策

- **收发用官方 SDK，版本锁定。** `plugins/qq` 依赖 `@tencent-connect/qqbot-nodejs@1.0.5`，走 WebSocket 网关，intents 用 SDK 默认值（和官方插件一样）。内容经 SDK 的 `contentSanitizer` 去掉 @机器人标记、把表情转成文字。SDK 的 info 和 debug 日志带消息正文，关掉；warn 和 error 记成警告。网关会话（session id 和 seq）存 kv，重启后 RESUME，平台会补发这段时间的消息。SDK 不等上一条处理完就交下一条，插件自己排队，按到达顺序处理。
- **扫码建机器人在插件内重写，不依赖 `qqbot-connector`。** `src/login.ts` 按上面的协议实现：未授权、混淆过的代码不进镜像；服务地址可配置，扫码流程可以用模拟服务做端到端测试；也不碰 stdout（那是插件协议通道）。登录走 ADR-0016 的通用协议（`login/*`），Core、网页和 CLI 都不加 QQ 专用代码。二维码过期就换新的，最多 3 张；8 分钟内没完成算超时。
- **凭据。** AppSecret 是秘密 `QQ_APP_SECRET`（`optionalSecrets`），由 `login/complete` 存进秘密库。AppID 不算秘密，放进秘密库会被全局脱敏，所以扫码后它和 AppSecret 的 sha256 一起存 kv（`signIn`）。启动时，只有 kv 里的哈希和当前秘密对得上，才用它记的 AppID，否则用配置 `appId`。这也是手动接入已有机器人的方式：配置 `appId`，再存秘密 `QQ_APP_SECRET`。秘密被手动换掉时，旧机器人的 openid、会话这些一并作废。扫码人 `qq:<user_openid>` 成为主人。
- **消息分流。** 主人私聊 → `chat.message` L1；非主人私聊 → `qq.message` L4 `store`；频道消息只存储。群消息由开关 `groups` 决定（默认关，`x-hot: false`）：关时全部存储；开时，@机器人的群消息 → `qq.message` L2 `flush`，并提供工具 `qq_group_reply {message_id, text}`。这个工具只能回复本次启动以来投递过的群消息，用的是带 msg_id 的被动回复。
- **回群默认要审批。** `qq_group_reply` 发给群里的其他人，按安全约定（[14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §2：有第三方副作用的工具默认 `ask`）列入 `sideEffectTools`，和 `tg_send_chat` 一样。审批请求会发到主人最近说话的平台（通常就是 QQ），主人回 `/approve` 后模型重新调用。想省掉这一步，可以设 `permissions.tools: { qq_group_reply: allow }`，或者用 `/mode auto`。
- **回复主人。** 被动回复：带上主人最新一条消息的 msg_id。平台拒绝（服务端给出了错误应答）后，这条消息不再试被动回复，改发不带 msg_id 的消息；再被拒，就返回失败回执，模型改走其他平台。网络错误不重发，避免重复。官方 SDK 的被动回复限额默认是每条消息 4 次、1 小时内；社区资料称 2025 年 4 月起主动消息已经关闭。这些数字都不写进代码，只看服务端返回什么。
- **连接故障。** 网关用不可恢复的关闭码断开时（4914 机器人下线或仅沙箱可用，4915 被封禁），停止重连，健康检查报告原因，再推一条 L2 的 `qq.connection_refused`。同一次拒绝只推一次，重新连上后清除。凭据被拒（取不到 token）时，从 5 秒开始退避，最长 5 分钟，健康检查报告原因。

## 备选方案

- 直接依赖 `@tencent-connect/qqbot-connector`：跟着官方升级省事，但许可证不允许分发，混淆代码没法审查，测试也接不了模拟服务。
- 只支持手填 AppID 和 AppSecret（QwenPaw 的做法）：做不到扫码即连。
- 把 AppID 也存成秘密：会被全局脱敏，日志和控制台里的机器人编号都会变成 `[REDACTED]`。
- 合成一个 `AppID:AppSecret` 秘密（OpenClaw 命令行的格式）：AppSecret 单独出现时不会被脱敏。
- 群消息默认投递（Telegram 的做法）：QQ 群里多数是别人，默认关更稳妥，需要时再打开。
- 回群默认放行：被动回复窗口短，逐条审批确实慢，但这会打破"发给第三方先问"的约定；需要时由主人自己放开。

## 后果

- 扫码通道和 `connect.html` 页面都没有公开文档，随时可能变；真实账号验证是 T15。
- 每次扫码可能都会新建一个机器人（据报道每个 QQ 号最多 5 个）。重新扫码前，最好先去 q.qq.com 删掉不用的。
- 主人在群里的 `member_openid` 和私聊的 `user_openid` 是否相同，官方没有说明。如果不同，主人在群里的消息会按普通成员显示（T15 核实）。
- QQ 文字不渲染 Markdown，清单声明 `markdown: none`。Markdown 消息要单独申请权限，这次不做；流式消息（`stream_messages`）也不做，回复整条发送。
- 不需要入站端口。出站要能访问 `bots.qq.com`（token）、`api.sgroup.qq.com`（API）、`/gateway` 返回的网关地址、`q.qq.com`（扫码）和图片 CDN。
- 登录和退出会改变秘密集合，思考前缀指纹随之变化一次；`groups` 开关变化时工具表也变一次（插件会重启）。
