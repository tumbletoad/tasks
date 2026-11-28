// Today's plan on the tree: a request of today's operations, each run as the tree's command inside
// one commit, and answered with today's result for each. The service then has one handler per
// entry for both backends: its checks, its plan and its answer are today's, and only this decides
// what an operation does to a tree. An operation or a field of one whose family has not moved to
// the tree is named by `planGap`, which the service refuses before it sends anything.
//
// Today's area is a project at the top of the tree, and today's project one inside it, or at the
// top when it has no area. A group the request makes is made when an operation that is not left
// out puts a task in it, or at the end when no operation names it: a group only a draft that found
// its task named is not made, as today's writer leaves it out.
import type { Row, SqlValue } from "../driver.ts";
import type { Id } from "../ids.ts";
import { formatEntryRef, parseTaskRef } from "../refs.ts";
import {
  NO_SUCH_TASK,
  OTHER_SPACE_TASK,
  WRITE_LIMITS,
  type Operation,
  type OpResult,
  type PageOwner,
  type TaskCreate,
  type TaskLifecycle,
  type TextNode,
} from "../write/request.ts";
import { problem, refText } from "./commands.ts";
import { TreeProblem } from "./fields.ts";
import type { Tx } from "./tx.ts";

const SQL = {
  task:
    "SELECT n.id, n.title, n.brief, n.description, n.parent_id, n.deleted_at, " +
    "n.version AS node_version, t.* FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
  byRef: "SELECT id FROM tasks WHERE ref = $ref",
  node: "SELECT id, kind, parent_id, version FROM nodes WHERE id = $id",
  /** A group by its slug: an area at the top, a project in an area or at the top. */
  groupBySlug:
    "SELECT n.id FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.kind = 'project' " +
    "AND n.slug = $slug AND n.deleted_at IS NULL ORDER BY (p.kind = $above) DESC LIMIT 1",
  note: "SELECT id, ordinal, kind, version FROM notes WHERE id = $id",
  noteAt: "SELECT id, ordinal, kind FROM notes WHERE owner_id = $owner AND ordinal = $ordinal",
  newestLog:
    "SELECT id, ordinal FROM notes WHERE owner_id = $owner AND body = $body AND deleted_at IS NULL " +
    "ORDER BY ordinal DESC LIMIT 1",
  origin: "SELECT origin_source_id FROM tasks WHERE id = $id",
  source: "SELECT version FROM sources WHERE id = $id",
  page: "SELECT id, ref, owner_id, version FROM pages WHERE id = $id",
  /** Where a task is: its parent's kind and title, and its grandparent's. */
  place:
    "SELECT p.id AS parent, p.kind AS kind, p.title AS title, g.id AS grand, g.kind AS above, " +
    "g.title AS area FROM nodes n JOIN nodes p ON p.id = n.parent_id " +
    "LEFT JOIN nodes g ON g.id = p.parent_id WHERE n.id = $id",
} as const;

/** Today's operations the tree takes, by family as each moves. */
const OPS: ReadonlySet<Operation["kind"]> = new Set([
  "task.create",
  "task.patch",
  "task.context_append",
  "task.move",
  "task.complete",
  "task.archive",
  "task.wrap_up",
  "task.reopen",
  "task.delete",
  "task.restore",
  "source.add",
  "log.add",
  "note.add",
  "note.patch",
  "log.patch",
  "note.delete",
  "note.restore",
  "area.create",
  "project.create",
  "node.set",
  "node.instruct",
  "page.create",
  "page.edit",
  "page.append",
  "page.set",
  "page.move",
  "page.trash",
  "page.restore",
  "undo",
  "redo",
]);

/** A task's fields the tree keeps, by today's name, and the tree's node or task column. */
const NODE_TEXTS: Readonly<Record<string, string>> = {
  title: "title",
  summary: "brief",
  context: "description",
};
const TASK_FIELDS = [
  "status",
  "inbox",
  "priority",
  "effort",
  "waiting_on",
  "reviewed_at",
  "due",
  "focus",
];
const CLEARED: ReadonlySet<string> = new Set([
  "summary",
  "context",
  "effort",
  "waiting_on",
  "due",
  "focus",
]);

/** A draft's fields the tree's `tasks.add` takes. */
const DRAFT_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "id",
  "title",
  "summary",
  "context",
  "status",
  "inbox",
  "priority",
  "effort",
  "due",
  "focus",
  "waiting_on",
  "area",
  "project",
]);

