// What the page's snapshot tells a person who comes back: the tasks agents changed in the last
// seven days, newest first, with who changed each last and when, and on a task's row the
// question an agent asked that still waits for the person. Against a real space in this thread,
// with the writer's clock set per request. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError } from "@ttasks/contracts";
import {
  newId,
  type Credential,
  type Id,
  type Operation,
  type ReceiptLookup,
  type SpaceWriterHandle,
  type WriteRequest,
} from "@ttasks/storage";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { readBatch, readSnapshot } from "../src/http/feed.ts";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
const DAY = 86_400_000;
/** A week after the fixture's own writes: the writer's commit times only move forward. */
const START = Date.now() + 7 * DAY;
let clock = START;

beforeAll(async () => {
  temp = tempRoot("while-away");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
  fx.reopen({ now: () => clock });
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

/** The service's request path over the fixture's writer, at the writer's clock. */
const host = (): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    {
      id: fx.spaceId,
      name: "Mira",
      state: "open",
      writer: {
        spaceId: fx.spaceId,
        submit: (request: WriteRequest) => Promise.resolve(fx.writer.submit(request)),
        receipt: (lookup: ReceiptLookup) => Promise.resolve(fx.writer.receipt(lookup)),
        actor: (kind: "human" | "agent", label: string) =>
          Promise.resolve(fx.writer.actor(kind, label)),
      } as unknown as SpaceWriterHandle,
      reader: readerOf(fx.reader),
    },
  ],
  now: () => clock,
  timeZone: () => "Europe/Lisbon",
});
const PERSON: Caller = { class: "cli-interactive", env: {} };
let n = 0;
const rid = () => `fixture-away-${String((n += 1)).padStart(6, "0")}`;
const call = (op: string, input: Record<string, unknown>) =>
  opCall(host(), PERSON, { op, input }) as Promise<Record<string, unknown>>;

/** `ops` as `actor` at `at`; the person's change goes on their undo stack, and an undo has no base. */
function submit(actor: Credential, ops: Operation[], at: number): void {
  clock = at;
  const undo = ops.some((op) => op.kind === "undo");
  const own = actor === fx.human && !undo ? { undoable: true } : {};
  const result = fx.writer.submit(fx.request(actor, ops, undo ? {} : { base: fx.base(), ...own }));
  if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
}

describe("[A5.while-away.service.recent] a snapshot holds the tasks agents changed lately", () => {
  test("newest first, each with its last agent and when; not the person's own, a deleted one or one older than a week", async () => {
    const [mine, logged, finished, old, deleted] = [
      newId("t"),
      newId("t"),
      newId("t"),
      newId("t"),
      newId("t"),
    ];
    const create = (id: Id<"t">, title: string): Operation => ({
      kind: "task.create",
      id,
      title,
      area: fx.areas.home,
    });
    submit(
      fx.human,
      [
        create(mine, "Fixture mine"),
        create(logged, "Fixture logged"),
        create(old, "Fixture old"),
        create(deleted, "Fixture deleted"),
      ],
      START,
    );
    submit(fx.codex, [{ kind: "log.add", task: old, body: "Fixture early" }], START + DAY);
    const now = START + 10 * DAY;
    submit(fx.codex, [{ kind: "log.add", task: logged, body: "Fixture one" }], now - 3 * DAY);
    submit(fx.claude, [create(finished, "Fixture finished")], now - 2 * DAY);
    submit(fx.codex, [{ kind: "log.add", task: deleted, body: "Fixture two" }], now - 2 * DAY);
    submit(fx.human, [{ kind: "task.delete", task: deleted }], now - 2 * DAY);
    submit(fx.claude, [{ kind: "task.complete", task: finished }], now - DAY);
    // The person's later change leaves the agent's in place.
    submit(fx.human, [{ kind: "task.patch", task: logged, set: { priority: 1 } }], now - DAY);
    submit(fx.human, [{ kind: "task.patch", task: mine, set: { priority: 2 } }], now);

    const snapshot = await readSnapshot(readerOf(fx.reader), undefined, now);
    expect(snapshot.agent_changes.map(({ task, actor, at }) => ({ task, actor, at }))).toEqual([
      { task: finished, actor: "Claude Code · work", at: now - DAY },
      { task: logged, actor: "Codex · work", at: now - 3 * DAY },
    ]);
    // The finished task is in no open row: its change brings its row.
    expect(snapshot.agent_changes[0]?.row).toMatchObject({ id: finished, lifecycle: "completed" });
    expect(snapshot.agent_changes[1]?.row).toBeUndefined();
    // Read a week later, nothing is that recent.
    expect(
      (await readSnapshot(readerOf(fx.reader), undefined, now + 8 * DAY)).agent_changes,
    ).toEqual([]);
  });
});

