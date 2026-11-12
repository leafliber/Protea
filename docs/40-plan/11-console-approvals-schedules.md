# 定时任务页、可读的授权请求、请求投递平台、提示词与控制台界面：方案

> 状态：Accepted（2026-11-12 实现；真实模型与真实平台下的表现待 T18 实测）· 更新：2026-11-12 · 决策：[ADR-0021](../20-decisions/ADR-0021-readable-approval-requests-and-delivery.md) · 相关：[14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) · [17-chat-and-console.md](../10-architecture/17-chat-and-console.md)

本文是实施前定下的方案，保留原样供对照；精确形态以架构与规范文档为准，实施中和方案不一样的地方记在最后一节。

六项修改一次做完。第 2、3、4 项是同一条链路（授权请求从产生到主人决定），放在一起设计；第 1、5、6 项是控制台。四个待定项都按推荐做了。

## 背景：现状（已核实）

| # | 要求 | 现状 |
|---|---|---|
| 1 | 定时任务独立显示 | `plugins/cron` 是进程内插件，任务存在 `config.yaml` 和 kv（`schedule:<id>`）。控制 API 和网页**没有任何入口**，主人只能让助理调 `schedule_list`。任务只有 `name / cron / at / note / level`，不能暂停，没有"上次运行" |
| 2 | 授权请求不可读 | 三个连接器各抄了一份同样的英文字符串（`qq/src/plugin.ts:696`、`telegram/src/plugin.ts:344`、`wechat/src/plugin.ts:317`）：`Approval a12 requested: shell_exec {"command":"…` + `Reply /approve a12 or /deny a12 (expires 2026-11-12T15:04:05.000+08:00)`。内容是工具名 + 截到 400 字的原始 JSON（`approvals.ts` `summarize`），时间是 ISO 串，决定要手打 id。网页对话用正则把给 CLI 写的句子再解析回来（`Chat.tsx:97`）。库里只存这 400 字摘要，没有结构，控制台也只能显示这一行 |
| 2 | 决定之后 | 原消息不变；其他平台不知道已经处理；回执是 `a12 approved.` |
| 2 | QQ 按钮 | QQ 插件已经为 `choices` 接好了按钮（`sendTextWithKeyboard`、`interaction` 事件、`acknowledgeInteraction`、被拒后降级为文字），授权请求没有用它。Telegram 完全没有用 inline keyboard |
| 3 | 投递平台 | `PluginHost.requestApproval`（`host.ts:1066`）固定发给所有运行中、能投递的插件，助理无法选择；助理也不知道发到了哪里 |
| 4 | 提示词 | 直接调用被拦下时**没有理由**（只有 `approval_request` 或自动审核才带 `reason`），所以技能里让助理"再发一条消息解释"，主人收到一条看不懂的通知加一条解释。三份 `ENV_PROMPT.md` 都写着让主人回复 `/approve <id>`。请求过期不通知助理 |
| 5 | 页面与布局 | 审批页把三种东西放在一起：待办（待审批、能力变更）、设置（权限模式、时限授权）、记录（审计）；而权限规则在「配置 → 权限」。总览按实现的结构排（阶段、模型、工具数、Skills 数），没有"现在需要我做什么" |
| 6 | 界面细节 | 样式是单个 3316 行的 `styles.css`，有颜色与圆角变量，没有间距与字号的刻度；多处用 `window.confirm`、"加载中…"文字、`title` 悬停提示承载关键说明；状态徽标是英文原值；`--faint`（`#9696a0`）在白底上的对比度约 2.9:1，不到正文要求的 4.5:1 |

本机实例需要登录，界面部分是按代码评估的，没有看运行中的页面。

---

## 1. 定时任务页

### 1.1 数据

`ScheduleSpec` 增加字段，旧的 kv 记录按默认值读，不需要迁移：

