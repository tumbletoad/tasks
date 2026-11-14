// Query-level invalidation (A5 3.13, 3.15 "Paged queries"; the second sentence of M5.02's Verify
// line): a task that starts to match an open Completed view appears in it, and one that starts to
// match an open search offers "Results changed · Refresh", which then shows it. The paged reads are
// fakes over the feed model (test/feed-model.ts); the changes come through the real store.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { FeedModel, ModelSubscription, SPACE, type Op } from "../../test/feed-model.ts";
import type { Change } from "./core.ts";
import type { FrameClock } from "./frame.ts";
import { affects, PagedQuery, type PageSource } from "./queries.ts";
import { LiveStore } from "./store.ts";

type Row = { readonly id: string; readonly title: string } & Record<string, unknown>;

/** Frames that run at once: these tests are about queries, not frames. */
const NOW: FrameClock = {
  request(run) {
    queueMicrotask(run);
    return () => undefined;
  },
};

/** Lets the frame, the restart's read and its answer run (each is a few microtasks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** The model's visible tasks at its head that `match`, in order, read in pages by position. */
function source(model: FeedModel, match: (row: Row) => boolean): PageSource<Row> {
  return ({ after, limit }) => {
    const rows = [...model.state.rows.values()]
      .filter((r) => r.type === "task" && !r.hidden && r.fields["deleted_at"] === undefined)
      .map((r) => r.fields as unknown as Row)
      .filter(match)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const start = after === undefined ? 0 : rows.findIndex((r) => r.id > after);
    const page = start < 0 ? [] : rows.slice(start, start + limit);
    const last = page.at(-1);
    return Promise.resolve({
      rows: page,
      ...(start >= 0 && start + limit < rows.length && last !== undefined ? { next: last.id } : {}),
    });
  };
}

const completed = (row: Row) => row["lifecycle"] === "completed";
/** A search for "Title", which a retitled task's new title has (feed-model.ts). */
const search = (row: Row) => row["lifecycle"] === "active" && row.title.includes("Title");

function world(pageSize = 2) {
  const model = new FeedModel();
  for (let i = 0; i < 4; i += 1) model.apply({ op: "add", hidden: false, area: 0 });
  const store = new LiveStore({ space: SPACE, frames: NOW, onResnapshot: () => undefined });
  const sub = new ModelSubscription(model);
  for (const m of sub.subscribe(undefined)) store.push(m);
  const done = new PagedQuery({ kind: "completed" }, source(model, completed), { pageSize });
  const found = new PagedQuery({ kind: "search" }, source(model, search), { pageSize });
  store.onChanges((changes) => {
    done.apply(changes);
    found.apply(changes);
  });
  /** An agent's commit, and the feed's batch for it. */
  const commit = async (op: Op) => {
    model.apply(op);
    for (const m of sub.pump(100)) store.push(m);
    await settle();
  };
  return { model, store, sub, done, found, commit };
}

const idsOf = (rows: readonly Row[]) => rows.map((r) => r.id).sort();