/**
 * What of `op` the tree does not take yet, named for a refusal (`created_at`, `place.set`), or
 * undefined when the tree takes all of it.
 */
export function planGap(op: Operation): string | undefined {
  if (!OPS.has(op.kind)) return op.kind;
  const given = (o: object, keys: readonly string[]) =>
    keys.find((k) => (o as Record<string, unknown>)[k] !== undefined);
  switch (op.kind) {
    case "task.create":
      return (
        Object.keys(op).find((k) => !DRAFT_FIELDS.has(k)) ??
        (op.dedupe === "new" ? "dedupe" : undefined)
      );
    case "task.patch":
      return (
        Object.keys(op.set ?? {}).find((k) => !(k in NODE_TEXTS) && !TASK_FIELDS.includes(k)) ??
        (op.unset ?? []).find((k) => !CLEARED.has(k))
      );
    case "task.move":
      return given(op, ["after", "before"]);
    case "task.complete":
      return given(op, ["outcome"]);
    case "task.wrap_up":
      return (op.learnings?.add?.length ?? 0) + (op.learnings?.remove?.length ?? 0) > 0
        ? "learnings"
        : given(op, ["clear_planning"]);
    case "task.restore":
      return given(op, ["change"]);
    case "source.add":
      return op.role !== undefined && op.role !== "origin" ? "role" : given(op, ["link_version"]);
    case "log.add":
      return given(op, ["at"]);
    case "area.create":
    case "project.create":
      return given(op, ["slug", "brief", "color"]);
    case "page.set":
      return given(op, ["from_seq"]);
    default:
      return undefined;
  }
}

/** What an operation did, before its status and version are known. */
type Done = Omit<OpResult, "i" | "status" | "version"> & {
  /** Its status, when its own writes do not say it: a draft's part, or one left out. */
  readonly status?: OpResult["status"];
  /** What the result says as the whole request left it, read once every operation ran. */
  readonly after?: () => Partial<OpResult>;
  /** The row whose version the result gives. */
  readonly row: {
    readonly entity: "task" | "note" | "source" | "page" | "node";
    readonly id: string;
  };
};

/** A draft the tree matched by its source's key: its later operations are its match's. */
interface Matched {
  readonly task: string;
  readonly active: boolean;
}

/** A group the request makes: the tree's ID for it, and whether it was made. */
interface Group {
  readonly tree: string;
  readonly title: string;
  /** Today's key of its area, for a project in one. */
  readonly area: string | undefined;
  made: boolean;
}

/** One request's run: what its operations found and made, for those after them. */
class Plan {
  readonly matched = new Map<string, Matched>();
  /** Operations a draft took into its `tasks.add`: their results, by index. */
  readonly taken = new Map<number, Done>();
  /** The groups the request makes, by today's key. */
  readonly groups = new Map<string, Group>();
  /** Today's keys of the groups an operation puts a task in, or a project's area. */
  readonly named = new Set<string>();

  readonly tx: Tx;
  readonly ops: readonly Operation[];

  constructor(tx: Tx, ops: readonly Operation[]) {
    this.tx = tx;
    this.ops = ops;
    for (const op of ops) {
      if (op.kind === "task.create" || op.kind === "task.move") {
        if (typeof op.area === "string") this.named.add(op.area);
        if (typeof op.project === "string") this.named.add(op.project);
      }
      if (op.kind === "project.create" && typeof op.area === "string") this.named.add(op.area);
    }
  }
}

