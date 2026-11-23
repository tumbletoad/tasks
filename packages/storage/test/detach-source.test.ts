// Detaching a source from a task and putting it back (`source.unlink`, `source.relink`): the link
// is removed and brought back as the same pair, the source and every other link stay, put back is
// refused while another active task holds the key, and undo and redo take either step back. Fixture
// text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import {
  expectedDocuments,
  storedDocuments,
  type SearchDocument,
} from "../src/search/documents.ts";
import type { Operation, SourceFields, WriteRequest, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("detach-source");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Row = Record<string, unknown>;

/** A document without its number and seq, sorted: what a rebuild compares. */
const plainDocs = (docs: Iterable<SearchDocument>) =>
  [...docs]
    .map(({ kind, entityId, taskId, lifecycle, audience, title, body, extra }) => ({
      kind,
      entityId,
      taskId,
      lifecycle,
      audience,
      title,
      body,
      extra,
    }))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

const ticket = (key: string): SourceFields => ({ kind: "ticket", title: `Ticket ${key}`, key });

describe("[A1.source.detach] a source detached from a task, and put back", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await fixture();
  });
  afterEach(() => {
    checkHistory(fx.reader);
    // The search index equals a fresh rebuild: a detached source is no longer the task's text.
    const { docs, stray } = storedDocuments(fx.reader);
    expect(stray).toBe(0);
    expect(plainDocs(docs.values())).toEqual(plainDocs(expectedDocuments(fx.reader).values()));
    fx.close();
  });

  type Who = "human" | "codex";
  const send = (who: Who, ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
    fx.writer.submit(
      fx.request(fx[who], ops, {
        ...(who === "human" ? { undoable: true } : {}),
        ...extra,
      }),
    );
  const applied = (result: WriteResult): WriteResult => {
    expectStatus(result, "applied");
    return result;
  };
  const one = (sql: string, params = {}): unknown =>
    Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
  const link = (task: string, source: string): Row =>
    fx.reader
      .prepare("SELECT * FROM task_sources WHERE task_id = $task AND source_id = $source")
      .get({ task, source }) ?? {};
  /** The commit whose write the link's removal holds: its provenance. */
  const removedBy = (task: string, source: string): unknown =>
    one(
      "SELECT json_extract(fp, '$.removed') FROM task_sources WHERE task_id = $task AND source_id = $source",
      { task, source },
    );
  const sourceOf = (key: string): Id<"s"> =>
    String(one("SELECT id FROM sources WHERE source_key = $key", { key })) as Id<"s">;
  /** The tasks a live link joins to the source with `key`. */
  const holders = (key: string): string[] =>
    fx.reader
      .prepare(
        "SELECT ts.task_id AS t FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
          "WHERE s.source_key = $key AND ts.removed_at IS NULL ORDER BY ts.task_id",
      )
      .all({ key })
      .map((r) => String(r["t"]));
  /** A new task with these sources, as add_tasks sends a capture. */
  const capture = (sources: SourceFields[], who: Who = "codex"): Id<"t"> => {
    const id = newId("t");
    const result = applied(
      send(who, [
        { kind: "task.create", id, title: "Answer the clinic" },
        ...sources.map((source): Operation => ({ kind: "source.add", task: id, source })),
      ]),
    );
    return result.results[0]?.task ?? id;
  };
  const unlink = (task: string, source: Id<"s">, who: Who = "human", extra = {}) =>
    send(who, [{ kind: "source.unlink", task, source }], { base: fx.base(), ...extra });
  const relink = (task: string, source: Id<"s">, who: Who = "human", extra = {}) =>
    send(who, [{ kind: "source.relink", task, source }], { base: fx.base(), ...extra });
  const undo = () => fx.writer.submit(fx.request(fx.human, [{ kind: "undo" }]));
  const redo = () => fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));

  test("a keyed link detached no longer catches a capture; the task's other links and another task's link to the same source stay", () => {
    const a = capture([ticket("jira:FIX-1"), ticket("jira:FIX-2")]);
    // B shares FIX-2 by an explicit link.
    const b = capture([{ kind: "ticket", title: "Other work" }]);
    applied(send("human", [{ kind: "source.add", task: b, source: ticket("jira:FIX-2") }]));
    const fix1 = sourceOf("jira:FIX-1");
    const before = link(a, sourceOf("jira:FIX-2"));
    const result = applied(unlink(a, fix1));
    expect(result.results[0]).toMatchObject({ status: "updated", id: fix1, task: a });
    expect(link(a, fix1)["removed_at"]).not.toBeNull();
    // The source stays, with its key, for other tasks.
    expect(one("SELECT deleted_at FROM sources WHERE id = $id", { id: fix1 })).toBeNull();
    expect(link(a, sourceOf("jira:FIX-2"))).toEqual(before);
    expect(holders("jira:FIX-2")).toEqual([a, b].sort());
    // A capture of FIX-1 makes new work: A no longer holds the key.
    const c = capture([ticket("jira:FIX-1")]);
    expect(c).not.toBe(a);
    expect(holders("jira:FIX-1")).toEqual([c]);
    // A capture of FIX-2 still has two active holders, as before.
    expect(holders("jira:FIX-2")).toEqual([a, b].sort());
  });

  test("put back brings back the same pair: source, role, position, and a capture finds the task again", () => {
    const a = capture([ticket("jira:FIX-1"), { kind: "email", title: "Re: times" }]);
    const fix1 = sourceOf("jira:FIX-1");
    const original = link(a, fix1);
    applied(unlink(a, fix1));
    const back = applied(relink(a, fix1));
    expect(back.results[0]).toMatchObject({ status: "updated", id: fix1 });
    const now = link(a, fix1);
    expect(now["removed_at"]).toBeNull();
    expect(now["role"]).toBe(original["role"]);
    expect(now["position"]).toBe(original["position"]);
    expect(now["added_by"]).toBe(original["added_by"]);
    expect(Number(one("SELECT count(*) FROM sources WHERE source_key = 'jira:FIX-1'"))).toBe(1);
    // The next capture of FIX-1 finds A.
    const again = newId("t");
    const found = send("codex", [
      { kind: "task.create", id: again, title: "Answer again" },
      { kind: "source.add", task: again, source: ticket("jira:FIX-1") },
    ]);
    expectStatus(found, "unchanged");
    expect(found.results[0]).toMatchObject({ status: "existing", task: a });
  });

  test("an unkeyed source, a duplicate URL and a title-only source are detached and put back by their ID alone", () => {
    const url = "https://tracker.example/issues/7";
    const a = capture([
      { kind: "issue", title: "First", url },
      { kind: "issue", title: "Second", url },
      { kind: "chat", title: "Call notes" },
    ]);
    const ids = fx.reader
      .prepare("SELECT source_id FROM task_sources WHERE task_id = $a ORDER BY position")
      .all({ a })
      .map((r) => String(r["source_id"]) as Id<"s">);
    expect(ids).toHaveLength(3);
    const [first, second, titled] = ids as [Id<"s">, Id<"s">, Id<"s">];
    applied(unlink(a, second));
    applied(unlink(a, titled));
    expect(link(a, first)["removed_at"]).toBeNull();
    expect(link(a, second)["removed_at"]).not.toBeNull();
    applied(relink(a, titled));
    expect(link(a, titled)["removed_at"]).toBeNull();
    expect(Number(one("SELECT count(*) FROM sources"))).toBe(3);
  });

  test("a stale link version or base is a conflict; a link already detached or still there is unchanged", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    const version = Number(link(a, fix1)["version"]);
    const stale = send("human", [
      { kind: "source.unlink", task: a, source: fix1, link_version: 0 },
    ]);
    expectStatus(stale, "conflict");
    expect(link(a, fix1)["removed_at"]).toBeNull();
    // Without a base or a link version: refused, naming the link.
    const bare = send("human", [{ kind: "source.unlink", task: a, source: fix1 }]);
    expectStatus(bare, "rejected");
    expect(bare.error).toMatchObject({ code: "BASE_REQUIRED", field: "link_version" });
    const base = fx.base();
    applied(
      send("human", [{ kind: "source.unlink", task: a, source: fix1, link_version: version }]),
    );
    // A put back from a read before the detach is stale.
    expectStatus(relink(a, fix1, "human", { base }), "conflict");
    // Detaching again changes nothing.
    expectStatus(unlink(a, fix1), "unchanged");
    applied(relink(a, fix1));
    expectStatus(relink(a, fix1), "unchanged");
  });

  test("a finished task takes a detach and a put back alone; a request that mixes either with another change is refused whole", () => {
    const a = capture([ticket("jira:FIX-1")]);
    applied(send("codex", [{ kind: "task.complete", task: a }], { base: fx.base() }));
    const fix1 = sourceOf("jira:FIX-1");
    const title = one("SELECT title FROM tasks WHERE id = $a", { a });
    const mixed = send(
      "human",
      [
        { kind: "task.patch", task: a, set: { title: "Changed" } },
        { kind: "source.unlink", task: a, source: fix1 },
      ],
      { base: fx.base(), active: true },
    );
    expectStatus(mixed, "rejected");
    expect(mixed.error?.code).toBe("TASK_NOT_ACTIVE");
    expect(one("SELECT title FROM tasks WHERE id = $a", { a })).toBe(title);
    expect(link(a, fix1)["removed_at"]).toBeNull();
    applied(unlink(a, fix1));
    expect(link(a, fix1)["removed_at"]).not.toBeNull();
    applied(relink(a, fix1));
    expect(holders("jira:FIX-1")).toEqual([a]);
  });

  test("put back while another active task holds the key is a conflict on that task's link, and nothing is copied", () => {
    const a = capture([{ ...ticket("jira:FIX-1"), who: "Ana", url: "https://jira.example/FIX-1" }]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1));
    const c = capture([ticket("jira:FIX-1")]);
    const cRef = `M-${String(one("SELECT ref FROM tasks WHERE id = $c", { c }))}`;
    const sources = Number(one("SELECT count(*) FROM sources"));
    const refused = relink(a, fix1);
    expectStatus(refused, "conflict");
    expect(refused.conflicts).toMatchObject([
      { entity: "task_sources", id: `${c}|${fix1}`, task: c, ref: cRef, field: "removed" },
    ]);
    // Nothing changed: the link stays detached, no second source or link was made.
    expect(link(a, fix1)["removed_at"]).not.toBeNull();
    expect(Number(one("SELECT count(*) FROM sources"))).toBe(sources);
    expect(Number(one("SELECT count(*) FROM task_sources WHERE task_id = $a", { a }))).toBe(1);
    expect(holders("jira:FIX-1")).toEqual([c]);
    // A finished task is refused alike: reopened, it would be a second holder.
    applied(send("codex", [{ kind: "task.complete", task: a }], { base: fx.base() }));
    expectStatus(relink(a, fix1), "conflict");
    applied(send("codex", [{ kind: "task.reopen", task: a }], { base: fx.base() }));
    // Once C no longer holds the key, put back works and captures find A again.
    applied(send("codex", [{ kind: "task.complete", task: c }], { base: fx.base() }));
    applied(relink(a, fix1));
    expect(link(a, fix1)["removed_at"]).toBeNull();
    const next = newId("t");
    const found = send("codex", [
      { kind: "task.create", id: next, title: "Answer again" },
      { kind: "source.add", task: next, source: ticket("jira:FIX-1") },
    ]);
    expectStatus(found, "unchanged");
    expect(found.results[0]).toMatchObject({ status: "existing", task: a });
  });

  test("a holder that detached the source itself, or was deleted, holds the key no more", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1));
    const c = capture([ticket("jira:FIX-1")]);
    applied(unlink(c, fix1));
    applied(relink(a, fix1));
    expect(holders("jira:FIX-1")).toEqual([a]);
    applied(unlink(a, fix1));
    applied(relink(c, fix1));
    applied(send("human", [{ kind: "task.delete", task: c }], { base: fx.base() }));
    applied(relink(a, fix1));
    expect(holders("jira:FIX-1").filter((t) => t === a)).toEqual([a]);
  });

  test("a put back made from a base before a later detach is a conflict", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1));
    const first = fx.base();
    applied(relink(a, fix1));
    applied(unlink(a, fix1));
    const stale = relink(a, fix1, "human", { base: first });
    expectStatus(stale, "conflict");
    expect(stale.conflicts).toMatchObject([{ entity: "task_sources", id: `${a}|${fix1}` }]);
    expect(link(a, fix1)["removed_at"]).not.toBeNull();
  });

  test("one request judges holders on what it built so far: a task it creates with the key keeps a put back out", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1));
    const b = newId("t");
    const refused = send(
      "codex",
      [
        { kind: "task.create", id: b, title: "Other work" },
        { kind: "source.add", task: b, source: ticket("jira:FIX-1") },
        { kind: "source.relink", task: a, source: fix1 },
      ],
      { base: fx.base() },
    );
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "INVALID_TRANSITION", op: 2, field: "source" });
    expect(holders("jira:FIX-1")).toEqual([]);
    // Put back first, then the capture: the capture finds A.
    const found = send(
      "codex",
      [
        { kind: "source.relink", task: a, source: fix1 },
        { kind: "task.create", id: b, title: "Other work" },
        { kind: "source.add", task: b, source: ticket("jira:FIX-1") },
      ],
      { base: fx.base() },
    );
    expectStatus(found, "applied");
    expect(found.results[1]).toMatchObject({ status: "existing", task: a });
    expect(holders("jira:FIX-1")).toEqual([a]);
  });

  test("an agent detaches a link, and the person puts it back", () => {
    const a = capture([ticket("jira:FIX-1")], "human");
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1, "codex"));
    expect(holders("jira:FIX-1")).toEqual([]);
    applied(relink(a, fix1, "human"));
    expect(holders("jira:FIX-1")).toEqual([a]);
  });

  test("undo and redo take a detach and a put back back and forth; an undo that would make a second holder is refused", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    const detach = applied(unlink(a, fix1));
    applied(undo());
    expect(holders("jira:FIX-1")).toEqual([a]);
    applied(redo());
    expect(holders("jira:FIX-1")).toEqual([]);
    // The redo holds the detach's own provenance: put back still lists it as a removal.
    expect(removedBy(a, fix1)).toBe(detach.seq);
    applied(relink(a, fix1));
    applied(undo());
    expect(holders("jira:FIX-1")).toEqual([]);
    expect(removedBy(a, fix1)).toBe(detach.seq);
    applied(redo());
    expect(holders("jira:FIX-1")).toEqual([a]);
    // Detached again, then captured elsewhere: the undo of the detach would make two holders.
    applied(unlink(a, fix1));
    const c = capture([ticket("jira:FIX-1")]);
    expectStatus(undo(), "conflict");
    expect(holders("jira:FIX-1")).toEqual([c]);
  });

  test("a link whose creation was undone is not put back: Redo brings it back", () => {
    // A link to a source another task has too: the undo removes the link and keeps the source.
    const b = capture([ticket("jira:FIX-7")]);
    applied(send("codex", [{ kind: "task.complete", task: b }], { base: fx.base() }));
    const a = capture([{ kind: "email", title: "Re: times" }]);
    applied(send("human", [{ kind: "source.add", task: a, source: ticket("jira:FIX-7") }]));
    const fix7 = sourceOf("jira:FIX-7");
    applied(undo());
    expect(link(a, fix7)["removed_at"]).not.toBeNull();
    const refused = relink(a, fix7);
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "INVALID_TRANSITION", field: "source" });
    // A new source whose creation was undone is gone with its link.
    applied(send("human", [{ kind: "source.add", task: a, source: ticket("jira:FIX-8") }]));
    const fix8 = sourceOf("jira:FIX-8");
    applied(undo());
    expectStatus(relink(a, fix8), "rejected");
    applied(redo());
    expect(holders("jira:FIX-8")).toEqual([a]);
  });

  test("a link the task never had is not found", () => {
    const a = capture([{ kind: "email", title: "Re: times" }]);
    const b = capture([ticket("jira:FIX-1")]);
    const refused = unlink(a, sourceOf("jira:FIX-1"));
    expectStatus(refused, "rejected");
    expect(refused.error).toMatchObject({ code: "NOT_FOUND", field: "source" });
    expect(holders("jira:FIX-1")).toEqual([b]);
  });
});
