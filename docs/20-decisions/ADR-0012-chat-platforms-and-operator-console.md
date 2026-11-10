# ADR-0012：对话走平台中枢，控制台只观察与注入

状态：Accepted · 日期：2026-11-10 · 相关：[../10-architecture/17-chat-and-console.md](../10-architecture/17-chat-and-console.md) · [../10-architecture/13-control-plane.md](../10-architecture/13-control-plane.md) §5

## 背景

网页早已分成对话窗口和控制台，但底层是同一个 `console` 连接器：事件流页的输入框、`protea events push` 和测试事件都会变成对话气泡；模型的正文只进转录，批结束后才看得到；实际发给模型的上下文没有接口可看。每接一个新平台，模型又要多学一个"回复主人"的工具（`tg_send`、`con_send`……）。

## 决策

- **对话与控制台是两件事。** 对话只有模型通过工具发给主人的内容和主人的输入；控制台显示全部过程：事件、用户输入、上下文、思考、正文、工具调用与结果、发出的消息、调度动作。
- **一个 `chat_send` 工具，`platform` 必填。** 工具归 Core 的对话中枢（`packages/core/src/chat/hub.ts`），schema 的枚举是正在运行的平台。平台是声明了对话能力的连接器；内置平台是 `webchat`。
- **入站统一成 `chat.message`，`source` 是平台 id。** 模型回到消息来的平台；主动发起时看 `<status/>` 的 `last_chat`。
- **中枢负责记录。** 发送成功后写入 `outputs`（`channel = chat`）并发到实时流，平台插件不用管，所以任何平台的对话控制台都看得到。
- **`console` 收窄为运维注入**：没有回复工具，模型对注入的回应就是它的正文，显示在运行流里。
- **运行流是总线的观察记录**（`model.request`、`model.delta`、`model.response`、`tool.call`），不改变运行：观察用的回调不算"外部输出"，模型调用仍可被抢占。增量不落库；历史从转录重建。
- **旧数据不改写**：`kv` 记一个分界游标，分界之前的 `console` 对话继续算作 `webchat`。转录里还有 `con_send` 时启动后做一次交接，新对话里不再有旧工具的例子。

## 备选方案

- 每个平台各有回复工具（`tg_send`、`wc_send`）：模型要记多套约定，接新平台要改提示词；平台间的记录和限流也各做一遍。
- `platform` 选填、默认最近的平台：提醒和后台任务发错地方时没人察觉。主人明确要求必须指定。
- `chat_send` 放在 `webchat` 插件里，其他平台注册到它名下：内置插件成了别的插件的依赖，禁用它就没有对话工具了。
- 对话页直接显示模型正文：模型的思考过程和对主人说的话混在一起，这正是要拆开的东西。
- 改写历史事件的来源：违背事件日志只追加（ADR-0002），`protea replay` 的结果会和转录对不上。
- 给运行流加存储：转录、`outputs`、`usage` 已经有全部内容，再存一份只是重复。

## 后果

- 平台启停会改变工具 schema，提示缓存失效一次（和任何插件工具变化一样）。
- 升级后系统前缀变化，且有一次交接。
- `permissions.tools.con_send`、Skill 的 `allowed-tools: tg_send` 这类旧配置不再匹配任何工具，需要改成 `chat_send`。
- 出站限流按 `chat_send` 的 `platform` 计，和同一平台的其他工具共享额度。
