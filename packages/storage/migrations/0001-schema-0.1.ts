// Schema 0.1 (A7 3.8 M1.03): the tables the core slice needs, from A1 3.4. Creating a space runs
// this step on an empty database, and M1.06's migration runner takes it as revision 0.1 unchanged.
//
// FROZEN. Real spaces at 0.1 exist (M3.01), so this step never changes again: every change to the
// schema is a new step (A1 3.17). The 0.1 fixture builder (storage's
// test/revisions.ts, testkit's seedMira with its steps) creates 0.1 spaces with this file, and the
// known 0.1 sample's digest (testkit FIXED_SAMPLE_0_1) pins what it produces.
//
// Departures from A1 3.4's DDL:
// - `space.hold` arrives with schema 0.2 (A7 3.8 M3.01 lists it there).
// - `changes` keeps a rowid: change rows of up to a few KB spill to overflow pages in a WITHOUT
//   ROWID table (the M0 lab measured 203 MB against 140 MB for the same rows and indexes).
// - `changes.before` and `changes.after` hold JSON, so they get A1's json_valid CHECK like every
//   other JSON column.
// - `space.ref_prefix` and `places.root_id` check every character, not only the first, as A1's
//   prose states ("1 to 6 upper-case letters", "lower case").
// - `machines` gets `fv` and `fp` like every other mutable row (A1 3.4's convention; its DDL
//   left them out although `name` and `retired_at` change).
// - `outbox`, which A1 3.7 gives as a column list, is WITHOUT ROWID: small rows, a text key.
// - `commits.compacted` is an integer flag, so it gets `CHECK (compacted IN (0,1))` like `inbox`
//   and `policy`.
// - `receipts` (A7 3.8 M1.05) joined this step in place, before any real space existed
//   (A1 3.17). Its `status` is a closed set, so it gets a CHECK with A1 3.7's five statuses.
// - `launches` (A7 3.9 M2.05) joined this step in place too, still before any real space existed
//   (A1 3.4). It departs from A1 3.4's DDL: `place_id` replaces
//   `folder`, so the space holds no absolute path (A1 3.15 keeps roots machine-local); it gets
//   `fv` and `fp` like every mutable row; `reference` checks its alphabet; `route` is an open set
//   the writer checks; and two indexes serve recovery (`openWork`) and a task's launches.
import type { Connection } from "../src/driver.ts";
import { misuse } from "../src/errors.ts";
import type { SchemaStep } from "../src/schema.ts";

const TABLES = [
  "space",
  "actors",
  "machines",
  "areas",
  "projects",
  "tasks",
  "notes",
  "log_entries",
  "sources",
  "task_sources",
  "places",
  "aliases",
  "preferences",
  "commits",
  "receipts",
  "changes",
  "outbox",
  "launches",
] as const;

