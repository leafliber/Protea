# ADR-0010：控制台账号与设置码初始化；模型供应商档案

状态：Accepted · 日期：2026-11-05 · 相关：[../10-architecture/12-model-providers.md](../10-architecture/12-model-providers.md) §3、[../10-architecture/13-control-plane.md](../10-architecture/13-control-plane.md) §2、[../30-specs/04-config-reference.md](../30-specs/04-config-reference.md)

## 背景

M0–M6 里模型固定是 Anthropic：配置 `providers.anthropic`，密钥是秘密 `ANTHROPIC_API_KEY`，要么放环境变量，要么 `docker exec … secrets set` 再重启。控制台用管理员令牌登录，令牌要从数据卷里读出来再粘贴。

主人要求：

- 供应商可以选，模型、接口地址与协议都能指定；
- 不依赖环境变量；
- 首次通过网页的引导建账号，用启动时打印的密钥鉴权；
- 登录后在网页里配置供应商。

## 决策

- **供应商档案**：`providers.profiles.<id>` 描述一个供应商（协议、地址、密钥秘密名、每个角色的模型与 effort、限额、价格）。`providers.default` 选默认档案，`providers.roles` 可以给某个角色换档案。守护进程的唯一 Provider 是路由器，按角色转发；档案热更新，密钥存入即生效。
- **内置三种协议**：`anthropic`（官方 SDK；`features: basic` 给其他厂商的 Anthropic 兼容接口）、`openai-chat`（Chat Completions，覆盖绝大多数厂商与本机服务）、`openai-responses`（OpenAI 的新接口），外加离线的 `echo`。OpenAI 风格的两种用 `fetch` + SSE 实现，不引入 OpenAI SDK。
- **命名**：密钥秘密默认 `PROVIDER_<ID>_API_KEY`，与厂商无关。默认配置不含任何档案；旧写法与旧密钥文件在启动时一次性迁移。
- **账号**：`accounts` 表（scrypt）与服务端会话 `auth_sessions`（cookie 只是随机串，库里存哈希）。角色仍是 `admin` 与 `readonly`。
- **设置码**：没有管理员账号时生成一次性设置码，存为秘密 `PROTEA_SETUP_CODE`，并绕过日志器打印到标准输出；控制台用它创建第一个管理员，之后作废。
- **API 令牌保留**：给 CLI、脚本与 Prometheus 用；控制台登录页可以"改用 API 令牌登录"作为恢复手段（会话绑定令牌指纹）。

## 备选方案

- **`openai-compat` 做成 `kind: provider` 插件（原 M7 计划）**：要把流式输出、取消与错误分类再经 JSON-RPC 转一层，换来的隔离对一个 HTTP 客户端没有意义。插件形式留给需要私有 SDK 的情况。
- **把供应商存进数据库**：配置就不再是一份可读、可备份、可版本管理的 `config.yaml`，环境变量层也覆盖不了。现在仍放在 `config.yaml` 里（控制台写回时保留注释），密钥留在秘密存储。
- **继续用令牌登录、只把令牌打印出来**：令牌长期有效，被看到一次就一直能用；也没法区分是谁做的操作。账号让审计写出用户名，密码可以改，会话可以注销。
- **首次访问直接建账号、不要设置码**：同一网络里谁先打开页面谁就成了管理员。设置码只有能看容器日志或数据卷的人拿得到。
- **无状态 HMAC cookie（M5 的做法）**：不存会话，但无法单独注销，改密码也无法让别处的登录失效。

## 后果

- 新部署第一次必须在控制台（或 `protea setup`）完成初始化，否则助理不能回答；`/readyz` 会说明原因。
- 设置码出现在容器的标准输出里。`docker logs` 的读者本来就能读数据卷，风险相当；建好账号后它就失效。
- 非 Anthropic 的协议没有工具搜索、精确计数、服务端压缩与思考块回传：工具多时全部直接发送，交接按估算；缓存命中率取决于厂商的自动缓存。在 Claude 与其他模型之间切换时，思考块只发回给 Claude（`basic` 模式也不发）。
- 环境变量层仍然可以完整配置供应商（适合自动化部署），但它覆盖的值在控制台里改不掉。