describe("[A5.while-away.service.question] the questions agents asked wait on their task's row", () => {
  /** A fresh task of the person's, with what its row says now. */
  function asking() {
    const task = newId("t");
    const next = () => (clock += 60_000);
    submit(
      fx.human,
      [{ kind: "task.create", id: task, title: "Fixture asks", area: fx.areas.home }],
      next(),
    );
    const row = async () =>
      (await readSnapshot(readerOf(fx.reader), undefined, clock)).tasks.find(
        (t) => t["id"] === task,
      );
    return {
      task,
      next,
      ask: (actor: Credential, body: string) => {
        submit(actor, [{ kind: "log.add", task, body, log_kind: "question" }], next());
      },
      row,
      refs: async () =>
        (((await row())?.["questions"] ?? []) as readonly { ref: string }[]).map((q) => q.ref),
    };
  }

  test("each waits, newest first, until the person's note after it: not the person's own question, nor one an agent's note follows", async () => {
    const { task, ask, row, refs, next } = asking();
    ask(fx.human, "Fixture mine?");
    submit(fx.codex, [{ kind: "log.add", task, body: "Fixture progress" }], next());
    expect(await row()).not.toHaveProperty("questions");

    const head = (await readSnapshot(readerOf(fx.reader), undefined, clock)).cursor.seq;
    ask(fx.codex, "Fixture which one?");
    const asked = clock;
    ask(fx.claude, "Fixture and which day?");
    expect((await row())?.["questions"]).toEqual([
      { ref: "l4", by: "Claude Code · work", text: "Fixture and which day?", at: clock },
      { ref: "l3", by: "Codex · work", text: "Fixture which one?", at: asked },
    ]);
    // The batch of a question carries the task's row with it.
    const { batch } = await readBatch(readerOf(fx.reader), head);
    const carried = batch.events.at(-1)?.entities.find((e) => e.type === "task" && e.id === task);
    expect(carried?.row?.["questions"]).toHaveLength(2);

    submit(fx.claude, [{ kind: "note.add", task, body: "Fixture agent note" }], next());
    expect(await refs()).toEqual(["l4", "l3"]);
    // The person's note answers every question before it, and none after it.
    submit(fx.human, [{ kind: "note.add", task, body: "Fixture answer" }], next());
    expect(await row()).not.toHaveProperty("questions");
    ask(fx.codex, "Fixture and now?");
    expect(await refs()).toEqual(["l5"]);
  });

  test("[A3.note.retract.question] a note the person takes back answers nothing: the question waits again, and put back it is answered", async () => {
    const { task, ask, refs, next } = asking();
    ask(fx.codex, "Fixture which one?");
    submit(fx.human, [{ kind: "note.add", task, body: "Fixture answer" }], next());
    expect(await refs()).toEqual([]);
    submit(fx.human, [{ kind: "note.delete", task, ordinal: 1 }], next());
    expect(await refs()).toEqual(["l1"]);
    submit(fx.human, [{ kind: "note.restore", task, ordinal: 1 }], next());
    expect(await refs()).toEqual([]);
  });

  test("Dismiss sets aside the question it names and those before it; one asked after it still waits, an Undo brings them back, and the answer names the field", async () => {
    const { task, ask, refs } = asking();
    ask(fx.codex, "Fixture first?");
    ask(fx.codex, "Fixture second?");
    // The person saw l1; l2 arrived before their Dismiss did.
    const dismissed = await call("task.update", {
      task,
      set: { reviewed: "l1" },
      request_id: rid(),
    });
    expect(dismissed).toMatchObject({ result: "updated", fields: ["reviewed"] });
    expect(await refs()).toEqual(["l2"]);
    // A stale Dismiss of l1 from another tab takes nothing back.
    await call("task.update", { task, set: { reviewed: "l1" }, request_id: rid() });
    expect(await refs()).toEqual(["l2"]);
    await call("task.update", { task, set: { reviewed: "l2" }, request_id: rid() });
    expect(await refs()).toEqual([]);
    await call("history.undo", { request_id: rid() });
    expect(await refs()).toEqual(["l2"]);
    // An entry that is no question of the task is refused and changes nothing.
    const refused: unknown = await call("task.update", {
      task,
      set: { reviewed: "l9" },
      request_id: rid(),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).toBody().code).toBe("invalid_input");
    expect(await refs()).toEqual(["l2"]);
  });

  test("a question that arrived in the same millisecond after the one dismissed still waits", async () => {
    const { task, refs, next } = asking();
    submit(
      fx.codex,
      [{ kind: "log.add", task, body: "Fixture one?", log_kind: "question" }],
      next(),
    );
    submit(
      fx.claude,
      [{ kind: "log.add", task, body: "Fixture two?", log_kind: "question" }],
      clock,
    );
    await call("task.update", { task, set: { reviewed: "l1" }, request_id: rid() });
    expect(await refs()).toEqual(["l2", "l1"]);
    await call("task.update", { task, set: { reviewed: "l2" }, request_id: rid() });
    expect(await refs()).toEqual([]);
  });

  test("a question asked after a Dismiss waits even when the clock has not moved since the one dismissed", async () => {
    const { task, refs, next } = asking();
    submit(
      fx.codex,
      [{ kind: "log.add", task, body: "Fixture one?", log_kind: "question" }],
      next(),
    );
    await call("task.update", { task, set: { reviewed: "l1" }, request_id: rid() });
    expect(await refs()).toEqual([]);
    submit(
      fx.claude,
      [{ kind: "log.add", task, body: "Fixture two?", log_kind: "question" }],
      clock,
    );
    expect(await refs()).toEqual(["l2"]);
  });

  test("a Dismiss sent together with another field keeps that field's own check against a newer value", async () => {
    const { task, ask, refs } = asking();
    ask(fx.codex, "Fixture which?");
    const alone = async (set: Record<string, unknown>) =>
      call("task.update", { task, set, request_id: rid() }).then(
        () => "updated",
        (e: unknown) => (e as AppError).toBody().code,
      );
    // Whatever a title sent without a base answers, the same title with a Dismiss answers too.
    const title = await alone({ title: "Fixture renamed without a base" });
    const both = await alone({ title: "Fixture renamed again", reviewed: "l1" });
    expect(both).toBe(title);
    if (both !== "updated") expect(await refs()).toEqual(["l1"]);
  });

  test("on a completed or dropped task they wait too: the snapshot brings its row, and Dismiss works there", async () => {
    for (const end of ["task.complete", "task.archive"] as const) {
      const { task, ask, next } = asking();
      ask(fx.codex, "Fixture after the end?");
      submit(fx.human, [{ kind: end, task }], next());
      // A month on, long out of the recent changes.
      const shown = async () =>
        (await readSnapshot(readerOf(fx.reader), undefined, clock + 30 * DAY)).asking.find(
          (r) => r["id"] === task,
        );
      expect((await shown())?.["questions"]).toMatchObject([{ ref: "l1" }]);
      ask(fx.claude, "Fixture still there?");
      expect((await shown())?.["questions"]).toMatchObject([{ ref: "l2" }, { ref: "l1" }]);
      await expect(
        call("task.update", { task, set: { reviewed: "l2" }, request_id: rid() }),
      ).resolves.toMatchObject({ result: "updated", fields: ["reviewed"] });
      expect(await shown()).toBeUndefined();
    }
  });

  test("a row carries ten, newest first, counts the rest, and cuts each at 300 characters", async () => {
    const { task, row, next } = asking();
    const long = `${"x".repeat(298)}\u{1F600}\u{1F600} and more`;
    submit(
      fx.codex,
      Array.from({ length: 12 }, (_, k): Operation => ({
        kind: "log.add",
        task,
        body: k === 11 ? long : `Fixture ${String(k)}?`,
        log_kind: "question",
      })),
      next(),
    );
    const read = await row();
    const questions = read?.["questions"] as readonly { ref: string; text: string }[];
    expect(questions.map((q) => q.ref)).toEqual(
      Array.from({ length: 10 }, (_, k) => `l${String(12 - k)}`),
    );
    expect(read?.["questions_more"]).toBe(2);
    expect(questions[0]?.text).toBe(`${"x".repeat(298)}…`);
  });
});

