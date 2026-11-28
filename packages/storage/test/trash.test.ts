// Moving a task to the Trash and back, by the writer: a second delete and a restore of a live task
// are no change, a restore of one change brings back only the tasks still there from it, a key
// another active task took meanwhile stays with it, and a task whose project or area is gone comes
// back in the area or the Inbox. Fixture text only.
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Operation, SourceFields, WriteRequest, WriteResult } from "../src/write/request.ts";
import { openWriter } from "../src/open.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
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
        ...extra,
      }),
    );
  /** A request without a base, as a restore of one change is sent. */
  const unbased = (ops: Operation[]): WriteResult => fx.writer.submit(fx.request(fx.human, ops));
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

  test("a delete undone and redone is in the Trash as the Redo's change, which its restore finds", () => {
    const a = task("Renew the passport");
    remove(a);
    applied(fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }])));
    expect(deleted(a)).toBe(false);
    const change = applied(fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]))).commit;
    expect(deleted(a)).toBe(true);
    const back = applied(unbased([{ kind: "task.restore", task: a, change: change as Id<"op"> }]));
    expect(back.results[0]?.status).toBe("updated");
  });

  const history = (kind: "undo" | "redo"): WriteResult =>
    fx.writer.submit(fx.request(fx.human, [{ kind }]));

  test("Redo of a removal after someone worked on the task keeps it, naming who; removing it again is one request", () => {
    const a = task("Renew the passport");
    const sourced = task("Answer the clinic");
    // What was done, and the task it was done to.
    const work: [string, Id<"t">, Operation][] = [
      ["a note", a, { kind: "note.add", task: a, body: "Booked for Tuesday" }],
      ["a log entry", a, { kind: "log.add", task: a, body: "Form sent" }],
      [
        "a source link",
        sourced,
        { kind: "source.add", task: sourced, source: ticket("jira:FIX-3") },
      ],
      ["a field", a, { kind: "task.patch", task: a, set: { summary: "Repurposed" } }],
    ];
    for (const [what, target, op] of work) {
      remove(target);
      applied(history("undo"));
      applied(send("codex", [op]));
      const late = history("redo");
      expectStatus(late, "unchanged");
      expect(late.kept, what).toBe(true);
      expect(late.newer?.work, what).toEqual([
        expect.objectContaining({ task: target, by: expect.objectContaining({ kind: "agent" }) }),
      ]);
      expect(deleted(target), what).toBe(false);
      // The person still wants it gone: one removal, from what they see now.
      remove(target);
      expect(deleted(target), what).toBe(true);
      applied(restore(target));
    }
  });

  test("Undo of a restore after someone added to the task keeps it, naming who", () => {
    const a = task("Renew the passport");
    remove(a);
    applied(restore(a));
    applied(send("codex", [{ kind: "note.add", task: a, body: "Booked for Tuesday" }]));
    const late = history("undo");
    expectStatus(late, "unchanged");
    expect(late.newer?.work).toEqual([expect.objectContaining({ task: a })]);
    expect(deleted(a)).toBe(false);
  });

  test("the person's own steps since do not hold back Redo or Undo of a removal", () => {
    // Redo: a title edit undone and redone after the removal's undo.
    const a = task("Renew the passport");
    applied(send("human", [{ kind: "task.patch", task: a, set: { title: "Renew both" } }]));
    remove(a);
    applied(history("undo"));
    applied(history("undo"));
    applied(history("redo"));
    applied(history("redo"));
    expect(deleted(a)).toBe(true);
    // Undo: a restore, then an edit of the person's that is undone first.
    applied(restore(a));
    applied(send("human", [{ kind: "task.patch", task: a, set: { title: "Renew one" } }]));
    applied(history("undo"));
    applied(history("undo"));
    expect(deleted(a)).toBe(true);
  });

  test("a named Undo or Redo of a change the space does not have says so, and changes nothing", () => {
    const a = task("Renew the passport");
    remove(a);
    for (const kind of ["undo", "redo"] as const) {
      const gone = fx.writer.submit(fx.request(fx.human, [{ kind, commit: newId("op") }]));
      expectStatus(gone, "rejected");
      expect(gone.error).toMatchObject({ code: "NOT_FOUND", field: "commit" });
    }
    expect(deleted(a)).toBe(true);
  });

  test("a removal with a base from before any change to one of its tasks is a conflict that names that task, and nothing moves", () => {
    const a = task("Renew the passport");
    const b = task("Book the dentist");
    const seen = fx.base();
    applied(send("codex", [{ kind: "task.patch", task: b, set: { summary: "Repurposed" } }]));
    const stale = send(
      "human",
      [
        { kind: "task.delete", task: a },
        { kind: "task.delete", task: b },
      ],
      { base: seen },
    );
    expectStatus(stale, "conflict");
    expect(stale.conflicts.map((c) => [c.task, c.field])).toEqual([[b, "summary"]]);
    expect([deleted(a), deleted(b)]).toEqual([false, false]);
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
    // Undo moves it back to the Trash; the link it gave up stays with the holder.
    applied(fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }])));
    expect(deleted(a)).toBe(true);
    expect(holders("jira:FIX-1")).toEqual([b]);
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

  test("a task whose project is gone comes back in the project's area", () => {
    const project = newId("p");
    applied(
      send("human", [{ kind: "project.create", id: project, title: "Garden", area: "home" }]),
    );
    const id = newId("t");
    applied(send("codex", [{ kind: "task.create", id, title: "Prune the roses", project }]));
    applied(send("codex", [{ kind: "task.delete", task: id }]));
    applied(send("human", [{ kind: "project.delete", project }]));
    const back = applied(restore(id));
    expect(back.results[0]).toMatchObject({ regrouped: "area" });
    expect(row(id)).toMatchObject({ area_id: fx.areas.home, project_id: null, deleted_at: null });
  });
});

