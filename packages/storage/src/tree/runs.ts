// What Open and Run record on the tree, by today's rules (write/moves.ts, write/request.ts): a
// launch and a run point at a task, start in the folder they name, and move only by an edge of
// their state machine, one compare-and-set on what the caller saw, with evidence that only grows.
// A second click on a task and an instance while a launch of it still opens gets that launch. Their
// moves take no base: the compare-and-set guards them. A folder is a node's default one on the
// request's machine, as that machine spells it.
import type { Row } from "../driver.ts";
import { FOLDER_HELD, folderProblem, machineOs } from "../write/folders.ts";
import {
  decodeLaunch,
  detailText,
  LAUNCH_SQL,
  newLaunchRef,
  NO_MACHINE,
  NO_REQUEST_NOTE,
  requestOrdinal,
  resumesOf,
  whereProblem,
} from "../write/launches.ts";
import { launchAfter, launchMoveProblem, runAfter, runMoveProblem } from "../write/moves.ts";
import {
  launchCreateFields,
  launchTransitionFields,
  runCreateFields,
  runTransitionFields,
  type Fields,
} from "../write/request.ts";
import { decodeRun, runDetailText, sortedJson } from "../write/runs.ts";
import { findNode, KEY, problem, read, required, str, type Check, type Input } from "./commands.ts";
import type { Command, Tx } from "./tx.ts";

type Run = Command["run"];

const SQL = {
  machine: "SELECT 1 FROM machines WHERE id = $id",
  task: "SELECT n.id, n.deleted_at FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
  folder: "SELECT * FROM folders WHERE id = $id",
  defaultFolder:
    "SELECT * FROM folders WHERE owner_id = $owner AND machine_id = $machine AND is_default = 1 " +
    "AND deleted_at IS NULL",
  removedFolders:
    "SELECT id FROM folders WHERE owner_id = $owner AND machine_id = $machine AND is_default = 1 " +
    "AND deleted_at IS NOT NULL",
  /** The note a launch names as its request: one of its task's, not removed. */
  request:
    "SELECT 1 FROM notes WHERE owner_id = $task AND ordinal = $ordinal AND deleted_at IS NULL",
  launch: "SELECT * FROM launches WHERE id = $id",
  run: "SELECT * FROM runs WHERE id = $id",
  attempts:
    "SELECT count(*) AS n FROM runs WHERE task_id = $task AND json_extract(spec, '$.due_at') = $due",
} as const;

/** The request's machine, which must have its record in the space. */
function machineOf(tx: Tx): string {
  const machine = tx.request.actor.machine_id;
  if (tx.get(SQL.machine, { id: machine }) === undefined) {
    problem(NO_MACHINE.code, NO_MACHINE.message, NO_MACHINE.field);
  }
  return machine;
}

function liveTask(tx: Tx, id: unknown): string {
  const task = tx.get(SQL.task, { id: String(id) });
  if (task === undefined) return problem("NOT_FOUND", "The space has no such task", "task");
  if (task["deleted_at"] !== null) problem("DELETED", "The task is in the Trash", "task");
  return String(task["id"]);
}

/** A folder a launch or a run names: there, not removed, and on the request's machine. */
function folderOn(tx: Tx, id: unknown, machine: string): string | null {
  if (typeof id !== "string") return null;
  const wrong = whereProblem(tx.get(SQL.folder, { id }), machine, "folder");
  if (wrong !== undefined) problem(wrong.code, wrong.message, wrong.field);
  return id;
}

/** A launch or a run row as today's decoders read one: the tree names a folder, not a place. */
export const asToday = (row: Row): Row => ({ ...row, place_id: null });