describe("[A5.3.15.web.store.queries] query-level invalidation", () => {
  test("a task that starts to match an open Completed view appears in it", async () => {
    const w = world();
    await w.done.refresh();
    expect(w.done.getState().rows).toEqual([]);
    await w.commit({ op: "complete", task: 1 });
    // The view restarted by itself on the change, and the task is there.
    const [task] = w.done.getState().rows;
    expect(task?.["lifecycle"]).toBe("completed");
    expect(w.done.getState().changed).toBe(false);
    // Reopened: it leaves the Completed view and is back in the open set.
    await w.commit({ op: "reopen", task: 0 });
    expect(w.done.getState().rows).toEqual([]);
    expect(w.store.getState().tasks.has(task?.id ?? "")).toBe(true);
  });

  test("a task that starts to match an open search offers a refresh, which shows it", async () => {
    const w = world();
    await w.found.refresh();
    expect(w.found.getState().rows).toEqual([]);
    await w.commit({ op: "retitle", task: 2 });
    // Frozen: nothing re-sorts under the reader; one line offers the refresh.
    expect(w.found.getState()).toMatchObject({ rows: [], changed: true });
    await w.found.refresh();
    expect(w.found.getState().rows).toHaveLength(1);
    expect(w.found.getState().changed).toBe(false);
    // A shown row takes new values in place; the change could reorder it, so Refresh is offered.
    const [shown] = w.found.getState().rows;
    await w.commit({ op: "retitle", task: 2 });
    expect(w.found.getState().rows[0]?.id).toBe(shown?.id);
    expect(w.found.getState().rows[0]?.title).not.toBe(shown?.title);
    expect(w.found.getState().changed).toBe(true);
  });

  test("a restart loads as many rows as were shown, and only the newest read applies", async () => {
    const w = world();
    for (let i = 0; i < 4; i += 1) w.model.apply({ op: "complete", task: 0 });
    await w.done.refresh();
    expect(w.done.getState().rows).toHaveLength(2);
    await w.done.more();
    expect(w.done.getState().rows).toHaveLength(4);
    // Two restarts race; the older answers last and is dropped.
    const answers: ((rows: Row[]) => void)[] = [];
    const racing = new PagedQuery<Row>(
      { kind: "completed" },
      () =>
        new Promise((resolve) => {
          answers.push((rows) => {
            resolve({ rows });
          });
        }),
    );
    const older = racing.refresh();
    const newer = racing.refresh();
    answers[1]?.([{ id: "t_new", title: "Newer" }]);
    await newer;
    answers[0]?.([{ id: "t_old", title: "Older" }]);
    await older;
    expect(racing.getState().rows.map((r) => r.id)).toEqual(["t_new"]);
    expect(racing.getState().phase).toBe("ready");
  });

  test("a fresh snapshot after a gap counts as a change to every query", () => {
    const change = (patch: Partial<Change>): Change => ({
      type: "task",
      id: "t_x",
      changed: [],
      created: false,
      kind: "ops",
      actor: { kind: "agent", label: "" },
      request_id: "",
      ...patch,
    });
    expect(affects({ kind: "completed" }, change({ changed: ["lifecycle"] }))).toBe(true);
    expect(affects({ kind: "completed" }, change({ changed: ["title"] }))).toBe(false);
    expect(affects({ kind: "search" }, change({ changed: ["title"] }))).toBe(true);
    expect(affects({ kind: "search" }, change({ changed: ["priority"] }))).toBe(false);
    expect(
      affects({ kind: "search", fields: ["priority"] }, change({ changed: ["priority"] })),
    ).toBe(true);
    expect(affects({ kind: "search" }, change({ type: "note", task: "t_x" }))).toBe(true);
    expect(affects({ kind: "trash" }, change({ changed: ["deleted"] }))).toBe(true);
    expect(affects({ kind: "trash" }, change({ changed: ["title"] }))).toBe(false);

    const found = new PagedQuery({ kind: "search" }, () => Promise.resolve({ rows: [] as Row[] }));
    return found.refresh().then(() => {
      found.apply({ changes: [], reset: true });
      expect(found.getState().changed).toBe(true);
    });
  });

  test("changes name the service's logical fields, and a cleared field clears all its columns", async () => {
    const change = (patch: Partial<Change>): Change => ({
      type: "task",
      id: "t_x",
      changed: [],
      created: false,
      kind: "ops",
      actor: { kind: "agent", label: "" },
      request_id: "",
      ...patch,
    });
    // The feed names a task's logical fields (A1 3.4; storage's TASK_FIELDS), not its columns.
    expect(affects({ kind: "trash" }, change({ changed: ["deleted"] }))).toBe(true);
    expect(affects({ kind: "completed" }, change({ changed: ["deleted"] }))).toBe(true);
    expect(affects({ kind: "completed" }, change({ changed: ["wrap"] }))).toBe(true);
    expect(affects({ kind: "search" }, change({ changed: ["deleted"] }))).toBe(true);
    expect(affects({ kind: "search" }, change({ changed: ["wrap"] }))).toBe(true);
    expect(affects({ kind: "search", fields: ["due"] }, change({ changed: ["due"] }))).toBe(true);
    expect(affects({ kind: "search" }, change({ changed: ["due"] }))).toBe(false);

    // A shown row whose due date the feed clears loses every column of `due`.
    const shown = { id: "t_x", title: "Plants", version: 3, due_date: "2026-12-01", snippet: "x" };
    const query = new PagedQuery<Row>({ kind: "completed" }, () =>
      Promise.resolve({ rows: [shown] }),
    );
    await query.refresh();
    const after = { id: "t_x", title: "Plants", version: 4, lifecycle: "completed" };
    query.apply({ changes: [change({ changed: ["due"], after: after as never })], reset: false });
    expect(query.getState().rows[0]).toEqual({ ...after, snippet: "x" });
    // An older row never replaces a newer one.
    const older = { ...after, title: "Old", version: 2 };
    query.apply({ changes: [change({ changed: ["title"], after: older as never })], reset: false });
    expect(query.getState().rows[0]?.title).toBe("Plants");
  });

  test("a read that answers after a feed change shows the change, not its older values", async () => {
    const base = { id: "t_x", title: "Old", version: 3, lifecycle: "completed" };
    let answer!: (page: { rows: Row[] }) => void;
    const query = new PagedQuery<Row>(
      { kind: "completed" },
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const read = query.refresh();
    // The feed retitles the task while the read is on its way; a title does not restart Completed.
    const after = { ...base, title: "New", version: 4 };
    query.apply({
      changes: [
        {
          type: "task",
          id: "t_x",
          task: "t_x",
          changed: ["title"],
          created: false,
          kind: "ops",
          actor: { kind: "agent", label: "" },
          request_id: "",
          after: after as never,
        },
      ],
      reset: false,
    });
    answer({ rows: [base] });
    await read;
    expect(query.getState().rows[0]?.title).toBe("New");
  });

  test("whatever the agents do, Completed shows every completed task and a search is current or says so", async () => {
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ op: fc.constant("add" as const), hidden: fc.boolean(), area: fc.nat(5) }),
      fc.record({ op: fc.constant("retitle" as const), task: fc.nat(20) }),
      fc.record({ op: fc.constant("complete" as const), task: fc.nat(20) }),
      fc.record({ op: fc.constant("reopen" as const), task: fc.nat(20) }),
      fc.record({ op: fc.constant("delete" as const), task: fc.nat(20) }),
      fc.record({ op: fc.constant("restore" as const), task: fc.nat(20) }),
      fc.record({ op: fc.constant("note" as const), task: fc.nat(20) }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(opArb, fc.boolean()), { maxLength: 30, size: "max" }),
        async (steps) => {
          // Pages large enough to hold every match, so membership is the whole answer.
          const w = world(1_000);
          await w.done.refresh();
          await w.found.refresh();
          const want = (match: (row: Row) => boolean) =>
            [...w.model.visibleAt(w.model.seq).tasks.values(), ...completedAt(w.model)]
              .map((f) => f as unknown as Row)
              .filter(match)
              .map((r) => r.id)
              .sort();
          for (const [op, refresh] of steps) {
            await w.commit(op);
            if (refresh) await w.found.refresh();
            expect(idsOf(w.done.getState().rows)).toEqual(want(completed));
            if (!w.found.getState().changed) {
              expect(idsOf(w.found.getState().rows)).toEqual(want(search));
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** The model's visible completed tasks at its head (not in the open working set). */
function completedAt(model: FeedModel) {
  return [...model.state.rows.values()]
    .filter(
      (r) =>
        r.type === "task" &&
        !r.hidden &&
        r.fields["deleted_at"] === undefined &&
        r.fields["lifecycle"] === "completed",
    )
    .map((r) => r.fields);
}