| 字段 | 含义 |
|---|---|
| `enabled: boolean` | 暂停时不计时、不触发；默认 `true` |
| `kind: 'once' \| 'recurring' \| 'wake'` | `wake` 是 `sleep_until` 建的唤醒，列表里默认折叠到"助理的唤醒" |
| `createdBy: 'config' \| 'assistant' \| 'operator'` | 新增 `operator`：在控制台建的 |
| `lastFiredAt?`、`fires` | 上次触发与累计次数，触发时写回 kv |

`config.yaml` 里定义的任务在页面上只读（标出"在配置文件里定义"），可以"立即运行"。

### 1.2 控制 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schedules` | 列表，每项带 `nextAt`、`human`（规则的人话）、`lastFiredAt` |
| POST | `/api/schedules` | 新建（管理员） |
| PATCH | `/api/schedules/:id` | 改名称、规则、备注、等级、`enabled` |
| DELETE | `/api/schedules/:id` | 删除 |
| POST | `/api/schedules/:id/run` | 立即触发一次，事件文字注明是操作者手动触发 |
| POST | `/api/schedules/preview` | 校验 `cron` 或 `at`，返回人话与接下来 5 次，供表单实时预览 |
| GET | `/api/schedules/:id/runs` | 最近 20 次触发：时间、事件游标、所在的批与结局。从事件日志按 `cron.tick` 与去重键前缀 `<id>@` 查，不新增存储 |

变更发总线记录 `schedule.changed`（WebSocket 分组 `schedule`），页面实时更新。

**助理要知道操作者做了什么**：操作者暂停、修改或删除助理建的任务时，推一条内部事件 `schedule.changed`（L4，`piggyback`），否则助理以为任务还在。`schedule_list` 的输出加上启用状态与下次时间；新增 `schedule_update`（现在只能删了重建）。

### 1.3 页面

侧边栏新增 `schedules`「定时任务」（时钟图标）。

- **顶部**：一行摘要"5 个启用 · 下一个：早间简报，2 小时后（18:00）"；右上「新建定时任务」。
- **筛选**：全部 / 重复 / 一次性 / 已暂停；创建者（助理 / 我 / 配置）。
- **列表每行**：启用开关｜名称与备注首行｜规则的人话（悬停显示 cron 原文）｜下次运行（相对时间，悬停显示绝对时间）｜上次运行（结局徽标，点击打开运行流里那一批）｜创建者｜⋯（立即运行、编辑、复制、删除）。窄屏下每行变成一张卡片。
- **详情抽屉**（`?id=`，可直接链接）：规则、备注全文、接下来 5 次、最近 20 次运行、id 与等级。
- **新建 / 编辑**：名称；类型（一次性 / 重复）；一次性用日期时间选择；重复用预设（每天、工作日、每周某几天、每月某日、每隔 N 分钟 / 小时、自定义 cron）加时间；"到时交给助理的话"（即 `note`，说明这是助理届时读到的全部内容）；"高级"里是等级（L4 说明为"只在有别的事时顺带处理"）。表单下方实时显示"每个工作日 07:00 · 接下来：…"。
- **空状态**：说明用途，给一个例子，并提示"也可以直接对助理说'每天早上 7 点提醒我…'"。

规则的人话用一个小函数覆盖上面的预设形态；认不出的表达式显示 cron 原文加接下来 3 次（`croner` 已是依赖），不引入新的库。总览增加"接下来的定时任务"（3 条）。

---

## 2. 授权请求的呈现与交互

参考的做法：Claude Code 与 Codex 的权限提示（一句话说要做什么，把命令或目标单独显示，选项是"同意 / 同意且这一类不再问 / 拒绝并说明"），Telegram 与 Slack 机器人的按钮消息（点了之后原消息改成结果）。共同点是：**主人看到的是动作而不是参数，决定是点一下而不是打一串字，决定之后请求就地变成结果**。

### 2.1 结构化的请求（`ApprovalView`）

