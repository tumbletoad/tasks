// The tree's named commands. Each reads what it needs and writes through its Tx, statement by
// statement, so every statement sees the ones before it; nothing is predicted in memory. A command
// returns what it did, which the receipt stores. Its input is checked first, by the command's check
// below and before any transaction, as today's writer checks a request: storage never trusts a
// caller with the space.
import type { Row, SqlValue } from "../driver.ts";
import { formatTaskRef, parseTaskRef } from "../refs.ts";
import { positionBetween } from "../write/positions.ts";
import { freeSlug } from "../write/slugs.ts";
import { listPreference, type ScaleKey } from "../preferences.ts";
import { dedupeWindowMs, finishedOf } from "../write/dedupe.ts";
import { alreadyThere } from "../write/pages.ts";
import { Fields, OTHER_SPACE_TASK, sourceFields, WRITE_LIMITS } from "../write/request.ts";
import type { Command, Tx } from "./tx.ts";

type Run = Command["run"];
import { TreeProblem } from "./fields.ts";

export type Input = Record<string, unknown>;

const NOTE_KINDS = [
  "note",
  "progress",
  "evidence",
  "blocker",
  "decision",
  "question",
  "handoff",
  "learning",
] as const;

const SQL = {
  liveSource: "SELECT id FROM sources WHERE source_key = $key AND deleted_at IS NULL",
  /** The newest live task a source is the origin of. */
  originTask:
    "SELECT t.id, t.ref, t.lifecycle, t.fp, t.created_seq, n.title, n.parent_id FROM tasks t " +
    "JOIN nodes n ON n.id = t.id " +
    "WHERE t.origin_source_id = $source AND n.deleted_at IS NULL ORDER BY n.created_seq DESC LIMIT 1",
  node: "SELECT * FROM nodes WHERE id = $id",
  sameLog:
    "SELECT 1 FROM notes WHERE owner_id = $owner AND body = $body AND deleted_at IS NULL " +
    "AND kind NOT IN ('note', 'learning')",
  taskByRef: "SELECT id FROM tasks WHERE ref = $ref",
  refOf: "SELECT ref FROM tasks WHERE id = $id",
  /** A project inside another project. */
  projectIn:
    "SELECT p.title FROM nodes p JOIN nodes g ON g.id = p.parent_id " +
    "WHERE p.id = $id AND p.kind = 'project' AND g.kind = 'project'",
  child:
    "SELECT * FROM nodes WHERE parent_id = $parent AND kind = 'project' AND (slug = $slug OR lower(title) = $title)",
  lastPosition: "SELECT max(position) AS p FROM nodes WHERE parent_id = $parent AND kind = $kind",
  slugTaken: "SELECT 1 FROM nodes WHERE parent_id = $parent AND kind = 'project' AND slug = $slug",
  task:
    "SELECT n.id, n.kind, n.parent_id, n.title, n.brief, n.description, n.deleted_at, n.fp AS node_fp, " +
    "n.created_seq AS node_seq, t.* FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
  /** The live tasks below a node, at any depth, nearest first. */
  subtree:
    "WITH RECURSIVE down(id, depth) AS (SELECT id, 1 FROM nodes WHERE parent_id = $id AND kind = 'task' " +
    "AND deleted_at IS NULL UNION ALL SELECT n.id, depth + 1 FROM nodes n JOIN down ON n.parent_id = down.id " +
    "WHERE n.kind = 'task' AND n.deleted_at IS NULL) " +
    "SELECT n.id, n.title, t.ref, t.lifecycle FROM down JOIN nodes n ON n.id = down.id " +
    "JOIN tasks t ON t.id = down.id ORDER BY down.depth, n.position",
  /** The tasks a trash of `$id` took along: deleted by the same commit. */
  trashedWith:
    "WITH RECURSIVE down(id) AS (SELECT id FROM nodes WHERE parent_id = $id AND kind = 'task' " +
    "UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id WHERE n.kind = 'task') " +
    "SELECT n.id FROM down JOIN nodes n ON n.id = down.id WHERE n.deleted_at IS NOT NULL " +
    "AND coalesce(json_extract(n.fp, '$.deleted'), n.created_seq) = $seq",
  /** Whether `$under` is `$id` or below it. */
  below:
    "WITH RECURSIVE up(id) AS (SELECT $under UNION ALL SELECT n.parent_id FROM nodes n JOIN up " +
    "ON n.id = up.id WHERE n.parent_id IS NOT NULL) SELECT 1 FROM up WHERE id = $id",
  lastOrdinal: "SELECT max(ordinal) AS o FROM notes WHERE owner_id = $owner",
  note: "SELECT * FROM notes WHERE id = $id",
  noteAt: "SELECT * FROM notes WHERE owner_id = $owner AND ordinal = $ordinal",
  /** A page, with whether what holds it lives: one under a task in the Trash is hidden. */
  page:
    "SELECT p.*, o.deleted_at IS NULL AS shown FROM pages p JOIN nodes o ON o.id = p.owner_id " +
    "WHERE p.id = $id OR p.ref = $ref",
  pageOwner: "SELECT owner_id FROM pages WHERE id = $id",
  /** The routines not paused in project `$id` and the projects below it. */
  unpausedRoutines:
    "WITH RECURSIVE down(id) AS (SELECT $id UNION ALL SELECT n.id FROM nodes n JOIN down " +
    "ON n.parent_id = down.id WHERE n.kind = 'project') SELECT r.id FROM routines r " +
    "JOIN nodes n ON n.id = r.id WHERE r.paused = 0 AND n.parent_id IN (SELECT id FROM down)",
} as const;

