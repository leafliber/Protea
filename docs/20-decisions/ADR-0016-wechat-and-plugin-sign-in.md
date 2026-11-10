# ADR-0016：微信连接器基于官方包，插件登录成为通用能力

状态：Accepted · 日期：2026-11-10 · 相关：[../10-architecture/08-event-source-plugins.md](../10-architecture/08-event-source-plugins.md) §6.3 · [../30-specs/03-plugin-protocol.md](../30-specs/03-plugin-protocol.md) · [ADR-0012](ADR-0012-chat-platforms-and-operator-console.md)

## 背景

主人想在微信里和助理说话。微信官方提供 iLink 机器人通道（ClawBot）：扫码绑定，HTTP 长轮询收消息，不需要入站端口。腾讯发布了 MIT 许可的 `@tencent-weixin/openclaw-weixin`，是这个协议的官方客户端，但它是 OpenClaw 框架的插件。QwenPaw 的 `plugins/channel/wechat` 是另一份实现，分工可以参考，协议细节却落后于官方包（缺 `iLink-App-*` 请求头，不调 `msg/notifystart`，扫码状态只处理两种）。

Protea 现有的插件没法扫码：缺秘密时启动直接失败，插件也写不了秘密库，控制台没有展示二维码的地方。

## 决策

- **协议代码用官方包，版本锁定。** `plugins/wechat` 依赖 `@tencent-weixin/openclaw-weixin@2.4.10`，直接调用它的 HTTP 客户端、发送、媒体下载解密、会话保护和 Markdown 过滤。对官方文件路径的引用只集中在 `src/ilink.ts`。
- **两处不用官方实现。** `auth/login-qr.js` 的等待函数从 stdin 读验证码、往 stdout 写提示，而这两者在 Protea 里是插件协议通道，所以扫码状态机由 `src/login.ts` 按同样的请求和状态重写，HTTP 仍走官方函数。`monitor/monitor.js` 运行在 OpenClaw 网关里，长轮询循环由插件自己写，游标和 `context_token` 进 kv。
- **`openclaw` 用本地替身。** 官方包把 `openclaw` 列为 peer，真实包约 200 MB。运行时只需要三个导入，`plugins/wechat/shims/openclaw` 提供它们。官方包的日志关闭（`setLogLevel('FATAL')`），因为它会把二维码链接和 CDN 地址写到数据目录外。
- **打包产物旁边放官方的 `package.json`。** 官方客户端靠向上查找自己的 `package.json` 生成 `iLink-App-Id` 和版本头，镜像里插件目录没有这个文件。`scripts/bundle-plugin.mjs` 按插件声明把它复制到 `dist/`。
- **登录是通用能力，不是微信特例。** 清单加 `login` 和 `optionalSecrets`，协议加 `login/start|status|submit|cancel` 和 `login/complete`。插件在后台完成登录，主动调用 `login/complete` 交出凭据，所以关掉网页也不影响完成。宿主把凭据存进 SecretStore，把扫码人写进 `owner.identities`，再重启插件。Core、网页和 CLI 里没有微信专用代码。
- **宿主把关。** `login/complete` 只在宿主发起的登录期间有效，只收清单声明的秘密名，身份的 `plugin` 字段由宿主固定。登录路由仅管理员可用，只读角色看不到二维码。二维码由控制平面根据文本绘制，插件不提供标记，链接也不经过第三方服务。
- **不把社区报告的额度写进代码。** 社区称窗口约 24 小时、每条入站后最多约 10 条回复，这些数字没有官方说明。插件只按服务端返回处理：`ret=-2` 变成明确的失败回执，模型据此改走其他平台。

## 备选方案

- 自己照协议写客户端（QwenPaw 的做法）：官方协议一变就要跟着改，请求头这类细节容易漏。
- 安装真实的 `openclaw`：约 200 MB，只为三个导入，镜像体积不可接受。
- 把 token 放插件 kv 或数据目录：会进备份，也不会被脱敏。
- 登录做成插件自带的命令行工具：网页用户用不上，容器里还要 `docker exec`。
- 宿主轮询 `login/status` 时取回凭据：浏览器关掉就没人取，凭据还会出现在状态响应里。

## 后果

- iLink 不是公开 API，服务端行为可能变化，也没有公开的后端使用条款。真实账号的验证是 T14，由主人在自己的环境里做。
- 微信不适合做可靠的主动推送：机器人不能先开口。`ChatHub.notifyOwner` 因此改成失败后依次尝试其他平台；`chat_send` 仍然必须指定平台，由模型根据回执决定（ADR-0012）。
- 升级官方包要复查 `src/ilink.ts` 引用的文件是否还在，`wechat.e2e` 用打包产物校验请求头。
- 登录和退出会改变秘密集合，思考前缀指纹随之变化一次；启用插件时 `chat_send` 的枚举也变一次。
- Python SDK 暂未提供登录能力。
