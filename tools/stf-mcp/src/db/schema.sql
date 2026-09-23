-- secops-task-factory plane schema.
-- The database is an IN-MEMORY cache rebuilt from .stf/export/*.json on load;
-- the committed export is the durable record. Column names are exported verbatim.

CREATE TABLE spec (
  seq           INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  phase         TEXT NOT NULL,          -- NEXT phase to run: specify|clarify|plan|tasks|analyze|done
  gate          TEXT,                   -- json {sessionId, runKey, reason, setAt} or null
  artefacts     TEXT NOT NULL DEFAULT '{}', -- json {phase: {path: sha256}}
  health        TEXT,                   -- json {score, highFindings, report, at} from the last passing analyze
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE task (
  seq            INTEGER NOT NULL,
  local_id       TEXT NOT NULL,         -- T001
  ordinal        INTEGER NOT NULL,      -- file order in tasks.md
  title          TEXT NOT NULL,
  phase          TEXT NOT NULL,
  story          TEXT,                  -- US1
  requirements   TEXT NOT NULL DEFAULT '[]', -- json ["FR-001"]
  parallel       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,         -- pending|in_progress|blocked|done|cancelled
  objective      TEXT,
  execution_plan TEXT,
  tests_command  TEXT,
  model_tier     TEXT,
  effort         TEXT,
  output         TEXT,
  run_key        TEXT,
  blocked_reason TEXT,
  completed_at   TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (seq, local_id)
);

CREATE TABLE artefact_hash (
  seq         INTEGER NOT NULL,
  local_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (seq, local_id, path)
);

CREATE TABLE run (
  run_key      TEXT PRIMARY KEY,
  seq          INTEGER,
  kind         TEXT NOT NULL,           -- lifecycle|implement|analyze|other
  status       TEXT NOT NULL,           -- open|completed|failed
  session_id   TEXT NOT NULL,
  summary      TEXT,
  started_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE event (
  id         INTEGER PRIMARY KEY,
  seq        INTEGER,
  kind       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  run_key    TEXT,
  session_id TEXT,
  at         TEXT NOT NULL
);

CREATE TABLE decision (
  local_id     TEXT PRIMARY KEY,        -- D-001
  seq          INTEGER,
  title        TEXT NOT NULL,
  statement    TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  status       TEXT NOT NULL,           -- accepted|superseded
  supersedes   TEXT NOT NULL DEFAULT '[]',
  resolves     TEXT NOT NULL DEFAULT '[]',
  rejects      TEXT NOT NULL DEFAULT '[]',
  consequences TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE question (
  local_id    TEXT PRIMARY KEY,         -- OQ-001
  seq         INTEGER,
  spec_ref    TEXT,                     -- e.g. "Q-002" inside spec.md
  question    TEXT NOT NULL,
  context     TEXT,
  status      TEXT NOT NULL,            -- open|resolved
  resolution  TEXT,
  resolved_by TEXT,                     -- D-001
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE alternative (
  local_id   TEXT PRIMARY KEY,          -- ALT-001
  seq        INTEGER,
  option     TEXT NOT NULL,
  summary    TEXT NOT NULL,
  tradeoffs  TEXT,
  verdict    TEXT NOT NULL,             -- chosen|rejected|open
  rationale  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE evidence (
  local_id   TEXT PRIMARY KEY,          -- EV-001
  seq        INTEGER,
  claim      TEXT NOT NULL,
  source     TEXT NOT NULL,
  detail     TEXT,
  link       TEXT,
  evidences  TEXT NOT NULL,             -- the ref it supports: D-001 | OQ-001 | 001/T003
  created_at TEXT NOT NULL
);

CREATE TABLE memory (
  local_id        TEXT PRIMARY KEY,     -- MEM-001
  kind            TEXT NOT NULL,        -- decision|lesson|open_question|resolved_open_question|constraint
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  tags            TEXT NOT NULL,        -- json array
  evidence        TEXT,
  source          TEXT NOT NULL,        -- user-initiated|agent-proposed|checkpoint
  seq             INTEGER,
  status          TEXT NOT NULL,        -- active|superseded|archived
  superseded_by   TEXT,
  archived_reason TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, tags);
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
  INSERT INTO memory_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TABLE handoff (
  local_id      TEXT PRIMARY KEY,       -- H-001
  seq           INTEGER,
  skill         TEXT NOT NULL,
  invocation    TEXT NOT NULL,
  model_tier    TEXT NOT NULL,
  effort        TEXT NOT NULL,
  fresh_session INTEGER NOT NULL DEFAULT 0,
  prompt        TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  status        TEXT NOT NULL,          -- sent|picked_up|done|archived
  continues     TEXT,                   -- previous link
  archived_reason TEXT,
  emitted_session TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  picked_up_at  TEXT,
  updated_at    TEXT NOT NULL
);
