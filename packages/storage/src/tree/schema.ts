// The tree's schema: a space is one tree of nodes (the space, projects, tasks, routines), with what
// only a task or a routine has in `tasks`, so launches and runs keep a task to point at. It stays
// outside the migration chain until the switch: only test and trial spaces are trees. The `space`
// row keeps today's shape, so whatever reads a space's identity, authority and lineage reads a tree
// space's too.
import type { Connection } from "../driver.ts";
import { newId, osRandom, type Id, type RandomSource } from "../ids.ts";
import { encodeRevision, type SchemaStep } from "../schema.ts";

/** The tree's format: a build before the tree meets it as a newer revision and refuses to write. */
export const TREE_FORMAT = { major: 1, minor: 0 } as const;

/** Columns a create change leaves out: each follows from the change's seq. */
export const DERIVED: ReadonlySet<string> = new Set([
  "created_seq",
  "version",
  "touched",
  "fv",
  "fp",
]);

const VERSIONS =
  "created_seq INTEGER NOT NULL, version INTEGER NOT NULL, " +
  "fv TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fv)), " +
  "fp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fp))";

const ONE_LINE = (column: string, max: number): string =>
  `CHECK (length(${column}) <= ${String(max)} AND instr(${column}, char(10)) = 0)`;

/** The statements that make an empty tree space, in order. */
export const TREE_STATEMENTS: readonly string[] = [
  `CREATE TABLE space (
  one INTEGER PRIMARY KEY CHECK (one = 1), space_id TEXT NOT NULL, name TEXT NOT NULL,
  ref_prefix TEXT NOT NULL CHECK (length(ref_prefix) BETWEEN 1 AND 6 AND ref_prefix NOT GLOB '*[^A-Z]*'),
  format_major INTEGER NOT NULL, format_minor INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0, next_ref INTEGER NOT NULL DEFAULT 1,
  authority_machine TEXT NOT NULL, authority_epoch INTEGER NOT NULL DEFAULT 1,
  authority_incarnation TEXT NOT NULL, authority_since INTEGER NOT NULL DEFAULT 0,
  lineage TEXT NOT NULL CHECK (json_valid(lineage)),
  transfer TEXT CHECK (transfer IS NULL OR json_valid(transfer)),
  undo_floor_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  hold TEXT CHECK (hold IS NULL OR json_valid(hold))
) STRICT`,
  `CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human','agent','routine','system','import')),
  label TEXT NOT NULL, instance_id TEXT, routine_id TEXT, created_at INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE machines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT NOT NULL CHECK (os IN ('linux','windows','macos')),
  first_seen INTEGER NOT NULL, retired_at INTEGER,
  ${VERSIONS}
) STRICT`,
  `CREATE TABLE commits (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL,
  incarnation TEXT NOT NULL, at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent','routine','system','import')),
  principal_id TEXT NOT NULL REFERENCES actors(id), author_id TEXT NOT NULL REFERENCES actors(id),
  scope_id TEXT NOT NULL, machine_id TEXT NOT NULL, session_id TEXT, run_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('ui','cli','mcp','http','import','system','migration')),
  request_id TEXT NOT NULL, kind TEXT NOT NULL, ops TEXT NOT NULL CHECK (json_valid(ops)),
  affected INTEGER NOT NULL DEFAULT 0, reason TEXT,
  undo_status TEXT CHECK (undo_status IN ('done','undone','dead')),
  undone_by INTEGER, undo_of INTEGER, redo_of INTEGER,
  UNIQUE (scope_id, request_id)
) STRICT`,
  "CREATE INDEX commits_undo ON commits(principal_id, undo_status, seq) WHERE undo_status IS NOT NULL",
  `CREATE TABLE receipts (
  scope_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied','unchanged','conflict','rejected')),
  seq INTEGER, epoch INTEGER NOT NULL, incarnation TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result)), at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, request_id)
) STRICT`,
  // node_id: the node a change belongs to, its own row's for a node or a task, the owner's else.
  `CREATE TABLE changes (
  seq INTEGER NOT NULL, n INTEGER NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  node_id TEXT, action TEXT NOT NULL CHECK (action IN ('create','set')), field TEXT,
  before TEXT CHECK (before IS NULL OR json_valid(before)),
  after TEXT CHECK (after IS NULL OR json_valid(after)),
  before_ver INTEGER, before_prov INTEGER, after_prov INTEGER,
  PRIMARY KEY (seq, n)
) STRICT`,
  "CREATE INDEX changes_node ON changes(node_id, seq)",
  "CREATE INDEX changes_entity ON changes(entity_id, seq)",
  `CREATE TABLE nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('space','project','task','routine')),
  parent_id TEXT REFERENCES nodes(id), position TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND instr(title, char(10)) = 0),
  brief TEXT NOT NULL DEFAULT '' ${ONE_LINE("brief", 400)},
  description TEXT NOT NULL DEFAULT '', for_agents TEXT NOT NULL DEFAULT '',
  slug TEXT, color TEXT, archived_at INTEGER,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  deleted_at INTEGER, deleted_by TEXT REFERENCES actors(id), touched INTEGER NOT NULL,
  ${VERSIONS},
  CHECK ((kind = 'space') = (parent_id IS NULL)),
  CHECK (kind = 'project' OR (slug IS NULL AND color IS NULL AND archived_at IS NULL)),
  CHECK (kind IN ('task','routine') OR deleted_at IS NULL),
  CHECK (kind NOT IN ('task','routine') OR for_agents = '')
) STRICT`,
  // Every child, live or in the Trash: the end of a parent's list counts them all.
  "CREATE INDEX nodes_children ON nodes(parent_id, kind, position)",
  "CREATE UNIQUE INDEX nodes_slug ON nodes(parent_id, slug) WHERE kind = 'project'",
  // Something from outside, on one node. The key that recognises it again is its own column.
  `CREATE TABLE sources (
  id TEXT PRIMARY KEY, ref INTEGER NOT NULL UNIQUE, owner_id TEXT NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL, title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  brief TEXT NOT NULL DEFAULT '' ${ONE_LINE("brief", 400)}, body TEXT NOT NULL DEFAULT '',
  who TEXT, outside_ref TEXT, url TEXT, at INTEGER, source_key TEXT,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id), deleted_at INTEGER,
  ${VERSIONS}
) STRICT`,
  "CREATE UNIQUE INDEX sources_key ON sources(source_key) " +
    "WHERE source_key IS NOT NULL AND deleted_at IS NULL",
  "CREATE INDEX sources_owner ON sources(owner_id) WHERE deleted_at IS NULL",
  // origin_source_id: the source a capture made the task from, which a repeat capture resolves.
  `CREATE TABLE tasks (
  id TEXT PRIMARY KEY REFERENCES nodes(id), ref INTEGER NOT NULL UNIQUE,
  origin_source_id TEXT REFERENCES sources(id),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','completed','archived')),
  status TEXT NOT NULL DEFAULT 'open', inbox INTEGER NOT NULL DEFAULT 0 CHECK (inbox IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4), effort TEXT,
  due_date TEXT, due_at INTEGER, due_tz TEXT, planned_for TEXT, focus_on TEXT, waiting_on TEXT,
  source_at INTEGER, reviewed_at INTEGER,
  completed_at INTEGER, completed_by TEXT REFERENCES actors(id), archived_reason TEXT,
  wrap_state TEXT CHECK (wrap_state IN ('pending','wrapped')), outcome TEXT,
  wrapped_at INTEGER, wrapped_by TEXT REFERENCES actors(id), created_session TEXT,
  ${VERSIONS},
  CHECK (lifecycle <> 'active' OR wrap_state IS NULL),
  CHECK (due_at IS NULL OR (due_tz IS NOT NULL AND due_date IS NULL))
) STRICT`,
  "CREATE INDEX tasks_open ON tasks(lifecycle, status)",
  "CREATE INDEX tasks_due ON tasks(due_date) WHERE lifecycle = 'active'",
  "CREATE INDEX tasks_done ON tasks(completed_at) WHERE lifecycle = 'completed'",
  "CREATE INDEX tasks_origin ON tasks(origin_source_id) WHERE origin_source_id IS NOT NULL",
  // Knowledge written in the space, on one node. Its earlier versions are its change rows.
  `CREATE TABLE pages (
  id TEXT PRIMARY KEY, ref INTEGER NOT NULL UNIQUE, owner_id TEXT NOT NULL REFERENCES nodes(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND instr(title, char(10)) = 0),
  brief TEXT NOT NULL DEFAULT '' ${ONE_LINE("brief", 400)}, body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES actors(id),
  deleted_at INTEGER, deleted_by TEXT REFERENCES actors(id),
  ${VERSIONS}
) STRICT`,
  "CREATE INDEX pages_owner ON pages(owner_id) WHERE deleted_at IS NULL",
  // A pointer from a node to a page or a source elsewhere in the space.
  `CREATE TABLE links (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES nodes(id), target_id TEXT NOT NULL,
  position TEXT NOT NULL, added_by TEXT NOT NULL REFERENCES actors(id), removed_at INTEGER,
  ${VERSIONS},
  UNIQUE (owner_id, target_id)
) STRICT`,
  "CREATE INDEX links_target ON links(target_id)",
  // The space's preferences, by key, as today's writer keeps them (preferences.ts reads both).
  `CREATE TABLE preferences (
  key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)), schema_ver INTEGER NOT NULL,
  policy INTEGER NOT NULL DEFAULT 0 CHECK (policy IN (0,1)),
  ${VERSIONS}
) STRICT`,
  // A folder of a node on one machine, as that machine spells it: the default one per node and
  // machine, where an agent starts.
  `CREATE TABLE folders (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES nodes(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096), is_default INTEGER NOT NULL DEFAULT 1
    CHECK (is_default IN (0,1)), label TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER,
  ${VERSIONS}
) STRICT`,
  "CREATE UNIQUE INDEX folders_default ON folders(owner_id, machine_id) " +
    "WHERE is_default = 1 AND deleted_at IS NULL",
  // What Open records: as today's, with the folder it opened in in place of a place. Launches and
  // runs point at tasks.
  `CREATE TABLE launches (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL CHECK (length(reference) = 6 AND reference GLOB 'L*'),
  task_id TEXT REFERENCES tasks(id), session_id TEXT, instance_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id), route TEXT NOT NULL,
  folder_id TEXT REFERENCES folders(id), task_version INTEGER, brief_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','dispatched','confirmed','failed','unknown')),
  reason TEXT, detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  ${VERSIONS}
) STRICT`,
  "CREATE INDEX launches_task ON launches(task_id, created_at)",
  "CREATE INDEX launches_open ON launches(machine_id, created_at) " +
    "WHERE state IN ('prepared','dispatching','dispatched')",
  // What Run records. A run outlives the redaction of its task, which leaves it without one. A
  // routine's run holds its due time in `spec`.
  `CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), session_id TEXT,
  instance_id TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES machines(id),
  adapter TEXT NOT NULL, folder_id TEXT REFERENCES folders(id), request TEXT,
  spec TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec)),
  state TEXT NOT NULL, reason TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  result TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result)),
  queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  ${VERSIONS}
) STRICT`,
  "CREATE INDEX runs_task ON runs(task_id, queued_at)",
  // A routine's schedule and its open time: the time that comes next or, once it has come, the one
  // still to do. `instance` is the agent instance that does it, null for the person.
  `CREATE TABLE routines (
  id TEXT PRIMARY KEY REFERENCES tasks(id),
  rule TEXT NOT NULL, start TEXT NOT NULL, tz TEXT NOT NULL, due_date TEXT NOT NULL, due_at INTEGER,
  instance TEXT, instruction TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)), enabled_by TEXT REFERENCES actors(id),
  ${VERSIONS},
  CHECK ((instance IS NULL) = (instruction IS NULL)),
  CHECK (instance IS NULL OR (due_at IS NOT NULL AND enabled_by IS NOT NULL))
) STRICT`,
  // Each time of a routine done or skipped, once per due time; no due time is an extra run's.
  `CREATE TABLE occurrences (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id),
  due_date TEXT, due_at INTEGER, state TEXT NOT NULL CHECK (state IN ('done','skipped')),
  actor_id TEXT NOT NULL REFERENCES actors(id), at INTEGER NOT NULL, run_id TEXT REFERENCES runs(id),
  why TEXT CHECK (why IN ('you','run_failed')), note TEXT, deleted_at INTEGER,
  ${VERSIONS},
  CHECK ((state = 'skipped') = (why IS NOT NULL)),
  CHECK (due_date IS NOT NULL OR due_at IS NULL)
) STRICT`,
  "CREATE UNIQUE INDEX occurrences_due ON occurrences(routine_id, due_date, coalesce(due_at, 0)) " +
    "WHERE due_date IS NOT NULL AND deleted_at IS NULL",
  "CREATE INDEX occurrences_routine ON occurrences(routine_id, at)",
  // Notes, log entries and learnings in one thread on a node, and a page's comments; numbered per
  // owner.
  `CREATE TABLE notes (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','progress','evidence','blocker',
    'decision','question','handoff','learning')),
  for_agents INTEGER NOT NULL DEFAULT 0 CHECK (for_agents IN (0,1)),
  author_id TEXT NOT NULL REFERENCES actors(id), session_id TEXT, run_id TEXT,
  body TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
  ${VERSIONS},
  UNIQUE (owner_id, ordinal)
) STRICT`,
  // The search index (search.ts): derived, each document on the node that holds it.
  `CREATE TABLE search_docs (
  doc INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('task','project','note','log','learning','page')),
  entity_id TEXT NOT NULL UNIQUE, node_id TEXT NOT NULL, seq INTEGER NOT NULL
) STRICT`,
  "CREATE INDEX search_docs_node ON search_docs(node_id)",
  "CREATE VIRTUAL TABLE search_fts USING fts5(title, body, extra, " +
    "tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')",
];

