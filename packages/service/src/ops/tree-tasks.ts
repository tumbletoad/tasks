// The tasks family on a tree space: add, update, finish, reopen, the Trash and the read, each one
// named command of the tree's writer answered as today's entry answers. A field or form of today's
// entries whose family has not moved yet (areas and projects, dates, folders, pages, follow-ups)
// is refused until it does.
import type { TreeResult } from "@ttasks/storage";
import { digestFolderOf } from "./digest-folder.ts";
import { digestOf, DIGEST_RANGES } from "./task-view.ts";
import { notOnTreeYet, submitTree, treeReader, type TreeCall, type TreeEntry } from "./tree.ts";
import { readTreeTask, treeTrail } from "./tree-read.ts";

type Json = Record<string, unknown>;

/** Today's names of a task's texts, and the tree's. */
const TEXTS: Readonly<Record<string, string>> = { summary: "brief", context: "description" };
const TODAY_NAME: Readonly<Record<string, string>> = { brief: "summary", description: "context" };

/** The fields of today's draft and set that a tree task takes as they are. */
const SAME = ["title", "status", "inbox", "priority", "effort"] as const;

const replayed = (result: TreeResult) => (result.replayed === true ? { replayed: true } : {});

const taskOf = (call: TreeCall): string => {
  const task = call.input["task"];
  if (typeof task !== "string") throw notOnTreeYet("A call without its task");
  return task;
};

/** A draft as the tree's `tasks.add` takes it; what has not moved yet is refused by its name. */
function draftOf(draft: Json, agent: boolean): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(draft)) {
    if ((SAME as readonly string[]).includes(key)) out[key] = value;
    else if (key in TEXTS) out[TEXTS[key] ?? key] = value;
    else if (key === "log") out["log"] = value;
    else if (key === "sources") {
      const sources = value as Json[];
      if (sources.length > 1) throw notOnTreeYet("More than one source on a draft");
      if (sources[0] !== undefined) out["source"] = sources[0];
    } else throw notOnTreeYet(`A draft's ${key}`);
  }
  // As today: an agent's task without an area or a project goes to the Inbox.
  if (typeof draft["inbox"] !== "boolean" && agent) out["inbox"] = true;
  return out;
}

const taskAdd: TreeEntry = async (call) => {
  const agent = call.principal.audience === "agent";
  const drafts = (call.input["tasks"] as Json[]).map((d) => draftOf(d, agent));
  const result = await submitTree(call, "tasks.add", { tasks: drafts });
  const made = ((result.result as { tasks?: Json[] } | undefined)?.tasks ?? []).map((t, i) => ({
    result: t["status"],
    id: t["id"],
    ref: t["ref"],
    lifecycle: t["lifecycle"],
    title: t["title"],
    // The tree finds an existing task by its source's key alone.
    ...(t["status"] === "exists" ? { matched_by: "source_key" } : {}),
    log_added: t["log_added"] === true,
    // As today: a log a finished match did not take is said to be left out.
    ...(t["status"] === "exists" && t["lifecycle"] !== "active" && drafts[i]?.["log"] !== undefined
      ? { log_left_out: true }
      : {}),
  }));
  return { as_of: result.as_of, tasks: made, warnings: [], ...replayed(result) };
};

const taskUpdate: TreeEntry = async (call) => {
  for (const key of Object.keys(call.input)) {
    if (!["task", "set", "base", "request_id", "mode", "reason"].includes(key)) {
      throw notOnTreeYet(`An update's ${key}`);
    }
  }
  const given = (call.input["set"] ?? {}) as Json;
  const set: Json = {};
  for (const [key, value] of Object.entries(given)) {
    if ((SAME as readonly string[]).includes(key) || key === "waiting_on") set[key] = value;
    else if (key in TEXTS) set[TEXTS[key] ?? key] = value;
    else throw notOnTreeYet(`An update of ${key}`);
  }
  const result = await submitTree(call, "task.update", { task: taskOf(call), set });
  const said = (result.result ?? {}) as { task?: Json; fields?: string[] };
  const fields = (said.fields ?? []).map((f) => TODAY_NAME[f] ?? f);
  return {
    result: fields.length > 0 ? "updated" : "no_change",
    task: said.task?.["ref"],
    fields,
    as_of: result.as_of,
    warnings: [],
    ...replayed(result),
  };
};