const launchCreate: Run = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const machine = machineOf(tx);
  const folder = folderOn(tx, input["folder"], machine);
  const evidence = (input["evidence"] ?? {}) as Record<string, unknown>;
  const asked = evidence["request"];
  if (asked !== undefined) {
    const ordinal = requestOrdinal(asked);
    const found = ordinal === undefined ? undefined : tx.get(SQL.request, { task, ordinal });
    if (found === undefined) {
      problem(NO_REQUEST_NOTE.code, NO_REQUEST_NOTE.message, NO_REQUEST_NOTE.field);
    }
  }
  // A second click on the same task and instance while a launch of it still opens gets that one,
  // when both continue the same agent conversation or neither does.
  const instance = String(input["instance"]);
  const resumes = resumesOf(evidence);
  const focus = tx.get(LAUNCH_SQL.focus, { task, instance, machine, resumes })?.["id"];
  if (typeof focus === "string") return { launch: { id: focus, existing: true } };
  const id = tx.newId("la");
  const reference = newLaunchRef(tx.conn, new Set(), tx.random);
  tx.create(
    "launches",
    {
      id,
      reference,
      task_id: task,
      session_id: str(input, "session") ?? null,
      instance_id: instance,
      machine_id: machine,
      route: String(input["route"]),
      folder_id: folder,
      task_version: Number(input["task_version"]),
      brief_hash: String(input["brief_hash"]),
      state: "prepared",
      reason: null,
      detail: detailText({ evidence: evidence as never, at: { prepared: tx.at } }),
      created_at: tx.at,
      updated_at: tx.at,
    },
    null,
  );
  return { launch: { id, reference } };
};

const launchTransition: Run = (tx, input) => {
  const id = String(input["launch"]);
  const row = tx.get(SQL.launch, { id }) ?? problem("NOT_FOUND", "No launch has this ID", "launch");
  if (row["machine_id"] !== tx.request.actor.machine_id) {
    problem("VALIDATION_FAILED", "A launch moves only on the machine that dispatched it", "launch");
  }
  const op = input as unknown as Parameters<typeof launchAfter>[1];
  const refused = launchMoveProblem(op);
  if (refused !== undefined) problem(refused.code, refused.message, refused.field);
  const after = launchAfter(decodeLaunch(asToday(row)), op, tx.at);
  if (after === undefined) return { launch: { id } };
  if ("problem" in after)
    return problem(after.problem.code, after.problem.message, after.problem.field);
  tx.set("launches", id, null, { state: { ...after.write, updated_at: tx.at } }, false);
  return { launch: { id, state: after.write.state } };
};

const runCreate: Run = (tx, input) => {
  const task = liveTask(tx, input["task"]);
  const machine = machineOf(tx);
  const folder = folderOn(tx, input["folder"], machine);
  const id = tx.newId("ru");
  const due = typeof input["due_at"] === "number" ? input["due_at"] : undefined;
  // A run for a routine's time carries its due time, and its attempt counts the runs for that time.
  const attempt =
    due === undefined ? 1 : Number(tx.get(SQL.attempts, { task, due })?.["n"] ?? 0) + 1;
  tx.create(
    "runs",
    {
      id,
      task_id: task,
      session_id: str(input, "session") ?? null,
      instance_id: String(input["instance"]),
      machine_id: machine,
      adapter: String(input["adapter"]),
      folder_id: folder,
      request: String(input["request"]),
      spec: sortedJson({
        brief_hash: input["brief_hash"],
        permission: input["permission"],
        limits: input["limits"],
        ...(due === undefined ? {} : { due_at: due }),
      }),
      attempt,
      state: "queued",
      reason: null,
      detail: runDetailText({ evidence: {}, at: { queued: tx.at } }),
      result: "{}",
      started_at: null,
      ended_at: null,
      queued_at: tx.at,
    },
    null,
  );
  return { run: { id } };
};

const runTransition: Run = (tx, input) => {
  const id = String(input["run"]);
  const row = tx.get(SQL.run, { id }) ?? problem("NOT_FOUND", "No run has this ID", "run");
  if (row["machine_id"] !== tx.request.actor.machine_id) {
    problem("VALIDATION_FAILED", "A run moves only on the machine that runs it", "run");
  }
  const op = input as unknown as Parameters<typeof runAfter>[1];
  const refused = runMoveProblem(op);
  if (refused !== undefined) problem(refused.code, refused.message, refused.field);
  const after = runAfter(decodeRun(asToday(row)), op, tx.at);
  if (after === undefined) return { run: { id } };
  if ("problem" in after)
    return problem(after.problem.code, after.problem.message, after.problem.field);
  tx.set("runs", id, null, { state: { ...after.write } }, false);
  return { run: { id, state: after.write.state } };
};