describe("[A5.while-away.service.reads] a waiting question breaks no read of task rows", () => {
  test("the views' snapshot, Completed, search, status and a task's read, with one on an active, a completed and a dropped task", async () => {
    const next = () => (clock += 60_000);
    const [active, done, dropped] = [newId("t"), newId("t"), newId("t")];
    submit(
      fx.human,
      [active, done, dropped].map((id): Operation => ({
        kind: "task.create",
        id,
        title: "Fixture reads",
        area: fx.areas.home,
      })),
      next(),
    );
    for (const task of [active, done, dropped]) {
      submit(
        fx.codex,
        [{ kind: "log.add", task, body: "Fixture which way?", log_kind: "question" }],
        next(),
      );
    }
    // Checked off: Completed's first list.
    submit(fx.human, [{ kind: "task.complete", task: done }], next());
    submit(fx.human, [{ kind: "task.archive", task: dropped }], next());

    const snapshot = await readSnapshot(readerOf(fx.reader), undefined, clock);
    expect(snapshot.tasks.find((t) => t["id"] === active)?.["questions"]).toMatchObject([
      { text: "Fixture which way?" },
    ]);
    expect(snapshot.asking.map((r) => r["id"])).toEqual(expect.arrayContaining([done, dropped]));
    const completed = (await call("task.finished", { checked_off: true })) as {
      rows: Record<string, unknown>[];
    };
    const other = (await call("task.finished", { checked_off: false })) as {
      rows: Record<string, unknown>[];
    };
    expect(completed.rows.find((r) => r["id"] === done)?.["questions"]).toMatchObject([
      { text: "Fixture which way?" },
    ]);
    expect(other.rows.find((r) => r["id"] === dropped)?.["questions"]).toMatchObject([
      { text: "Fixture which way?" },
    ]);
    for (const scope of ["active", "finished", "all"]) {
      await expect(call("task.search", { q: "Fixture reads", scope })).resolves.toMatchObject({
        rows: expect.any(Array) as unknown,
      });
    }
    await expect(
      call("space.status", {
        include: ["today", "week", "review", "waiting", "inbox", "changes"],
      }),
    ).resolves.toMatchObject({ space: expect.any(Object) as unknown });
    for (const task of [active, done, dropped]) {
      await expect(call("task.get", { task })).resolves.toMatchObject({
        task: { id: task },
      });
    }
  });
});

