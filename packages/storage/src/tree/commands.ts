// The tree's named commands for tasks, the Trash and projects. Each reads what it needs and writes
// through its Tx, statement by statement, so every statement sees the ones before it; nothing is
// predicted in memory. A command returns what it did, which the receipt stores. Input is checked
// here as well as by the service: storage never trusts a caller with the space.
import type { SqlValue } from "../driver.ts";
import { freeSlug } from "../write/slugs.ts";
import {
  addNote,
  endOf,
  findNode,
  givenId,
  liveTask,
  parentFor,
  problem,
  refText,
  text,
  title,
  type Input,
} from "./inputs.ts";
import { KNOWLEDGE } from "./knowledge.ts";
import type { Command, Tx } from "./tx.ts";

const SQL = {
  node: "SELECT * FROM nodes WHERE id = $id",
  slugTaken: "SELECT 1 FROM nodes WHERE parent_id = $parent AND kind = 'project' AND slug = $slug",
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
} as const;

const tasksAdd: Command = (tx, input) => {
  const drafts = input["tasks"];
  if (!Array.isArray(drafts) || drafts.length === 0 || drafts.length > 25) {
    return problem("VALIDATION_FAILED", "Expected 1 to 25 tasks", "tasks");
  }
  return {
    tasks: drafts.map((raw: unknown, i) => {
      const draft = (typeof raw === "object" && raw !== null ? raw : {}) as Input;
      const at = (field: string) => `tasks.${String(i)}.${field}`;
      const log = text(draft, "log", 4000, false);
      const parent = parentFor(tx, draft["under"], at("under"));
      const id = givenId(draft["id"], "t", at("id")) ?? tx.newId("t");
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
      tx.create(
        "tasks",
        {
          id,
          ref,
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
  const task = liveTask(tx, input["task"], "task", "either");
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
  return { task: { id: ids[0], ref: refText(tx, task["ref"]) }, tasks: ids.length };
};

const nodesRestore: Command = (tx, input) => {
  const task = liveTask(tx, input["task"], "task", "either");
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
  const id = givenId(input["id"], "p", "id") ?? tx.newId("p");
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
  "project.create": projectCreate,
  "project.archive": projectArchived(true),
  "project.unarchive": projectArchived(false),
  ...KNOWLEDGE,
};
