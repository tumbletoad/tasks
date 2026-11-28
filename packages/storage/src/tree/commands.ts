// The tree's named commands. Each reads what it needs and writes through its Tx, statement by
// statement, so every statement sees the ones before it; nothing is predicted in memory. A command
// returns what it did, which the receipt stores. Input is checked here as well as by the service:
// storage never trusts a caller with the space.
import { readPreference } from "@ttasks/contracts/preferences";
import type { Row, SqlValue } from "../driver.ts";
import { formatTaskRef, parseTaskRef } from "../refs.ts";
import { positionBetween } from "../write/positions.ts";
import { freeSlug } from "../write/slugs.ts";
import type { Command, Tx } from "./tx.ts";
import { TreeProblem } from "./fields.ts";

type Input = Record<string, unknown>;

const DAY_MS = 86_400_000;
const NOTE_KINDS = ["note", "progress", "evidence", "blocker", "decision", "question", "handoff"];

const SQL = {
  node: "SELECT * FROM nodes WHERE id = $id",
  taskByRef: "SELECT id FROM tasks WHERE ref = $ref",
  child:
    "SELECT * FROM nodes WHERE parent_id = $parent AND kind = 'project' AND (slug = $slug OR lower(title) = $title)",
  lastPosition: "SELECT max(position) AS p FROM nodes WHERE parent_id = $parent AND kind = $kind",
  slugTaken: "SELECT 1 FROM nodes WHERE parent_id = $parent AND kind = 'project' AND slug = $slug",
  task:
    "SELECT n.id, n.parent_id, n.title, n.deleted_at, n.fp AS node_fp, n.created_seq AS node_seq, " +
    "t.ref, t.lifecycle, t.wrap_state, t.outcome FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
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
  liveSource: "SELECT id FROM sources WHERE source_key = $key AND deleted_at IS NULL",
  /** The newest live task a source is the origin of. */
  originTask:
    "SELECT t.id, t.ref, t.lifecycle, t.completed_at FROM tasks t JOIN nodes n ON n.id = t.id " +
    "WHERE t.origin_source_id = $source AND n.deleted_at IS NULL ORDER BY n.created_seq DESC LIMIT 1",
  lastOrdinal: "SELECT max(ordinal) AS o FROM notes WHERE owner_id = $owner",
  note: "SELECT * FROM notes WHERE id = $id",
  noteAt: "SELECT * FROM notes WHERE owner_id = $owner AND ordinal = $ordinal",
} as const;

const problem = (code: string, message: string, field?: string, data?: unknown): never => {
  throw new TreeProblem(code, message, field, data);
};

const text = (input: Input, field: string, max: number, oneLine = true): string | undefined => {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max || (oneLine && value.includes("\n"))) {
    return problem(
      "VALIDATION_FAILED",
      `Expected ${field} as text of at most ${String(max)}`,
      field,
    );
  }
  return value;
};

const title = (input: Input): string => {
  const value = text(input, "title", 300);
  if (value === undefined || value.trim() === "")
    problem("VALIDATION_FAILED", "A title is needed", "title");
  return value as string;
};