// A tombstone an earlier version wrote, made by hand: the history checks do not hold for it.
describe("[A1.trash.write] a creation an earlier version undid", () => {
  test("a task whose creation an earlier version undid is neither restored nor removed, alone or beside another: the request is refused whole", async () => {
    const fx = await fixture();
    const send = (ops: Operation[]): WriteResult =>
      fx.writer.submit(fx.request(fx.human, ops, { base: fx.base() }));
    const task = (title: string): Id<"t"> => {
      const id = newId("t");
      expectStatus(send([{ kind: "task.create", id, title }]), "applied");
      return id;
    };
    const deleted = (id: string): boolean =>
      fx.reader.prepare("SELECT deleted_at FROM tasks WHERE id = $id").get({ id })?.[
        "deleted_at"
      ] !== null;
    const live = task("Renew the passport");
    expectStatus(send([{ kind: "task.delete", task: live }]), "applied");
    const other = task("Book the dentist");
    const a = task("Answer the clinic");
    // An earlier version undid a creation with a tombstone written by the undo of the commit that
    // created the task: made here from an undo of a title, pointed at the creation.
    expectStatus(send([{ kind: "task.patch", task: other, set: { title: "Book it" } }]), "applied");
    const undo = fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }]));
    const raw = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    raw
      .prepare(
        "UPDATE commits SET undo_of = (SELECT created_seq FROM tasks WHERE id = $a) WHERE seq = $u",
      )
      .run({ a, u: undo.seq });
    raw
      .prepare(
        "UPDATE tasks SET deleted_at = 1, deleted_by = created_by, " +
          "fp = json_set(fp, '$.deleted', $u) WHERE id = $a",
      )
      .run({ a, u: undo.seq });
    raw.close();
    for (const ops of [
      [{ kind: "task.restore", task: a }],
      [
        { kind: "task.restore", task: live },
        { kind: "task.restore", task: a },
      ],
      // Removed with a live task: never "in the Trash already", and the live task stays.
      [{ kind: "task.delete", task: a }],
      [
        { kind: "task.delete", task: other },
        { kind: "task.delete", task: a },
      ],
    ] as Operation[][]) {
      const refused = send(ops);
      expectStatus(refused, "rejected");
      expect(refused.error).toMatchObject({
        code: "NOT_FOUND",
        field: "task",
        reason: "creation_undone",
      });
    }
    expect([deleted(live), deleted(other), deleted(a)]).toEqual([true, false, true]);
    fx.close();
  });
});
