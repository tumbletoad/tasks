// The tree's schema: a space is one tree of nodes (the space, projects, tasks), with what only a
// task has in `tasks`, so launches and runs keep a task to point at. It stays outside the migration
// chain until the switch: nothing in the product opens a tree space yet. Each family of commands
// adds the tables it writes.
import type { Connection } from "../driver.ts";
import { newId, osRandom, type Id, type RandomSource } from "../ids.ts";

/** The tree's format: a build before the tree meets it as a newer revision and refuses to write. */
export const TREE_FORMAT = { major: 1, minor: 0 } as const;

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
  authority_incarnation TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human','agent','routine','system','import')),
  label TEXT NOT NULL, instance_id TEXT, routine_id TEXT, created_at INTEGER NOT NULL
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
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('space','project','task')),
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
  CHECK (kind = 'task' OR deleted_at IS NULL),
  CHECK (kind <> 'task' OR for_agents = '')
) STRICT`,
  // Every child, live or in the Trash: the end of a parent's list counts them all.
  "CREATE INDEX nodes_children ON nodes(parent_id, kind, position)",
  "CREATE UNIQUE INDEX nodes_slug ON nodes(parent_id, slug) WHERE kind = 'project'",
  `CREATE TABLE tasks (
  id TEXT PRIMARY KEY REFERENCES nodes(id), ref INTEGER NOT NULL UNIQUE,
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
  // The prototype import's task IDs, which text written before may hold: a task is found by them.
  `CREATE TABLE aliases (
  namespace TEXT NOT NULL CHECK (namespace IN ('planning')), alias TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES nodes(id), created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, alias)
) STRICT, WITHOUT ROWID`,
  // Notes, log entries and learnings in one thread, numbered per owner.
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
];

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
 * Makes an empty tree space on an empty database: the tables, the space row, its person and its
 * system actor, and the root node. The root is the space's own row, made before any commit, like
 * the space row: it has no change row.
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
    for (const statement of TREE_STATEMENTS) conn.exec(statement);
    conn
      .prepare(
        "INSERT INTO space (one, space_id, name, ref_prefix, format_major, format_minor, " +
          "authority_machine, authority_incarnation, created_at) VALUES (1, $id, $name, $prefix, " +
          "$major, $minor, $machine, $incarnation, $at)",
      )
      .run({
        id: made.spaceId,
        name: space.name,
        prefix: space.refPrefix,
        major: TREE_FORMAT.major,
        minor: TREE_FORMAT.minor,
        machine: space.machineId,
        incarnation: made.incarnation,
        at: space.at,
      });
    const actor = conn.prepare(
      "INSERT INTO actors (id, kind, label, created_at) VALUES ($id, $kind, $label, $at)",
    );
    actor.run({ id: made.human, kind: "human", label: space.human, at: space.at });
    actor.run({ id: made.system, kind: "system", label: "system", at: space.at });
    conn
      .prepare(
        "INSERT INTO nodes (id, kind, parent_id, position, title, created_at, created_by, " +
          "touched, created_seq, version) VALUES ($id, 'space', NULL, 'a0', $title, $at, $by, 0, 0, 0)",
      )
      .run({ id: made.spaceId, title: space.name, at: space.at, by: made.system });
  });
  return made;
}
