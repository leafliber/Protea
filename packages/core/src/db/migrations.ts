/**
 * Schema migrations, applied in order at startup. Each must be forward compatible
 * or flagged as non-reversible in release notes. See docs/30-specs/06-storage-schema.md.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE events (
  cursor       INTEGER PRIMARY KEY AUTOINCREMENT,
  run          TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  source       TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('external','internal')),
  level        INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4),
  trigger      TEXT NOT NULL,
  eff_level    INTEGER NOT NULL CHECK (eff_level BETWEEN 0 AND 4),
  eff_trigger  TEXT NOT NULL,
  state        TEXT NOT NULL,
  sender_key   TEXT,
  sender_role  TEXT,
  dedupe_key   TEXT,
  correlation  TEXT,
  ephemeral    INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  text         TEXT NOT NULL,
  meta         TEXT,
  tags         TEXT,
  blobs        TEXT,
  batch_id     TEXT
);
CREATE UNIQUE INDEX ux_events_dedupe ON events(source, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ix_events_state_level ON events(state, eff_level, cursor);
CREATE INDEX ix_events_source_ts ON events(source, ts);
CREATE INDEX ix_events_type ON events(type);

CREATE TABLE batches (
  id           TEXT PRIMARY KEY,
  level        INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  rounds       INTEGER NOT NULL DEFAULT 0,
  end_reason   TEXT
);

CREATE TABLE deliveries (
  cursor     INTEGER PRIMARY KEY REFERENCES events(cursor),
  outcome    TEXT NOT NULL,
  batch_id   TEXT,
  session_id TEXT,
  at         TEXT NOT NULL
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  state           TEXT NOT NULL,
  level           INTEGER,
  parent_id       TEXT,
  transcript_path TEXT NOT NULL,
  checkpoint_path TEXT,
  model           TEXT,
  created_at      TEXT NOT NULL,
  ended_at        TEXT,
  summary         TEXT
);

CREATE TABLE usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  at                 TEXT NOT NULL,
  at_ms              INTEGER NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  role               TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  batch_id           TEXT,
  level              INTEGER,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  stop_reason        TEXT,
  fallback_model     TEXT
);
CREATE INDEX ix_usage_at ON usage(at_ms);

CREATE TABLE kv (
  ns         TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, key)
);
`,
  },
  {
    version: 2,
    name: 'approvals-and-audit',
    sql: `
CREATE TABLE approvals (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  tool         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  input_hash   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  reason       TEXT,
  state        TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired','used')),
  session_id   TEXT,
  batch_id     TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  expires_ms   INTEGER NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  used_at      TEXT
);
CREATE INDEX ix_approvals_lookup ON approvals(tool, input_hash, state);

CREATE TABLE audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  tool         TEXT,
  owner        TEXT,
  session_id   TEXT,
  batch_id     TEXT,
  call_id      TEXT,
  input_hash   TEXT,
  summary      TEXT,
  policy       TEXT,
  outcome      TEXT,
  approval_id  TEXT,
  detail       TEXT
);
CREATE INDEX ix_audit_at ON audit(at);
`,
  },
  {
    version: 3,
    name: 'tool-stats',
    sql: `
CREATE TABLE tool_stats (
  name        TEXT PRIMARY KEY,
  calls       INTEGER NOT NULL,
  failures    INTEGER NOT NULL,
  total_ms    INTEGER NOT NULL,
  last_at     TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    name: 'memory-index',
    sql: `
CREATE TABLE memory_files (
  path        TEXT PRIMARY KEY,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, body, tokenize = 'trigram');
`,
  },
  {
    version: 5,
    name: 'accounts',
    sql: `
CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password       TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin','readonly')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_login_at  TEXT
);
CREATE TABLE auth_sessions (
  id             TEXT PRIMARY KEY,
  account_id     INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('admin','readonly')),
  via            TEXT NOT NULL CHECK (via IN ('password','token')),
  token_fp       TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  address        TEXT,
  user_agent     TEXT
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);
`,
  },
  {
    version: 6,
    name: 'outputs',
    sql: `
CREATE TABLE outputs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  plugin      TEXT NOT NULL,
  channel     TEXT,
  text        TEXT NOT NULL,
  session_id  TEXT,
  batch_id    TEXT
);
CREATE INDEX ix_outputs_plugin_at ON outputs(plugin, at);
CREATE INDEX ix_outputs_batch ON outputs(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX ix_events_source_received ON events(source, received_at);
CREATE INDEX ix_events_batch ON events(batch_id) WHERE batch_id IS NOT NULL;
`,
  },
  {
    version: 7,
    name: 'memory-layers',
    // The search index changes shape: emptying memory_files makes the sync at start index every file again.
    sql: `
CREATE TABLE board_items (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  section     TEXT NOT NULL,
  text        TEXT NOT NULL,
  due         TEXT,
  state       TEXT NOT NULL DEFAULT 'open',
  outcome     TEXT,
  source      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX ix_board_state ON board_items(state, section);
DROP TABLE memory_fts;
DELETE FROM memory_files;
CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, summary, keywords, body, body_text UNINDEXED, tokenize = 'unicode61');
`,
  },
  {
    version: 8,
    name: 'blobs-and-grants',
    sql: `
CREATE TABLE blobs (
  handle      TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  source      TEXT,
  created_at  TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX ix_blobs_created ON blobs(created_ms);

CREATE TABLE approval_grants (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  family      TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  decided_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX ix_grants_family ON approval_grants(family, expires_ms);
`,
  },
  {
    version: 9,
    name: 'chat-rich-content',
    // What a reply carries besides its text (images, choices, a widget), and the widgets themselves.
    sql: `
ALTER TABLE outputs ADD COLUMN meta TEXT;
CREATE TABLE widgets (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  code        TEXT NOT NULL,
  session_id  TEXT,
  batch_id    TEXT,
  created_at  TEXT NOT NULL
);
`,
  },
  {
    version: 10,
    name: 'change-requests',
    // Changes to MCP servers, skills and plugins that the assistant proposed and a person decides (ADR-0019).
    sql: `
CREATE TABLE change_requests (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('mcp','skill','plugin')),
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  before_text TEXT,
  after_text  TEXT,
  meta        TEXT NOT NULL,
  digest      TEXT NOT NULL,
  base_hash   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending','applied','rejected','failed','stale','expired','withdrawn')),
  session_id  TEXT,
  batch_id    TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  decided_at  TEXT,
  decided_by  TEXT,
  note        TEXT,
  result      TEXT
);
CREATE INDEX ix_changes_id ON change_requests(id);
CREATE INDEX ix_changes_state ON change_requests(state, expires_ms);
`,
  },
  {
    version: 11,
    name: 'approval-view',
    // What the owner reads (title, target, fields), where it was shown, and what the owner said.
    sql: `
ALTER TABLE approvals ADD COLUMN view_json TEXT;
ALTER TABLE approvals ADD COLUMN input_json TEXT;
ALTER TABLE approvals ADD COLUMN delivered_to TEXT;
ALTER TABLE approvals ADD COLUMN note TEXT;
`,
  },
  {
    version: 12,
    name: 'memory-chunks',
    // Search returns pieces of files; the index keeps each note's summary; memory use is recorded.
    // memory_files starts empty, so the sync at start indexes every file again.
    sql: `
DROP TABLE memory_fts;
DROP TABLE memory_files;
CREATE TABLE memory_files (
  path         TEXT PRIMARY KEY,
  mtime_ms     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  has_summary  INTEGER NOT NULL DEFAULT 0,
  indexed_at   TEXT NOT NULL
);
CREATE VIRTUAL TABLE memory_chunks USING fts5(path UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, meta, body, chars, tokenize = 'unicode61');
CREATE TABLE memory_access (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms    INTEGER NOT NULL,
  session  TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('search','hit','read','write')),
  path     TEXT,
  query    TEXT,
  hits     INTEGER
);
CREATE INDEX ix_memory_access_at ON memory_access(at_ms);
CREATE INDEX ix_memory_access_session ON memory_access(session, kind, at_ms);
`,
  },
];
