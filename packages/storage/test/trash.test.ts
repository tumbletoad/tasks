// Moving a task to the Trash and back, by the writer: a second delete and a restore of a live task
// are no change, a restore of one change brings back only the tasks still there from it, a key
// another active task took meanwhile stays with it, and a task whose project or area is gone comes
// back in the area or the Inbox. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Operation, SourceFields, WriteRequest, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("trash");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

const ticket = (key: string): SourceFields => ({ kind: "ticket", title: `Ticket ${key}`, key });

describe("[A1.trash.write] a task moved to the Trash and restored, by the writer", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await fixture();
  });
  afterEach(() => {
    checkHistory(fx.reader);
    fx.close();
  });

  type Who = "human" | "codex";
  const send = (who: Who, ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
    fx.writer.submit(
      fx.request(fx[who], ops, {
        base: fx.base(),
        ...(who === "human" ? { undoable: true } : {}),
        ...extra,
      }),
    );
  /** A request without a base, as a restore of one change is sent. */
  const unbased = (ops: Operation[]): WriteResult =>
    fx.writer.submit(fx.request(fx.human, ops, { undoable: true }));
  const applied = (result: WriteResult): WriteResult => {
    expectStatus(result, "applied");
    return result;
  };
  const row = (id: string): Record<string, unknown> =>
    fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
  const deleted = (id: string): boolean => row(id)["deleted_at"] !== null;
  /** The tasks whose live link holds the source with `key`. */
  const holders = (key: string): string[] =>
    fx.reader
      .prepare(
        "SELECT ts.task_id AS t FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
          "WHERE s.source_key = $key AND ts.removed_at IS NULL ORDER BY ts.task_id",
      )
      .all({ key })
      .map((r) => String(r["t"]));
  const sourceOf = (key: string): string =>
    String(
      fx.reader.prepare("SELECT id FROM sources WHERE source_key = $key").get({ key })?.["id"],
    );
  const task = (title: string, sources: SourceFields[] = [], extra: Operation[] = []): Id<"t"> => {
    const id = newId("t");
    applied(
      send("human", [
        { kind: "task.create", id, title },
        ...sources.map((source): Operation => ({ kind: "source.add", task: id, source })),
        ...extra,
      ]),
    );
    return id;
  };
  /** A capture of `key` by an agent: the task it lands on, new or matched. */
  const capture = (key: string): Id<"t"> => {
    const id = newId("t");
    const result = send("codex", [
      { kind: "task.create", id, title: "Answer the clinic" },
      { kind: "source.add", task: id, source: ticket(key) },
    ]);
    expect(["applied", "unchanged"]).toContain(result.status);
    return result.results[0]?.task ?? id;
  };
  const remove = (...ids: string[]) =>
    applied(
      send(
        "human",
        ids.map((id): Operation => ({ kind: "task.delete", task: id })),
      ),
    );
  const restore = (...ids: string[]) =>
    send(
      "human",
      ids.map((id): Operation => ({ kind: "task.restore", task: id })),
    );

  test("a second delete and a restore of a live task are no change and name the task", () => {
    const a = task("Renew the passport");
    const b = task("Book the dentist");
    remove(a);
    const again = send("human", [
      { kind: "task.delete", task: a },
      { kind: "task.delete", task: b },
    ]);
    expectStatus(again, "applied");
    expect(again.results.map((r) => [r.status, r.task])).toEqual([
      ["unchanged", a],
      ["updated", b],
    ]);
    const back = applied(restore(a));
    expect(back.results[0]).toMatchObject({ status: "updated", task: a });
    expectStatus(restore(a), "unchanged");
  });

  test("a delete sent with a base from before someone restored the task is a conflict naming it, and nothing moves", () => {
    const a = task("Renew the passport");
    const b = task("Book the dentist");
    remove(a);
    const seen = fx.base();
    applied(restore(a));
    const late = send(
      "human",
      [
        { kind: "task.delete", task: a },
        { kind: "task.delete", task: b },
      ],
      { base: seen },
    );
    expectStatus(late, "conflict");
    expect(late.conflicts).toMatchObject([{ task: a, field: "deleted" }]);
    expect([deleted(a), deleted(b)]).toEqual([false, false]);
  });

  test("restoring a change brings back only the tasks still there from it; one restored and moved again since stays with the later change", () => {
    const [a, b, c] = [task("One"), task("Two"), task("Three")];
    const first = remove(a, b, c);
    const change = first.commit as Id<"op">;
    applied(restore(b));
    remove(b);
    applied(restore(c));
    const result = applied(
      unbased([a, b, c].map((id): Operation => ({ kind: "task.restore", task: id, change }))),
    );
    expect(result.results.map((r) => r.status)).toEqual(["updated", "unchanged", "unchanged"]);
    expect([deleted(a), deleted(b), deleted(c)]).toEqual([false, true, false]);
    // A change the space does not have (a backup restored since) moves nothing.
    const gone = unbased([{ kind: "task.restore", task: b, change: newId("op") }]);
    expectStatus(gone, "rejected");
    expect(gone.error).toMatchObject({ code: "NOT_FOUND", field: "change" });
    expect(deleted(b)).toBe(true);
  });

  test("a delete undone and redone is still its first change: the change's restore finds it", () => {
    const a = task("Renew the passport");
    const change = remove(a).commit as Id<"op">;
    applied(fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }])));
    expect(deleted(a)).toBe(false);
    applied(fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }])));
    expect(deleted(a)).toBe(true);
    const back = applied(unbased([{ kind: "task.restore", task: a, change }]));
    expect(back.results[0]?.status).toBe("updated");
  });

  test("a key another active task took meanwhile stays with it: the restored task's link stays removed, and its other links come back", () => {
    const a = task("Answer the clinic", [ticket("jira:FIX-1"), ticket("jira:FIX-2")]);
    remove(a);
    const b = capture("jira:FIX-1");
    expect(b).not.toBe(a);
    const back = applied(restore(a));
    expect(back.results[0]).toMatchObject({
      status: "updated",
      held_links: [{ source: sourceOf("jira:FIX-1"), by: "M-2" }],
    });
    expect(holders("jira:FIX-1")).toEqual([b]);
    expect(holders("jira:FIX-2")).toEqual([a]);
    // The next capture goes on to the holder, not to the restored task.
    expect(capture("jira:FIX-1")).toBe(b);
    // Undo takes the restore back whole: deleted again, the link as it was.
    applied(fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }])));
    expect(deleted(a)).toBe(true);
    expect(holders("jira:FIX-1")).toEqual([a, b].sort());
  });

  test("a finished task restored beside an active holder keeps its link", () => {
    const a = task("Answer the clinic", [ticket("jira:FIX-1")], []);
    applied(send("human", [{ kind: "task.complete", task: a }]));
    remove(a);
    const b = capture("jira:FIX-1");
    const back = applied(restore(a));
    expect(back.results[0]?.held_links).toBeUndefined();
    expect(holders("jira:FIX-1")).toEqual([a, b].sort());
    expect(capture("jira:FIX-1")).toBe(b);
  });

  test("two restores of one key: in one request and in two, the first holds it and the second's link stays removed", () => {
    for (const together of [true, false]) {
      const key = together ? "jira:FIX-7" : "jira:FIX-8";
      const a = task("First", [ticket(key)]);
      remove(a);
      const b = capture(key);
      expect(b).not.toBe(a);
      remove(b);
      const results = together
        ? applied(restore(a, b)).results
        : [applied(restore(a)).results[0], applied(restore(b)).results[0]];
      expect(results[0]?.held_links).toBeUndefined();
      expect(results[1]?.held_links).toMatchObject([{ source: sourceOf(key) }]);
      expect(holders(key)).toEqual([a]);
    }
  });

  test("a project moved to another area while its task was in the Trash carries it: the task comes back there", () => {
    const project = newId("p");
    applied(
      send("human", [{ kind: "project.create", id: project, title: "Portal", area: "lumen" }]),
    );
    const id = newId("t");
    applied(send("human", [{ kind: "task.create", id, title: "Fix the login page", project }]));
    remove(id);
    applied(send("human", [{ kind: "project.move", project, area: "home" }]));
    const back = applied(restore(id));
    expect(back.results[0]?.regrouped).toBeUndefined();
    expect(row(id)).toMatchObject({
      project_id: project,
      area_id: fx.areas.home,
      deleted_at: null,
    });
  });

  test("a task whose area is gone comes back in the Inbox", () => {
    // The area's creation is undone after an agent's task in it was moved to the Trash: the
    // area goes, as nothing live is in it.
    const area = newId("a");
    applied(send("human", [{ kind: "area.create", id: area, title: "Garden" }]));
    const id = newId("t");
    applied(send("codex", [{ kind: "task.create", id, title: "Prune the roses", area }]));
    applied(send("codex", [{ kind: "task.delete", task: id }]));
    applied(fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }])));
    expect(
      fx.reader.prepare("SELECT deleted_at FROM areas WHERE id = $area").get({ area })?.[
        "deleted_at"
      ],
    ).not.toBeNull();
    const back = applied(restore(id));
    expect(back.results[0]).toMatchObject({ regrouped: "inbox" });
    expect(row(id)).toMatchObject({ area_id: null, project_id: null, inbox: 1, deleted_at: null });
  });
});