export const SCHEMA_0_1_SQL = `
CREATE TABLE space (
  one               INTEGER PRIMARY KEY CHECK (one = 1),
  space_id          TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  ref_prefix        TEXT    NOT NULL
                    CHECK (length(ref_prefix) BETWEEN 1 AND 6 AND ref_prefix NOT GLOB '*[^A-Z]*'),
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

CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  os          TEXT NOT NULL CHECK (os IN ('linux','windows','macos')),
  first_seen  INTEGER NOT NULL,
  retired_at  INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT;

CREATE TABLE areas (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL,
  position TEXT NOT NULL, color TEXT, brief TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','archived')),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
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
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
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
CREATE INDEX tasks_open    ON tasks(lifecycle, status, project_id, position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due     ON tasks(due_date) WHERE deleted_at IS NULL AND lifecycle = 'active';
CREATE INDEX tasks_done    ON tasks(completed_at) WHERE lifecycle = 'completed';
CREATE INDEX tasks_touched ON tasks(touched);

CREATE TABLE notes (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES actors(id),
  addressee TEXT NOT NULL DEFAULT 'self' CHECK (addressee IN ('self','agents')),
  audience  TEXT NOT NULL DEFAULT 'all'  CHECK (audience IN ('all','owner','members')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  UNIQUE (task_id, ordinal)
) STRICT;

CREATE TABLE log_entries (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES actors(id),
  session_id TEXT, run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'progress'
       CHECK (kind IN ('progress','evidence','blocker','decision','question','handoff')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
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
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  ext TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ext))
) STRICT;
CREATE UNIQUE INDEX sources_key ON sources(source_key)
  WHERE source_key IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE task_sources (
  task_id TEXT NOT NULL REFERENCES tasks(id), source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT NOT NULL DEFAULT 'origin' CHECK (role IN ('origin','related','evidence')),
  position TEXT NOT NULL, added_by TEXT NOT NULL REFERENCES actors(id), removed_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp)),
  PRIMARY KEY (task_id, source_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE places (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('task','project','area')),
  owner_id   TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  root_id    TEXT NOT NULL CHECK (length(root_id) BETWEEN 1 AND 32
                                  AND root_id GLOB '[a-z0-9]*' AND root_id NOT GLOB '*[^a-z0-9_-]*'),
  rel_path   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'folder' CHECK (kind IN ('folder','file')),
  identity   TEXT CHECK (identity IS NULL OR json_valid(identity)),
  created_at INTEGER NOT NULL, deleted_at INTEGER,
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT;
CREATE UNIQUE INDEX places_owner ON places(owner_kind, owner_id, machine_id) WHERE deleted_at IS NULL;

CREATE TABLE aliases (
  namespace TEXT NOT NULL,
  alias TEXT NOT NULL, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, alias)
) STRICT, WITHOUT ROWID;

CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  schema_ver INTEGER NOT NULL,
  policy INTEGER NOT NULL DEFAULT 0 CHECK (policy IN (0,1)),
  created_seq INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT;

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
  compacted    INTEGER NOT NULL DEFAULT 0 CHECK (compacted IN (0,1)),
  UNIQUE (scope_id, request_id)
) STRICT;
CREATE INDEX commits_undo    ON commits(principal_id, undo_status, seq) WHERE undo_status IS NOT NULL;
CREATE INDEX commits_session ON commits(session_id, seq) WHERE session_id IS NOT NULL;
CREATE INDEX commits_scope   ON commits(scope_id, at) WHERE affected > 0;

-- One per decided request (A1 3.8, M1.05). Keeps a rowid: it holds a JSON result (A1 3.4).
CREATE TABLE receipts (
  scope_id    TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      TEXT NOT NULL
              CHECK (status IN ('applied','proposed','unchanged','conflict','rejected')),
  seq         INTEGER,
  epoch       INTEGER NOT NULL,
  incarnation TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (json_valid(result)),
  at          INTEGER NOT NULL,
  PRIMARY KEY (scope_id, request_id)
) STRICT;

CREATE TABLE changes (
  seq         INTEGER NOT NULL,
  n           INTEGER NOT NULL,
  op          INTEGER NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  task_id     TEXT,
  action      TEXT NOT NULL CHECK (action IN ('create','set')),
  field       TEXT,
  before      TEXT CHECK (before IS NULL OR json_valid(before)),
  after       TEXT CHECK (after IS NULL OR json_valid(after)),
  before_ver  INTEGER,
  before_prov INTEGER,
  after_prov  INTEGER,
  PRIMARY KEY (seq, n)
) STRICT;
CREATE INDEX changes_task   ON changes(task_id, seq);
CREATE INDEX changes_entity ON changes(entity_id, seq);

-- Post-commit work that must not be lost (A1 3.7). last_error holds an error code, never a message.
CREATE TABLE outbox (
  topic      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  first_seq  INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT    CHECK (last_error IS NULL OR length(last_error) <= 64),
  PRIMARY KEY (topic, key),
  CHECK (first_seq <= seq)
) STRICT, WITHOUT ROWID;

-- Launch intents and their receipts (A4 3.9, 3.16). Written only through the execution store, as
-- the operations launch.create and launch.transition. IDs, states, instants and fixed codes only:
-- the absolute folder, the composer text and the tickets stay in machine state. detail holds the
-- evidence and the time of each state. Keeps a rowid: detail is JSON (A1 3.4).
CREATE TABLE launches (
  id           TEXT    PRIMARY KEY,
  reference    TEXT    NOT NULL
               CHECK (length(reference) = 6 AND reference GLOB 'L*'
                      AND substr(reference, 2) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  task_id      TEXT    REFERENCES tasks(id),
  session_id   TEXT,
  instance_id  TEXT    NOT NULL,
  machine_id   TEXT    NOT NULL REFERENCES machines(id),
  route        TEXT    NOT NULL,
  place_id     TEXT    REFERENCES places(id),
  task_version INTEGER,
  brief_hash   TEXT,
  state        TEXT    NOT NULL
               CHECK (state IN ('prepared','dispatching','dispatched','confirmed','failed','unknown')),
  reason       TEXT,
  detail       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_seq  INTEGER NOT NULL, version INTEGER NOT NULL,
  fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)),
  fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))
) STRICT;
CREATE INDEX launches_ref  ON launches(reference, created_at);
CREATE INDEX launches_task ON launches(task_id, created_at);
CREATE INDEX launches_open ON launches(machine_id, created_at)
  WHERE state IN ('prepared','dispatching','dispatched');
`;

/** The user tables of the main schema with whether each is STRICT. */
function userTables(conn: Connection): Map<string, boolean> {
  const rows = conn
    .prepare(
      "SELECT name, strict FROM pragma_table_list " +
        "WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all<{ name: string; strict: number }>();
  return new Map(rows.map((row) => [row.name, row.strict === 1]));
}

export const step0001: SchemaStep = {
  id: 1,
  from: 0,
  revision: { major: 0, minor: 1 },
  // Before 1.0 any step may be breaking (A1 3.17). The first step creates everything.
  kind: "breaking",
  format: { major: 0, minor: 1 },
  // Every build that knows schema 0.1 reads and writes it: no older app exists.
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TABLES,
  up(conn) {
    conn.exec(SCHEMA_0_1_SQL);
  },
  verify(conn) {
    const found = userTables(conn);
    const expected = new Set<string>(TABLES);
    if (found.size !== expected.size || [...found].some(([n, s]) => !expected.has(n) || !s)) {
      throw misuse("Schema 0.1 did not produce its tables as STRICT tables");
    }
  },
};
