// Today's plan on the tree: a request of today's operations, each run as the tree's command inside
// one commit, and answered with today's result for each. The service then has one handler per
// entry for both backends: its checks, its plan and its answer are today's, and only this decides
// what an operation does to a tree. An operation or a field of one whose family has not moved to
// the tree is named by `planGap`, which the service refuses before it sends anything.
import type { Row, SqlValue } from "../driver.ts";
import type { Id } from "../ids.ts";
import { formatEntryRef, parseTaskRef } from "../refs.ts";
import {
  NO_SUCH_TASK,
  OTHER_SPACE_TASK,
  WRITE_LIMITS,
  type LogAdd,
  type Operation,
  type OpResult,
  type SourceAdd,
  type TaskCreate,
  type TaskLifecycle,
} from "../write/request.ts";
import { problem, refText } from "./commands.ts";
import { TreeProblem } from "./fields.ts";
import type { Tx } from "./tx.ts";

const SQL = {
  task:
    "SELECT n.id, n.title, n.brief, n.description, n.deleted_at, n.version AS node_version, t.* " +
    "FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
  byRef: "SELECT id FROM tasks WHERE ref = $ref",
  note: "SELECT ordinal, version FROM notes WHERE id = $id",
  newestLog:
    "SELECT id, ordinal FROM notes WHERE owner_id = $owner AND body = $body AND deleted_at IS NULL " +
    "ORDER BY ordinal DESC LIMIT 1",
  origin: "SELECT origin_source_id FROM tasks WHERE id = $id",
  source: "SELECT version FROM sources WHERE id = $id",
  /** Where a restored task is back: its parent's names, a top-level project as its area. */
  back:
    "SELECT p.kind AS kind, p.title AS title, g.kind AS above, g.title AS area FROM nodes n " +
    "JOIN nodes p ON p.id = n.parent_id LEFT JOIN nodes g ON g.id = p.parent_id WHERE n.id = $id",
} as const;

/** Today's operations the tree takes, by family as each moves. */
const OPS: ReadonlySet<Operation["kind"]> = new Set([
  "task.create",
  "task.patch",
  "task.context_append",
  "task.complete",
  "task.archive",
  "task.wrap_up",
  "task.reopen",
  "task.delete",
  "task.restore",
  "source.add",
  "log.add",
]);

/** A task's fields the tree keeps, by today's name, and the tree's node or task column. */
const NODE_TEXTS: Readonly<Record<string, string>> = {
  title: "title",
  summary: "brief",
  context: "description",
};
const TASK_FIELDS = ["status", "inbox", "priority", "effort", "waiting_on", "reviewed_at"];
const CLEARED: ReadonlySet<string> = new Set(["summary", "context", "effort", "waiting_on"]);

/** A draft's fields the tree's `tasks.add` takes. */
const DRAFT_FIELDS = new Set(["kind", "id", "title", "summary", "context", "status", "inbox"]);
const DRAFT_MORE = new Set(["priority", "effort"]);

/**
 * What of `op` the tree does not take yet, named for a refusal (`area`, `task.move`), or undefined
 * when the tree takes all of it.
 */
export function planGap(op: Operation): string | undefined {
  if (!OPS.has(op.kind)) return op.kind;
  const given = (o: object, keys: readonly string[]) =>
    keys.find((k) => (o as Record<string, unknown>)[k] !== undefined);
  switch (op.kind) {
    case "task.create":
      return (
        Object.keys(op).find((k) => !DRAFT_FIELDS.has(k) && !DRAFT_MORE.has(k)) ??
        (op.dedupe === "new" ? "dedupe" : undefined)
      );
    case "task.patch":
      return (
        Object.keys(op.set ?? {}).find((k) => !(k in NODE_TEXTS) && !TASK_FIELDS.includes(k)) ??
        (op.unset ?? []).find((k) => !CLEARED.has(k))
      );
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
    default:
      return undefined;
  }
}

