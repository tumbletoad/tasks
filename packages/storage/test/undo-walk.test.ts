// One walk of Undo's kinds (undo-rule.ts), run against today's writer and the tree's: for each
// kind, the action, its opposite by hand, two Undos and two Redos walk the state back and forth
// exactly; a first filing and a filing into a project made just before walk back and forth too.
// Each writer says how it does an action in its own operations or commands; the walk and what a
// person sees are the same for both. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId } from "../src/ids.ts";
import type { Operation } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems } from "./tree-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("undo-walk");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

/** An action a person takes on a task, in neither writer's words. */
type Act =
  | { do: "finish"; outcome?: string }
  | { do: "drop"; reason: string }
  | { do: "reopen" | "trash" | "restore" | "remove-note" | "put-back-note" }
  | { do: "note" | "note-words"; body: string }
  | { do: "title"; title: string }
  | { do: "inbox"; inbox: boolean; status?: string }
  | { do: "dismiss"; at: number }
  | { do: "file"; into: string };

/** What a person sees of a task and its first note; never when it was written. */
interface Seen {
  lifecycle: unknown;
  trash: boolean;
  wrap: unknown;
  outcome: unknown;
  title: unknown;
  inbox: unknown;
  status: unknown;
  reviewed: unknown;
  group: unknown;
  note: { body: unknown; gone: boolean } | null;
}

interface Walker {
  task(): string;
  project(title: string): string;
  act(task: string, act: Act): void;
  undo(): void;
  redo(): void;
  seen(task: string): Seen;
  archived(project: string): boolean;
  close(): void;
}

/** Today's writer, on its fixture space. */
async function today(): Promise<Walker> {
  const fx = await fixture();
  const send = (ops: Operation[]) => {
    expectStatus(fx.writer.submit(fx.request(fx.human, ops, { base: fx.base() })), "applied");
  };
  const history = (kind: "undo" | "redo") => {
    const result = fx.writer.submit(fx.request(fx.human, [{ kind }]));
    expectStatus(result, "applied");
    expect(result.kept).toBeUndefined();
  };
  const op = (task: string, act: Act): Operation => {
    switch (act.do) {
      case "finish":
        return {
          kind: "task.complete",
          task,
          ...(act.outcome === undefined ? {} : { outcome: act.outcome }),
        };
      case "drop":
        return { kind: "task.archive", task, reason: act.reason };
      case "reopen":
        return { kind: "task.reopen", task };
      case "trash":
        return { kind: "task.delete", task };
      case "restore":
        return { kind: "task.restore", task };
      case "note":
        return { kind: "note.add", task, body: act.body };
      case "remove-note":
        return { kind: "note.delete", task, ordinal: 1 };
      case "put-back-note":
        return { kind: "note.restore", task, ordinal: 1 };
      case "note-words":
        return { kind: "note.patch", task, ordinal: 1, body: act.body };
      case "title":
        return { kind: "task.patch", task, set: { title: act.title } };
      case "inbox":
        return {
          kind: "task.patch",
          task,
          set: { inbox: act.inbox, ...(act.status === undefined ? {} : { status: act.status }) },
        };
      case "dismiss":
        return { kind: "task.patch", task, set: { reviewed_at: act.at } };
      case "file":
        return { kind: "task.move", task, project: act.into };
    }
  };
  return {
    task: () => {
      const id = newId("t");
      send([{ kind: "task.create", id, title: "Renew the passport" }]);
      return id;
    },
    project: (title) => {
      const id = newId("p");
      send([{ kind: "project.create", id, title }]);
      return id;
    },
    act: (task, act) => {
      send([op(task, act)]);
    },
    undo: () => {
      history("undo");
    },
    redo: () => {
      history("redo");
    },
    seen: (id) => {
      const t =
        fx.reader
          .prepare(
            "SELECT t.*, p.title AS group_title FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $id",
          )
          .get({ id }) ?? {};
      const note = fx.reader
        .prepare("SELECT body, deleted_at FROM notes WHERE task_id = $id AND ordinal = 1")
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
        group: t["group_title"] ?? null,
        note: note === undefined ? null : { body: note["body"], gone: note["deleted_at"] !== null },
      };
    },
    archived: (id) =>
      fx.reader.prepare("SELECT lifecycle FROM projects WHERE id = $id").get({ id })?.[
        "lifecycle"
      ] === "archived",
    close: () => {
      checkHistory(fx.reader);
      fx.close();
    },
  };
}