核心在创建请求时生成，脱敏后存进 `approvals.view_json`，所有平台和控制台都从它渲染：

```ts
interface ApprovalView {
  title: string;        // "运行命令"、"在 QQ 群里回复"：做什么，用 daemon.language
  target?: string;      // 最要紧的那一个值：命令、收件人、路径
  fields: Array<{ label: string; value: string }>;  // 其余要紧的参数，最多 6 项，每项单行、最多 300 字
  reason?: string;      // 助理自己写的一句话：为了什么（§3、§4）
  held?: string;        // 自动审核没有放行的原因
  family: { id: string; label: string };  // "1 小时内不再问"覆盖的范围，如"shell 插件的工具"
}
```

`title` 与 `fields` 的来源，按优先级：

1. 工具自己声明：`ToolSpec` 与插件清单的工具条目新增 `approval: { title, target, show }`（纯声明，进程外插件不执行代码）。内置和自带插件的工具（`shell_exec`、`tg_send_chat`、`qq_group_reply`、写文件、浏览器等）全部补上。
2. MCP 工具：用 `annotations.title`，没有则把工具名拆成词；字段取 schema 里的顶层标量，字符串在前。
3. 兜底：工具名加前 4 个标量字段。对象与数组显示成"〈3 项〉"。

另存一份脱敏后的完整输入（上限 8 KB）供控制台"完整参数"展开。**参数值是数据**：每个值压成单行、截断，只当纯文本渲染（Telegram 不带 `parse_mode`），防止输入里夹带换行伪造出"已同意"之类的行。

`id`（`a12`）继续作为内部标识用于审计、API 和 `approval.decided`，**主人不再需要看到或输入它**。旧插件仍能收到 `summary`，内容改成从 `ApprovalView` 生成的人话。

### 2.2 各平台的样子

文字形式（`daemon.language: zh`）：

```
【需要你确认】运行命令
npm publish --tag beta
目录：/workspace/site
原因：你让我发布 beta 版本
10 分钟内有效
```

| 平台 | 呈现 | 决定 | 决定之后 |
|---|---|---|---|
| 网页对话 | 卡片（§2.5） | 按钮 | 卡片收成时间线里的一行"你同意了：运行命令 · 14:02" |
| QQ | 上面的文字 + 官方消息按钮（`sendTextWithKeyboard`）：`同意`、`同意，1 小时内不再问`、`拒绝` | 回调按钮（`action.type: 1`，`data: ap:<id>:y\|h\|n`，`click_limit: 1`）；插件在 `interaction` 里校验是主人后调 `approvals/decide` 并应答 | 按钮文字变成 `visited_label`（"已同意" / "已拒绝"）；成功时不另发回执，省下一条被动回复额度 |
| Telegram | 文字 + `inline_keyboard` | `callback_query`（`allowed_updates` 加上它），`answerCallbackQuery` 弹出结果 | `editMessageText` 去掉按钮，末行写"已同意 · 14:02" |
| 微信 | 文字 + "回复：同意 / 拒绝 / 同意 1 小时" | 回复词（§2.3） | 一行回执 |
| CLI | `protea approvals` 的列表显示 `title` 与 `target` | 命令不变 | — |

- QQ 不给发按钮时（多数机器人没有这项权限，现有 `refused(err)` 分支），降级为文字加回复词，与 `choices` 的降级方式一致。授权按钮和 `openChoices` 互不影响（`data` 前缀不同）。QQ 的官方按钮在真实账号下的表现并入 T15 实测。
- 文字与按钮由 `@protea/plugin-sdk` 的 `approvalMessage(view, { buttons, language })` 统一生成（Python SDK 同步），三份手抄的字符串删掉。

### 2.3 没有按钮时怎么决定

回复词：`同意`、`批准`、`approve`、`yes` / `拒绝`、`不行`、`deny`、`no` / `同意 1 小时`、`同意 1h`。`拒绝` 后面的字是给助理的话（`拒绝 太贵了`）。