/** What an operation did, before its status and version are known. */
type Done = Omit<OpResult, "i" | "status" | "version"> & {
  /** Its status, when its own writes do not say it: a draft's part, or one left out. */
  readonly status?: OpResult["status"];
  /** What the result says of the task as the whole request left it, read once all ops ran. */
  readonly after?: () => Partial<OpResult>;
  /** The row whose version the result gives. */
  readonly row: { readonly entity: "task" | "note" | "source"; readonly id: string };
};

/** A draft the tree matched by its source's key: its later operations are its match's. */
interface Matched {
  readonly task: string;
  readonly active: boolean;
}

/** Runs today's `ops` on the tree, in order, and gives today's result of each. */
export function runPlan(tx: Tx, ops: readonly Operation[]): OpResult[] {
  const matched = new Map<string, Matched>();
  /** Operations a draft took into its `tasks.add`: their results, by index. */
  const taken = new Map<number, Done>();
  const runs: { i: number; from: number; to: number; done: Done }[] = [];
  ops.forEach((_, i) => {
    const from = tx.mark;
    const clashes = tx.conflicts.length;
    try {
      const done = taken.get(i) ?? runOne(tx, ops, i, matched, taken);
      runs.push({ i, from, to: tx.mark, done });
      for (const c of tx.conflicts.slice(clashes)) c.op = i;
    } catch (error) {
      for (const c of tx.conflicts.slice(clashes)) c.op = i;
      if (error instanceof TreeProblem && error.op === undefined) error.op = i;
      throw error;
    }
  });
  // Statuses after every operation ran: a field written twice is judged as the request left it.
  return runs.map(({ i, from, to, done }) => {
    const { row, status: given, after, ...rest } = done;
    const status = given ?? tx.did(from, to);
    const result: OpResult = {
      i,
      status,
      ...rest,
      ...after?.(),
      version: versionOf(tx, row, status),
    };
    // As today's writer: a wrap-up names no task of its own and creates nothing.
    if (ops[i]?.kind === "task.wrap_up" && status === "created") result.status = "updated";
    return result;
  });
}

function versionOf(tx: Tx, row: Done["row"], status: string): number {
  if (status !== "unchanged" && status !== "existing") return tx.seq;
  if (row.entity === "task") {
    const task = tx.get(SQL.task, { id: row.id });
    return Math.max(Number(task?.["node_version"] ?? 0), Number(task?.["version"] ?? 0));
  }
  return Number(tx.get(row.entity === "note" ? SQL.note : SQL.source, { id: row.id })?.["version"]);
}