export const problem = (code: string, message: string, field?: string, data?: unknown): never => {
  throw new TreeProblem(code, message, field, data);
};

/** A text the input holds, as check() left it. */
export const str = (input: Input, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
};

/** A node by ID, or a task by its reference (`M-14`). Undefined when the space has none. */
export function findNode(tx: Tx, key: unknown): Row | undefined {
  if (typeof key !== "string") return undefined;
  const ref = parseTaskRef(key);
  if (ref !== undefined) {
    if (ref.prefix !== tx.space.refPrefix) return undefined;
    const id = tx.get(SQL.taskByRef, { ref: ref.ref })?.["id"];
    return typeof id === "string" ? tx.get(SQL.node, { id }) : undefined;
  }
  if (key === "space") return tx.get(SQL.node, { id: tx.space.spaceId });
  const byId = tx.get(SQL.node, { id: key });
  if (byId !== undefined) return byId;
  // A project path: each part is a project's slug or title, ignoring case.
  let at: Row | undefined = tx.get(SQL.node, { id: tx.space.spaceId });
  for (const part of key.split("/")) {
    const wanted = part.trim().toLowerCase();
    at = tx.get(SQL.child, { parent: String(at?.["id"]), slug: wanted, title: wanted });
    if (at === undefined) return undefined;
  }
  return at;
}

/**
 * A task by its key: live, in the Trash (`deleted` true), or either. `kinds` adds a routine, which
 * the Trash takes; every other task command refuses one.
 */
function liveTask(
  tx: Tx,
  key: unknown,
  field = "task",
  deleted: boolean | "either" = false,
  kinds: readonly string[] = ["task"],
): Row {
  const parsed = typeof key === "string" ? parseTaskRef(key) : undefined;
  if (parsed !== undefined && parsed.prefix !== tx.space.refPrefix) {
    problem("SPACE_MISMATCH", OTHER_SPACE_TASK, field);
  }
  const found = findNode(tx, key);
  if (found === undefined || !kinds.includes(String(found["kind"])))
    return problem("NOT_FOUND", "The space has no such task", field);
  const task = tx.get(SQL.task, { id: String(found["id"]) }) as Row;
  if (deleted !== "either" && (task["deleted_at"] !== null) !== deleted) {
    problem(
      deleted ? "INVALID_TRANSITION" : "DELETED",
      deleted ? "The task is not in the Trash" : "The task is in the Trash",
      field,
    );
  }
  return task;
}

/** A due date, or a due time with its zone, as a task's columns hold it; none clears it. */
function dueColumns(due: unknown): {
  due_date: string | null;
  due_at: number | null;
  due_tz: string | null;
} {
  const value = (due ?? {}) as Record<string, unknown>;
  return {
    due_date: typeof value["date"] === "string" ? value["date"] : null,
    due_at: typeof value["at"] === "number" ? value["at"] : null,
    due_tz: typeof value["tz"] === "string" ? value["tz"] : null,
  };
}

/** The end of a parent's children of one kind. */
export const endOf = (tx: Tx, parent: string, kind: string): string => {
  const last = tx.get(SQL.lastPosition, { parent, kind })?.["p"];
  return positionBetween(typeof last === "string" ? last : undefined, undefined);
};

export const refText = (tx: Tx, ref: unknown): string =>
  formatTaskRef(tx.space.refPrefix, Number(ref));

