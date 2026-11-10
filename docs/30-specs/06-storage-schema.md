# 规范：存储 Schema

> 状态：Accepted（M0–M6）· 更新：2026-11-04 · 设计：[../10-architecture/03-event-store-and-bus.md](../10-architecture/03-event-store-and-bus.md)

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

`sessions` 的用法：主会话一行（`id='main'`、`kind='main'`）；每个 Fork 一行（M1）：`kind='fork'`，`state` ∈ `queued|running|paused|completed|cancelled|failed`，`level` 为 Fork 等级，`parent_id` 为派生它的批，`model` 为模型角色（`fork|cheap|main`），路径相对数据目录，结束时写 `ended_at` 与 `summary`（结果前 2000 字符或错误）。

`usage.level` 是用量归属的等级（主会话为批等级，Fork 为 Fork 等级），预算统计按它分组；`usage.session_id` 是 `main` 或 Fork id。

`events.eff_trigger` 在老化与 `events_promote` 时会被改写（等级 `eff_level` 不变），`state` 可能从 `archived` 回到 `pending`。

### 1.2 迁移 2：`approvals-and-audit`（M2）

```sql
CREATE TABLE approvals (                                -- id 为 'a' || seq，例如 a12
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  tool TEXT NOT NULL, owner TEXT NOT NULL,              -- owner：声明该工具的插件
  input_hash TEXT NOT NULL, summary TEXT NOT NULL, reason TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired','used')),
  session_id TEXT, batch_id TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, expires_ms INTEGER NOT NULL,
  decided_at TEXT, decided_by TEXT, used_at TEXT
);
CREATE INDEX ix_approvals_lookup ON approvals(tool, input_hash, state);

CREATE TABLE audit (                                    -- 只追加（I-8）
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  kind TEXT NOT NULL,                                   -- tool_call | tool_blocked | approval_requested | approval_decided | approval_expired | memory_write（M4）| control_write（M5）
  tool TEXT, owner TEXT, session_id TEXT, batch_id TEXT, call_id TEXT,
  input_hash TEXT, summary TEXT, policy TEXT, outcome TEXT, approval_id TEXT, detail TEXT
);
```

`input_hash` = sha256(工具名 + 换行 + 键排序后的 JSON 输入)。`summary` 与 `reason` 写入前经过秘密扫描。`control_write`（M5）是控制 API 的写请求：`summary` 为 `METHOD /path`，`owner` 为 `api:<role>` 或 `console:<role>`，`outcome` 为 HTTP 状态码。调度的运营暂停在 `kv` 的 `scheduler` / `paused`（值为暂停者），重启后保持。预算的放行与扣住名单在 `kv` 的 `budget` / `state`：`{ released: { <level>|hard: untilMs }, held: [{ cursor, level, trigger }] }`（最多 2000 条，M6）。插件的 kv 状态（例如 Telegram 的偏移量、filewatch 的快照）在 `kv` 表的 `plugin:<id>` 命名空间。

### 1.3 迁移 3：`tool-stats`（M3）

```sql
CREATE TABLE tool_stats (                               -- 每个工具一行，调度器每次执行后累加
  name TEXT PRIMARY KEY, calls INTEGER NOT NULL, failures INTEGER NOT NULL,
  total_ms INTEGER NOT NULL, last_at TEXT NOT NULL
);
```

工具搜索用 `calls` 决定每个 MCP 服务器哪几个工具保持加载。Skills 的加载统计与"本会话已加载"记录在 `kv` 表的 `skills` 命名空间（`stats`、`loaded:main`）。

### 1.4 迁移 4：`memory-index`（M4）

```sql
CREATE TABLE memory_files (                             -- 已索引的记忆文件，用于启动时增量同步
  path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, body, tokenize = 'trigram');
```

`path` 相对 `/data/memory`。`blobs/` 与隐藏文件、超过 1 MB 或含 NUL 的文件不进索引。启动时按 `(mtime_ms, size)` 与目录比对；记忆工具的写入立即更新；目录监视补上外部改动。

### 1.5 迁移 5：`accounts`（2026-11-05）

```sql
CREATE TABLE accounts (                                 -- 控制台账号
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,                               -- "scrypt$N$r$p$<盐>$<哈希>"（base64url）
  role TEXT NOT NULL CHECK (role IN ('admin','readonly')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE auth_sessions (                            -- 控制台会话
  id TEXT PRIMARY KEY,                                  -- cookie 值的 SHA-256（hex），cookie 本身不存
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,   -- 用令牌登录的会话为 NULL
  role TEXT NOT NULL CHECK (role IN ('admin','readonly')),
  via TEXT NOT NULL CHECK (via IN ('password','token')),
  token_fp TEXT,                                        -- 令牌登录：令牌指纹，令牌换了会话即失效
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,   -- 30 天
  address TEXT, user_agent TEXT
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);
```

没有管理员账号时控制台进入初始化（[../10-architecture/13-control-plane.md](../10-architecture/13-control-plane.md) §2）。过期会话在创建新会话时顺带清理（至多每小时一次）。诊断包不导出这两张表；备份会带上它们（密码只有哈希）。