/** Runs today's `ops` on the tree, in order, and gives today's result of each. */
export function runPlan(tx: Tx, ops: readonly Operation[]): OpResult[] {
  const plan = new Plan(tx, ops);
  const runs: { i: number; from: number; to: number; done: Done }[] = [];
  ops.forEach((_, i) => {
    const from = tx.mark;
    const clashes = tx.conflicts.length;
    try {
      const done = plan.taken.get(i) ?? runOne(plan, i);
      runs.push({ i, from, to: tx.mark, done });
      for (const c of tx.conflicts.slice(clashes)) c.op = i;
    } catch (error) {
      for (const c of tx.conflicts.slice(clashes)) c.op = i;
      if (error instanceof TreeProblem && error.op === undefined) error.op = i;
      throw error;
    }
  });
  // A group no operation names was asked for itself.
  for (const [key, group] of plan.groups) {
    if (!group.made && !plan.named.has(key)) make(plan, groupInputs(plan, key));
  }
  // Statuses after every operation ran: a field written twice is judged as the request left it.
  return runs.map(({ i, from, to, done }) => {
    const { row, status: given, after, ...rest } = done;
    const late = after?.() ?? {};
    const status = late.status ?? given ?? tx.did(from, to);
    const result: OpResult = { i, ...rest, ...late, status, version: versionOf(tx, row, status) };
    // As today's writer: a wrap-up names no task of its own and creates nothing.
    if (ops[i]?.kind === "task.wrap_up" && status === "created") result.status = "updated";
    return result;
  });
}

function versionOf(tx: Tx, row: Done["row"], status: string): number {
  if (status !== "unchanged" && status !== "existing") return tx.seq;
  switch (row.entity) {
    case "task": {
      const task = tx.get(SQL.task, { id: row.id });
      return Math.max(Number(task?.["node_version"] ?? 0), Number(task?.["version"] ?? 0));
    }
    case "node":
      return Number(tx.get(SQL.node, { id: row.id })?.["version"] ?? 0);
    case "page":
      return Number(tx.get(SQL.page, { id: row.id })?.["version"] ?? 0);
    case "note":
      return Number(tx.get(SQL.note, { id: row.id })?.["version"] ?? 0);
    case "source":
      return Number(tx.get(SQL.source, { id: row.id })?.["version"] ?? 0);
  }
}

/** A task by today's key (an ID or `M-14`), refused as today's writer refuses one. */
function taskRow(plan: Plan, key: string): Row {
  const { tx } = plan;
  const id = plan.matched.get(key)?.task ?? key;
  const parsed = parseTaskRef(id);
  if (parsed !== undefined && parsed.prefix !== tx.space.refPrefix) {
    problem("SPACE_MISMATCH", OTHER_SPACE_TASK, "task");
  }
  const found =
    parsed === undefined
      ? tx.get(SQL.task, { id })
      : tx.get(SQL.task, { id: String(tx.get(SQL.byRef, { ref: parsed.ref })?.["id"]) });
  return found ?? problem("NOT_FOUND", NO_SUCH_TASK, "task");
}

const named = (row: Row, tx: Tx) => ({
  id: String(row["id"]),
  ref: refText(tx, row["ref"]),
  row: { entity: "task" as const, id: String(row["id"]) },
});