/** The tree's writer, on a disposable tree space. */
async function tree(): Promise<Walker> {
  const fx = openTree(await checkedDriver(), temp.make(), true);
  const send = (command: string, input: Record<string, unknown>) => {
    const result = fx.send(command, input);
    expect(result.status).toBe("applied");
    return result.result as Record<string, unknown>;
  };
  const history = (command: "undo" | "redo") => {
    const result = fx.send(command, {}, { base: null });
    expect(result.status).toBe("applied");
    expect((result.result as { kept?: unknown } | undefined)?.kept).toBeUndefined();
  };
  const call = (task: string, act: Act): [string, Record<string, unknown>] => {
    switch (act.do) {
      case "finish":
        return [
          "task.finish",
          { task, ...(act.outcome === undefined ? {} : { outcome: act.outcome }) },
        ];
      case "drop":
        return ["task.finish", { task, status: "dropped", reason: act.reason }];
      case "reopen":
        return ["task.reopen", { task }];
      case "trash":
        return ["nodes.trash", { task }];
      case "restore":
        return ["nodes.restore", { task }];
      case "note":
        return ["note.add", { on: task, body: act.body }];
      case "remove-note":
        return ["note.remove", { on: task, ordinal: 1 }];
      case "put-back-note":
        return ["note.put_back", { on: task, ordinal: 1 }];
      case "note-words":
        return ["note.edit", { on: task, ordinal: 1, body: act.body }];
      case "title":
        return ["task.update", { task, set: { title: act.title } }];
      case "inbox":
        return [
          "task.update",
          {
            task,
            set: { inbox: act.inbox, ...(act.status === undefined ? {} : { status: act.status }) },
          },
        ];
      case "dismiss":
        return ["task.update", { task, set: { reviewed_at: act.at } }];
      case "file":
        return ["task.move", { task, under: act.into }];
    }
  };
  return {
    task: () =>
      String(
        (
          send("tasks.add", { tasks: [{ title: "Renew the passport" }] }) as {
            tasks: { id: string }[];
          }
        ).tasks[0]?.id,
      ),
    project: (title) =>
      (send("project.create", { title }) as { project: { id: string } }).project.id,
    act: (task, act) => {
      send(...call(task, act));
    },
    undo: () => {
      history("undo");
    },
    redo: () => {
      history("redo");
    },
    seen: (id) => {
      const t =
        fx.conn
          .prepare(
            "SELECT n.*, t.*, p.title AS group_title FROM nodes n JOIN tasks t USING (id) LEFT JOIN nodes p ON p.id = n.parent_id AND p.kind = 'project' WHERE n.id = $id",
          )
          .get({ id }) ?? {};
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
        group: t["group_title"] ?? null,
        note: note === undefined ? null : { body: note["body"], gone: note["deleted_at"] !== null },
      };
    },
    archived: (id) =>
      fx.conn.prepare("SELECT archived_at FROM nodes WHERE id = $id").get({ id })?.[
        "archived_at"
      ] !== null,
    close: () => {
      const problems = treeHistoryProblems(fx.conn);
      fx.close();
      expect(problems).toEqual([]);
    },
  };
}

const NOTE: Act = { do: "note", body: "Ask for the old one back" };

/** Each kind: its action, its opposite by hand, and what comes before them. */
const WALKS: [string, Act, Act, Act[]][] = [
  ["a check-off", { do: "finish" }, { do: "reopen" }, []],
  ["a drop", { do: "drop", reason: "Not needed" }, { do: "reopen" }, []],
  ["a reopen", { do: "reopen" }, { do: "finish" }, [{ do: "finish", outcome: "Sent the form" }]],
  ["the Trash", { do: "trash" }, { do: "restore" }, []],
  ["a restore", { do: "restore" }, { do: "trash" }, [{ do: "trash" }]],
  ["a removed note", { do: "remove-note" }, { do: "put-back-note" }, [NOTE]],
  [
    "a note put back",
    { do: "put-back-note" },
    { do: "remove-note" },
    [NOTE, { do: "remove-note" }],
  ],
  [
    "a title edited twice",
    { do: "title", title: "Renew both passports" },
    { do: "title", title: "Renew the passports" },
    [],
  ],
  [
    "a note's words edited twice",
    { do: "note-words", body: "Ask for both back" },
    { do: "note-words", body: "Ask for all of them back" },
    [NOTE],
  ],
  [
    "out of the Inbox",
    { do: "inbox", inbox: false, status: "open" },
    { do: "inbox", inbox: true },
    [{ do: "inbox", inbox: true, status: "waiting" }],
  ],
  [
    "a dismissal",
    { do: "dismiss", at: 1_794_470_500_000 },
    { do: "dismiss", at: 1_794_470_400_000 },
    [{ do: "dismiss", at: 1_794_470_400_000 }],
  ],
];

describe.each([
  ["today's writer", today],
  ["the tree's writer", tree],
] as const)("[S2.undo.walk] Undo's kinds, on %s", (_, open) => {
  let w: Walker;
  beforeEach(async () => {
    w = await open();
  });
  afterEach(() => {
    w.close();
  });

  test.each(WALKS)(
    "%s, its opposite by hand, two Undos and two Redos walk the state back and forth exactly",
    (_, action, opposite, setup) => {
      const id = w.task();
      for (const act of setup) w.act(id, act);
      const states = [w.seen(id)];
      w.act(id, action);
      states.push(w.seen(id));
      w.act(id, opposite);
      states.push(w.seen(id));
      for (const at of [1, 0]) {
        w.undo();
        expect(w.seen(id)).toEqual(states[at]);
      }
      for (const at of [1, 2]) {
        w.redo();
        expect(w.seen(id)).toEqual(states[at]);
      }
    },
  );

  test("a first filing walks back to no project and forth into it", () => {
    const into = w.project("Garden");
    const id = w.task();
    const states = [w.seen(id)];
    w.act(id, { do: "file", into });
    states.push(w.seen(id));
    w.undo();
    expect(w.seen(id)).toEqual(states[0]);
    w.redo();
    expect(w.seen(id)).toEqual(states[1]);
  });

  test("a filing into a project made just before walks back with the project, and forth", () => {
    const first = w.project("Garden");
    const id = w.task();
    w.act(id, { do: "file", into: first });
    const second = w.project("Shed");
    w.act(id, { do: "file", into: second });
    expect(w.seen(id)).toMatchObject({ group: "Shed" });
    w.undo();
    expect(w.seen(id)).toMatchObject({ group: "Garden" });
    w.undo();
    expect(w.archived(second)).toBe(true);
    w.redo();
    expect(w.archived(second)).toBe(false);
    w.redo();
    expect(w.seen(id)).toMatchObject({ group: "Shed" });
  });
});