/** The tree as a schema step: what a tree space's database is built with, at revision 1.0. */
export const TREE_STEP: SchemaStep = {
  id: 1000,
  from: 0,
  revision: TREE_FORMAT,
  kind: "breaking",
  format: TREE_FORMAT,
  minReader: "0.0.0",
  minWriter: "0.0.0",
  undoFloor: false,
  tables: TREE_STATEMENTS.flatMap((s) => /^CREATE (?:VIRTUAL )?TABLE (\w+)/u.exec(s)?.[1] ?? []),
  up(conn) {
    for (const statement of TREE_STATEMENTS) conn.exec(statement);
  },
  verify() {
    // The statements are the schema: nothing is carried that could differ.
  },
};

/** The user_version of a tree space's database. */
export const TREE_USER_VERSION = encodeRevision(TREE_FORMAT);

/** What the space's first commit needs: the space row and its system actor are already there. */
export interface TreeRoot {
  spaceId: string;
  name: string;
  system: string;
  incarnation: string;
  machineId: string;
  at: number;
}

/**
 * Makes the root node by the space's first commit, a system commit with its create row, so the
 * space's brief and description have a history like every node's. Inside the caller's transaction.
 */
export function seedTreeRoot(conn: Connection, root: TreeRoot, random: RandomSource): void {
  conn
    .prepare(
      "INSERT INTO nodes (id, kind, parent_id, position, title, created_at, created_by, " +
        "touched, created_seq, version) VALUES ($id, 'space', NULL, 'a0', $title, $at, $by, 1, 1, 1)",
    )
    .run({ id: root.spaceId, title: root.name, at: root.at, by: root.system });
  conn
    .prepare(
      "INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, author_id, " +
        "scope_id, machine_id, origin, request_id, kind, ops) VALUES (1, $id, 1, $incarnation, " +
        "$at, 'system', $by, $by, 'system', $machine, 'system', 'space.create', 'space.create', '[]')",
    )
    .run({
      id: newId("op", random),
      incarnation: root.incarnation,
      at: root.at,
      by: root.system,
      machine: root.machineId,
    });
  const row = conn.prepare("SELECT * FROM nodes WHERE id = $id").get({ id: root.spaceId }) ?? {};
  const after = Object.fromEntries(Object.entries(row).filter(([c]) => !DERIVED.has(c)));
  conn
    .prepare(
      "INSERT INTO changes (seq, n, entity, entity_id, node_id, action, after, after_prov) " +
        "VALUES (1, 1, 'nodes', $id, $id, 'create', $after, 1)",
    )
    .run({ id: root.spaceId, after: JSON.stringify(after) });
  conn.exec("UPDATE space SET last_seq = 1 WHERE one = 1");
}