为了不把普通聊天当成决定，只有满足下面之一才算：

1. 这条消息**引用**了请求消息（Telegram 的 `reply_to_message`，QQ 的引用）。
2. 整条消息恰好是一个回复词，**并且**请求是机器人在这个平台发出的最后一条消息，**并且**这个平台上只有一个待定的请求。

有多个待定请求时，请求带编号，回复 `同意 2`；只回 `同意` 则答复"有 3 个待确认：1. … 2. … 3. …"。不满足条件的消息照常作为对话交给助理。`/approve a12`、`/deny a12` 保留兼容，不再在任何地方提示。

实现：`plugin-sdk` 的 `approvalReply()` 取代 `approvalCommand()`，SDK 按 `approvals/request` 与 `approvals/resolved` 维护本平台的待定列表。

### 2.4 结果同步与选项

- 新增宿主到插件的通知 `approvals/resolved { id, state, by }`，发给所有投递过这条请求的插件（同意、拒绝、过期都发）。能改消息的平台改消息；不能改的平台对过期按钮的点击应答"已经处理过了"。
- 选项：`同意` / `同意，1 小时内不再问〈family.label〉` / `拒绝`。`permissions.grantMaxMs` 为 0 时不显示第二项；网页上可选 1 小时或 8 小时（不超过上限）。
- 拒绝可以带一句话（网页是可选输入框，聊天平台是回复词后面的字），写进 `approval.decided` 的文字：`The owner said: "…"`。

### 2.5 网页卡片

```
┌ 需要你确认                                    还剩 9:41 ┐
│ 运行命令                                                │
│ ┌──────────────────────────────────────────────────┐  │
│ │ npm publish --tag beta                           │  │
│ └──────────────────────────────────────────────────┘  │
│ 目录    /workspace/site                                 │
│ 原因    你让我发布 beta 版本                             │
│ ▸ 完整参数                                              │
│                     [拒绝…]  [同意 ▾]  [ 同  意 ]        │
└────────────────────────────────────────────────────────┘
```

`同意 ▾` 展开"1 小时内不再问 shell 插件的工具"。`拒绝…` 展开一个可选的原因输入框。对话页与控制台审批页用同一个 `ApprovalCard` 组件。对话历史里的通知带上请求 id（`output.meta.approval`），前端按 id 渲染，不再用正则解析文字。

### 2.6 不变的安全约束

决定只能来自 `owner.resolve` 判定为主人的发送者，或控制台管理员；模型没有任何能决定请求的工具；按钮回调同样校验主人与请求状态；`ApprovalView` 在脱敏之后生成；一次同意仍只对输入完全相同的一次调用有效。

---

## 3. 助理选择请求发到哪个平台

- `approval_request` 增加 `platforms?: string[]`。
- 策略为 `ask` 的工具，在给模型的 schema 里多一个保留字段 `_approval?: { reason?: string; platforms?: string[] }`。分发器在校验、求哈希、执行与审计之前把它摘掉，所以它不影响"同样的输入再调一次"。这样一次调用就同时带上理由和投递平台，不需要先调 `approval_request` 再调工具，也不需要事后补一条解释。
- **不给 `platforms` 就是广播**：发给所有运行中、能投递的平台，和现在一样。
- 给了就只发给这些平台。写了不存在或没在运行的平台：`approval_request` 返回错误并列出可选值；`_approval` 里的则忽略并改为广播，回执里说明。
- 选中的平台都没送达（例如 QQ 的窗口关了）时，自动改发其余平台，回执里说明。
- 回执告诉助理实际发到了哪里：`…The owner was asked on qq.`；`ApprovalInfo.deliveredTo` 同步显示在控制台。
- 对一个已经在等的请求再调 `approval_request`（同样的工具与输入），可以补理由或换平台重发，用于"在 QQ 上没人理，改发 Telegram"。
- **平台只决定通知发到哪，不决定谁能处理**：网页对话的卡片与控制台审批页读的是请求状态，始终显示所有待定请求；主人在任何平台都能决定。

