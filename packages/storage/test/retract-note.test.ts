// Retracting a note and putting it back (`note.delete`, `note.restore`): the row stays with its
// ordinal, author and audience, the task and its other notes are untouched, undo and redo take
// either step back, and a note whose writing was undone is Redo's. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import {
  expectedDocuments,
  storedDocuments,
  type SearchDocument,
} from "../src/search/documents.ts";
import type { Operation, WriteRequest, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("retract-note");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Row = Record<string, unknown>;

const plainDocs = (docs: Iterable<SearchDocument>) =>
  [...docs]
    .map(({ kind, entityId, taskId, audience, body }) => ({
      kind,
      entityId,
      taskId,
      audience,
      body,
    }))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

describe("[A1.note.retract] a note retracted from a task, and put back", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await fixture();
  });
  afterEach(() => {
    checkHistory(fx.reader);
    // The search index equals a fresh rebuild: a retracted note is no longer the task's text.
    const { docs, stray } = storedDocuments(fx.reader);
    expect(stray).toBe(0);
    expect(plainDocs(docs.values())).toEqual(plainDocs(expectedDocuments(fx.reader).values()));
    fx.close();
  });

  type Who = "human" | "codex";
  const send = (who: Who, ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
    fx.writer.submit(
      fx.request(fx[who], ops, { ...(who === "human" ? { undoable: true } : {}), ...extra }),
    );
  const applied = (result: WriteResult): WriteResult => {
    expectStatus(result, "applied");
    return result;
  };
  const note = (task: string, ordinal: number): Row =>
    fx.reader
      .prepare("SELECT * FROM notes WHERE task_id = $task AND ordinal = $ordinal")
      .get({ task, ordinal }) ?? {};
  /** The task's own fields: `touched` follows every change under it. */
  const taskRow = (id: string): Row => {
    const { touched: _, ...fields } =
      fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
    return fields;
  };
  /** A task with notes by the person and by Codex, in that order: n1, n2, n3. */
  const noted = (): Id<"t"> => {
    const id = newId("t");
    applied(send("human", [{ kind: "task.create", id, title: "Answer the clinic" }]));
    applied(send("human", [{ kind: "note.add", task: id, body: "Ask about the invoice" }]));
    applied(
      send("human", [
        { kind: "note.add", task: id, body: "Keep the old format", addressee: "agents" },
      ]),
    );
    applied(send("codex", [{ kind: "note.add", task: id, body: "Drafted the reply" }]));
    return id;
  };
  const retract = (task: string, ordinal: number, extra: Partial<WriteRequest> = {}) =>
    send("human", [{ kind: "note.delete", task, ordinal }], { base: fx.base(), ...extra });
  const putBack = (task: string, ordinal: number, extra: Partial<WriteRequest> = {}) =>
    send("human", [{ kind: "note.restore", task, ordinal }], { base: fx.base(), ...extra });
  const undo = () => fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }]));
  const redo = () => fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));

  test("a retracted note keeps its row; put back brings back the same note with its number, author and audience", () => {
    const task = noted();
    const original = note(task, 2);
    const before = taskRow(task);
    const others = [note(task, 1), note(task, 3)];
    const result = applied(retract(task, 2));
    expect(result.results[0]).toMatchObject({ status: "updated", task, entry: "n2" });
    expect(note(task, 2)["deleted_at"]).not.toBeNull();
    // The task and the other notes are untouched.
    expect(taskRow(task)).toEqual(before);
    expect([note(task, 1), note(task, 3)]).toEqual(others);
    const back = applied(putBack(task, 2));
    expect(back.results[0]).toMatchObject({ status: "updated", entry: "n2" });
    const now = note(task, 2);
    for (const column of ["id", "ordinal", "author_id", "addressee", "audience", "body"]) {
      expect(now[column]).toEqual(original[column]);
    }
    expect(now["deleted_at"]).toBeNull();
    // A note written afterwards takes the next number: a retracted one keeps its own.
    applied(send("human", [{ kind: "note.add", task, body: "One more" }]));
    expect(note(task, 4)["body"]).toBe("One more");
  });

  test("an agent's note is retracted the same way; a repeat is unchanged", () => {
    const task = noted();
    applied(retract(task, 3));
    expectStatus(retract(task, 3), "unchanged");
    applied(putBack(task, 3));
    expectStatus(putBack(task, 3), "unchanged");
  });

  test("a retract needs a base, and one from before a put back is a conflict", () => {
    const task = noted();
    const bare = send("human", [{ kind: "note.delete", task, ordinal: 1 }]);
    expectStatus(bare, "rejected");
    expect(bare.error).toMatchObject({ code: "BASE_REQUIRED" });
    const seen = fx.base();
    applied(retract(task, 1));
    applied(putBack(task, 1));
    const stale = retract(task, 1, { base: seen });
    expectStatus(stale, "conflict");
    expect(note(task, 1)["deleted_at"]).toBeNull();
  });

  test("a number the task has no note under is not found, and the task stays as it was", () => {
    const task = noted();
    const before = taskRow(task);
    const missing = retract(task, 9);
    expectStatus(missing, "rejected");
    expect(missing.error).toMatchObject({ code: "NOT_FOUND", field: "ordinal" });
    expect(taskRow(task)).toEqual(before);
  });

  test("undo puts a retracted note back and redo retracts it again, as the same change", () => {
    const task = noted();
    const done = applied(retract(task, 1));
    const provenance = () =>
      fx.reader
        .prepare(
          "SELECT json_extract(fp, '$.deleted') AS p FROM notes WHERE task_id = $task AND ordinal = 1",
        )
        .get({ task })?.["p"];
    expect(provenance()).toBe(done.seq);
    applied(undo());
    expect(note(task, 1)["deleted_at"]).toBeNull();
    applied(redo());
    expect(note(task, 1)["deleted_at"]).not.toBeNull();
    expect(provenance()).toBe(done.seq);
    // Put back after the redo works: the removal is a retraction, not an undone writing.
    applied(putBack(task, 1));
  });

  test("a note whose writing was undone is not put back: Redo brings it back", () => {
    const task = noted();
    applied(send("human", [{ kind: "note.add", task, body: "Typed by mistake" }]));
    applied(undo());
    expect(note(task, 4)["deleted_at"]).not.toBeNull();
    const refused = putBack(task, 4);
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "INVALID_TRANSITION", field: "ordinal" });
    applied(redo());
    expect(note(task, 4)["deleted_at"]).toBeNull();
  });

  test("a task in the Trash takes no retract", () => {
    const task = noted();
    applied(send("human", [{ kind: "task.delete", task }], { base: fx.base() }));
    const refused = retract(task, 1);
    expectStatus(refused, "rejected");
    expect(note(task, 1)["deleted_at"]).toBeNull();
  });
});
