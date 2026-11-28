// Undo and redo by the writer: a person's check-off, reopen, Trash and restore, removed note, words,
// move out of the Inbox, first filing, new area and unarchive are steps, undone and redone with
// the ordinary operations that write back what the commit changed; any other change is no step and
// Undo passes over it, also one an earlier version stored as a step. A change since to what the step
// wrote, anyone's, or someone else's work on what Undo would take out of sight, keeps the step as it
// is; so does an opposite that cannot be applied. A kept step leaves the stack, and the answer, which
// a resend replays, names who or why. Fixture text only.
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
    // Filed into the area the person's change right before made: the move is a step too.
    const filed = task({ area: fx.areas.home });
    send([{ kind: "area.create", id: newId("a"), title: "Shed" }]);
    const moved = send([{ kind: "task.move", task: filed, area: fx.areas.lumen }]);
    expect(status(moved.seq)).toBeNull();
    const shed = newId("a");
    send([{ kind: "area.create", id: shed, title: "Shed two" }]);
    send([{ kind: "task.move", task: filed, area: shed }]);
    applied(undo());
    expect(row("tasks", filed)["area_id"]).toBe(fx.areas.lumen);
    applied(undo());
    expect(row("areas", shed)["lifecycle"]).toBe("archived");
    applied(undo());
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
    // The first filing was moved on since, by the person: Undo keeps the newer area.
    const kept = undo();
    expect(kept.kept).toBe(true);
    expect(kept.newer?.work).toMatchObject([{ by: { kind: "human" } }]);
    expect(row("tasks", other)["area_id"]).toBe(fx.areas.home);
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

  test("a title changed again since, with a priority, is kept: Undo never writes over the newer words", () => {
    const id = task();
    send([{ kind: "task.patch", task: id, set: { title: "Renew both passports" } }]);
    send([{ kind: "task.patch", task: id, set: { title: "Renew the passports", priority: 1 } }]);
    const kept = undo();
    expect(kept.kept).toBe(true);
    expect(row("tasks", id)["title"]).toBe("Renew the passports");
    expect(undo().error?.code).toBe("NOTHING_TO_UNDO");
  });

  test("a step whose task an agent moved to the Trash is kept with why and who, and the next Undo reaches the step below", () => {
    const first = task();
    const done = send([{ kind: "task.complete", task: first }]);
    const id = task({ title: "Book the dentist" });
    send([{ kind: "task.patch", task: id, set: { title: "Book the dentist early" } }]);
    send([{ kind: "task.delete", task: id }], fx.codex);
    const kept = undo();
    expect(kept).toMatchObject({ status: "unchanged", kept: true, why: "The task is deleted" });
    expect(kept.newer?.work).toMatchObject([{ task: id, by: { kind: "agent" } }]);
    applied(undo(done.commit));
    expect(row("tasks", first)["lifecycle"]).toBe("active");
  });

  test("undoing the reopen of a dropped task drops it again with its outcome", () => {
    const id = task();
    send([
      { kind: "task.archive", task: id, reason: "Not needed" },
      { kind: "task.wrap_up", task: id, outcome: "The old one is still valid" },
    ]);
    send([{ kind: "task.reopen", task: id }]);
    applied(undo());
    expect(row("tasks", id)).toMatchObject({
      lifecycle: "archived",
      archived_reason: "Not needed",
      wrap_state: "wrapped",
      outcome: "The old one is still valid",
    });
  });

  test("setting questions aside is a step: Undo puts the earlier mark back", () => {
    const id = task();
    send([{ kind: "task.patch", task: id, set: { reviewed_at: 1_794_470_400_000 } }]);
    const dismissed = send([
      { kind: "task.patch", task: id, set: { reviewed_at: 1_794_470_500_000 } },
    ]);
    expect(status(dismissed.seq)).toBe("done");
    applied(undo());
    expect(row("tasks", id)["reviewed_at"]).toBe(1_794_470_400_000);
  });

  test("a named commit that is not the newest step leaves the stack alone", () => {
    const id = task();
    const done = send([{ kind: "task.complete", task: id }]);
    send([{ kind: "task.patch", task: id, set: { title: "Renew both passports" } }]);
    expect(undo(done.commit).error?.code).toBe("INVALID_TRANSITION");
    expect(status(done.seq)).toBe("done");
    expect(redo().error?.code).toBe("NOTHING_TO_REDO");
  });

  test("a new project, archived by hand, walks back to archived and forth to archived", () => {
    const project = newId("p");
    const lifecycle = () => row("projects", project)["lifecycle"];
    send([{ kind: "project.create", id: project, title: "Garden" }]);
    send([{ kind: "project.archive", project }]);
    applied(undo());
    expect(lifecycle()).toBe("active");
    applied(undo());
    expect(lifecycle()).toBe("archived");
    applied(redo());
    expect(lifecycle()).toBe("active");
    applied(redo());
    expect(lifecycle()).toBe("archived");
  });

  test("an outcome an agent wrote since a drop or a check-off keeps the finish, naming the agent", () => {
    for (const finish of ["task.archive", "task.complete"] as const) {
      const id = task();
      send([{ kind: finish, task: id }]);
      send([{ kind: "task.wrap_up", task: id, outcome: "Sent it in time" }], fx.codex);
      const kept = undo();
      expect(kept.kept).toBe(true);
      expect(kept.newer?.work).toMatchObject([{ task: id, by: { kind: "agent" } }]);
      expect(row("tasks", id)).toMatchObject({ wrap_state: "wrapped", outcome: "Sent it in time" });
    }
  });

  test("undoing a reopen wraps up again a task wrapped up with a learning alone", () => {
    const id = task();
    send([
      { kind: "task.complete", task: id },
      { kind: "task.wrap_up", task: id, learnings: { add: ["Book a week ahead"] } },
    ]);
    expect(row("tasks", id)["wrap_state"]).toBe("wrapped");
    send([{ kind: "task.reopen", task: id }]);
    applied(undo());
    expect(row("tasks", id)).toMatchObject({ lifecycle: "completed", wrap_state: "wrapped" });
  });

  /** A page as a person sees it: its words, and whether it is in the Trash. */
  const seenPage = (ref: string): unknown => {
    const p =
      fx.reader
        .prepare("SELECT * FROM pages WHERE ref = $ref")
        .get({ ref: Number(ref.slice(2)) }) ?? {};
    return {
      title: p["title"],
      brief: p["brief"],
      body: p["body"],
      trash: p["deleted_at"] !== null,
    };
  };
  /** The space's texts as a person sees them: empty while it has none. */
  const seenTexts = (): unknown => {
    const t = fx.reader
      .prepare("SELECT * FROM node_texts WHERE owner_id = $id")
      .get({ id: fx.spaceId });
    return {
      brief: t?.["brief"] ?? "",
      description: t?.["description"] ?? "",
      forAgents: t?.["for_agents"] ?? "",
    };
  };
  const space = { kind: "space" } as const;
  const newPage = (): string =>
    send([
      { kind: "page.create", owner: space, title: "Passport", brief: "", body: "Bring a photo." },
    ]).results[0]?.ref ?? "";
  const pageWalks: [
    string,
    (page: string) => Operation[],
    (page: string) => Operation[],
    ((page: string) => Operation[])?,
  ][] = [
    [
      "a page's body set twice",
      (page) => [{ kind: "page.set", page, body: "Bring two photos." }],
      (page) => [{ kind: "page.set", page, body: "Bring two photos and the old passport." }],
    ],
    [
      "a page's title and brief",
      (page) => [{ kind: "page.set", page, title: "Passport renewal", brief: "What to bring" }],
      (page) => [{ kind: "page.set", page, brief: "What to bring, and when" }],
    ],
    [
      "a page to the Trash",
      (page) => [{ kind: "page.trash", page }],
      (page) => [{ kind: "page.restore", page }],
    ],
    [
      "a page out of the Trash",
      (page) => [{ kind: "page.restore", page }],
      (page) => [{ kind: "page.trash", page }],
      (page) => [{ kind: "page.trash", page }],
    ],
  ];

  test.each(pageWalks)(
    "%s, its opposite by hand, two Undos and two Redos walk the page back and forth exactly",
    (_, action, opposite, setup) => {
      const page = newPage();
      for (const op of setup?.(page) ?? []) send([op]);
      const states = [seenPage(page)];
      send(action(page));
      states.push(seenPage(page));
      send(opposite(page));
      states.push(seenPage(page));
      for (const at of [1, 0]) {
        applied(undo());
        expect(seenPage(page)).toEqual(states[at]);
      }
      for (const at of [1, 2]) {
        applied(redo());
        expect(seenPage(page)).toEqual(states[at]);
      }
    },
  );

  const textWalks: [string, Operation, Operation][] = [
    [
      "the space's first description, then another",
      { kind: "node.set", node: space, description: "Home and paperwork." },
      { kind: "node.set", node: space, description: "Home, paperwork and travel." },
    ],
    [
      "the space's brief",
      { kind: "node.set", node: space, brief: "Home" },
      { kind: "node.set", node: space, brief: "Home and travel" },
    ],
    [
      "the text for agents",
      { kind: "node.instruct", node: space, text: "Ask before you book anything." },
      { kind: "node.instruct", node: space, text: "Ask before you pay for anything." },
    ],
  ];

  test.each(textWalks)(
    "%s, its opposite by hand, two Undos and two Redos walk the texts back and forth exactly",
    (_, action, opposite) => {
      const states = [seenTexts()];
      send([action]);
      states.push(seenTexts());
      send([opposite]);
      states.push(seenTexts());
      for (const at of [1, 0]) {
        applied(undo());
        expect(seenTexts()).toEqual(states[at]);
      }
      for (const at of [1, 2]) {
        applied(redo());
        expect(seenTexts()).toEqual(states[at]);
      }
    },
  );

  test("an agent's page writes and a person's new page are no steps: Undo has nothing", () => {
    const page = newPage();
    send([{ kind: "page.set", page, body: "Bring two photos." }], fx.codex);
    send([{ kind: "page.trash", page }], fx.codex);
    expect(undo().error?.code).toBe("NOTHING_TO_UNDO");
  });
});
