// The person's correction of a note's or a log entry's words (`note.patch`, `log.patch`): the entry
// keeps its number, author and time, the words before stay in history, a stale base is a conflict,
// a removed entry is not found, and undo and redo move between the two texts. Fixture text only.
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

const temp = tempFolders("correct-entry");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Row = Record<string, unknown>;

const plainDocs = (docs: Iterable<SearchDocument>) =>
  [...docs]
    .map(({ kind, entityId, body }) => ({ kind, entityId, body }))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

describe("[A1.entry.correct] the person corrects a note's or a log entry's words", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await fixture();
  });
  afterEach(() => {
    checkHistory(fx.reader);
    // The search index equals a fresh rebuild: it finds the words the entry holds now.
    const { docs, stray } = storedDocuments(fx.reader);
    expect(stray).toBe(0);
    expect(plainDocs(docs.values())).toEqual(plainDocs(expectedDocuments(fx.reader).values()));
    fx.close();
  });

  type Who = "human" | "codex";
  const send = (who: Who, ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
    fx.writer.submit(fx.request(fx[who], ops, extra));
  const applied = (result: WriteResult): WriteResult => {
    expectStatus(result, "applied");
    return result;
  };
  const entry = (table: "notes" | "log_entries", task: string, ordinal: number): Row =>
    fx.reader
      .prepare(`SELECT * FROM ${table} WHERE task_id = $task AND ordinal = $ordinal`)
      .get({ task, ordinal }) ?? {};
  /** A task with Codex's note n1 and its progress entry l1. */
  const written = (): Id<"t"> => {
    const id = newId("t");
    applied(send("human", [{ kind: "task.create", id, title: "Answer the clinic" }]));
    applied(send("codex", [{ kind: "note.add", task: id, body: "Drafted teh reply" }]));
    applied(send("codex", [{ kind: "log.add", task: id, body: "Checked the invoce" }]));
    return id;
  };
  const correct = (
    kind: "note.patch" | "log.patch",
    task: string,
    body: string,
    extra: Partial<WriteRequest> = {},
  ) => send("human", [{ kind, task, ordinal: 1, body }], { base: fx.base(), ...extra });
  const undo = () => fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }]));
  const redo = () => fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));

  test("an agent's note and log entry take the person's words and keep their number, author and time", () => {
    const task = written();
    for (const [kind, table, words, ref] of [
      ["note.patch", "notes", "Drafted the reply", "n1"],
      ["log.patch", "log_entries", "Checked the invoice", "l1"],
    ] as const) {
      const before = entry(table, task, 1);
      const result = applied(correct(kind, task, words));
      expect(result.results[0]).toMatchObject({ status: "updated", task, entry: ref });
      const after = entry(table, task, 1);
      expect(after["body"]).toBe(words);
      for (const column of ["id", "ordinal", "author_id", "created_at", "created_seq"]) {
        expect(after[column]).toEqual(before[column]);
      }
      // The words before stay in history.
      const change = fx.reader
        .prepare("SELECT before, after FROM changes WHERE seq = $seq AND field = 'body'")
        .get({ seq: result.seq });
      expect(change).toEqual({
        before: JSON.stringify(before["body"]),
        after: JSON.stringify(words),
      });
    }
  });

  test("the same words are unchanged, and a correction needs a base and is a conflict after another change", () => {
    const task = written();
    expectStatus(correct("note.patch", task, "Drafted teh reply"), "unchanged");
    const bare = send("human", [{ kind: "note.patch", task, ordinal: 1, body: "x" }]);
    expect(bare.error).toMatchObject({ code: "BASE_REQUIRED" });
    const seen = fx.base();
    applied(correct("log.patch", task, "Checked the invoice"));
    const stale = correct("log.patch", task, "Checked the invoices", { base: seen });
    expectStatus(stale, "conflict");
    expect(entry("log_entries", task, 1)["body"]).toBe("Checked the invoice");
    // Another entry's change since is no conflict.
    applied(correct("note.patch", task, "Drafted the reply", { base: seen }));
  });

  test("a removed note, and a number with no entry, are not found", () => {
    const task = written();
    applied(send("human", [{ kind: "note.delete", task, ordinal: 1 }], { base: fx.base() }));
    const removed = correct("note.patch", task, "Drafted the reply");
    expectStatus(removed, "rejected");
    expect(removed.error).toMatchObject({ code: "NOT_FOUND", field: "ordinal" });
    const missing = send("human", [{ kind: "log.patch", task, ordinal: 9, body: "x" }], {
      base: fx.base(),
    });
    expect(missing.error).toMatchObject({ code: "NOT_FOUND", field: "ordinal" });
  });

  test("undo puts the words before back, and redo the person's", () => {
    const task = written();
    applied(correct("note.patch", task, "Drafted the reply"));
    applied(undo());
    expect(entry("notes", task, 1)["body"]).toBe("Drafted teh reply");
    applied(redo());
    expect(entry("notes", task, 1)["body"]).toBe("Drafted the reply");
  });

  test("a task in the Trash takes no correction", () => {
    const task = written();
    applied(send("human", [{ kind: "task.delete", task }], { base: fx.base() }));
    expectStatus(correct("note.patch", task, "Drafted the reply"), "rejected");
    expect(entry("notes", task, 1)["body"]).toBe("Drafted teh reply");
  });
});