### 1.6 迁移 6：`outputs`（2026-11-05）

```sql
CREATE TABLE outputs (                                  -- 插件发给主人的输出（con_send 回复、审批提示）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,                                     -- ISO（UTC），与 events.received_at 同格式，便于按时间合并
  plugin TEXT NOT NULL, channel TEXT,                   -- console：channel 为 console（回复）或 approvals（审批提示）
  text TEXT NOT NULL,
  session_id TEXT, batch_id TEXT                        -- 发出它的工具调用所在的会话与批（插件没给时为 NULL）
);
CREATE INDEX ix_outputs_plugin_at ON outputs(plugin, at);
CREATE INDEX ix_outputs_batch ON outputs(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX ix_events_source_received ON events(source, received_at);
CREATE INDEX ix_events_batch ON events(batch_id) WHERE batch_id IS NOT NULL;
```

控制台「对话」页的历史（`GET /api/chat`）= `console.message` 事件 + `plugin = 'console'` 的输出，按 `(at, 种类, id)` 倒序分页。迁移之前发出的回复在第一次启动时从主会话转录（`sessions/main.*.jsonl`）里找回：迁移时间之前、结果不是错误的 `con_send` 调用，各补一行；完成后在 `kv`（`core` / `outputs.backfilled`）记下，只做一次。和 `events` 一样不自动清理。诊断包不导出这张表（里面是回复正文）；备份会带上。`model.error` 内部事件从此在 `meta` 里带 `batchId` 与 `kind`，对话页据此说明某条消息为什么没有回复。

### 1.7 迁移 7：`memory-layers`（2026-11-10）

```sql
CREATE TABLE board_items (                              -- 白板；已关闭的条目保留
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  section TEXT NOT NULL,                                -- goals | todo | notes
  text TEXT NOT NULL, due TEXT,
  state TEXT NOT NULL DEFAULT 'open',                   -- open | done | dropped
  outcome TEXT, source TEXT,                            -- source：添加它的批
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX ix_board_state ON board_items(state, section);
DROP TABLE memory_fts;
DELETE FROM memory_files;                               -- 下次启动时全部重新索引
CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, summary, keywords, body, body_text UNINDEXED, tokenize = 'unicode61');
```

`summary`、`keywords`、`body` 是把 CJK 切成重叠二元组后的文本，`body_text` 是原文（用于片段）。kv 命名空间 `memory` 有两项：`board`（`rev`、`externalRev`、`seq`）与 `dream`（最近一次整理的状态）。转录的消息记录增加可选字段 `boardRev`：这条消息显示了哪个外部修订的白板。

### 1.8 后续迁移（计划）

| 表 | 用途 | 里程碑 |
|---|---|---|
| `plugin_state` | 插件生命周期状态（M2 用内存状态 + `config.yaml` 的 enabled，未建表） | 按需 |
| `blobs` / `event_blobs` | 附件元数据与引用计数 | 按需（随 `blob/*` 协议方法） |

## 2. 文件