/** Where a new or moved task goes: a live project, a live task, or the space; never a routine. */
export function parentFor(tx: Tx, under: unknown, field: string): Row {
  const found =
    under === undefined ? tx.get(SQL.node, { id: tx.space.spaceId }) : findNode(tx, under);
  if (found === undefined)
    return problem("NOT_FOUND", "Nothing of that name to put it under", field);
  if (found["kind"] === "routine") problem("VALIDATION_FAILED", "A routine holds no tasks", field);
  if (found["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", field);
  // As today's: a task can still be filed into an archived project; nothing of the person's is
  // refused.
  return found;
}

export function addNote(
  tx: Tx,
  owner: string,
  node: string,
  body: string,
  kind = "note",
  agents = false,
) {
  const last = tx.get(SQL.lastOrdinal, { owner })?.["o"];
  const ordinal = (typeof last === "number" ? last : 0) + 1;
  const id = tx.newId("n");
  tx.create(
    "notes",
    {
      id,
      owner_id: owner,
      ordinal,
      kind,
      for_agents: agents ? 1 : 0,
      author_id: tx.author,
      session_id: tx.request.actor.session_id ?? null,
      run_id: tx.request.actor.run_id ?? null,
      body,
      created_at: tx.at,
    },
    node,
  );
  return { id, ordinal };
}

/** A status or an effort the space's own list holds, refused naming the field otherwise. */
function known(tx: Tx, list: ScaleKey, value: unknown, field: string): string {
  const keys = listPreference(tx.conn, list);
  if (typeof value !== "string" || !keys.includes(value)) {
    return problem(
      "VALIDATION_FAILED",
      list === "tasks.statuses" ? "Not a status of this space" : "Not an effort of this space",
      field,
    );
  }
  return value;
}

/**
 * The task a draft with source key `key` captured before, when it still counts, and the live source
 * of that key. An open task counts; a finished one when it finished within the space's window, by
 * today's rule (dedupe.ts `finishedOf`): when this space recorded the finish, never the date the
 * finish names, so an archive and a backdated completion count too. One this request finished is
 * no match: a draft after it is new work.
 */
export function captured(tx: Tx, key: string): { task: Row | undefined; source: string | null } {
  const source = tx.get(SQL.liveSource, { key })?.["id"];
  if (typeof source !== "string") return { task: undefined, source: null };
  const task = tx.get(SQL.originTask, { source });
  if (task === undefined || task["lifecycle"] === "active") return { task, source };
  const finished = finishedOf(tx.conn, task);
  const counts = finished.seq !== tx.seq && finished.at >= tx.at - dedupeWindowMs(tx.conn);
  return { task: counts ? task : undefined, source };
}

/**
 * The project a task shows as today's project: its parent, when that is a project inside another
 * one. A task directly under a top-level project shows that project as its area alone.
 */
function projectTitle(tx: Tx, parent: string): { project?: string } {
  const row = tx.get(SQL.projectIn, { id: parent });
  return typeof row?.["title"] === "string" ? { project: row["title"] } : {};
}

const tasksAdd: Run = (tx, input) => {
  const drafts = input["tasks"] as Input[];
  const found = drafts.map((draft) => {
    const source = draft["source"] as Input | undefined;
    const key = source === undefined ? undefined : str(source, "key");
    return key === undefined ? undefined : captured(tx, key);
  });
  return {
    tasks: drafts.map((draft, i) => {
      const at = (field: string) => `tasks.${String(i)}.${field}`;
      const log = str(draft, "log");
      const source = draft["source"] as Input | undefined;
      const match = found[i];
      if (match?.task !== undefined) {
        const id = String(match.task["id"]);
        // As today: the log follows an active match only, and once.
        const follows =
          match.task["lifecycle"] === "active" &&
          tx.get(SQL.sameLog, { owner: id, body: log ?? "" }) === undefined;
        if (log !== undefined && follows) addNote(tx, id, id, log, "progress");
        return {
          status: "exists",
          id,
          ref: refText(tx, match.task["ref"]),
          title: match.task["title"],
          lifecycle: match.task["lifecycle"],
          ...projectTitle(tx, String(match.task["parent_id"])),
          log_added: log !== undefined && follows,
        };
      }
      const parent = parentFor(tx, draft["under"], at("under"));
      const id = str(draft, "id") ?? tx.newId("t");
      const ref = tx.ref();
      const priority = typeof draft["priority"] === "number" ? draft["priority"] : 4;
      tx.create(
        "nodes",
        {
          id,
          kind: "task",
          parent_id: String(parent["id"]),
          position: endOf(tx, String(parent["id"]), "task"),
          title: str(draft, "title") ?? "",
          brief: str(draft, "brief") ?? "",
          description: str(draft, "description") ?? "",
          created_at: tx.at,
          created_by: tx.author,
        },
        id,
      );
      // The source the task is made from: the one that holds the key already, else a new one on the
      // task. A repeat capture of the key finds the task through it, wherever it moves.
      // A source whose key the space holds already is linked to the new task, as today's is.
      let origin = match?.source ?? null;
      if (source !== undefined) {
        const made = tx.call("source.add", { on: id, source }) as { source: { id: string } };
        origin = made.source.id;
      }
      tx.create(
        "tasks",
        {
          id,
          ref,
          origin_source_id: origin,
          status: known(tx, "tasks.statuses", draft["status"] ?? "open", at("status")),
          effort:
            draft["effort"] === undefined
              ? null
              : known(tx, "tasks.effort_scale", draft["effort"], at("effort")),
          inbox: draft["inbox"] === true ? 1 : 0,
          priority,
          ...dueColumns(draft["due"]),
          focus_on: typeof draft["focus"] === "string" ? draft["focus"] : null,
          waiting_on: str(draft, "waiting_on") ?? null,
          created_session: tx.request.actor.session_id ?? null,
        },
        id,
      );
      if (log !== undefined) addNote(tx, id, id, log, "progress");
      return {
        status: "created",
        id,
        ref: refText(tx, ref),
        title: str(draft, "title") ?? "",
        lifecycle: "active",
        ...projectTitle(tx, String(parent["id"])),
        log_added: log !== undefined,
      };
    }),
  };
};

const taskUpdate: Run = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  const set = (input["set"] ?? {}) as Input;
  const node: Record<string, SqlValue> = {};
  if (set["title"] !== undefined) node["title"] = str(set, "title") ?? "";
  if (set["brief"] !== undefined) node["brief"] = str(set, "brief") ?? "";
  if (set["description"] !== undefined) node["description"] = str(set, "description") ?? "";
  const fields: Record<string, SqlValue> = {};
  // As today's writer: a stale save is a conflict first, whatever the space's list holds now.
  const listed = (list: ScaleKey, field: "status" | "effort") =>
    tx.held("tasks", id, id, [field])
      ? (set[field] as SqlValue)
      : known(tx, list, set[field], `set.${field}`);
  if (set["status"] !== undefined) fields["status"] = listed("tasks.statuses", "status");
  if (set["effort"] !== undefined) {
    fields["effort"] = set["effort"] === null ? null : listed("tasks.effort_scale", "effort");
  }
  if (set["inbox"] !== undefined) fields["inbox"] = set["inbox"] === true ? 1 : 0;
  if (set["priority"] !== undefined) fields["priority"] = Number(set["priority"]);
  if (set["reviewed_at"] !== undefined) fields["reviewed_at"] = set["reviewed_at"] as SqlValue;
  if (set["waiting_on"] !== undefined) fields["waiting_on"] = str(set, "waiting_on") ?? null;
  if (set["focus"] !== undefined) fields["focus"] = str(set, "focus") ?? null;
  if (Object.keys(node).length > 0) tx.set("nodes", id, id, node);
  const due = set["due"] === undefined ? {} : { due: dueColumns(set["due"]) };
  if (Object.keys(fields).length > 0 || set["due"] !== undefined) {
    tx.set("tasks", id, id, { ...fields, ...due });
  }
  // The fields it changed, in the order they were given: a value it already held is no change.
  const changed = Object.keys(set).filter((key) => {
    if (key === "due") {
      const want = dueColumns(set["due"]);
      return Object.entries(want).some(([column, value]) => task[column] !== value);
    }
    const column = { focus: "focus_on" }[key] ?? key;
    const now = key in node ? node[key] : fields[key];
    return now !== undefined && now !== task[column];
  });
  return { task: { id, ref: refText(tx, task["ref"]) }, fields: changed };
};