/** A node's default folder on the request's machine: set, or changed, as that machine spells it. */
const folderSet: Run = (tx, input) => {
  const node = findNode(tx, input["node"]);
  if (node === undefined) return problem("NOT_FOUND", "The space has nothing of that name", "node");
  if (node["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", "node");
  const machine = machineOf(tx);
  const os = machineOs(tx.conn, machine);
  const path = String(input["path"]);
  const wrong = os === undefined ? "The machine's system is not known" : folderProblem(path, os);
  if (wrong !== undefined) problem("VALIDATION_FAILED", wrong, "path");
  const owner = String(node["id"]);
  const held = tx.get(SQL.defaultFolder, { owner, machine });
  if (held === undefined) {
    // A folder cleared since the caller's base is a change it has not seen.
    if (tx.request.base !== undefined) {
      for (const gone of tx.all(SQL.removedFolders, { owner, machine })) {
        if (tx.held("folders", String(gone["id"]), owner, ["deleted"])) return { folder: null };
      }
    }
    const id = tx.newId("fo");
    tx.create(
      "folders",
      { id, owner_id: owner, machine_id: machine, path, is_default: 1, created_at: tx.at },
      owner,
    );
    return { folder: { id } };
  }
  const id = String(held["id"]);
  if (tx.held("folders", id, owner, FOLDER_HELD)) return { folder: { id } };
  if (held["path"] !== path) tx.set("folders", id, owner, { path }, false);
  return { folder: { id } };
};

const folderClear: Run = (tx, input) => {
  const node = findNode(tx, input["node"]);
  if (node === undefined) return problem("NOT_FOUND", "The space has nothing of that name", "node");
  // A task in the Trash keeps its folder for its restore, as today's writer refuses the clear.
  if (node["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", "node");
  const owner = String(node["id"]);
  const held = tx.get(SQL.defaultFolder, { owner, machine: tx.request.actor.machine_id });
  if (held === undefined) return { folder: null };
  const id = String(held["id"]);
  if (!tx.held("folders", id, owner, FOLDER_HELD)) {
    tx.set("folders", id, owner, { deleted: tx.at }, false);
  }
  return { folder: { id } };
};

// The checks: today's readers for a launch and a run (write/request.ts), with the folder they name
// read here; the tree names a folder where today's writer names a place.

const folderOf = (f: Fields) =>
  !f.has("folder") || f.raw("folder") === null ? null : f.id("folder", "fo");

function withFolder(
  f: Fields,
  read: (f: Fields, where: typeof folderOf) => { place: string | null },
): Input {
  const { place, ...rest } = read(f, folderOf);
  f.done();
  return { ...rest, folder: place };
}

const checkFolderSet: Check = (f) => {
  required(f, "node");
  required(f, "path");
  return read(f, {
    node: (k) => f.text(k, KEY),
    path: (k) => f.text(k, { chars: 4096, line: true }),
  });
};

const checkFolderClear: Check = (f) => {
  required(f, "node");
  return read(f, { node: (k) => f.text(k, KEY) });
};

export const RUNS: Readonly<Record<string, Command>> = {
  "launch.create": { check: (f) => withFolder(f, launchCreateFields), run: launchCreate },
  "launch.transition": {
    check: (f) => {
      const out = { ...launchTransitionFields(f) };
      f.done();
      return out;
    },
    run: launchTransition,
  },
  "run.create": {
    check: (f) => {
      const due = f.has("due_at") ? f.instant("due_at") : undefined;
      return { ...withFolder(f, runCreateFields), ...(due === undefined ? {} : { due_at: due }) };
    },
    run: runCreate,
  },
  "run.transition": {
    check: (f) => {
      const out = { ...runTransitionFields(f) };
      f.done();
      return out;
    },
    run: runTransition,
  },
  "folder.set": { check: checkFolderSet, run: folderSet },
  "folder.clear": { check: checkFolderClear, run: folderClear },
};
