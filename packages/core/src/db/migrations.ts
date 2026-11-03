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
];