export interface NewTreeSpace {
  name: string;
  refPrefix: string;
  machineId: Id<"m">;
  /** The label of the space's person. */
  human: string;
  at: number;
}

export interface CreatedTreeSpace {
  spaceId: Id<"sp">;
  human: Id<"ac">;
  system: Id<"ac">;
  incarnation: Id<"ai">;
}

/**
 * Makes an empty tree space on an empty database, without a space folder: the tables, the space
 * row, its person and its system actor, and the root node. A space folder is made by storage's
 * `createSpace` with the tree's step.
 */
export function createTreeSpace(
  conn: Connection,
  space: NewTreeSpace,
  random: RandomSource = osRandom,
): CreatedTreeSpace {
  const made: CreatedTreeSpace = {
    spaceId: newId("sp", random),
    human: newId("ac", random),
    system: newId("ac", random),
    incarnation: newId("ai", random),
  };
  conn.transaction("immediate", () => {
    TREE_STEP.up(conn);
    conn.pragma("user_version", TREE_USER_VERSION);
    const lineage = {
      forked_from: null,
      incarnations: [
        {
          incarnation: made.incarnation,
          epoch: 1,
          kind: "create",
          parent: null,
          machine_id: space.machineId,
          at: space.at,
        },
      ],
    };
    conn
      .prepare(
        "INSERT INTO space (one, space_id, name, ref_prefix, format_major, format_minor, " +
          "authority_machine, authority_incarnation, lineage, created_at) VALUES (1, $id, $name, " +
          "$prefix, $major, $minor, $machine, $incarnation, $lineage, $at)",
      )
      .run({
        id: made.spaceId,
        name: space.name,
        prefix: space.refPrefix,
        major: TREE_FORMAT.major,
        minor: TREE_FORMAT.minor,
        machine: space.machineId,
        incarnation: made.incarnation,
        lineage: JSON.stringify(lineage),
        at: space.at,
      });
    const actor = conn.prepare(
      "INSERT INTO actors (id, kind, label, created_at) VALUES ($id, $kind, $label, $at)",
    );
    actor.run({ id: made.human, kind: "human", label: space.human, at: space.at });
    actor.run({ id: made.system, kind: "system", label: "system", at: space.at });
    seedTreeRoot(
      conn,
      {
        spaceId: made.spaceId,
        name: space.name,
        system: made.system,
        incarnation: made.incarnation,
        machineId: space.machineId,
        at: space.at,
      },
      random,
    );
  });
  return made;
}
