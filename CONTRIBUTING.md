# 贡献指南

欢迎贡献代码、测试、文档和部署经验。报告故障前可以先搜索已有 Issue。涉及新能力或跨组件的改动，可以先开 Issue 讨论用途和实现范围。 [GitHub Issues](https://github.com/leafliber/Protea/issues)

## 开发环境

使用 Node.js 22.13 或更高版本，以及 `package.json` 中固定的 pnpm 版本。Fork 仓库后，克隆自己的 Fork，在仓库根目录安装依赖并构建网页。

```bash
pnpm install --frozen-lockfile
pnpm --filter @protea/web... build
PROTEA_CONTROL__LISTEN=127.0.0.1:7788 PROTEA_PROVIDERS__DEFAULT=echo pnpm dev
```

用启动输出里的设置码在本机网页上创建管理员账号。Echo 供应商可用于离线调试消息流程。修改网页时，可以另开终端运行 `pnpm web`，Vite 会把 API 请求转发给守护进程。 [本机网页](http://127.0.0.1:7788/)

| 目录 | 内容 |
| --- | --- |
| `apps/daemon`、`apps/cli`、`apps/web` | 守护进程、命令行和网页 |
| `packages/` | 事件处理、协议、控制层和插件 SDK |
| `plugins/`、`optional-plugins/` | 内置和可选插件 |
| `examples/plugins/` | TypeScript 与 Python 插件示例 |
| `docs/` | 架构、接口规范和设计决策 |

## 检查与提交

```bash
pnpm typecheck
pnpm build
pnpm test
```

用 `pnpm test <测试文件>` 运行相关测试。涉及容器、真实供应商或外部聊天平台的改动，可以按对应测试流程记录验证结果。 [测试策略](docs/40-plan/03-testing-strategy.md) · [实际测试指南](docs/40-plan/06-real-world-testing.md)

1. 从最新的 `main` 创建工作分支，按仓库惯例写提交信息，例如 `fix(cli): handle empty input`。 [开发与文档规范](docs/40-plan/05-conventions.md)
2. 为行为变化补充回归测试，更新受影响的用法、配置或接口文档。
3. 向 `main` 提交 PR，说明变更原因、验证结果和升级影响，关联相关 Issue。

提交内容请遵循仓库许可证，并保留第三方版权与许可声明。对社区成员的交流要求和漏洞报告方式见对应政策。 [许可证](LICENSE) · [行为准则](CODE_OF_CONDUCT.md) · [安全政策](SECURITY.md)