describe("[A5.while-away.service.recent-limits] the recent read is what happened in the week", () => {
  test("a hundred tasks agents changed and the person then deleted take no place of the hundred still there", async () => {
    const at = (clock += DAY);
    const make = (count: number) => Array.from({ length: count }, () => newId("t"));
    const [kept, deleted] = [make(100), make(100)];
    submit(
      fx.human,
      [...kept, ...deleted].map((id): Operation => ({
        kind: "task.create",
        id,
        title: "Fixture many",
        area: fx.areas.home,
      })),
      at,
    );
    for (const list of [kept, deleted]) {
      submit(
        fx.codex,
        list.map((task): Operation => ({ kind: "log.add", task, body: "Fixture touched" })),
        (clock += 60_000),
      );
    }
    submit(
      fx.human,
      deleted.map((task): Operation => ({ kind: "task.delete", task })),
      (clock += 60_000),
    );
    const listed = (await readSnapshot(readerOf(fx.reader), undefined, clock)).agent_changes;
    expect(new Set(listed.map((c) => c.task))).toEqual(new Set(kept));
  });

  test("a change six days back is found behind tens of thousands of later commits", async () => {
    const task = newId("t");
    submit(
      fx.human,
      [{ kind: "task.create", id: task, title: "Fixture behind", area: fx.areas.home }],
      (clock += DAY),
    );
    submit(fx.codex, [{ kind: "log.add", task, body: "Fixture early" }], (clock += 60_000));
    const asked = clock;
    const busy = newId("t");
    submit(
      fx.human,
      [{ kind: "task.create", id: busy, title: "Fixture busy", area: fx.areas.home }],
      clock,
    );
    for (let k = 0; k < 25_000; k += 1) {
      submit(fx.human, [{ kind: "task.patch", task: busy, set: { priority: (k % 4) + 1 } }], clock);
    }
    const listed = (await readSnapshot(readerOf(fx.reader), undefined, asked + 6 * DAY))
      .agent_changes;
    expect(listed.find((c) => c.task === task)).toMatchObject({ at: asked });
  }, 120_000);
});