const taskMove: Run = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  const parent = parentFor(tx, input["under"], "under");
  const to = String(parent["id"]);
  if (tx.get(SQL.below, { under: to, id }) !== undefined) {
    problem("INVALID_TRANSITION", "A task cannot go under itself or its subtasks", "under");
  }
  const moved = task["parent_id"] !== to;
  if (moved) tx.set("nodes", id, id, { place: { parent_id: to, position: endOf(tx, to, "task") } });
  return { task: { id, ref: refText(tx, task["ref"]) }, moved };
};

function finishOne(tx: Tx, id: string, dropped: boolean, at: number, reason: string | null) {
  tx.set("tasks", id, id, {
    lifecycle: dropped
      ? { lifecycle: "archived", completed_at: null, completed_by: null, archived_reason: reason }
      : {
          lifecycle: "completed",
          completed_at: at,
          completed_by: tx.request.actor.principal_id,
          archived_reason: null,
        },
    ...(dropped ? {} : { wrap: { wrap_state: "pending" } }),
  });
}

const taskFinish: Run = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  const dropped = input["status"] === "dropped";
  const outcome = str(input, "outcome");
  const reason = str(input, "reason") ?? null;
  const at = typeof input["at"] === "number" ? input["at"] : tx.at;
  const open = tx.all(SQL.subtree, { id }).filter((t) => t["lifecycle"] === "active");
  const choice = input["subtasks"];
  if (open.length > 0 && choice !== "only" && choice !== "all") {
    const subtasks = open.map((t) => ({ ref: refText(tx, t["ref"]), title: t["title"] }));
    problem("OPEN_SUBTASKS", "The task has open subtasks: say only or all", "subtasks", {
      subtasks,
    });
  }
  // A task finished already, by the person first or by a resend, is left as it is.
  const finishing = task["lifecycle"] === "active";
  if (finishing) finishOne(tx, id, dropped, at, reason);
  // "All" finishes every open task below, whether or not the task itself was still open.
  if (choice === "all") for (const t of open) finishOne(tx, String(t["id"]), dropped, at, null);
  if (outcome !== undefined) {
    const wrapped = task["wrap_state"] === "wrapped" && !finishing;
    if (wrapped && task["outcome"] !== outcome) {
      problem(
        "INVALID_TRANSITION",
        "The task was wrapped up already with another outcome",
        "outcome",
      );
    }
    if (!wrapped) {
      tx.set("tasks", id, id, {
        wrap: { wrap_state: "wrapped", outcome, wrapped_at: at, wrapped_by: tx.author },
      });
    }
  }
  const follow = input["follow_ups"];
  const made =
    Array.isArray(follow) && follow.length > 0
      ? tx.call("tasks.add", { tasks: follow })
      : undefined;
  const lifecycle = finishing ? (dropped ? "archived" : "completed") : task["lifecycle"];
  const wrapState =
    outcome !== undefined && !dropped
      ? "wrapped"
      : finishing && !dropped
        ? "pending"
        : (task["wrap_state"] ?? null);
  return {
    task: {
      id,
      ref: refText(tx, task["ref"]),
      finished: finishing,
      lifecycle,
      wrap_state: wrapState,
    },
    ...(choice === "all" ? { subtasks: open.length } : {}),
    ...(made === undefined ? {} : { follow_ups: (made as { tasks: unknown[] }).tasks }),
  };
};

