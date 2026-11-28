// Launches, runs and a task's folder, the same ordinary sequences on today's writer and the tree's:
// a launch and a second click, its moves; a run queued, started and ended, and one stopped; a
// folder set, changed, removed, and cleared while its task is in the Trash. What each answered and
// what a reader sees of the launches, the runs and the folder are compared. Fixture text only.
import { afterAll, describe, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Operation } from "../src/write/request.ts";
import {
  both,
  TodaySession,
  todayAnswer,
  TreeSession,
  treeAnswer,
  type Side,
} from "./both-helpers.ts";
import { tempFolders } from "./space-helpers.ts";
import { fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("runs-both");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

const TASK = "Fix the export";
const HASH = "a1b2c3d4".repeat(8);
const LIMITS = { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 };

type Step =
  | { do: "task" }
  | { do: "launch"; as: string }
  | { do: "launch moves"; launch: string; from: string; to: string }
  | { do: "run"; as: string }
  | { do: "run moves"; run: string; from: string; to: string }
  | { do: "folder"; name: string }
  | { do: "folder clear" }
  | { do: "trash" | "restore" };

/** The folder's last part: each machine spells the path its own way. */
const lastPart = (path: unknown) =>
  typeof path === "string" ? (path.split(/[\\/]/u).at(-1) ?? null) : null;

type Named = { names: Map<string, string> };

const TODAY: Side<Step, TodaySession & Named> = {
  open: async () => Object.assign(new TodaySession(await fixture()), { names: new Map() }),
  step: (s, step) => {
    const named = (key: string) => s.names.get(key) ?? "";
    let ops: Operation[];
    switch (step.do) {
      case "task":
        ops = [{ kind: "task.create", id: newId("t"), title: TASK }];
        break;
      case "launch":
        ops = [
          {
            kind: "launch.create",
            task: s.task(TASK),
            instance: "codex-work",
            route: "terminal",
            place: null,
            task_version: 3,
            brief_hash: HASH,
          },
        ];
        break;
      case "launch moves":
        ops = [
          {
            kind: "launch.transition",
            launch: named(step.launch) as Id<"la">,
            expect: step.from as never,
            next: step.to as never,
          },
        ];
        break;
      case "run":
        ops = [
          {
            kind: "run.create",
            task: s.task(TASK),
            instance: "codex-work",
            adapter: "codex",
            place: null,
            request: "Check the export",
            brief_hash: HASH,
            permission: "full-access",
            limits: LIMITS,
          },
        ];
        break;
      case "run moves": {
        const id = named(step.run);
        const version = Number(
          s.fx.reader.prepare("SELECT version FROM runs WHERE id = $id").get({ id })?.["version"],
        );
        ops = [
          {
            kind: "run.transition",
            run: id as Id<"ru">,
            expect: step.from as never,
            expect_version: version,
            next: step.to as never,
          },
        ];
        break;
      }
      case "folder":
        ops = [
          { kind: "task.folder_set", task: s.task(TASK), path: `/home/mira/work/${step.name}` },
        ];
        break;
      case "folder clear":
        ops = [{ kind: "task.folder_clear", task: s.task(TASK) }];
        break;
      case "trash":
        ops = [{ kind: "task.delete", task: s.task(TASK) }];
        break;
      case "restore":
        ops = [{ kind: "task.restore", task: s.task(TASK) }];
        break;
    }
    const result = s.send(ops);
    if ((step.do === "launch" || step.do === "run") && result.status === "applied") {
      s.names.set(step.as, String(result.results[0]?.id));
    }
    return todayAnswer(result);
  },
  seen: (s) => ({
    launches: s.fx.reader.prepare("SELECT state FROM launches ORDER BY created_at, id").all(),
    runs: s.fx.reader.prepare("SELECT state FROM runs ORDER BY queued_at, id").all(),
    folder: lastPart(
      s.fx.reader
        .prepare(
          "SELECT f.path FROM folders f JOIN tasks t ON t.id = f.owner_id " +
            "WHERE t.title = $t AND f.deleted_at IS NULL",
        )
        .get({ t: TASK })?.["path"],
    ),
  }),
  close: (s) => {
    s.close();
  },
};

const TREE: Side<Step, TreeSession & Named> = {
  open: async () => Object.assign(await TreeSession.open(temp.make()), { names: new Map() }),
  step: (s, step) => {
    const named = (key: string) => s.names.get(key) ?? "";
    const [command, input]: [string, Record<string, unknown>] = (() => {
      switch (step.do) {
        case "task":
          return ["tasks.add", { tasks: [{ title: TASK }] }];
        case "launch":
          return [
            "launch.create",
            {
              task: s.task(TASK),
              instance: "codex-work",
              route: "terminal",
              folder: null,
              task_version: 3,
              brief_hash: HASH,
            },
          ];
        case "launch moves":
          return [
            "launch.transition",
            { launch: named(step.launch), expect: step.from, next: step.to },
          ];
        case "run":
          return [
            "run.create",
            {
              task: s.task(TASK),
              instance: "codex-work",
              adapter: "codex",
              folder: null,
              request: "Check the export",
              brief_hash: HASH,
              permission: "full-access",
              limits: LIMITS,
            },
          ];
        case "run moves": {
          const id = named(step.run);
          const version = Number(
            s.fx.conn.prepare("SELECT version FROM runs WHERE id = $id").get({ id })?.["version"],
          );
          return [
            "run.transition",
            { run: id, expect: step.from, expect_version: version, next: step.to },
          ];
        }
        case "folder":
          return ["folder.set", { node: s.task(TASK), path: `C:\\Work\\${step.name}` }];
        case "folder clear":
          return ["folder.clear", { node: s.task(TASK) }];
        case "trash":
          return ["nodes.trash", { task: s.task(TASK) }];
        case "restore":
          return ["nodes.restore", { task: s.task(TASK) }];
      }
    })();
    const result = s.send(command, input);
    if ((step.do === "launch" || step.do === "run") && result.status === "applied") {
      const made = result.result as { launch?: { id: string }; run?: { id: string } };
      s.names.set(step.as, String((made.launch ?? made.run)?.id));
    }
    return treeAnswer(result);
  },
  seen: (s) => ({
    launches: s.fx.conn.prepare("SELECT state FROM launches ORDER BY created_at, id").all(),
    runs: s.fx.conn.prepare("SELECT state FROM runs ORDER BY queued_at, id").all(),
    folder: lastPart(
      s.fx.conn
        .prepare(
          "SELECT f.path FROM folders f JOIN nodes n ON n.id = f.owner_id " +
            "WHERE n.title = $t AND f.deleted_at IS NULL",
        )
        .get({ t: TASK })?.["path"],
    ),
  }),
  close: (s) => {
    s.close();
  },
};

describe("[S2.runs.both] launches, runs and a task's folder, the same on both writers", () => {
  test("a launch and a second click; a run started and ended, one stopped", async () => {
    await both({ today: TODAY, tree: TREE }, [
      { do: "task" },
      { do: "launch", as: "first" },
      { do: "launch", as: "again" },
      { do: "launch moves", launch: "first", from: "prepared", to: "dispatching" },
      { do: "launch moves", launch: "first", from: "dispatching", to: "dispatched" },
      { do: "run", as: "run" },
      { do: "run moves", run: "run", from: "queued", to: "starting" },
      { do: "run moves", run: "run", from: "starting", to: "running" },
      { do: "run moves", run: "run", from: "running", to: "succeeded" },
      { do: "run", as: "stopped" },
      { do: "run moves", run: "stopped", from: "queued", to: "starting" },
      { do: "run moves", run: "stopped", from: "starting", to: "cancelling" },
      { do: "run moves", run: "stopped", from: "cancelling", to: "cancelled" },
    ]);
  });

  test("a folder set, changed, removed, and cleared while its task is in the Trash", async () => {
    await both({ today: TODAY, tree: TREE }, [
      { do: "task" },
      { do: "folder", name: "export" },
      { do: "folder", name: "export-2" },
      { do: "folder clear" },
      { do: "folder clear" },
      { do: "folder", name: "export-3" },
      { do: "trash" },
      { do: "folder clear" },
      { do: "restore" },
    ]);
  });
});
