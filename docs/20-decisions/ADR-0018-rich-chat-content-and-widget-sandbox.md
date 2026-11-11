# ADR-0018：对话内容走 Markdown，附件、选项与小组件是平台声明的能力；小组件在不透明源的沙箱里运行

状态：Accepted · 日期：2026-11-11 · 相关：[../40-plan/09-chat-rich-display.md](../40-plan/09-chat-rich-display.md) · [../10-architecture/17-chat-and-console.md](../10-architecture/17-chat-and-console.md) · [../10-architecture/14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §8.1 · [ADR-0012](ADR-0012-chat-platforms-and-operator-console.md) · [ADR-0014](ADR-0014-images-as-blob-references.md)

## 背景

对话窗口只能把回复显示成段落、列表和代码块：表格原样显示成竖线，流程图只能是源码，助理发不了图片，也给不了可点的选项。`chat_send` 只有一个 `text`。流式草稿只有进程内的平台能用。网页的运行时依赖只有 React，页面带严格的 CSP，不能被嵌入，也不嵌入任何东西。

Claude Code、Codex、OpenClaw 的共同做法：正文是 Markdown；流程图由客户端变换 ` ```mermaid ` 围栏；提问用专门的结构；自由界面是模型写的 HTML，在隔离的 iframe 里运行。

## 决策

- **能用 Markdown 说的就用 Markdown。** 表格、流程图（` ```mermaid `）、代码、公式、任务列表留在 `text` 里。网页用 `react-markdown` + `remark-gfm` 渲染成 React 元素，从不经过 HTML 字符串，不渲染原始 HTML，不加载站外资源。Mermaid、高亮（lowlight）、KaTeX 在第一次用到时才下载。
- **图片、选项、小组件是 `chat_send` 的参数**（`images`、`choices`、`widget`），不是正文里的标记：正文里引用到的外部内容伪造不了参数。
- **每一项都是平台声明的能力**（清单 `chat` 块的 `images`、`choices`、`widgets`、`drafts`）。调用带了平台没有声明的字段时回执失败并说明，中枢不改写内容。工具描述里按声明生成一行平台能力。`webchat` 不走特殊通道。
- **流式草稿进入进程外协议**：通知 `chat/draft`，每次带全文，按平台声明的间隔合并。声明 `drafts` 的平台必须能撤回预览，因为草稿不是外部输出。
- **选项的答案是普通的 `chat.message`**，`meta.answer` 指向它回答的那条回复。不阻塞，不新增事件类型。同一时刻只有最新的一组选项有效。
- **小组件只在沙箱外壳里运行。** 外壳是一个静态页面，响应头带 `sandbox allow-scripts` 和 `default-src 'none'`，iframe 也带 `sandbox`，两层都没有 `allow-same-origin`。对话窗口用自己的登录态取代码，经 `postMessage` 交给外壳。外壳发回的消息一律按不可信输入处理，`sendPrompt` 只把文字填进输入框。主页面的 CSP 只写明了 `frame-src 'self'`。
- **三条禁令**（要改先写新的 ADR）：不给外壳的沙箱增加 `allow-same-origin`、表单、弹窗、顶层跳转、模态框或下载；不给外壳的 CSP 增加任何网络来源；不新增把小组件代码当网页返回的地址。
- **只读账号可以读对话里出现过的图片**，其他 blob 仍然只有管理员能读。这修改了 ADR-0014 的一条后果。

## 备选方案

- **把回复拆成带类型的块**（Vercel AI SDK 的 `UIMessage.parts`、OpenClaw 的 `MessagePresentation`）：每个平台都能精确渲染，但模型要多学一套 schema，流式草稿要解析嵌套的半截 JSON，历史不再是一段可读的文字。
- **正文里的带内标记**（Codex 的 `::directive{…}`、OpenClaw 的 `MEDIA:`）：不用改工具 schema，但外部内容可以伪造。
- **阻塞式提问**（三家都是）：主人可能几小时后才回答；阻塞的工具调用挡住抢占，重启会丢。
- **中枢把选项、表格降级成各平台的文字**（OpenClaw）：等于核心替模型写内容，违背 P1；模型从工具描述里知道每个平台显示什么，自己决定。
- **声明式界面**（A2UI）：OpenClaw 用过又去掉了；组件目录要长期维护。
- **小组件用单独的源（第二个端口或子域名）**：隔离同样成立，但部署多一个入口。响应头的 `sandbox` 指令让同一个主机上的页面也是不透明源。
- **`srcdoc` 或 `blob:` 的 iframe**：继承主页面的 CSP，内联脚本会被拦；要放开主页面的 `script-src` 才行。
- **小组件点了就发消息**：小组件可以让按钮上的字和发出的字不一样。选项可以点了就发，是因为标签由页面自己画。
- **继续手写 Markdown 解析**：每加一种语法都是新的边角情况。

## 后果

- 网页多了运行时依赖。首屏多出解析器；Mermaid、高亮、KaTeX 是按需加载的独立文件。构建不再把字体内联成 `data:`（主页面的 CSP 只加载自己的文件）。
- 迁移 9：`outputs.meta` 与表 `widgets`。旧镜像不能再打开升级后的数据库。
- 插件协议只增不改（`chat/send` 的新字段、`chat/draft`、能力位 `chatDrafts`），契约版本 `api` 不变。
- 系统里第一次有模型写的脚本在运行。**浏览器不把 WebRTC 纳入 CSP**：拿到 `RTCPeerConnection` 的小组件可以向任意主机发 UDP 数据报。外壳拿掉这些构造函数并移除嵌套框架，实测（Chrome 157）能挡住直接使用和 `srcdoc` 子框架，但这是加固，不是边界。代价是被注入的模型可以绕过 `ask` 策略，在主人打开对话页面时把写进小组件的内容发出去。`chat.widgets: false` 关掉小组件。
- 沙箱的行为用 `scripts/widget-escape-probe.mjs` 在真实浏览器里检查；2026-11-11 在 Chrome 157 里全部通过，Firefox 与 Safari 没有跑过（T16）。
- 内嵌浏览器如果拦截不透明源发起的请求（Claude 桌面应用的浏览器面板就是这样），小组件加载不出来，窗口显示"没有正常运行"。