const taskReopen: Run = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  if (task["lifecycle"] === "active") problem("INVALID_TRANSITION", "The task is open", "task");
  tx.set("tasks", id, id, {
    lifecycle: {
      lifecycle: "active",
      completed_at: null,
      completed_by: null,
      archived_reason: null,
    },
    wrap: { wrap_state: null },
  });
  return {
    task: { id, ref: refText(tx, task["ref"]), lifecycle: "active", status: task["status"] },
  };
};

const TRASHED = ["task", "routine"] as const;

const nodesTrash: Run = (tx, input) => {
  const task = liveTask(tx, input["task"], "task", "either", TRASHED);
  // A task in the Trash already is no change: two tabs that both asked get the same answer.
  if (task["deleted_at"] !== null)
    return { task: { id: task["id"], ref: refText(tx, task["ref"]) }, tasks: 0 };
  const ids = [
    String(task["id"]),
    ...tx.all(SQL.subtree, { id: String(task["id"]) }).map((t) => String(t["id"])),
  ];
  // A task goes to the Trash as the person saw it: any field of it, or of a task below it, changed
  // since the base makes the request a conflict, so work someone did meanwhile never leaves unseen.
  for (const id of ids) {
    tx.guard("nodes", id, id);
    tx.guard("tasks", id, id);
    tx.set("nodes", id, id, { deleted: { deleted_at: tx.at, deleted_by: tx.author } });
  }
  // A routine in the Trash is paused, and Restore brings it back paused.
  if (task["kind"] === "routine") {
    const id = String(task["id"]);
    tx.set("routines", id, id, { paused: { paused: 1 } });
  }
  return { task: { id: ids[0], ref: refText(tx, task["ref"]) }, tasks: ids.length };
};