---

## 4. 提示词

我把这一项理解为授权调用这条链路上助理读到的全部文字（见"待定"第 3 条）。提示词保持英文、内容稳定以便缓存。

| 位置 | 现在 | 改为 |
|---|---|---|
| 系统段 `permissions`（`policy.ts` `flow`） | 讲"返回 pending approval，批准后原样再调" | 加上：主人看到的是一张带按钮的卡片；`_approval.reason` 用主人的语言写一句"为了什么"（卡片已经显示了做什么）；`platforms` 填正在回答的那条消息的 `source`，后台或定时的工作不填；不要再发消息复述请求，不要让主人输入命令；被拒绝后不要换个办法达到同样结果 |
| 拦下时的回执（`guard.ts` `hold`） | `pending approval a12: X needs the owner's approval and did not run. The owner has been asked; … (the request expires at <ISO>)` | `pending approval a12: X did not run. The owner was asked on qq; the request expires in 10 minutes. Carry on with what does not depend on it, or end the turn. Do not call it again until approval.decided arrives.` |
| `approval_request` 的描述 | 提前请求一次具体的调用 | 说明什么时候用（已经知道后面要用受限工具、需要补理由或换平台重发），以及 `platforms` 的含义 |
| `approval.decided` 事件 | 同意 / 拒绝两句 | 同意：点明"现在用完全相同的输入再调一次"；拒绝：带上主人的话；带授权时说明范围与到期 |
| 新增 `approval.expired` 事件（L3） | 过期不通知，助理一直等 | `Approval a12 expired without an answer. It did not run. Ask again only if it is still needed.` |
| 三份连接器 `ENV_PROMPT.md` | `The owner approves or denies requests by replying "/approve <id>"…` | 删掉。怎么决定是平台的事，助理不需要知道，也就不会教主人打命令 |
| `skills/protea-self-ops` "Restricted tools" | "Tell the owner what you want to do and why, in one line" | 改成写进 `_approval.reason`；加上选平台与过期后的做法 |
| `plugins/cron/ENV_PROMPT.md` | 只讲工具 | 加：主人能在控制台看到并修改这些任务，所以名称要让人看得懂；被操作者改动时会收到 `schedule.changed` |

---

## 5. 控制台的页面与布局

原则：先回答"现在需要我做什么"，再是"它在做什么"，最后才是"它是怎么配置的"。

### 5.1 侧边栏

| 分组 | 页面 | 变化 |
|---|---|---|
| — | 总览 | 重排（§5.2） |
| 待办 | 审批、定时任务 | 审批只留"等我决定的事"；定时任务是新页 |
| 观察 | 运行流、会话、日志 | 日志从「系统」移来 |
| 能力 | 插件、MCP、Skills、模型、记忆与人格 | 不变 |
| 系统 | 权限、配置 | 「权限」是新页：把审批页的权限模式、时限授权、审计与「配置 → 权限」的规则合到一处 |

只有需要处理的数量才显示徽标。侧边栏可以收成图标栏（记在本地）。旧地址（`approvals?tab=grants|audit`、`config?tab=permissions`）跳到新位置。

### 5.2 各页

