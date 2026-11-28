// Detaching a source from a task and putting it back (`source.unlink`, `source.relink`): the link
// is removed and brought back as the same pair, the source and every other link stay, put back is
// refused while another active task holds the key, and neither is a step on the person's Undo:
// put back is the way back. Fixture text only.
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

  test("a finished task takes its link back while an active task holds the key, and captures stay with the active one", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(send("codex", [{ kind: "task.complete", task: a }], { base: fx.base() }));
    applied(unlink(a, fix1));
    const c = capture([ticket("jira:FIX-1")]);
    applied(relink(a, fix1));
    expect(holders("jira:FIX-1")).toEqual([a, c].sort());
    expect(Number(one("SELECT count(*) FROM sources"))).toBe(1);
    const next = newId("t");
    const found = send("codex", [
      { kind: "task.create", id: next, title: "Answer again" },
      { kind: "source.add", task: next, source: ticket("jira:FIX-1") },
    ]);
    expect(found.results[0]).toMatchObject({ status: "existing", task: c });
  });

  // Each order of an add, a detach and a put back of one link in one request ends as the last of
  // them asks: an add or a put back leaves it linked, a detach leaves it detached.
  const steps = ["add", "unlink", "relink"] as const;
  type Step = (typeof steps)[number];
  const orders: Step[][] = [
    ...steps.flatMap((x) => steps.map((y) => [x, y])),
    ...steps.flatMap((x) =>
      steps.filter((y) => y !== x).map((y) => [x, y, ...steps.filter((z) => z !== x && z !== y)]),
    ),
  ];
  test.each([true, false].flatMap((linked) => orders.map((order) => ({ linked, order }))))(
    "one request that changes a link several times ends as its last step asks: linked $linked, $order",
    ({ linked, order }) => {
      const key = "jira:ORD-1";
      const a = capture([ticket(key)]);
      const source = sourceOf(key);
      if (!linked) applied(unlink(a, source));
      const ops = order.map((step): Operation =>
        step === "add"
          ? { kind: "source.add", task: a, source: ticket(key) }
          : { kind: `source.${step}`, task: a, source },
      );
      const result = send("human", ops, { base: fx.base() });
      expect(["applied", "unchanged"]).toContain(result.status);
      const last = order.at(-1);
      expect(holders(key)).toEqual(last === "unlink" ? [] : [a]);
      expect(Number(one("SELECT count(*) FROM sources"))).toBe(1);
      expect(Number(one("SELECT count(*) FROM task_sources"))).toBe(1);
    },
  );

  test("an add of a detached pair while another active task holds the key links it again, and says the key is shared", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1));
    const c = capture([ticket("jira:FIX-1")]);
    const cRef = `M-${String(one("SELECT ref FROM tasks WHERE id = $c", { c }))}`;
    const added = applied(
      send("codex", [{ kind: "source.add", task: a, source: ticket("jira:FIX-1") }], {
        base: fx.base(),
      }),
    );
    expect(added.results[0]).toMatchObject({ status: "updated", id: fix1, shared_with: [cRef] });
    expect(holders("jira:FIX-1")).toEqual([a, c].sort());
    expect(Number(one("SELECT count(*) FROM sources"))).toBe(1);
    expect(Number(one("SELECT count(*) FROM task_sources"))).toBe(2);
    const next = newId("t");
    const found = send("codex", [
      { kind: "task.create", id: next, title: "Answer again" },
      { kind: "source.add", task: next, source: ticket("jira:FIX-1") },
    ]);
    expect(found.results[0]?.ambiguous).toHaveLength(2);
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
    // Captured on C meanwhile: still a conflict, and nothing is linked to A.
    const c = capture([ticket("jira:FIX-1")]);
    const sources = Number(one("SELECT count(*) FROM sources"));
    expectStatus(relink(a, fix1, "human", { base: first }), "conflict");
    expect(Number(one("SELECT count(*) FROM sources"))).toBe(sources);
    expect(holders("jira:FIX-1")).toEqual([c]);
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

  test("one request that detaches a key and captures it matches as if the detach had happened", () => {
    const a = capture([ticket("jira:FIX-1"), ticket("jira:FIX-2")]);
    const fix1 = sourceOf("jira:FIX-1");
    const b = newId("t");
    const result = applied(
      send(
        "codex",
        [
          { kind: "source.unlink", task: a, source: fix1 },
          { kind: "task.create", id: b, title: "The right task" },
          { kind: "source.add", task: b, source: ticket("jira:FIX-1") },
          { kind: "source.add", task: b, source: ticket("jira:FIX-2") },
        ],
        { base: fx.base() },
      ),
    );
    // FIX-1 names no task any more: the draft is new work and holds it; A keeps FIX-2.
    expect(result.results[1]).toMatchObject({ status: "created" });
    expect(holders("jira:FIX-1")).toEqual([b]);
    expect(holders("jira:FIX-2")).toEqual([a]);
    const next = newId("t");
    const found = send("codex", [
      { kind: "task.create", id: next, title: "Answer again" },
      { kind: "source.add", task: next, source: ticket("jira:FIX-1") },
    ]);
    expect(found.results[0]).toMatchObject({ status: "existing", task: b });
  });

  test("an agent detaches a link, and the person puts it back", () => {
    const a = capture([ticket("jira:FIX-1")], "human");
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1, "codex"));
    expect(holders("jira:FIX-1")).toEqual([]);
    applied(relink(a, fix1, "human"));
    expect(holders("jira:FIX-1")).toEqual([a]);
  });

  test("a detach and a put back are no step: Undo passes over them", () => {
    const a = capture([ticket("jira:FIX-1")]);
    const fix1 = sourceOf("jira:FIX-1");
    applied(unlink(a, fix1));
    applied(relink(a, fix1));
    expect(undo().error?.code).toBe("NOTHING_TO_UNDO");
    expect(holders("jira:FIX-1")).toEqual([a]);
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