/** A command run for an operation, its refusal's field named as today's operation names it. */
function call(tx: Tx, command: string, input: Record<string, unknown>, strip = ""): unknown {
  try {
    return tx.call(command, input);
  } catch (error) {
    if (error instanceof TreeProblem && strip !== "" && error.field?.startsWith(strip) === true) {
      const moved = new TreeProblem(error.code, error.message, error.field.slice(strip.length));
      Object.assign(moved, { data: error.data });
      throw moved;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Groups: today's areas and projects as the tree's projects

/** The tree's node for today's group key: one the request makes, else by ID or slug. */
function groupNode(plan: Plan, key: string, kind: "area" | "project", field: string): string {
  const made = plan.groups.get(key);
  if (made !== undefined) return made.tree;
  const { tx } = plan;
  const byId = tx.get(SQL.node, { id: key });
  if (byId?.["kind"] === "project") return key;
  const above = kind === "area" ? "space" : "project";
  const bySlug = tx.get(SQL.groupBySlug, { slug: key, above })?.["id"];
  if (typeof bySlug === "string") return bySlug;
  return problem("NOT_FOUND", `No ${kind} has this ID or slug`, field);
}

/** `project.create` inputs for a group the request makes and has not made yet, its area first. */
function groupInputs(plan: Plan, key: string | undefined): Record<string, unknown>[] {
  const group = key === undefined ? undefined : plan.groups.get(key);
  if (group === undefined || group.made) return [];
  const area = groupInputs(plan, group.area);
  const under = group.area === undefined ? undefined : groupNode(plan, group.area, "area", "area");
  return [
    ...area,
    { id: group.tree, title: group.title, ...(under === undefined ? {} : { under }) },
  ];
}

/** Marks the groups of `inputs` made, after a command made them. */
function madeAll(plan: Plan, inputs: readonly Record<string, unknown>[]): void {
  for (const group of plan.groups.values()) {
    if (inputs.some((p) => p["id"] === group.tree)) group.made = true;
  }
}

function make(plan: Plan, inputs: readonly Record<string, unknown>[]): void {
  for (const input of inputs) plan.tx.call("project.create", input);
  madeAll(plan, inputs);
}

/** Where today's placement puts a task in the tree, and the groups it needs made first. */
function placement(
  plan: Plan,
  area: string | null | undefined,
  project: string | null | undefined,
): { under?: string; projects: Record<string, unknown>[] } {
  if (typeof project === "string") {
    return {
      under: groupNode(plan, project, "project", "project"),
      projects: groupInputs(plan, project),
    };
  }
  if (typeof area === "string") {
    return { under: groupNode(plan, area, "area", "area"), projects: groupInputs(plan, area) };
  }
  return { projects: [] };
}

/** A task's area and project by today's names: the tree's two levels of projects above it. */
function groupsOf(tx: Tx, id: string): { area: string | null; project: string | null } {
  const at = tx.get(SQL.place, { id });
  if (at?.["kind"] !== "project") return { area: null, project: null };
  return at["above"] === "project"
    ? { area: String(at["grand"]), project: String(at["parent"]) }
    : { area: String(at["parent"]), project: null };
}

/** What a page's owner or a node's texts are on, by today's kinds. */
function ownerOf(tx: Tx, id: string): { kind: PageOwner["kind"]; id: string } {
  const node = tx.get(SQL.node, { id });
  if (node?.["kind"] === "space") return { kind: "space", id };
  if (node?.["kind"] === "task") return { kind: "task", id };
  const parent = tx.get(SQL.node, { id: String(node?.["parent_id"]) });
  return { kind: parent?.["kind"] === "space" ? "area" : "project", id };
}

/** The tree's key for today's node or page owner. */
function nodeKey(plan: Plan, node: PageOwner | TextNode): string {
  switch (node.kind) {
    case "space":
      return "space";
    case "area":
      return groupNode(plan, node.area, "area", "area");
    case "project":
      return groupNode(plan, node.project, "project", "project");
    case "task":
      return String(taskRow(plan, node.task)["id"]);
  }
}

// ---------------------------------------------------------------------------------------------
// The operations

function runOne(plan: Plan, i: number): Done {
  const { tx } = plan;
  const op = plan.ops[i] as Operation;
  // A later operation of a matched draft: its entries go to an open match, the rest is left out.
  const on = "task" in op && typeof op.task === "string" ? plan.matched.get(op.task) : undefined;
  if (on !== undefined && !((op.kind === "log.add" || op.kind === "note.add") && on.active)) {
    const row = taskRow(plan, on.task);
    return { ...named(row, tx), task: String(row["id"]) as Id<"t">, status: "existing" };
  }
  switch (op.kind) {
    case "task.create":
      return taskCreate(plan, i, op);
    case "task.patch": {
      const task = taskRow(plan, op.task);
      const set: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(op.set ?? {})) set[NODE_TEXTS[key] ?? key] = value;
      for (const key of op.unset ?? []) {
        set[NODE_TEXTS[key] ?? key] = key in NODE_TEXTS ? "" : null;
      }
      const said = call(tx, "task.update", { task: String(task["id"]), set }) as {
        fields: string[];
      };
      const today = Object.fromEntries(Object.entries(NODE_TEXTS).map(([k, v]) => [v, k]));
      const fields = said.fields.map((f) => today[f] ?? f);
      return { ...named(task, tx), ...(fields.length === 0 ? {} : { fields }) };
    }
    case "task.context_append": {
      // Base-free, as today's: two appends both land, and the field's version still moves.
      const task = taskRow(plan, op.task);
      const id = String(task["id"]);
      const current = typeof task["description"] === "string" ? task["description"] : "";
      const context = current === "" ? op.text : `${current}\n\n${op.text}`;
      if (Buffer.byteLength(context, "utf8") > WRITE_LIMITS.context) {
        problem("TOO_LARGE", "The context would be larger than 64 KiB", "text");
      }
      tx.set("nodes", id, id, { description: context }, false);
      return { ...named(task, tx), fields: ["context"] };
    }
    case "task.move": {
      const task = taskRow(plan, op.task);
      const id = String(task["id"]);
      const before = groupsOf(tx, id);
      const where = placement(plan, op.area, op.project);
      call(tx, "task.move", {
        task: id,
        ...(where.under === undefined ? {} : { under: where.under }),
        ...(where.projects.length === 0 ? {} : { projects: where.projects }),
      });
      madeAll(plan, where.projects);
      const now = groupsOf(tx, id);
      const fields = (["area", "project"] as const).filter((f) => before[f] !== now[f]);
      return { ...named(task, tx), ...(fields.length === 0 ? {} : { fields }) };
    }
    case "task.complete":
    case "task.archive": {
      const task = taskRow(plan, op.task);
      if (task["lifecycle"] !== "active" && op.if_active !== true) {
        problem("INVALID_TRANSITION", "The task is not active", "task");
      }
      const dropped = op.kind === "task.archive";
      call(tx, "task.finish", {
        task: String(task["id"]),
        ...(dropped ? { status: "dropped" } : {}),
        ...(op.kind === "task.complete" && op.at !== undefined ? { at: op.at } : {}),
        ...(op.kind === "task.archive" && op.reason !== undefined ? { reason: op.reason } : {}),
      });
      return finished(tx, String(task["id"]), false);
    }
    case "task.wrap_up":
      return wrapUp(plan, op.task, op.outcome, op.once === true);
    case "task.reopen": {
      const task = taskRow(plan, op.task);
      call(tx, "task.reopen", { task: String(task["id"]) });
      return finished(tx, String(task["id"]), true);
    }
    case "task.delete":
    case "task.restore": {
      const task = taskRow(plan, op.task);
      const id = String(task["id"]);
      const said = call(tx, op.kind === "task.delete" ? "nodes.trash" : "nodes.restore", {
        task: id,
      }) as { tasks: number };
      return {
        ...named(task, tx),
        task: id as Id<"t">,
        ...(op.kind === "task.restore" && said.tasks > 0 ? { back: backOf(tx, id) } : {}),
      };
    }
    case "source.add": {
      const task = taskRow(plan, op.task);
      const id = String(task["id"]);
      const said = call(tx, "source.add", { on: id, source: op.source }) as {
        source: { id: string };
      };
      return {
        id: said.source.id,
        task: id as Id<"t">,
        ref: refText(tx, task["ref"]),
        row: { entity: "source", id: said.source.id },
      };
    }
    case "log.add":
    case "note.add": {
      const task = taskRow(plan, op.task);
      const id = String(task["id"]);
      const log = op.kind === "log.add";
      const said = call(tx, "note.add", {
        on: id,
        body: op.body,
        kind: log ? (op.log_kind ?? "progress") : "note",
        ...(!log && op.addressee === "agents" ? { for_agents: true } : {}),
      }) as { note: { id: string; ordinal: number } };
      return entryDone(tx, task, said.note.id, log ? "log" : "note", said.note.ordinal);
    }
    case "note.patch":
    case "log.patch":
    case "note.delete":
    case "note.restore": {
      const task = taskRow(plan, op.task);
      const id = String(task["id"]);
      const note = tx.get(SQL.noteAt, { owner: id, ordinal: op.ordinal });
      if (note === undefined || (note["kind"] === "note") !== op.kind.startsWith("note.")) {
        problem("NOT_FOUND", "The task has no entry with this number", "ordinal");
      }
      const command =
        op.kind === "note.delete"
          ? "note.remove"
          : op.kind === "note.restore"
            ? "note.put_back"
            : "note.edit";
      call(tx, command, {
        on: id,
        ordinal: op.ordinal,
        ...("body" in op ? { body: op.body } : {}),
      });
      const kind = op.kind === "log.patch" ? "log" : "note";
      return entryDone(tx, task, String(note?.["id"]), kind, op.ordinal);
    }
    case "area.create":
    case "project.create": {
      const key = op.id ?? tx.newId("p");
      // An area's ID is today's; the tree names its projects with its own.
      const tree = op.kind === "project.create" ? key : tx.newId("p");
      const group: Group = {
        tree,
        title: op.title,
        area: op.kind === "project.create" && typeof op.area === "string" ? op.area : undefined,
        made: false,
      };
      plan.groups.set(key, group);
      return {
        id: tree,
        row: { entity: "node", id: tree },
        after: () => ({ status: group.made ? "created" : "unchanged" }),
      };
    }
    case "node.set":
    case "node.instruct": {
      const node = nodeKey(plan, op.node);
      call(
        tx,
        op.kind,
        op.kind === "node.set"
          ? {
              node,
              ...(op.brief === undefined ? {} : { brief: op.brief }),
              ...(op.description === undefined ? {} : { description: op.description }),
            }
          : { node, text: op.text },
      );
      const id = node === "space" ? tx.space.spaceId : node;
      return { id, row: { entity: "node", id } };
    }
    case "page.create": {
      const said = call(tx, "page.create", {
        on: nodeKey(plan, op.owner),
        title: op.title,
        brief: op.brief,
        body: op.body,
      }) as { page: { id: string } };
      return pageDone(tx, said);
    }
    case "page.edit":
    case "page.append":
    case "page.set":
    case "page.move":
    case "page.trash":
    case "page.restore": {
      const { kind, page, ...rest } = op;
      const input: Record<string, unknown> =
        op.kind === "page.move" ? { page, on: nodeKey(plan, op.owner) } : { page, ...rest };
      delete input["owner"];
      const said = call(tx, kind, input) as {
        page: { id: string };
        found?: number;
        excerpt?: string;
      };
      return pageDone(tx, said);
    }
    default:
      throw new TreeProblem("VALIDATION_FAILED", "The tree does not take this operation yet");
  }
}

/** A note's or a log entry's result, by today's kind of entry. */
function entryDone(tx: Tx, task: Row, note: string, kind: "note" | "log", ordinal: number): Done {
  return {
    id: note,
    task: String(task["id"]) as Id<"t">,
    ref: refText(tx, task["ref"]),
    entry: formatEntryRef(kind, ordinal),
    row: { entity: "note", id: note },
  };
}

/** A page's result: what holds it now, and of an edit that wrote nothing, what stands there. */
function pageDone(tx: Tx, said: { page: { id: string }; found?: number; excerpt?: string }): Done {
  const page = tx.get(SQL.page, { id: said.page.id }) as Row;
  const found = said.found === 1 ? undefined : said.found;
  const edited = found !== undefined;
  return {
    id: said.page.id,
    ref: refText(tx, page["ref"]),
    // An edit that wrote nothing names what stands there, not what holds the page.
    ...(found !== undefined ? { found } : { owner: ownerOf(tx, String(page["owner_id"])) }),
    ...(edited && said.excerpt !== undefined ? { excerpt: said.excerpt } : {}),
    row: { entity: "page", id: said.page.id },
  };
}

/** The task as the request left it, which the answer of a finish or a reopen says. */
function finished(tx: Tx, id: string, reopened: boolean): Done {
  const read = () => tx.get(SQL.task, { id }) as Row;
  return {
    ...named(read(), tx),
    after: () => {
      const task = read();
      const wrap = task["wrap_state"];
      return {
        lifecycle: task["lifecycle"] as TaskLifecycle,
        ...(reopened ? { status_key: String(task["status"]) } : {}),
        ...(!reopened && (wrap === "pending" || wrap === "wrapped") ? { wrap_state: wrap } : {}),
      };
    },
  };
}

/**
 * Today's wrap-up of a finished task: its outcome, and the task marked wrapped. `once`: a task
 * wrapped already is left as it is when the outcome is the same, and a conflict on its wrap-up
 * otherwise, whatever the base.
 */
function wrapUp(plan: Plan, key: string, outcome: string | undefined, once: boolean): Done {
  const { tx } = plan;
  const task = taskRow(plan, key);
  const id = String(task["id"]);
  if (task["lifecycle"] === "active") {
    problem("INVALID_TRANSITION", "Only a finished task is wrapped up", "task");
  }
  const wrapped = task["wrap_state"] === "wrapped";
  const same = outcome === undefined || outcome === task["outcome"];
  if (once && wrapped && !same) tx.clash("tasks", id, id, "wrap");
  else if (!(once && wrapped)) {
    const wrap: Record<string, SqlValue> = {
      wrap_state: "wrapped",
      wrapped_at: tx.at,
      wrapped_by: tx.author,
    };
    if (outcome !== undefined) wrap["outcome"] = outcome;
    tx.set("tasks", id, id, { wrap });
  }
  return named(task, tx);
}

/** Where a restored task is back, by today's names: an area, a project in it, or the Inbox. */
function backOf(tx: Tx, id: string): NonNullable<OpResult["back"]> {
  const task = tx.get(SQL.task, { id }) as Row;
  const at = tx.get(SQL.place, { id });
  const group =
    at?.["kind"] !== "project"
      ? {}
      : at["above"] === "project"
        ? { area: String(at["area"]), project: String(at["title"]) }
        : { area: String(at["title"]) };
  return {
    lifecycle: task["lifecycle"] as NonNullable<OpResult["back"]>["lifecycle"],
    status: String(task["status"]),
    inbox: task["inbox"] === 1,
    ...group,
  };
}

/**
 * A draft: the tree's `tasks.add` with its first log entry and its first source, which a capture
 * of the source's key finds again, and the groups it goes in, made only when it is added. A draft
 * that finds its task takes its log there while that task is open; its other operations are left
 * out, as today's rebinding rules leave them.
 */
function taskCreate(plan: Plan, i: number, op: TaskCreate): Done {
  const { tx, ops } = plan;
  const id = op.id;
  const own = (kind: Operation["kind"]) =>
    id === undefined
      ? -1
      : ops.findIndex((o, k) => k > i && o.kind === kind && "task" in o && o.task === id);
  const logAt = own("log.add");
  const sourceAt = own("source.add");
  const log = logAt < 0 ? undefined : (ops[logAt] as Extract<Operation, { kind: "log.add" }>);
  const source =
    sourceAt < 0 ? undefined : (ops[sourceAt] as Extract<Operation, { kind: "source.add" }>);
  if (log !== undefined && log.log_kind !== undefined && log.log_kind !== "progress") {
    throw Object.assign(new TreeProblem("VALIDATION_FAILED", "A draft's log is progress"), {
      op: logAt,
    });
  }
  const where = placement(plan, op.area, op.project);
  const draft: Record<string, unknown> = { title: op.title };
  if (id !== undefined) draft["id"] = id;
  if (where.under !== undefined) draft["under"] = where.under;
  for (const [key, value] of Object.entries(op)) {
    if (["kind", "id", "title", "dedupe", "area", "project"].includes(key)) continue;
    draft[NODE_TEXTS[key] ?? key] = value;
  }
  if (log !== undefined) draft["log"] = log.body;
  if (source !== undefined) draft["source"] = source.source;
  const said = call(
    tx,
    "tasks.add",
    { tasks: [draft], ...(where.projects.length === 0 ? {} : { projects: where.projects }) },
    "tasks.0.",
  ) as { tasks: Row[] };
  const made = said.tasks[0] as Row;
  const task = tx.get(SQL.task, { id: String(made["id"]) }) as Row;
  const exists = made["status"] === "exists";
  if (exists && id !== undefined) {
    plan.matched.set(id, { task: String(task["id"]), active: task["lifecycle"] === "active" });
  }
  if (!exists) madeAll(plan, where.projects);
  const base = named(task, tx);
  const on = String(task["id"]) as Id<"t">;
  // As today's: a match takes the log while it is open and has none the same, else leaves it out.
  if (log !== undefined) {
    const status =
      made["log_added"] === true
        ? "created"
        : task["lifecycle"] === "active"
          ? "unchanged"
          : "existing";
    const entry = tx.get(SQL.newestLog, { owner: on, body: log.body });
    plan.taken.set(logAt, {
      id: typeof entry?.["id"] === "string" ? entry["id"] : on,
      task: on,
      ref: base.ref,
      ...(entry === undefined ? {} : { entry: formatEntryRef("log", Number(entry["ordinal"])) }),
      row: entry === undefined ? base.row : { entity: "note", id: String(entry["id"]) },
      status,
    });
  }
  if (source !== undefined) {
    const held = tx.get(SQL.origin, { id: on })?.["origin_source_id"];
    plan.taken.set(sourceAt, {
      id: typeof held === "string" ? held : on,
      task: on,
      ref: base.ref,
      row: typeof held === "string" ? { entity: "source", id: held } : base.row,
      status: exists ? "existing" : "created",
    });
  }
  return exists
    ? {
        ...base,
        status: "existing",
        task: on,
        matched_by: "source_key",
        lifecycle: task["lifecycle"] as TaskLifecycle,
      }
    : base;
}