- **总览**：最上面是"需要你处理"（待审批、能力变更、异常的插件或 MCP、模型未就绪、预算告警、投递暂停；没有时显示"一切正常"）。接着四个数字块：当前状态、今日费用、上下文占用、排队的事件。下面两栏：左边"正在做什么"（当前这一批、进行中的 Fork、最近的活动），右边"接下来"（定时任务 3 条）与预算。工具数、Skills 数、记忆文件数等收进折叠的"运行详情"。
- **审批**：收件箱。"待处理"里工具调用与能力变更按时间排在一起，用 §2.5 的卡片，默认展开；"已处理"按结果、工具、时间筛选，每行显示 `title` 与 `target`、谁在哪个平台决定的。
- **权限**：权限模式做成四个并排的选项卡片，说明直接写在卡片上（现在藏在悬停提示里），临时模式的时限在旁边；规则表；时限授权（有效的在前，显示范围的人话与剩余时间）；审计（类型用中文，可按类型与工具筛选）。
- **配置**：去掉权限后剩生效配置、账号、秘密、预算、事件调度（原"调度"，避免和定时任务混淆）、备份。
- **所有列表页**用同一套骨架：工具条（左筛选与搜索，右主要操作）→ 列表 → 抽屉里的详情（地址可链接）。页头去掉与标题重复的面包屑，顶栏只放全局状态。

---

## 6. 界面的细化

- **刻度**：补上间距（4 / 8 / 12 / 16 / 24 / 32）、字号（12 / 13 / 14 / 16 / 20）、控件高度（28 / 34）和层级的变量，现有的零散数值逐步换成变量。数字与时间用等宽数字。
- **对比度**：`--faint` 调到正文可读（浅色约 `#74747e`）；逐个核对徽标前景与底色。
- **新增共用组件**（`components/ui.tsx`）：`Stat`、`SegmentedControl`、`Switch`、`Menu`、`ConfirmDialog`（替换 `window.confirm`）、`Toast`（操作成功或失败的反馈）、`Skeleton`（替换"加载中…"）、`EmptyState`（图标、一句说明、下一步操作）、`Countdown`、`RelativeTime`。
- **状态徽标**统一成中文（运行中、已停止、待处理…），原值放在悬停提示里。
- **表格**：行高一致、表头吸顶、悬停高亮；720px 以下变成卡片。
- **表单**：标签在上、说明在下、错误就地显示；危险操作用红色按钮并二次确认。
- **主题**：在用户菜单里加浅色 / 深色 / 跟随系统的切换（现在只跟随系统）。
- **动效**：抽屉与弹窗 120 ms 过渡，尊重"减少动效"的系统设置。
- **样式文件**：`styles.css` 按区域拆成 tokens、base、console、chat、rich 五个文件，行为不变。

---

## 涉及的改动

| 范围 | 文件 |
|---|---|
| 协议 | `packages/protocol`：`ApprovalView`、`ApprovalRequestParams.view`、`approvals/resolved`、`ApprovalInfo.deliveredTo`、`ScheduleInfo` |
| 核心 | `permissions/approvals.ts`（view、投递目标、过期事件、拒绝附言）、`guard.ts`、`policy.ts`、`tools.ts`、`tools/registry.ts` 与 `dispatcher.ts`（`_approval`）、`plugins/host.ts`（按平台投递、`resolved`）、迁移（`approvals` 加列） |
| SDK | `plugin-sdk`：`approvalMessage`、`approvalReply`、`onApprovalResolved`；Python SDK 同步 |
| 连接器 | `qq`、`telegram`、`wechat`、`webchat`；`cron`（字段、API 用的方法、`schedule_update`） |
| 控制面 | `packages/control/src/app.ts`：`/api/schedules*`、审批接口带 `view` 与附言 |
| 网页 | `Console.tsx`、新页 `Schedules.tsx` 与 `Permissions.tsx`、`Approvals.tsx`、`Overview.tsx`、`Config.tsx`、`Chat.tsx`（`ApprovalCard`）、`components/ui.tsx`、样式 |
| 文档 | 新 ADR-0021（授权请求的呈现与投递）；更新 14、17、08、`03-plugin-protocol`、`05-control-api`、`06-storage-schema`、`06-real-world-testing`（新增 T18） |

