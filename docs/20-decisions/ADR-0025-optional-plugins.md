# ADR-0025：可选插件放在 `optional-plugins/`，不随镜像分发

状态：Accepted · 日期：2026-11-12 · 相关：[../10-architecture/07-plugin-system.md](../10-architecture/07-plugin-system.md) · [../10-architecture/08-event-source-plugins.md](../10-architecture/08-event-source-plugins.md) §6.5 · [../40-plan/02-repo-layout.md](../40-plan/02-repo-layout.md)

## 背景

镜像构建时把 `plugins/*/protea.plugin.json` 所在的目录全部复制进 `$PROTEA_ASSETS_DIR/plugins`，每个实例都会发现它们（默认停用）。滴答清单插件 `dida365`（2026-11-12）也放在这里，于是每个实例的插件列表里都有它，镜像也带着它的 400 KB 打包文件，而用到它的只是有滴答清单账号的人。

这类插件和 `telegram`、`shell` 不同：它们面向某个具体服务的个人账号，不是 Protea 的基本能力。但它们仍然值得留在仓库里：和内置插件共用 SDK 与协议，一起跑类型检查和测试，协议改动时会一起改到。

## 决策

1. 仓库新增 `optional-plugins/`，放可选插件；`dida365` 移到 `optional-plugins/dida365`。镜像只复制 `plugins/*`，所以可选插件不在镜像里，守护进程也不会把它们当内置插件发现。
2. 可选插件仍是 pnpm 工作区成员，`tsconfig.json` 与 `vitest.config.ts` 包含它们，`pnpm typecheck` 和 `pnpm test` 照常覆盖。安全检查清单测试（默认审批策略）也继续检查它们的工具。
3. 安装走已有的数据卷安装：`node scripts/pack-plugin.mjs <dir> [out]` 打出一个干净目录（manifest、配置 schema、ENV_PROMPT 等运行时文件，加上 `dist/main.js` 单文件包；去掉的文件和镜像里内置插件去掉的一样），再 `protea plugins install <目录>`。Docker 部署先 `docker cp` 进容器。
4. 仓库不提交打包产物，所以不能直接用 `protea plugins install --git <仓库> --subdir optional-plugins/<id>` 安装。以后发布版本时可以把打包好的目录作为 Release 附件，用 `--tarball` 安装；这次不做。

## 备选方案

- **留在 `plugins/`，用 manifest 字段标记"不进镜像"**：Dockerfile 要读 JSON 判断，开发时守护进程仍会把它当内置插件发现，两种运行方式看到的插件列表不同。
- **移到 `examples/plugins/`**：那里是写插件的示例，不进测试；`dida365` 是要实际使用的插件，不是示例。
- **拆到独立仓库**：协议还在变（上线前不做兼容，ADR-0022），分开后每次改协议都要跨仓库同步，测试也会脱节。

## 后果

- 镜像和每个实例的插件列表里不再有 `dida365`。已经在用它的实例（它的配置在 `config.yaml` 的 `plugins.dida365`）升级镜像后它会消失，要按 README 打包安装。令牌照常生效；`config.yaml` 里原来的 `plugins.dida365` 配置留在原处，但安装时不会读它（安装本来就这样），重启一次守护进程后才生效。按 ADR-0022 不为此写迁移。
- 数据卷里的插件不会随镜像升级：可选插件更新后要重新打包、卸载、再安装，卸载会删掉 `plugins.<id>` 配置。
- 开发时（`pnpm protea serve`）同样要先打包安装，不再用 `src/main.ts` 直接运行；改插件代码时用 `pnpm protea dev-plugin optional-plugins/<id>` 调试。