/** A node by ID, or a task by its reference (`M-14`). Undefined when the space has none. */
function findNode(tx: Tx, key: unknown): Row | undefined {
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

function liveTask(tx: Tx, key: unknown, field = "task", deleted = false): Row {
  const found = findNode(tx, key);
  if (found?.["kind"] !== "task") return problem("NOT_FOUND", "The space has no such task", field);
  const task = tx.get(SQL.task, { id: String(found["id"]) }) as Row;
  if ((task["deleted_at"] !== null) !== deleted) {
    problem(
      deleted ? "INVALID_TRANSITION" : "DELETED",
      deleted ? "The task is not in the Trash" : "The task is in the Trash",
      field,
    );
  }
  return task;
}

/** The end of a parent's children of one kind. */
const endOf = (tx: Tx, parent: string, kind: string): string => {
  const last = tx.get(SQL.lastPosition, { parent, kind })?.["p"];
  return positionBetween(typeof last === "string" ? last : undefined, undefined);
};

const refText = (tx: Tx, ref: unknown): string => formatTaskRef(tx.space.refPrefix, Number(ref));

/** Where a new or moved task goes: a live project, a live task, or the space. */
function parentFor(tx: Tx, under: unknown, field: string): Row {
  const found =
    under === undefined ? tx.get(SQL.node, { id: tx.space.spaceId }) : findNode(tx, under);
  if (found === undefined)
    return problem("NOT_FOUND", "Nothing of that name to put it under", field);
  if (found["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", field);
  if (found["archived_at"] !== null && found["archived_at"] !== undefined) {
    problem("INVALID_TRANSITION", "That project is archived", field);
  }
  return found;
}

function addNote(tx: Tx, owner: string, node: string, body: string, kind = "note", agents = false) {
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

/** A draft that names a source key the space captured before: the task it made, if it still counts. */
function captured(tx: Tx, key: string): { task: Row | undefined; source: string | undefined } {
  const source = tx.get(SQL.liveSource, { key })?.["id"];
  if (typeof source !== "string") return { task: undefined, source: undefined };
  const task = tx.get(SQL.originTask, { source });
  if (task === undefined) return { task: undefined, source };
  const days = readPreference("tasks.dedupe_window_days", undefined).value as number;
  const finished = task["completed_at"];
  const counts =
    task["lifecycle"] === "active" ||
    (typeof finished === "number" && finished >= tx.at - days * DAY_MS);
  return { task: counts ? task : undefined, source };
}

const tasksAdd: Command = (tx, input) => {
  const drafts = input["tasks"];
  if (!Array.isArray(drafts) || drafts.length === 0 || drafts.length > 25) {
    return problem("VALIDATION_FAILED", "Expected 1 to 25 tasks", "tasks");
  }
  return {
    tasks: drafts.map((raw: unknown, i) => {
      const draft = (typeof raw === "object" && raw !== null ? raw : {}) as Input;
      const at = (field: string) => `tasks.${String(i)}.${field}`;
      const source = draft["source"] as Input | undefined;
      const key = source === undefined ? undefined : text(source, "key", 200);
      const log = text(draft, "log", 4000, false);
      const found = key === undefined ? { task: undefined, source: undefined } : captured(tx, key);
      if (found.task !== undefined) {
        const id = String(found.task["id"]);
        if (log !== undefined) addNote(tx, id, id, log, "progress");
        return { status: "exists", id, ref: refText(tx, found.task["ref"]) };
      }
      const parent = parentFor(tx, draft["under"], at("under"));
      const id = typeof draft["id"] === "string" ? draft["id"] : tx.newId("t");
      const ref = tx.ref();
      const priority = draft["priority"] ?? 4;
      if (typeof priority !== "number" || ![1, 2, 3, 4].includes(priority)) {
        problem("VALIDATION_FAILED", "A priority is 1 to 4", at("priority"));
      }
      tx.create(
        "nodes",
        {
          id,
          kind: "task",
          parent_id: String(parent["id"]),
          position: endOf(tx, String(parent["id"]), "task"),
          title: title(draft),
          brief: text(draft, "brief", 400) ?? "",
          description: text(draft, "description", 64_000, false) ?? "",
          created_at: tx.at,
          created_by: tx.author,
        },
        id,
      );
      let origin: string | null = found.source ?? null;
      if (source !== undefined && origin === null) {
        origin = tx.newId("s");
        tx.create(
          "sources",
          {
            id: origin,
            ref: tx.ref(),
            owner_id: id,
            kind: text(source, "kind", 40) ?? "other",
            title: title(source),
            url: text(source, "url", 2000) ?? null,
            who: text(source, "who", 200) ?? null,
            outside_ref: text(source, "ref", 200) ?? null,
            source_key: key ?? null,
            created_at: tx.at,
            created_by: tx.author,
          },
          id,
        );
      }
      tx.create(
        "tasks",
        {
          id,
          ref,
          origin_source_id: origin,
          status: text(draft, "status", 40) ?? "open",
          inbox: draft["inbox"] === true ? 1 : 0,
          priority: priority as number,
          created_session: tx.request.actor.session_id ?? null,
        },
        id,
      );
      if (log !== undefined) addNote(tx, id, id, log, "progress");
      return { status: "created", id, ref: refText(tx, ref) };
    }),
  };
};

/** The fields `task.update` sets: on the node, or on the task. */
const NODE_SET = ["title", "brief", "description"] as const;
const TASK_SET = ["status", "inbox", "priority", "reviewed_at", "waiting_on"] as const;

const taskUpdate: Command = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  const set = (input["set"] ?? {}) as Input;
  const unknown = Object.keys(set).find(
    (k) =>
      !(NODE_SET as readonly string[]).includes(k) && !(TASK_SET as readonly string[]).includes(k),
  );
  if (unknown !== undefined)
    problem("VALIDATION_FAILED", "Not a field this sets", `set.${unknown}`);
  const node: Record<string, SqlValue> = {};
  if (set["title"] !== undefined) node["title"] = title(set);
  if (set["brief"] !== undefined) node["brief"] = text(set, "brief", 400) ?? "";
  if (set["description"] !== undefined)
    node["description"] = text(set, "description", 64_000, false) ?? "";
  const fields: Record<string, SqlValue> = {};
  if (set["status"] !== undefined) fields["status"] = text(set, "status", 40) ?? "open";
  if (set["inbox"] !== undefined) fields["inbox"] = set["inbox"] === true ? 1 : 0;
  if (set["priority"] !== undefined) fields["priority"] = Number(set["priority"]);
  if (set["reviewed_at"] !== undefined) fields["reviewed_at"] = set["reviewed_at"] as SqlValue;
  if (set["waiting_on"] !== undefined) fields["waiting_on"] = text(set, "waiting_on", 400) ?? null;
  if (Object.keys(node).length > 0) tx.set("nodes", id, id, node);
  if (Object.keys(fields).length > 0) tx.set("tasks", id, id, fields);
  return { task: { id, ref: refText(tx, task["ref"]) } };
};

const taskMove: Command = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  const parent = parentFor(tx, input["under"], "under");
  const to = String(parent["id"]);
  if (tx.get(SQL.below, { under: to, id }) !== undefined) {
    problem("INVALID_TRANSITION", "A task cannot go under itself or its subtasks", "under");
  }
  if (task["parent_id"] !== to)
    tx.set("nodes", id, id, { place: { parent_id: to, position: endOf(tx, to, "task") } });
  return { task: { id, ref: refText(tx, task["ref"]) } };
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

const taskFinish: Command = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const id = String(task["id"]);
  const dropped = input["status"] === "dropped";
  const outcome = text(input, "outcome", 4000, false);
  const reason = text(input, "reason", 400) ?? null;
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
  if (finishing) {
    finishOne(tx, id, dropped, at, reason);
    if (choice === "all") for (const t of open) finishOne(tx, String(t["id"]), dropped, at, null);
  }
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
  return {
    task: { id, ref: refText(tx, task["ref"]), finished: finishing },
    ...(choice === "all" ? { subtasks: open.length } : {}),
    ...(made === undefined ? {} : { follow_ups: (made as { tasks: unknown[] }).tasks }),
  };
};

const taskReopen: Command = (tx, input) => {
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
  return { task: { id, ref: refText(tx, task["ref"]) } };
};

const nodesTrash: Command = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const ids = [
    String(task["id"]),
    ...tx.all(SQL.subtree, { id: String(task["id"]) }).map((t) => String(t["id"])),
  ];
  for (const id of ids)
    tx.set("nodes", id, id, { deleted: { deleted_at: tx.at, deleted_by: tx.author } });
  return { task: { id: ids[0], ref: refText(tx, task["ref"]) }, tasks: ids.length };
};

