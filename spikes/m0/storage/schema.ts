// The tables of A1 3.4 and 3.12 that a realistic corpus needs, at spike level: the space row,
// actors, grouping, tasks with their notes, log entries and sources, the history (commits,
// receipts, changes, history_text), the outbox, projection_files and the search index. Columns and constraints follow
// A1 so row sizes and index shapes are close to the real schema. Labels, learnings, places,
// launches, sessions, runs, routines, proposals, preferences and exchanges are left out.
import type { DatabaseSync } from "node:sqlite";

/**
 * The changes table of A1 3.4 with its indexes. The bench keeps A1's WITHOUT ROWID layout. The
 * history-layout measurement (layout.ts) also builds it with a rowid, for M1 to decide.
 */
export const CHANGES = `CREATE TABLE changes (
  seq        INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  op         INTEGER NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  task_id    TEXT,
  action     TEXT NOT NULL CHECK (action IN ('create','set')),
  field      TEXT,
  before     TEXT,
  after      TEXT,
  before_ver INTEGER,
  before_prov INTEGER,
  after_prov INTEGER,
  PRIMARY KEY (seq, n)
) STRICT, WITHOUT ROWID;
CREATE INDEX changes_task   ON changes(task_id, seq);
CREATE INDEX changes_entity ON changes(entity_id, seq);`;

