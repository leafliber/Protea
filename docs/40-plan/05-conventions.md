# 开发与文档规范

> 状态：Draft · 更新：2026-11-03

## 代码

- 工具链：Node.js ≥ 22.12（开发机已在 Node 26 验证）、pnpm 11、TypeScript 7、Vitest 5。
- TypeScript `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`，模块解析 `nodenext`（相对导入写 `.js` 后缀）；禁止 `any`（用 `unknown` + 校验）。ESLint + Prettier 在 M5 前接入。
- 所有跨进程/跨包数据结构在 `@protea/protocol` 用 JSON Schema 定义，TS 类型由 schema 生成；运行时校验用 ajv。
- 错误：自定义错误类带 `code`；不吞错；对外错误脱敏。
- 异步：显式 `AbortSignal` 贯穿工具、Provider、插件调用；禁止无超时的外部 I/O。
- 时间：内部一律 ISO 8601 带偏移；比较用 epoch ms。
- 日志：结构化字段，不拼接字符串；不记录秘密与事件全文（除非调试模式）。

## 提交与分支

- Conventional Commits：`feat(scheduler): aging promotion`；范围取包名或子系统名。
- 主干 `main` 受保护；功能分支 + PR；CI 绿 + 一人评审。
- 影响架构文档"必须/禁止"条款的 PR 必须附 ADR。

## 文档

- 架构文档描述"是什么与为什么"，规范文档描述"精确形态"；实现细节（函数名）不写进架构文档。
- 每篇文档头部：状态、更新日期、相关链接。
- 图：Mermaid；复杂图附源文件。
- 术语：首次出现链接术语表；新术语先加术语表。
- 变更：文档与代码同 PR；里程碑验收时更新状态。

## 版本

- 内核 semver；插件协议 `api` 整数版本独立递增，兼容上一版本一个大版本周期。
- 数据库迁移编号递增；不可回滚迁移在发布说明标注。
- 镜像标签：`<semver>`、`<semver>-slim`、`latest`、`edge`（main 分支）。

## 安全披露

`SECURITY.md`（M6）说明报告渠道与响应时限。