const nodesRestore: Run = (tx, input) => {
  const task = liveTask(tx, input["task"], "task", "either", TRASHED);
  const id = String(task["id"]);
  if (task["deleted_at"] === null) return { task: { id, ref: refText(tx, task["ref"]) }, tasks: 0 };
  const parent = tx.get(SQL.node, { id: String(task["parent_id"]) });
  if (parent?.["deleted_at"] !== null) {
    problem("INVALID_TRANSITION", "The task above it is in the Trash: restore that one", "task");
  }
  const fp = JSON.parse(String(task["node_fp"])) as Record<string, number>;
  const seq = fp["deleted"] ?? Number(task["node_seq"]);
  const ids = [id, ...tx.all(SQL.trashedWith, { id, seq }).map((t) => String(t["id"]))];
  for (const one of ids)
    tx.set("nodes", one, one, { deleted: { deleted_at: null, deleted_by: null } });
  return { task: { id, ref: refText(tx, task["ref"]) }, tasks: ids.length };
};

/** A page by its reference or ID while what holds it lives, or undefined. */
export function findPage(tx: Tx, key: unknown): Row | undefined {
  if (typeof key !== "string") return undefined;
  const parsed = parseTaskRef(key);
  const ref = parsed !== undefined && parsed.prefix === tx.space.refPrefix ? parsed.ref : -1;
  const row = tx.get(SQL.page, { id: key, ref });
  return row?.["shown"] === 1 ? row : undefined;
}

/** What a note is on (a node, or a page), and the node its change rows belong to. */
function noteHolder(tx: Tx, key: unknown): { owner: string; node: string } {
  const page = findPage(tx, key);
  if (page !== undefined) {
    if (page["deleted_at"] !== null) problem("DELETED", "The page is in the Trash", "on");
    return { owner: String(page["id"]), node: String(page["owner_id"]) };
  }
  const node = findNode(tx, key);
  if (node === undefined || node["deleted_at"] !== null) {
    return problem("NOT_FOUND", "Nothing of that name to write on", "on");
  }
  return { owner: String(node["id"]), node: String(node["id"]) };
}

/** The node a note's change rows belong to: its owner, or the node that holds its page. */
const nodeOf = (tx: Tx, note: Row): string => {
  const owner = String(note["owner_id"]);
  const page = tx.get(SQL.pageOwner, { id: owner })?.["owner_id"];
  return typeof page === "string" ? page : owner;
};

/** A note by ID, or by its owner and ordinal. */
function findNote(tx: Tx, input: Input): Row {
  const on = input["on"];
  const row =
    typeof input["note"] === "string"
      ? tx.get(SQL.note, { id: input["note"] })
      : tx.get(SQL.noteAt, {
          owner: String(findPage(tx, on)?.["id"] ?? findNode(tx, on)?.["id"]),
          ordinal: Number(input["ordinal"]),
        });
  return row ?? problem("NOT_FOUND", "The space has no such note", "note");
}

/** The task a note is on, by its reference, when it is on a task. */
function taskOfNote(tx: Tx, owner: string): { task?: string } {
  const ref = tx.get(SQL.refOf, { id: owner })?.["ref"];
  return ref === undefined ? {} : { task: refText(tx, ref) };
}

const noteAdd: Run = (tx, input) => {
  const { owner, node } = noteHolder(tx, input["on"]);
  const kind = str(input, "kind") ?? "note";
  const body = String(input["body"]);
  return {
    note: addNote(tx, owner, node, body, kind, input["for_agents"] === true),
    ...taskOfNote(tx, owner),
  };
};

/** A note's words, and its removal, are the person's to correct: an agent writes a new note. */
function personsNote(tx: Tx, input: Input): Row {
  if (tx.request.actor.actor_kind !== "human") {
    problem("USER_ONLY", "Only a person corrects or removes a note", "note");
  }
  return findNote(tx, input);
}

const noteEdit: Run = (tx, input) => {
  const note = personsNote(tx, input);
  const body = String(input["body"]);
  const edited = note["body"] !== body;
  if (edited) {
    tx.set("notes", String(note["id"]), nodeOf(tx, note), { body: { body, edited_at: tx.at } });
  }
  return {
    note: { id: note["id"], ordinal: note["ordinal"], kind: note["kind"] },
    edited,
    ...taskOfNote(tx, String(note["owner_id"])),
  };
};

