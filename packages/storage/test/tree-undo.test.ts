// Undo and Redo on the tree writer, by the rule of write/steps.ts: for every kind Undo is for, the
// action, its opposite by hand, two Undos and two Redos walk the state back and forth exactly; any
// other change is no step and Undo passes over it; someone else's newer work keeps the step and
// says whose; one Undo takes back a finish of a task and all its subtasks. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TreeResult } from "../src/tree/core.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-undo");
afterAll(temp.cleanup);

type Call = [string, Record<string, unknown>];

describe("[S2.tree.undo] Undo and Redo of the steps a person takes back, on the tree", () => {
  let fx: TreeFixture;
  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const send = ([command, input]: Call): TreeResult => {
    const result = fx.send(command, input);
    expect(result.status).toBe("applied");
    return result;
  };
  const undo = () => fx.send("undo", {});
  const redo = () => fx.send("redo", {});
  const applied = (result: TreeResult) => {
    expect(result.status).toBe("applied");
    expect((result.result as { kept?: unknown } | undefined)?.kept).toBeUndefined();
  };
  /** A task's state as a person sees it, and its first note's: never when it was written. */
  const seen = (id: string): unknown => {
    const t =
      fx.conn.prepare("SELECT * FROM nodes n JOIN tasks t USING (id) WHERE id = $id").get({ id }) ??
      {};
    const note = fx.conn
      .prepare("SELECT body, deleted_at FROM notes WHERE owner_id = $id AND ordinal = 1")
      .get({ id });
    return {
      lifecycle: t["lifecycle"],
      trash: t["deleted_at"] !== null,
      wrap: t["wrap_state"],
      outcome: t["outcome"],
      title: t["title"],
      inbox: t["inbox"],
      status: t["status"],
      reviewed: t["reviewed_at"],
      note: note === undefined ? null : { body: note["body"], gone: note["deleted_at"] !== null },
    };
  };
  const task = (): string => {
    const made = send(["tasks.add", { tasks: [{ title: "Renew the passport" }] }]);
    return (made.result as { tasks: { id: string }[] }).tasks[0]?.id ?? "";
  };
  const note = (id: string): Call => ["note.add", { on: id, body: "Ask for the old one back" }];

  const walks: [string, (id: string) => Call, (id: string) => Call, ((id: string) => Call[])?][] = [
    ["a check-off", (id) => ["task.finish", { task: id }], (id) => ["task.reopen", { task: id }]],
    [
      "a drop",
      (id) => ["task.finish", { task: id, status: "dropped", reason: "Not needed" }],
      (id) => ["task.reopen", { task: id }],
    ],
    [
      "a reopen",
      (id) => ["task.reopen", { task: id }],
      (id) => ["task.finish", { task: id }],
      (id) => [["task.finish", { task: id, outcome: "Sent the form" }]],
    ],
    ["the Trash", (id) => ["nodes.trash", { task: id }], (id) => ["nodes.restore", { task: id }]],
    [
      "a restore",
      (id) => ["nodes.restore", { task: id }],
      (id) => ["nodes.trash", { task: id }],
      (id) => [["nodes.trash", { task: id }]],
    ],
    [
      "a removed note",
      (id) => ["note.remove", { on: id, ordinal: 1 }],
      (id) => ["note.put_back", { on: id, ordinal: 1 }],
      (id) => [note(id)],
    ],
    [
      "a note put back",
      (id) => ["note.put_back", { on: id, ordinal: 1 }],
      (id) => ["note.remove", { on: id, ordinal: 1 }],
      (id) => [note(id), ["note.remove", { on: id, ordinal: 1 }]],
    ],
    [
      "a title edited twice",
      (id) => ["task.update", { task: id, set: { title: "Renew both passports" } }],
      (id) => ["task.update", { task: id, set: { title: "Renew the passports" } }],
    ],
    [
      "a note's words edited twice",
      (id) => ["note.edit", { on: id, ordinal: 1, body: "Ask for both back" }],
      (id) => ["note.edit", { on: id, ordinal: 1, body: "Ask for all of them back" }],
      (id) => [note(id)],
    ],
    [
      "out of the Inbox",
      (id) => ["task.update", { task: id, set: { inbox: false, status: "open" } }],
      (id) => ["task.update", { task: id, set: { inbox: true } }],
      (id) => [["task.update", { task: id, set: { inbox: true, status: "waiting" } }]],
    ],
    [
      "a dismissal",
      (id) => ["task.update", { task: id, set: { reviewed_at: 1_794_470_500_000 } }],
      (id) => ["task.update", { task: id, set: { reviewed_at: 1_794_470_400_000 } }],
      (id) => [["task.update", { task: id, set: { reviewed_at: 1_794_470_400_000 } }]],
    ],
  ];

  test.each(walks)(
    "%s, its opposite by hand, two Undos and two Redos walk the state back and forth exactly",
    (_, action, opposite, setup) => {
      const id = task();
      for (const call of setup?.(id) ?? []) send(call);
      const states = [seen(id)];
      send(action(id));
      states.push(seen(id));
      send(opposite(id));
      states.push(seen(id));
      for (const at of [1, 0]) {
        applied(undo());
        expect(seen(id)).toEqual(states[at]);
      }
      for (const at of [1, 2]) {
        applied(redo());
        expect(seen(id)).toEqual(states[at]);
      }
    },
  );

  test("a new project, archived by hand, walks back to archived and forth to archived", () => {
    const made = send(["project.create", { title: "Garden" }]);
    const id = (made.result as { project: { id: string } }).project.id;
    const archived = () =>
      fx.conn.prepare("SELECT archived_at FROM nodes WHERE id = $id").get({ id })?.[
        "archived_at"
      ] !== null;
    send(["project.archive", { project: id }]);
    applied(undo());
    expect(archived()).toBe(false);
    applied(undo());
    expect(archived()).toBe(true);
    applied(redo());
    expect(archived()).toBe(false);
    applied(redo());
    expect(archived()).toBe(true);
  });

  test("any other change is no step: Undo passes over it to the step below", () => {
    const id = task();
    send(["task.finish", { task: id }]);
    send(["task.reopen", { task: id }]);
    send(["task.update", { task: id, set: { priority: 1 } }]);
    applied(undo());
    expect(seen(id)).toMatchObject({ lifecycle: "completed" });
    expect(
      fx.conn.prepare("SELECT priority FROM tasks WHERE id = $id").get({ id })?.["priority"],
    ).toBe(1);
  });

  test("someone else's newer work keeps the step, takes it off the stack and names them", () => {
    const id = task();
    send(["task.finish", { task: id }]);
    send(["task.update", { task: id, set: { title: "Renew the passport first" } }]);
    expect(
      fx.send("task.update", { task: id, set: { title: "Renew it today" } }, { who: fx.agent })
        .status,
    ).toBe("applied");
    const kept = undo();
    expect(kept.status).toBe("applied");
    const work = (kept.result as { kept: { work: { by: { label: string } }[] } }).kept.work;
    expect(work.map((w) => w.by.label)).toEqual(["agent:codex"]);
    // The next Undo reaches the step below: the check-off.
    applied(undo());
    expect(seen(id)).toMatchObject({ lifecycle: "active", title: "Renew it today" });
  });

  test("one Undo takes back a finish of a task and all its subtasks, and Redo does it again", () => {
    const id = task();
    send([
      "tasks.add",
      {
        tasks: [
          { under: id, title: "Find the old one" },
          { under: id, title: "Book a photo" },
        ],
      },
    ]);
    send(["task.finish", { task: id, subtasks: "all" }]);
    const open = () =>
      Number(
        fx.conn.prepare("SELECT count(*) AS n FROM tasks WHERE lifecycle = 'active'").get()?.["n"],
      );
    expect(open()).toBe(0);
    applied(undo());
    expect(open()).toBe(3);
    applied(redo());
    expect(open()).toBe(0);
  });
});