| 路径 | 格式 | 说明 |
|---|---|---|
| `sessions/main.current` | 文本 | 当前主转录的文件名；交接时以"临时文件 + rename"切换（M4） |
| `sessions/main.<seq>.jsonl` | NDJSON | 主会话转录，只追加，每条记录写入后 `fdatasync` |
| `sessions/forks/<id>.jsonl` | NDJSON | Fork 转录，记录格式同主转录；缺失回执的占位文本为 `[result missing (fork paused/restarted)]`；结束时追加 `fork_ended` 标记 |
| `sessions/forks/<id>.checkpoint.json` | JSON | Fork 检查点，每回合与状态变化后以"临时文件 + rename"原子替换（字段见 [05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) §5.3） |
| `plugins/<id>/` | 目录 | 安装到数据卷的插件（覆盖同名内置插件）；`.install-*` 是安装中的临时目录 |
| `plugin-data/<id>/` | 目录 | 插件的可写数据目录（初始化参数 `dataDir`） |
| `plugin-data/mcp/<id>/` | 目录 | stdio MCP 服务器的默认工作目录 |
| `skills/<name>/` | 目录 | 用户 Skills（`SKILL.md` + 附带文件）；`.install-*` 是安装中的临时目录 |
| `workspace/` | 目录 | 向 MCP 服务器声明的根目录（roots）；`shell` 工具的工作目录（M6） |
| `inbox/` | 目录 | `filewatch` 默认监视的目录 |
| `runs/<runId>/log.jsonl` | NDJSON | 本次运行的结构化日志（debug 及以上） |
| `runs/<runId>/transcript.jsonl` | NDJSON | 启动修复时移出的内容（`truncated-tail`、`orphan-result-drop`） |
| `runs/<runId>/shutdown.json` | JSON | 正常关停的记录（M5，字段见 [15-observability.md](../10-architecture/15-observability.md) §4）；只保留最近 `observability.keepRuns` 个运行目录 |
| `runs/<runId>/crash/<time>.json` | JSON | 未捕获异常 / 未处理拒绝的报告：错误、堆栈、最近 200 条总线记录（M5）；写盘前过滤秘密值（M6） |
| `runs/<runId>/provider.jsonl` | NDJSON | 录制模式下每次模型调用一行：`seq, at, role, model, ms, response?, error?, request?`（M6） |
| `backups/protea-backup-<time>[/｜.tar.gz]` | 目录或 tar.gz | `protea backup` 的输出：`protea.db`（在线备份）、复制的数据目录与 `manifest.json`（`format, createdAt, protea, schema, items, files, bytes, dbSha256, excluded`）（M6） |
| `backups/protea-v<N>-<time>.db` | SQLite | 迁移前的快照（入口脚本的 `protea migrate`，M6） |
| `backups/pre-restore-<time>/` | 目录 | `protea restore --force` 移开的旧文件（M6） |
| `replays/<time>/` | 目录 | `protea replay` 的离线数据目录（`data/`）与日志（M6） |
| `cache/` | 目录 | npm/uv/pip 缓存与 `backup-git/<hash>/`（Git 备份的工作副本）；可以清空（M6） |
| `secrets/<NAME>` | 文本，0600 | 秘密（API 令牌 `PROTEA_ADMIN_TOKEN`、供应商密钥 `PROVIDER_<ID>_API_KEY`、初始化前的设置码 `PROTEA_SETUP_CODE` 等） |
| `secrets/mcp-oauth/<id>.json` | JSON，0600 | MCP 服务器的 OAuth 客户端注册、令牌与 PKCE verifier |
| `persona/*.md` | Markdown | 人格文件，首次启动从默认人格复制；`persona/hooks.{ts,mts,mjs,js}` 为可选钩子（M4） |
| `memory/` | 目录（0700），文件 0600 | 记忆（M4）：`INDEX.md`（发布副本进系统前缀）、`journal/`、`notes/`、`handoff/<UTC>Z.md`（压缩笔记）、`raw/<UTC>Z.md`（被压缩的对话原文）、`blobs/`；首次启动从 `personas/default/memory/` 创建 |
| `sessions/main.<seq>.jsonl.abandoned-<ms>` | NDJSON | 交接在切换指针前崩溃留下的新转录（不再使用） |
| `protea.lock` | 文本 | 单实例锁（pid） |

### 2.1 转录记录

```jsonc
{"t":"mark","kind":"session_start","file":"main.0001.jsonl","at":"…"}
{"t":"msg","role":"user","content":[{"type":"text","text":"<events …>…</events>"},{"type":"text","text":"<status …/>"}],"batch":"b_…","cursors":[18233,18234],"at":"…"}
{"t":"msg","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"…"},{"type":"tool_use",…}],"batch":"b_…","usage":{…},"stop":"tool_use","model":"claude-opus-5-5","at":"…"}
{"t":"msg","role":"user","content":[{"type":"tool_result",…}],"batch":"b_…","at":"…"}
{"t":"mark","kind":"model_call_cancelled","batch":"b_…","reason":"preempt","by":18251,"at":"…"}
{"t":"mark","kind":"turn_cancelled","batch":"b_…","reason":"interrupt","by":18240,"during":"tools","at":"…"}
{"t":"mark","kind":"batch_ended","batch":"b_…","reason":"end_turn","rounds":2,"resumable":false,"at":"…"}
{"t":"mark","kind":"repair","actions":[{"action":"drop-result","msgIndex":7,"toolUseId":"toolu_…"}],"at":"…"}
{"t":"mark","kind":"prefix","hash":"3f2a…","floor":42,"at":"…"}
{"t":"mark","kind":"handoff","to":"main.0002.jsonl","notes":"handoff/2026-11-03T08-00-00Z.md","reason":"…","at":"…"}
{"t":"mark","kind":"handoff_from","file":"main.0001.jsonl","notes":"handoff/2026-11-03T08-00-00Z.md","reason":"…","dropped":120,"kept":14,"at":"…"}
```

M4：`prefix` 记录下一次请求的前缀指纹；带 `floor` 时，序号小于 `floor` 的 `msg` 记录发送时去掉 thinking 块（[../10-architecture/05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) §8.1）。`handoff` 写在旧转录末尾，`handoff_from` 写在新转录开头。

`batch_ended.reason` 取值：`end_turn`、`ends_turn`、`max_tokens`、`refusal`、`round_limit`、`model_error`、`interrupted`（M1）、`context_overflow`（M4）、`handoff`（M4：空闲时手动交接后，新转录以 user 消息结尾，不需要续跑）、`aborted`；只有 `aborted` 是 `resumable: true`。

`msgIndex` 指已提交的 `msg` 记录序号（从 0 开始），因此修复动作在任何一次加载中都指向同一条消息。修复规则见 [../10-architecture/05-sessions-and-agent-loop.md](../10-architecture/05-sessions-and-agent-loop.md) §6.2。