const noteGone =
  (gone: boolean): Run =>
  (tx, input) => {
    const note = personsNote(tx, input);
    // As today: a note removed already, or there already, changes nothing.
    const done = alreadyThere(note["deleted_at"] !== null, !gone);
    if (!done) {
      tx.set("notes", String(note["id"]), nodeOf(tx, note), { deleted: gone ? tx.at : null });
    }
    return {
      note: { id: note["id"], ordinal: note["ordinal"] },
      changed: !done,
      ...taskOfNote(tx, String(note["owner_id"])),
    };
  };

const projectCreate: Run = (tx, input) => {
  const parent = parentFor(tx, input["under"], "under");
  if (parent["kind"] === "task")
    problem("VALIDATION_FAILED", "A project sits in the space or a project", "under");
  const name = str(input, "title") ?? "";
  const under = String(parent["id"]);
  const slug = freeSlug(
    name,
    "project",
    (s) => tx.get(SQL.slugTaken, { parent: under, slug: s }) !== undefined,
  );
  const id = str(input, "id") ?? tx.newId("p");
  tx.create(
    "nodes",
    {
      id,
      kind: "project",
      parent_id: under,
      position: endOf(tx, under, "project"),
      title: name,
      brief: str(input, "brief") ?? "",
      slug,
      created_at: tx.at,
      created_by: tx.author,
    },
    id,
  );
  return { project: { id, slug } };
};

const projectArchived =
  (archived: boolean): Run =>
  (tx, input) => {
    const project = findNode(tx, input["project"]);
    if (project?.["kind"] !== "project")
      return problem("NOT_FOUND", "The space has no such project", "project");
    const id = String(project["id"]);
    if ((project["archived_at"] !== null) === archived) return { project: { id } };
    tx.set("nodes", id, id, { archived: archived ? tx.at : null });
    // An archive pauses the routines in the project, and an unarchive leaves them paused.
    if (archived) {
      for (const r of tx.all(SQL.unpausedRoutines, { id })) {
        tx.set("routines", String(r["id"]), String(r["id"]), { paused: { paused: 1 } });
      }
    }
    return { project: { id } };
  };

// ---------------------------------------------------------------------------------------------
// The checks: each reads a command's input through the one `Fields` today's writer reads with
// (write/request.ts), so text is normalised the same way, limits are the same, and a key the
// command does not know is refused without its text.

/** A node's key: an ID, a task's reference, `space`, or a project's path. */
export const KEY = { chars: 250, line: true } as const;
export const TITLE = { chars: WRITE_LIMITS.title, line: true } as const;
export const BRIEF = { chars: WRITE_LIMITS.summary, line: true, empty: true } as const;
export const DESCRIPTION = { bytes: WRITE_LIMITS.context, empty: true } as const;
export const NOTE = { bytes: WRITE_LIMITS.note } as const;

export type Check = Command["check"];

/** Copies the keys present, each read by its own reader, and refuses any other. */
export function read(f: Fields, readers: Record<string, (key: string) => unknown>): Input {
  const out: Input = {};
  for (const [key, reader] of Object.entries(readers)) if (f.has(key)) out[key] = reader(key);
  f.done();
  return out;
}

export const required = (f: Fields, key: string): void => {
  if (!f.has(key)) f.fail("VALIDATION_FAILED", "This field is needed", key);
};

const oneTask: Check = (f) => {
  required(f, "task");
  return read(f, { task: (k) => f.text(k, KEY) });
};

function draft(f: Fields): Input {
  required(f, "title");
  return read(f, {
    id: (k) => f.id(k, "t"),
    under: (k) => f.text(k, KEY),
    title: (k) => f.text(k, TITLE),
    brief: (k) => f.text(k, BRIEF),
    description: (k) => f.text(k, DESCRIPTION),
    status: (k) => f.key(k),
    inbox: (k) => f.boolean(k),
    priority: (k) => f.int(k, 1, 4),
    effort: (k) => f.level(k),
    due: (k) => f.due(k),
    focus: (k) => f.dateOrNull(k),
    waiting_on: (k) => f.nullableText(k, { chars: WRITE_LIMITS.line, line: true }),
    log: (k) => f.text(k, { bytes: WRITE_LIMITS.log }),
    source: (k) => ({ ...sourceFields(f.sub(k)) }),
  });
}

