# 测试策略

> 状态：Draft（M6 起与实现对齐的部分见各节注）· 更新：2026-11-04

## 1. 金字塔

| 层 | 工具 | 覆盖 | 运行时机 |
|---|---|---|---|
| 单元 | Vitest | 门禁、调度矩阵、窗口/老化、转录修复、渲染、清单校验、策略决策 | 每次提交 |
| 组件 | Vitest + 真实 SQLite（临时文件）+ `ProviderRecorder` 夹具 | Event Store、Session loop、Context Assembler、Plugin Host（用 FakeHost / 真子进程） | 每次提交 |
| 协议一致性 | 共享用例集，对 TS 与 Python SDK 各跑一遍 | 插件协议 | 每次提交 |
| 端到端 | 真实守护进程 + 桩 Provider（可切真网）+ 模拟连接器 | 路线图中的验收场景 | PR 合并前 |
| 回放回归 | `protea replay`（M6）+ 录制的 `provider.jsonl` | 人格/提示/调度变更的行为回归 | PR 合并前（离线；评测集尚未建立） |
| 容器冒烟 | `scripts/container-smoke.sh`（M6） | 非 root、健康检查、插件资源上限、回复、stop/start 不丢事件、容器内备份、迁移 | CI 每次推送（full 与 slim） |
| 真网冒烟 | 真实 Anthropic API | 模型 ID、beta 头、流式、工具搜索 | 每周 + 发布前 |
| 实际测试 | 真实 API key、网络、账号与长时间使用（[06-real-world-testing.md](06-real-world-testing.md)） | 各里程碑需要真实条件的验收项 | 在实际使用中做，结果附诊断包 |
| 长稳/压测 | `scripts/soak.mjs`（M6，无依赖）+ echo Provider | 内存、存储增长、延迟 | 每个里程碑末跑加速短程；长时间运行留给实际使用观察 |

## 2. 不变量测试

[01-system-overview.md](../10-architecture/01-system-overview.md) §5 的八条不变量各有一组属性测试（fast-check）：随机事件序列 + 随机取消/崩溃注入 → 检查投影一致（I-2）、历史只追加（I-4）、抢占方向（I-5）等。

## 3. 确定性

- 调度器与会话循环使用可注入的时钟与随机源；测试中用虚拟时间推进窗口。
- Provider 响应用录制夹具；夹具带模型 ID 与 API 版本标记，过期时冒烟测试告警。

## 4. 故障注入

- 插件：握手超时、心跳丢失、工具抛错、无限输出、违反协议。
- Provider：429/529、流中断、`refusal`、输入过长、慢响应触发取消。
- 存储：磁盘满、WAL 损坏（启动时的错误路径）。
- 进程：`kill -9` 守护进程于各阶段（delivering/model/tools/handoff）。

## 5. 安全测试

渗透用例固化为测试：伪造 owner、越权等级、注入指令的外部内容触发副作用、秘密出现在各出口（请求体、日志、工具回执）。M6 的实现在 `apps/daemon/test/m6-security.test.ts`，同一文件还有默认策略审查与"哪些代码能读秘密值"的静态检查（[../10-architecture/14-security-and-permissions.md](../10-architecture/14-security-and-permissions.md) §9）。

## 6. 覆盖率与门禁

- `packages/core` 行覆盖 ≥ 85%，分支 ≥ 75%；调度器与转录修复 100% 分支。
- CI 阻断：lint、typecheck、单元/组件/协议测试、Docker 构建、镜像扫描高危。M6 的 `.github/workflows/ci.yml` 已有 typecheck、构建、全部测试、`pnpm audit --prod --audit-level high`、两种镜像的构建与容器冒烟测试、Trivy（HIGH/CRITICAL、有修复的）；lint 与覆盖率门槛尚未加入。
