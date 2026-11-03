# ADR-0006：SQLite 单文件存储 + 文件目录

状态：Accepted · 日期：2026-11-03 · 相关：[../30-specs/06-storage-schema.md](../30-specs/06-storage-schema.md)

## 背景

单实例、零运维、容器内持久化到一个卷；需要事务、索引查询、全文检索；备份要简单。

## 决策

- 结构化数据（事件、投递、批、会话索引、审批、用量、审计、KV）存 **SQLite**（WAL 模式）单文件 `/data/protea.db`，使用 `better-sqlite3`（同步 API，在单线程事件循环内对小事务是最快且最简单的选择；长查询放 worker）。
- 会话转录、记忆、人格、Skills、插件代码为**文件**（人可读、可 Git）。
- 全文检索用 SQLite FTS5；向量检索（v2）用 sqlite-vec 扩展。

## 备选方案

- PostgreSQL：功能更强，但需要第二个容器或外部服务。
- 纯 JSONL 日志 + 内存索引：启动重建成本随事件量增长；查询能力弱。
- LevelDB/RocksDB：无 SQL、无 FTS。

## 后果

- 单写者；所有写入经守护进程，插件通过宿主 API 写。
- 备份用 SQLite 在线备份 API，避免复制中的 WAL 不一致。
- 数据库 schema 版本化与迁移脚本是发布流程的一部分。