/** 1 to 25 task drafts at `key`, each refused under its own path (`tasks.0.title`). */
function drafts(f: Fields, key: string): Input[] {
  const list = f.raw(key);
  if (!Array.isArray(list) || list.length === 0 || list.length > 25) {
    return f.fail("VALIDATION_FAILED", "Expected 1 to 25 tasks", key);
  }
  return list.map((value: unknown, i) => draft(new Fields(value, `${key}.${String(i)}`)));
}

const checkTasksAdd: Check = (f) => {
  const tasks = drafts(f, "tasks");
  f.done();
  return { tasks };
};

const checkUpdate: Check = (f) => {
  required(f, "task");
  const task = f.text("task", KEY);
  const s = f.sub("set");
  const set = read(s, {
    title: (k) => s.text(k, TITLE),
    brief: (k) => s.text(k, BRIEF),
    description: (k) => s.text(k, DESCRIPTION),
    status: (k) => s.key(k),
    inbox: (k) => s.boolean(k),
    priority: (k) => s.int(k, 1, 4),
    effort: (k) => (s.raw(k) === null ? null : s.level(k)),
    reviewed_at: (k) => s.instantOrNull(k),
    waiting_on: (k) => s.nullableText(k, { chars: WRITE_LIMITS.line, line: true }),
    due: (k) => s.due(k),
    focus: (k) => s.dateOrNull(k),
  });
  f.done();
  return { task, set };
};

const checkMove: Check = (f) => {
  required(f, "task");
  return read(f, {
    task: (k) => f.text(k, KEY),
    under: (k) => f.text(k, KEY),
  });
};

const checkFinish: Check = (f) => {
  required(f, "task");
  const out = read(f, {
    task: (k) => f.text(k, KEY),
    status: (k) => f.oneOf(k, ["done", "dropped"]),
    reason: (k) => f.text(k, { chars: WRITE_LIMITS.line, line: true }),
    outcome: (k) => f.text(k, { bytes: WRITE_LIMITS.outcome }),
    at: (k) => f.instant(k),
    subtasks: (k) => f.oneOf(k, ["only", "all"]),
    follow_ups: (k) => drafts(f, k),
  });
  return out;
};

/** A note by its ID, or by what it is on and its number there. */
const noteKey = (f: Fields) => ({
  note: (k: string) => f.id(k, "n"),
  on: (k: string) => f.text(k, KEY),
  ordinal: (k: string) => f.int(k, 1, 1_000_000_000),
});

const checkNoteAdd: Check = (f) => {
  required(f, "on");
  required(f, "body");
  return read(f, {
    on: (k) => f.text(k, KEY),
    body: (k) => f.text(k, NOTE),
    kind: (k) => f.oneOf(k, NOTE_KINDS),
    for_agents: (k) => f.boolean(k),
  });
};

const checkNoteEdit: Check = (f) => {
  required(f, "body");
  return read(f, { ...noteKey(f), body: (k) => f.text(k, NOTE) });
};

const checkNote: Check = (f) => read(f, noteKey(f));

const checkProjectCreate: Check = (f) => {
  required(f, "title");
  return read(f, {
    id: (k) => f.id(k, "p"),
    under: (k) => f.text(k, KEY),
    title: (k) => f.text(k, TITLE),
    brief: (k) => f.text(k, BRIEF),
  });
};

const checkProject: Check = (f) => {
  required(f, "project");
  return read(f, { project: (k) => f.text(k, KEY) });
};

/** An undo or a redo: of the newest step, or of the one change it names. */
export const checkHistory: Check = (f) => read(f, { commit: (k) => f.id(k, "op") });

export const TASK_COMMANDS: Readonly<Record<string, Command>> = {
  "tasks.add": { check: checkTasksAdd, run: tasksAdd },
  "task.update": { check: checkUpdate, run: taskUpdate },
  "task.move": { check: checkMove, run: taskMove },
  "task.finish": { check: checkFinish, run: taskFinish },
  "task.reopen": { check: oneTask, run: taskReopen },
  "nodes.trash": { check: oneTask, run: nodesTrash },
  "nodes.restore": { check: oneTask, run: nodesRestore },
  "note.add": { check: checkNoteAdd, run: noteAdd },
  "note.edit": { check: checkNoteEdit, run: noteEdit },
  "note.remove": { check: checkNote, run: noteGone(true) },
  "note.put_back": { check: checkNote, run: noteGone(false) },
  "project.create": { check: checkProjectCreate, run: projectCreate },
  "project.archive": { check: checkProject, run: projectArchived(true) },
  "project.unarchive": { check: checkProject, run: projectArchived(false) },
};