/** As today: an agent that finishes without naming the pages it updated is reminded to. */
const LIBRARY_WARNING = 'Next time give library: the pages you updated, or "nothing reusable".';

const taskFinish: TreeEntry = async (call) => {
  const learnings = (call.input["learnings"] as unknown[] | undefined) ?? [];
  if (learnings.length > 0) throw notOnTreeYet("A finish's learnings");
  if (call.input["library"] !== undefined) throw notOnTreeYet("A finish's library");
  const follow = (call.input["follow_ups"] as unknown[] | undefined) ?? [];
  if (follow.length > 0) throw notOnTreeYet("A finish's follow-ups");
  const outcome = call.input["outcome"];
  const result = await submitTree(call, "task.finish", {
    task: taskOf(call),
    ...(typeof outcome === "string" ? { outcome } : {}),
  });
  const task = (result.result as { task?: Json } | undefined)?.task ?? {};
  return {
    result: task["finished"] === true ? "completed" : "no_change",
    task: task["ref"],
    lifecycle: task["lifecycle"],
    ...(task["wrap_state"] === null || task["wrap_state"] === undefined
      ? {}
      : { wrap_state: task["wrap_state"] }),
    learnings: 0,
    follow_ups: [],
    ...(call.principal.audience === "agent" ? { warnings: [LIBRARY_WARNING] } : {}),
    as_of: result.as_of,
    ...replayed(result),
  };
};

const taskReopen: TreeEntry = async (call) => {
  const result = await submitTree(call, "task.reopen", { task: taskOf(call) });
  const task = (result.result as { task?: Json } | undefined)?.task ?? {};
  return {
    result: "reopened",
    task: task["ref"],
    lifecycle: task["lifecycle"],
    status: task["status"],
    as_of: result.as_of,
    ...replayed(result),
  };
};

const taskDelete: TreeEntry = async (call) => {
  const tasks = (call.input["tasks"] as string[] | undefined) ?? [];
  if (call.input["restore"] !== undefined) throw notOnTreeYet("A restore of a change");
  if (tasks.length !== 1) throw notOnTreeYet("A Trash of other than one task");
  const result = await submitTree(call, "nodes.trash", { task: tasks[0] });
  const said = (result.result ?? {}) as { task?: Json; tasks?: number };
  const moved = (said.tasks ?? 0) > 0;
  return {
    result: moved ? "moved" : "no_change",
    moved: moved ? [said.task?.["ref"]] : [],
    // As today: a task that was in the Trash already is named.
    ...(moved ? {} : { already: [said.task?.["ref"]] }),
    ...(result.commit === undefined ? {} : { commit: result.commit }),
    as_of: result.as_of,
    ...replayed(result),
  };
};

const taskGet: TreeEntry = async (call) => {
  for (const key of ["sections", "launch", "notes", "before"]) {
    if (call.input[key] !== undefined) throw notOnTreeYet(`A read's ${key}`);
  }
  const reader = treeReader(call);
  const read = await readTreeTask(reader, taskOf(call), {
    machine: call.host.machine.id,
    ...DIGEST_RANGES,
    trash: true,
  });
  const digest = digestOf(read, call.today, await digestFolderOf(call.host, read.folder));
  const library = await treeTrail(reader, read.space, read.row);
  const more = digest["more"] as Json;
  return {
    view: "digest",
    as_of: read.space.asOf,
    bound: false,
    task: {
      ...digest,
      pages: library.pages,
      more: { ...more, pages: library.count - library.pages.length },
    },
    trail: library.trail,
  };
};

/** The tasks family's entries on a tree space. */
export const TREE_TASKS: Readonly<Record<string, TreeEntry>> = {
  "task.add": taskAdd,
  "task.update": taskUpdate,
  "task.finish": taskFinish,
  "task.reopen": taskReopen,
  "task.delete": taskDelete,
  "task.get": taskGet,
};