/** A task by today's key (an ID or `M-14`), refused as today's writer refuses one. */
function taskRow(tx: Tx, key: string, matched: ReadonlyMap<string, Matched>): Row {
  const id = matched.get(key)?.task ?? key;
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

/** A command run for operation `op`, its fields named as today's operation names them. */
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

function runOne(
  tx: Tx,
  ops: readonly Operation[],
  i: number,
  matched: Map<string, Matched>,
  taken: Map<number, Done>,
): Done {
  const op = ops[i] as Operation;
  // A later operation of a matched draft: its entries go to an open match, the rest is left out.
  const on = "task" in op && typeof op.task === "string" ? matched.get(op.task) : undefined;
  if (on !== undefined && !(op.kind === "log.add" && on.active)) {
    const row = taskRow(tx, on.task, matched);
    return { ...named(row, tx), task: String(row["id"]) as Id<"t">, status: "existing" };
  }
  switch (op.kind) {
    case "task.create":
      return taskCreate(tx, ops, i, op, matched, taken);
    case "task.patch": {
      const task = taskRow(tx, op.task, matched);
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
      const task = taskRow(tx, op.task, matched);
      const id = String(task["id"]);
      const current = typeof task["description"] === "string" ? task["description"] : "";
      const context = current === "" ? op.text : `${current}\n\n${op.text}`;
      if (Buffer.byteLength(context, "utf8") > WRITE_LIMITS.context) {
        problem("TOO_LARGE", "The context would be larger than 64 KiB", "text");
      }
      tx.set("nodes", id, id, { description: context }, false);
      return { ...named(task, tx), fields: ["context"] };
    }
    case "task.complete":
    case "task.archive": {
      const task = taskRow(tx, op.task, matched);
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
      return wrapUp(tx, op.task, op.outcome, op.once === true, matched);
    case "task.reopen": {
      const task = taskRow(tx, op.task, matched);
      call(tx, "task.reopen", { task: String(task["id"]) });
      return finished(tx, String(task["id"]), true);
    }
    case "task.delete":
    case "task.restore": {
      const task = taskRow(tx, op.task, matched);
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
    case "source.add":
      return sourceAdd(tx, op, matched);
    case "log.add":
      return logAdd(tx, op, matched);
    default:
      throw new TreeProblem("VALIDATION_FAILED", "The tree does not take this operation yet");
  }
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
function wrapUp(
  tx: Tx,
  key: string,
  outcome: string | undefined,
  once: boolean,
  matched: ReadonlyMap<string, Matched>,
): Done {
  const task = taskRow(tx, key, matched);
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
  const at = tx.get(SQL.back, { id });
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
 * of the source's key finds again. A draft that finds its task takes its log there while that task
 * is open; its other operations are left out, as today's rebinding rules leave them.
 */
function taskCreate(
  tx: Tx,
  ops: readonly Operation[],
  i: number,
  op: TaskCreate,
  matched: Map<string, Matched>,
  taken: Map<number, Done>,
): Done {
  const id = op.id;
  const own = (kind: Operation["kind"]) =>
    id === undefined
      ? -1
      : ops.findIndex((o, k) => k > i && o.kind === kind && "task" in o && o.task === id);
  const logAt = own("log.add");
  const sourceAt = own("source.add");
  const log = logAt < 0 ? undefined : (ops[logAt] as LogAdd);
  const source = sourceAt < 0 ? undefined : (ops[sourceAt] as SourceAdd);
  if (log !== undefined && log.log_kind !== undefined && log.log_kind !== "progress") {
    throw Object.assign(new TreeProblem("VALIDATION_FAILED", "A draft's log is progress"), {
      op: logAt,
    });
  }
  const draft: Record<string, unknown> = { title: op.title };
  if (id !== undefined) draft["id"] = id;
  for (const [key, value] of Object.entries(op)) {
    if (key === "kind" || key === "id" || key === "title" || key === "dedupe") continue;
    draft[NODE_TEXTS[key] ?? key] = value;
  }
  if (log !== undefined) draft["log"] = log.body;
  if (source !== undefined) draft["source"] = source.source;
  const said = call(tx, "tasks.add", { tasks: [draft] }, "tasks.0.") as { tasks: Row[] };
  const made = said.tasks[0] as Row;
  const task = tx.get(SQL.task, { id: String(made["id"]) }) as Row;
  const exists = made["status"] === "exists";
  if (exists && id !== undefined) {
    matched.set(id, { task: String(task["id"]), active: task["lifecycle"] === "active" });
  }
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
    taken.set(logAt, {
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
    taken.set(sourceAt, {
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
        task: String(task["id"]) as Id<"t">,
        matched_by: "source_key",
        lifecycle: task["lifecycle"] as TaskLifecycle,
      }
    : base;
}

function sourceAdd(tx: Tx, op: SourceAdd, matched: ReadonlyMap<string, Matched>): Done {
  const task = taskRow(tx, op.task, matched);
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

function logAdd(tx: Tx, op: LogAdd, matched: ReadonlyMap<string, Matched>): Done {
  const task = taskRow(tx, op.task, matched);
  const id = String(task["id"]);
  const said = call(tx, "note.add", {
    on: id,
    body: op.body,
    kind: op.log_kind ?? "progress",
  }) as { note: { id: string; ordinal: number } };
  return {
    id: said.note.id,
    task: id as Id<"t">,
    ref: refText(tx, task["ref"]),
    entry: formatEntryRef("log", said.note.ordinal),
    row: { entity: "note", id: said.note.id },
  };
}