export const SCHEMA = `
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE space (
  one               INTEGER PRIMARY KEY CHECK (one = 1),
  space_id          TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  ref_prefix        TEXT    NOT NULL CHECK (ref_prefix GLOB '[A-Z]*' AND length(ref_prefix) BETWEEN 1 AND 6),
  format_major      INTEGER NOT NULL,
  format_minor      INTEGER NOT NULL,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  next_ref          INTEGER NOT NULL DEFAULT 1,
  authority_machine TEXT    NOT NULL,
  authority_epoch   INTEGER NOT NULL DEFAULT 1,
  authority_incarnation TEXT NOT NULL,
  authority_since   INTEGER NOT NULL DEFAULT 0,
  lineage           TEXT    NOT NULL CHECK (json_valid(lineage)),
  transfer          TEXT    CHECK (transfer IS NULL OR json_valid(transfer)),
  hold              TEXT    CHECK (hold IS NULL OR json_valid(hold)),
  undo_floor_seq    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
) STRICT;

CREATE TABLE actors (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('human','agent','routine','system','import')),
  label       TEXT NOT NULL,
  instance_id TEXT,
  routine_id  TEXT,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE areas (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL,
  position TEXT NOT NULL, color TEXT, brief TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','archived')),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  ext TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ext))
) STRICT;
CREATE UNIQUE INDEX areas_slug ON areas(slug) WHERE deleted_at IS NULL;

CREATE TABLE projects (
  id TEXT PRIMARY KEY, area_id TEXT REFERENCES areas(id),
  slug TEXT NOT NULL, title TEXT NOT NULL, position TEXT NOT NULL, color TEXT,
  brief TEXT NOT NULL DEFAULT '',
  defaults TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(defaults)),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','completed','archived')),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  ext TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ext))
) STRICT;
CREATE UNIQUE INDEX projects_slug ON projects(slug) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  ref             INTEGER NOT NULL UNIQUE,
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND instr(title, char(10)) = 0),
  summary         TEXT NOT NULL DEFAULT '' CHECK (instr(summary, char(10)) = 0),
  context         TEXT NOT NULL DEFAULT '',
  lifecycle       TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','completed','archived')),
  status          TEXT NOT NULL DEFAULT 'open',
  inbox           INTEGER NOT NULL DEFAULT 0 CHECK (inbox IN (0,1)),
  priority        INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  effort          TEXT,
  due_date        TEXT,
  due_at          INTEGER,
  due_tz          TEXT,
  planned_for     TEXT,
  focus_on        TEXT,
  owner           TEXT,
  waiting_on      TEXT,
  area_id         TEXT REFERENCES areas(id),
  project_id      TEXT REFERENCES projects(id),
  position        TEXT NOT NULL,
  parent_id       TEXT REFERENCES tasks(id),
  source_at       INTEGER,
  reviewed_at     INTEGER,
  completed_at    INTEGER, completed_by TEXT REFERENCES actors(id),
  archived_reason TEXT,
  wrap_state      TEXT CHECK (wrap_state IN ('pending','wrapped')),
  outcome         TEXT,
  wrapped_at      INTEGER, wrapped_by TEXT REFERENCES actors(id),
  created_at      INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  created_session TEXT,
  deleted_at      INTEGER, deleted_by TEXT REFERENCES actors(id),
  created_seq     INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  touched         INTEGER NOT NULL,
  fv              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  ext             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ext)),
  CHECK (lifecycle <> 'active' OR wrap_state IS NULL),
  CHECK (due_at IS NULL OR (due_tz IS NOT NULL AND due_date IS NULL))
) STRICT;
CREATE INDEX tasks_open     ON tasks(lifecycle, status, project_id, position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due      ON tasks(due_date) WHERE deleted_at IS NULL AND lifecycle = 'active';
CREATE INDEX tasks_done     ON tasks(completed_at) WHERE lifecycle = 'completed';
CREATE INDEX tasks_touched  ON tasks(touched);

CREATE TABLE notes (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES actors(id),
  addressee TEXT NOT NULL DEFAULT 'self' CHECK (addressee IN ('self','agents')),
  audience  TEXT NOT NULL DEFAULT 'all'  CHECK (audience IN ('all','owner','members')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL, fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  UNIQUE (task_id, ordinal)
) STRICT;

CREATE TABLE log_entries (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES actors(id),
  session_id TEXT, run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'progress' CHECK (kind IN ('progress','evidence','blocker','decision','question','handoff')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL, fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  UNIQUE (task_id, ordinal)
) STRICT;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  source_key TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  who TEXT, ref TEXT, url TEXT, at INTEGER,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id), deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  ext TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ext))
) STRICT;
CREATE UNIQUE INDEX sources_key ON sources(source_key) WHERE source_key IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE task_sources (
  task_id TEXT NOT NULL REFERENCES tasks(id), source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT NOT NULL DEFAULT 'origin' CHECK (role IN ('origin','related','evidence')),
  position TEXT NOT NULL, added_by TEXT NOT NULL REFERENCES actors(id), removed_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  PRIMARY KEY (task_id, source_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE commits (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  epoch        INTEGER NOT NULL,
  incarnation  TEXT NOT NULL,
  at           INTEGER NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human','agent','routine','system','import')),
  principal_id TEXT NOT NULL REFERENCES actors(id),
  author_id    TEXT NOT NULL REFERENCES actors(id),
  scope_id     TEXT NOT NULL,
  machine_id   TEXT NOT NULL,
  session_id   TEXT, run_id TEXT,
  origin       TEXT NOT NULL CHECK (origin IN ('ui','cli','mcp','http','import','system','migration')),
  request_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ops          TEXT NOT NULL CHECK (json_valid(ops)),
  affected     INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  proposal_id  TEXT,
  undo_status  TEXT CHECK (undo_status IN ('done','undone','dead')),
  undone_by    INTEGER, undo_of INTEGER, redo_of INTEGER,
  revert_of    TEXT, reverted_by INTEGER,
  compacted    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scope_id, request_id)
) STRICT;
CREATE INDEX commits_undo    ON commits(principal_id, undo_status, seq) WHERE undo_status IS NOT NULL;
CREATE INDEX commits_session ON commits(session_id, seq) WHERE session_id IS NOT NULL;
CREATE INDEX commits_scope   ON commits(scope_id, at) WHERE affected > 0;

CREATE TABLE receipts (
  scope_id    TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      TEXT NOT NULL,
  seq         INTEGER,
  epoch       INTEGER NOT NULL, incarnation TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (json_valid(result)),
  at          INTEGER NOT NULL,
  PRIMARY KEY (scope_id, request_id)
) STRICT, WITHOUT ROWID;

${CHANGES}

CREATE TABLE history_text (hash TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT, WITHOUT ROWID;

CREATE TABLE outbox (
  topic TEXT NOT NULL, key TEXT NOT NULL,
  first_seq INTEGER NOT NULL, seq INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (topic, key)
) STRICT, WITHOUT ROWID;

-- What the projection last wrote (A1 3.4, 3.13), with the task's catalogue line as rendered. The
-- task index finds a task's old path when it moves. The fixture leaves the table empty: R06 fills it.
CREATE TABLE projection_files (
  path    TEXT PRIMARY KEY,
  task_id TEXT,
  sha256  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  entry   TEXT
) STRICT;
CREATE INDEX projection_files_task ON projection_files(task_id);

CREATE TABLE search_docs (
  doc       INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('task','note','log','learning','project','area')),
  entity_id TEXT NOT NULL UNIQUE,
  task_id   TEXT,
  lifecycle TEXT,
  audience  TEXT NOT NULL DEFAULT 'all',
  seq       INTEGER NOT NULL
) STRICT;
CREATE INDEX search_docs_task ON search_docs(task_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, extra,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
`;

/** The optional trigram index of A1 3.12, behind features.search_trigram until measured (R05). */
export const TRIGRAM = `
CREATE VIRTUAL TABLE search_tri USING fts5(title, body, extra, tokenize = 'trigram');
INSERT INTO search_tri(rowid, title, body, extra) SELECT rowid, title, body, extra FROM search_fts;
`;

// busy_timeout comes first on every connection: journal_mode = WAL reads the database and may
// find it locked by another connection that is opening at the same moment. Without the timeout
// installed, that read fails at once with "database is locked".

/** The writer settings of A1 3.9 (A1-3: WAL, synchronous=FULL). */
export function configureWriter(db: DatabaseSync): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -32000;
    PRAGMA trusted_schema = OFF;
  `);
}

/** The reader settings of A1 3.9: read-only plus query_only. */
export function configureReader(db: DatabaseSync): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA query_only = 1;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -32000;
    PRAGMA trusted_schema = OFF;
  `);
}
