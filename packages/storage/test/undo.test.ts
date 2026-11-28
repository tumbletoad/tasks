// Undo and redo by the writer: a person's check-off, reopen, Trash and restore, removed note, words,
// move out of the Inbox, first filing, new area and unarchive are steps, undone and redone with
// the ordinary operations that write back what the commit changed; any other change is no step and
// Undo passes over it, also one an earlier version stored as a step. Someone else's newer work
// keeps the step as they left it, takes it off the stack and is named, in an answer a resend
// replays. Fixture text only.
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

describe("[A1.5.history.undo-redo] undo and redo of the steps a person takes back", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await fixture();
  });
  afterEach(() => {
    checkHistory(fx.reader);
    fx.close();
  });

  const send = (ops: Operation[], who?: Credential): WriteResult => {
    const result = fx.writer.submit(fx.request(who ?? fx.human, ops, { base: fx.base() }));
    expectStatus(result, "applied");
    return result;
  };
  const undo = (commit?: Id<"op">): WriteResult =>
    fx.writer.submit(fx.request(fx.human, [{ kind: "undo", ...(commit ? { commit } : {}) }]));
  const redo = (): WriteResult => fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));
  const task = (fields: Record<string, unknown> = {}, ops: Operation[] = []): Id<"t"> => {
    const id = newId("t");
    send([{ kind: "task.create", id, title: "Renew the passport", ...fields }, ...ops]);
    return id;
  };
  const row = (table: string, id: string): Record<string, unknown> =>
    fx.reader.prepare(`SELECT * FROM ${table} WHERE id = $id`).get({ id }) ?? {};
  const status = (seq: number): unknown =>
    fx.reader.prepare("SELECT undo_status FROM commits WHERE seq = $seq").get({ seq })?.[
      "undo_status"
    ];
  const applied = (result: WriteResult): WriteResult => {
    expectStatus(result, "applied");
    expect(result.kept).toBeUndefined();
    return result;
  };

  test("a check-off and a reopen are undone and redone, keeping the time and the outcome", () => {
    const id = task();
    const done = send([{ kind: "task.complete", task: id, outcome: "Sent the form" }]);
    const completedAt = row("tasks", id)["completed_at"];
    expect(status(done.seq)).toBe("done");
    expect(applied(undo(done.commit)).results[0]).toMatchObject({
      id: done.commit,
      lifecycles: ["M-1"],
    });
    expect(row("tasks", id)).toMatchObject({
      lifecycle: "active",
      wrap_state: null,
      outcome: "Sent the form",
    });
    applied(redo());
    expect(row("tasks", id)).toMatchObject({ lifecycle: "completed", completed_at: completedAt });
    // A reopen is a step too: its undo completes the task again as it was, wrapped up.
    const reopened = send([{ kind: "task.reopen", task: id }]);
    applied(undo(reopened.commit));
    expect(row("tasks", id)).toMatchObject({
      lifecycle: "completed",
      completed_at: completedAt,
      wrap_state: "wrapped",
      outcome: "Sent the form",
    });
    // A wrap-up of a finished task alone is no step: Undo never reopens it.
    const wrapped = send([{ kind: "task.wrap_up", task: id, outcome: "Sent it twice" }]);
    expect(status(wrapped.seq)).toBeNull();
  });

  test("the Trash and a restore of a whole change take back only what the commit changed", () => {
    const a = task();
    const b = task({ title: "Book the dentist" });
    send([
      { kind: "task.delete", task: a },
      { kind: "task.delete", task: b },
    ]);
    applied(undo());
    expect([row("tasks", a)["deleted_at"], row("tasks", b)["deleted_at"]]).toEqual([null, null]);
    // Redone, the two are in the Trash as the Redo's change.
    const removed = applied(redo()).commit as Id<"op">;
    send([{ kind: "task.restore", task: a }]);
    // The whole change names both tasks and brings back only b, so its Undo trashes only b.
    const whole = send([
      { kind: "task.restore", task: a, change: removed },
      { kind: "task.restore", task: b, change: removed },
    ]);
    applied(undo(whole.commit));
    expect(row("tasks", a)["deleted_at"]).toBeNull();
    expect(row("tasks", b)["deleted_at"]).not.toBeNull();
  });

  test("a removed note, and the words of a title, a note and a log entry", () => {
    const id = task({}, []);
    send([
      { kind: "note.add", task: id, body: "Ask for the old one back" },
      { kind: "log.add", task: id, body: "Called the office" },
    ]);
    const note = String(
      fx.reader.prepare("SELECT id FROM notes WHERE task_id = $id").get({ id })?.["id"],
    );
    const log = String(
      fx.reader.prepare("SELECT id FROM log_entries WHERE task_id = $id").get({ id })?.["id"],
    );
    send([{ kind: "note.delete", task: id, ordinal: 1 }]);
    applied(undo());
    expect(row("notes", note)["deleted_at"]).toBeNull();
    applied(redo());
    expect(row("notes", note)["deleted_at"]).not.toBeNull();
    send([{ kind: "task.patch", task: id, set: { title: "Renew both passports" } }]);
    send([{ kind: "log.patch", task: id, ordinal: 1, body: "Called the office twice" }]);
    applied(undo());
    expect(row("log_entries", log)["body"]).toBe("Called the office");
    applied(undo());
    expect(row("tasks", id)["title"]).toBe("Renew the passport");
    applied(redo());
    applied(redo());
    expect(row("tasks", id)["title"]).toBe("Renew both passports");
    expect(row("log_entries", log)["body"]).toBe("Called the office twice");
  });

  test("out of the Inbox with its status, a first filing, a new area and an unarchive", () => {
    const id = task({ inbox: true, status: "waiting" });
    send([{ kind: "task.patch", task: id, set: { inbox: false, status: "open" } }]);
    applied(undo());
    expect(row("tasks", id)).toMatchObject({ inbox: 1, status: "waiting" });
    const loose = task();
    send([{ kind: "task.move", task: loose, area: fx.areas.home }]);
    applied(undo());
    expect(row("tasks", loose)).toMatchObject({ area_id: null, project_id: null });
    const area = newId("a");
    send([{ kind: "area.create", id: area, title: "Garden" }]);
    applied(undo());
    expect(row("areas", area)["lifecycle"]).toBe("archived");
    applied(redo());
    expect(row("areas", area)["lifecycle"]).toBe("active");
    send([{ kind: "area.archive", area }]);
    send([{ kind: "area.unarchive", area }]);
    applied(undo());
    expect(row("areas", area)["lifecycle"]).toBe("archived");
  });

  test("any other change is no step: Undo passes over it, also one an earlier version stored", async () => {
    const id = task();
    const done = send([{ kind: "task.complete", task: id }]);
    const other = task({ title: "Water the plants" });
    // An ordinary move, a priority, a mixed request and an agent's change join no stack.
    const moved = send([{ kind: "task.move", task: other, area: fx.areas.lumen }]);
    const later = send([{ kind: "task.move", task: other, area: fx.areas.home }]);
    const mixed = send([
      { kind: "task.patch", task: other, set: { title: "Water them", priority: 1 } },
    ]);
    send([{ kind: "task.patch", task: other, set: { title: "Water all" } }], fx.codex);
    expect([moved, later, mixed].map((r) => status(r.seq))).toEqual(["done", null, null]);
    // An earlier version stored every change as a step: Undo passes over such a one.
    const raw = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    raw.prepare("UPDATE commits SET undo_status = 'done' WHERE seq = $s").run({ s: later.seq });
    raw.close();
    applied(undo());
    expect(row("tasks", other)["area_id"]).toBeNull();
    applied(undo(done.commit));
    expect(row("tasks", id)["lifecycle"]).toBe("active");
    expect(status(later.seq)).toBe("done");
  });

  test("someone else's newer work keeps the step, takes it off the stack and names them", () => {
    const id = task();
    const first = send([{ kind: "task.patch", task: id, set: { summary: "The old form" } }]);
    send([{ kind: "task.patch", task: id, set: { title: "Renew both passports" } }]);
    send([{ kind: "task.patch", task: id, set: { title: "Renew three passports" } }], fx.codex);
    const request = fx.request(fx.human, [{ kind: "undo" }]);
    const kept = fx.writer.submit(request);
    expectStatus(kept, "unchanged");
    expect(kept.kept).toBe(true);
    expect(kept.newer?.work).toMatchObject([{ ref: "M-1", by: { label: "Codex · work" } }]);
    expect(row("tasks", id)["title"]).toBe("Renew three passports");
    // Sent again, the answer replays and the step below stays.
    expect(fx.writer.submit(request)).toEqual({ ...kept, replayed: true });
    expect(status(first.seq)).toBe("done");
    // The next Undo reaches the step before it.
    applied(undo(first.commit));
    expect(row("tasks", id)["summary"]).toBe("");
  });

  test("a check-off is not redone over an agent's log entry, nor a note's removal over its words", () => {
    const id = task();
    send([{ kind: "task.complete", task: id }]);
    applied(undo());
    send([{ kind: "log.add", task: id, body: "Found the old passport" }], fx.codex);
    expect(redo().kept).toBe(true);
    expect(row("tasks", id)["lifecycle"]).toBe("active");
    send([{ kind: "note.add", task: id, body: "Ask for the old one back" }]);
    send([{ kind: "note.delete", task: id, ordinal: 1 }]);
    applied(undo());
    send([{ kind: "note.patch", task: id, ordinal: 1, body: "Ask for both back" }], fx.codex);
    expect(redo().kept).toBe(true);
    expect(
      fx.reader.prepare("SELECT deleted_at FROM notes WHERE task_id = $id").get({ id }),
    ).toEqual({
      deleted_at: null,
    });
  });

  test("a named commit that is not the newest step leaves the stack alone", () => {
    const id = task();
    const done = send([{ kind: "task.complete", task: id }]);
    send([{ kind: "task.patch", task: id, set: { title: "Renew both passports" } }]);
    expect(undo(done.commit).error?.code).toBe("INVALID_TRANSITION");
    expect(status(done.seq)).toBe("done");
    expect(redo().error?.code).toBe("NOTHING_TO_REDO");
  });
});