const nodesRestore: Command = (tx, input) => {
  const task = liveTask(tx, input["task"], "task", true);
  const id = String(task["id"]);
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

/** A note by ID, or by its owner and ordinal. */
function findNote(tx: Tx, input: Input): Row {
  const row =
    typeof input["note"] === "string"
      ? tx.get(SQL.note, { id: input["note"] })
      : tx.get(SQL.noteAt, {
          owner: String(findNode(tx, input["on"])?.["id"]),
          ordinal: Number(input["ordinal"]),
        });
  return row ?? problem("NOT_FOUND", "The space has no such note", "note");
}

const noteAdd: Command = (tx, input) => {
  const owner = findNode(tx, input["on"]);
  if (owner === undefined || owner["deleted_at"] !== null)
    problem("NOT_FOUND", "Nothing of that name to write on", "on");
  const kind = input["kind"] ?? "note";
  if (typeof kind !== "string" || !NOTE_KINDS.includes(kind))
    problem("VALIDATION_FAILED", "Not a kind of note", "kind");
  const body = text(input, "body", 16_000, false);
  if (body === undefined || body.trim() === "")
    return problem("VALIDATION_FAILED", "A note needs words", "body");
  const id = String(owner?.["id"]);
  return { note: addNote(tx, id, id, body, kind as string, input["for_agents"] === true) };
};

const noteEdit: Command = (tx, input) => {
  const note = findNote(tx, input);
  const body = text(input, "body", 16_000, false);
  if (body === undefined || body.trim() === "")
    return problem("VALIDATION_FAILED", "A note needs words", "body");
  if (note["body"] !== body) {
    tx.set("notes", String(note["id"]), String(note["owner_id"]), {
      body: { body, edited_at: tx.at },
    });
  }
  return { note: { id: note["id"], ordinal: note["ordinal"] } };
};

const noteGone =
  (gone: boolean): Command =>
  (tx, input) => {
    const note = findNote(tx, input);
    tx.set("notes", String(note["id"]), String(note["owner_id"]), { deleted: gone ? tx.at : null });
    return { note: { id: note["id"], ordinal: note["ordinal"] } };
  };

const projectCreate: Command = (tx, input) => {
  const parent = parentFor(tx, input["under"], "under");
  if (parent["kind"] === "task")
    problem("VALIDATION_FAILED", "A project sits in the space or a project", "under");
  const name = title(input);
  const under = String(parent["id"]);
  const slug = freeSlug(
    name,
    "project",
    (s) => tx.get(SQL.slugTaken, { parent: under, slug: s }) !== undefined,
  );
  const id = typeof input["id"] === "string" ? input["id"] : tx.newId("p");
  tx.create(
    "nodes",
    {
      id,
      kind: "project",
      parent_id: under,
      position: endOf(tx, under, "project"),
      title: name,
      brief: text(input, "brief", 400) ?? "",
      slug,
      created_at: tx.at,
      created_by: tx.author,
    },
    id,
  );
  return { project: { id, slug } };
};

const projectArchived =
  (archived: boolean): Command =>
  (tx, input) => {
    const project = findNode(tx, input["project"]);
    if (project?.["kind"] !== "project")
      return problem("NOT_FOUND", "The space has no such project", "project");
    const id = String(project["id"]);
    if ((project["archived_at"] !== null) !== archived)
      tx.set("nodes", id, id, { archived: archived ? tx.at : null });
    return { project: { id } };
  };

export const COMMANDS: Readonly<Record<string, Command>> = {
  "tasks.add": tasksAdd,
  "task.update": taskUpdate,
  "task.move": taskMove,
  "task.finish": taskFinish,
  "task.reopen": taskReopen,
  "nodes.trash": nodesTrash,
  "nodes.restore": nodesRestore,
  "note.add": noteAdd,
  "note.edit": noteEdit,
  "note.remove": noteGone(true),
  "note.put_back": noteGone(false),
  "project.create": projectCreate,
  "project.archive": projectArchived(true),
  "project.unarchive": projectArchived(false),
};
