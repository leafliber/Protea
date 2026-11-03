# 规范：存储 Schema

> 状态：Accepted（M0）· 更新：2026-11-03 · 设计：[../10-architecture/03-event-store-and-bus.md](../10-architecture/03-event-store-and-bus.md)

## 1. SQLite（/data/protea.db）

WAL 模式，`synchronous = NORMAL`，`foreign_keys = ON`。迁移以 TypeScript 数组内嵌在 `packages/core/src/db/migrations.ts`（便于打包），启动时按版本顺序在各自的事务里应用；库的版本比程序新时拒绝启动。

### 1.1 M0（迁移 1 `init`）

```sql
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);

CREATE TABLE events (
  cursor       INTEGER PRIMARY KEY AUTOINCREMENT,   -- 游标，不复用
  run          TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  source       TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('external','internal')),
  level        INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4),        -- 来源申请的等级
  trigger      TEXT NOT NULL,
  eff_level    INTEGER NOT NULL CHECK (eff_level BETWEEN 0 AND 4),    -- 门禁后的等级
  eff_trigger  TEXT NOT NULL,
  state        TEXT NOT NULL,       -- pending/archived/delivering/delivered/withdrawn/expired/discarded
  sender_key   TEXT,
  sender_role  TEXT,                -- owner/unknown，门禁时写入
  dedupe_key   TEXT,
  correlation  TEXT,
  ephemeral    INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  text         TEXT NOT NULL,
  meta         TEXT,                -- JSON
  tags         TEXT,                -- JSON 数组
  blobs        TEXT,                -- JSON 数组
  batch_id     TEXT
);
CREATE UNIQUE INDEX ux_events_dedupe ON events(source, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ix_events_state_level ON events(state, eff_level, cursor);
CREATE INDEX ix_events_source_ts ON events(source, ts);
CREATE INDEX ix_events_type ON events(type);

CREATE TABLE batches (
  id TEXT PRIMARY KEY, level INTEGER NOT NULL, reason TEXT NOT NULL,   -- window/flush/resume
  session_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  rounds INTEGER NOT NULL DEFAULT 0, end_reason TEXT
);

CREATE TABLE deliveries (                              -- 每个事件至多一行（I-2）
  cursor INTEGER PRIMARY KEY REFERENCES events(cursor),
  outcome TEXT NOT NULL, batch_id TEXT, session_id TEXT, at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, level INTEGER, parent_id TEXT,
  transcript_path TEXT NOT NULL, checkpoint_path TEXT, model TEXT,
  created_at TEXT NOT NULL, ended_at TEXT, summary TEXT
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, role TEXT NOT NULL, session_id TEXT NOT NULL,
  batch_id TEXT, level INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL, stop_reason TEXT, fallback_model TEXT
);
CREATE INDEX ix_usage_at ON usage(at_ms);

CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (ns, key));
```

`kv` 的命名空间：插件为 `plugin:<id>`（例如 cron 的动态日程存在 `plugin:cron` / `schedule:<id>`）。

### 1.2 后续迁移（计划）

| 表 | 用途 | 里程碑 |
|---|---|---|
| `approvals` | 审批请求与决定 | M2 |
| `audit` | 副作用工具调用审计 | M2 |
| `plugin_state` | 插件生命周期状态 | M2 |
| `blobs` / `event_blobs` | 附件元数据与引用计数 | M2 |
| `memory_fts`（FTS5 虚表） | 记忆全文检索 | M4 |

## 2. 文件

| 路径 | 格式 | 说明 |
|---|---|---|
| `sessions/main.current` | 文本 | 当前主转录的文件名（交接时轮换，M4） |
| `sessions/main.<seq>.jsonl` | NDJSON | 主会话转录，只追加，每条记录写入后 `fdatasync` |
| `sessions/forks/<id>.jsonl` / `.checkpoint.json` | NDJSON / JSON | Fork 转录与检查点（M1） |
| `runs/<runId>/log.jsonl` | NDJSON | 本次运行的结构化日志 |
| `runs/<runId>/transcript.jsonl` | NDJSON | 启动修复时移出的内容（`truncated-tail`、`orphan-result-drop`） |
| `secrets/<NAME>` | 文本，0600 | 秘密 |
| `persona/*.md` | Markdown | 人格文件，首次启动从默认人格复制 |
| `protea.lock` | 文本 | 单实例锁（pid） |

### 2.1 转录记录

```jsonc
{"t":"mark","kind":"session_start","file":"main.0001.jsonl","at":"…"}
{"t":"msg","role":"user","content":[{"type":"text","text":"<events …>…</events>"},{"type":"text","text":"<status …/>"}],"batch":"b_…","cursors":[18233,18234],"at":"…"}
{"t":"msg","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"…"},{"type":"tool_use",…}],"batch":"b_…","usage":{…},"stop":"tool_use","model":"claude-opus-5-5","at":"…"}
{"t":"msg","role":"user","content":[{"type":"tool_result",…}],"batch":"b_…","at":"…"}
{"t":"mark","kind":"batch_ended","batch":"b_…","reason":"end_turn","rounds":2,"resumable":false,"at":"…"}
{"t":"mark","kind":"repair","actions":[{"action":"drop-result","msgIndex":7,"toolUseId":"toolu_…"}],"at":"…"}
```

`msgIndex` 指已提交的 `msg` 记录序号（从 0 开始），因此修复动作在任何一次加载中都指向同一条消息。修复规则见 [../10-architecture/05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) §6.2。