测试：核心单测（view 生成与脱敏、`_approval` 不进哈希、按平台投递与回退、过期事件）、连接器的假服务端测试（按钮、回调、回复词的三条判定、降级）、`apps/daemon` 端到端（请求 → 在另一平台决定 → 各平台同步）、cron（暂停、手动触发、API）。`apps/daemon/test/m6-security.test.ts` 钉住的"第三方副作用工具默认询问"不变。

## 待定：需要你定的四件事

1. **`_approval` 保留字段**（推荐）。代价是每个需要审批的工具的 schema 多几十个 token，策略变化时前缀缓存失效一次。不要它的话，助理只能先调 `approval_request` 才能带理由和选平台，直接调用被拦下时仍是广播且没有理由。
2. **新增「权限」页**，把模式、规则、时限授权、审计从审批页和配置页合过去（推荐）。不拆的话只在原处重新排版。
3. **第 4 项的范围**：我理解为授权调用链路上的提示词。如果你指的是所有工具的描述（`chat_send`、`fork_spawn`、记忆工具等）都过一遍，范围要大得多，需要单独列清单。
4. **没有按钮时用回复词**（`同意` / `拒绝`，带 §2.3 的三条判定）。更保守的做法是只认引用回复和编号，不认单独的"同意"。

## 实施记录（2026-11-12）

四个待定项都按推荐实现。和方案不一样的地方：

| 方案里写的 | 实际 |
|---|---|
| QQ 的引用回复也能指定请求 | 只有 Telegram 的引用回复可以：QQ 给的是引用的序号，不是消息 id。QQ 上用按钮、编号或单独的回复词 |
| 网页卡片的 `同意 ▾` 是一个分裂按钮 | 三个并排的按钮：`拒绝…`、`同意并暂时不再问 ▾`（展开 1 小时 / 8 小时，不超过上限）、`同意` |
| 对话历史里的通知带请求 id（`output.meta.approval`），前端按 id 渲染 | 待定的请求由卡片显示（读 `/api/approvals`）；对话历史里是两行文字记录：请求了什么、结果如何。没有给输出加 `meta` |
| `ScheduleSpec.kind` 字段 | 只存 `wake` 标记，`kind` 在接口里算出来 |
| 定时任务的 ⋯ 菜单有"复制" | 没有做 |
| `/api/schedules` 有端到端测试 | 插件层有单测（暂停、修改、手动触发、重启后保留、通知助理）；HTTP 接口是在本地实例上手工调用验证的，没有自动测试 |
| Python SDK 同步 `approvalMessage` 等 | Python SDK 本来就没有投递授权请求的钩子，只给 `approvals_decide` 加了 `note` |
| 样式拆成五个文件 | 七个：`tokens`、`base`、`console`、`rich`、`chat`、`extras`（原文件末尾的差异对比与能力变更）、`components`（这次新增的） |
| 现有的零散间距、字号逐步换成变量 | 只有这次新增的样式用了刻度变量；旧样式没有逐条替换 |
| 表单统一成"标签在上、说明在下、错误就地显示" | 新的定时任务表单是这样；旧表单没有改 |
| 720px 以下表格变成卡片 | 定时任务、权限页的规则与审计是；其余页面的表格没有改 |

方案之外多做的：

- 运行流的侧边栏徽标去掉了（它一直有数字，不代表需要处理）。
- `window.confirm` 全部换成了页面内的确认框（12 处）。
- 流程图跟随手动选择的主题。
- 连接器重启后待定列表清空：单独的"同意"重新变回普通消息，按钮、控制台与 `/approve <id>` 仍然有效（见 ADR-0021 的后果）。

没有验证的：真实模型是否恰当地填写 `_approval`、QQ 官方按钮在真实账号下是否可用、Telegram 与微信的真实收发。都在 T18 里。界面是在一个临时的本地实例上用内置浏览器看的（总览、审批、处理记录、定时任务与表单、权限；桌面与手机宽度、浅色与深色），没有按惯例在真实 Chrome 里逐页核对。
