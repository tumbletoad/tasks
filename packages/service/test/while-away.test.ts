// What the page's snapshot tells a person who comes back: the tasks agents changed in the last
// seven days, newest first, with who changed each last and when, and on a task's row the
// question an agent asked that still waits for the person. Against a real space in this thread,
// with the writer's clock set per request. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, type Credential, type Id, type Operation } from "@ttasks/storage";
import { writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { MACHINE } from "@ttasks/storage/write-helpers";
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

describe("[A5.while-away.service.question] an agent's question waits on its task's row", () => {
  test("until the person's note after it or their dismissal; an undo of that brings it back, a new question comes back, and the feed carries the row", async () => {
    let at = START + 20 * DAY;
    const next = () => (at += 60_000);
    const task = newId("t");
    const rowOf = async () =>
      (await readSnapshot(readerOf(fx.reader), undefined, at)).tasks.find((t) => t["id"] === task);
    submit(
      fx.human,
      [{ kind: "task.create", id: task, title: "Fixture asks", area: fx.areas.home }],
      next(),
    );
    // The person's own question and an agent's progress wait for nobody.
    submit(
      fx.human,
      [{ kind: "log.add", task, body: "Fixture mine?", log_kind: "question" }],
      next(),
    );
    submit(fx.codex, [{ kind: "log.add", task, body: "Fixture progress" }], next());
    expect(await rowOf()).not.toHaveProperty("question");

    const head = (await readSnapshot(readerOf(fx.reader), undefined, at)).cursor.seq;
    const asked = next();
    submit(
      fx.codex,
      [{ kind: "log.add", task, body: "Fixture which one?", log_kind: "question" }],
      asked,
    );
    expect((await rowOf())?.["question"]).toEqual({
      ref: "l3",
      by: "Codex · work",
      text: "Fixture which one?",
      at: asked,
    });
    // The batch of the question carries the task's row with it.
    const { batch } = await readBatch(readerOf(fx.reader), head);
    const carried = batch.events.at(-1)?.entities.find((e) => e.type === "task" && e.id === task);
    expect(carried?.row?.["question"]).toMatchObject({ ref: "l3" });

    // An agent's note answers nothing; the person's does.
    submit(fx.claude, [{ kind: "note.add", task, body: "Fixture agent note" }], next());
    expect((await rowOf())?.["question"]).toMatchObject({ ref: "l3" });
    submit(fx.human, [{ kind: "note.add", task, body: "Fixture answer" }], next());
    expect(await rowOf()).not.toHaveProperty("question");

    // A later question waits again; the person dismisses it, and Undo brings it back.
    submit(
      fx.codex,
      [{ kind: "log.add", task, body: "Fixture and now?", log_kind: "question" }],
      next(),
    );
    expect((await rowOf())?.["question"]).toMatchObject({ ref: "l4" });
    submit(fx.human, [{ kind: "task.patch", task, set: { reviewed_at: next() } }], at);
    expect(await rowOf()).not.toHaveProperty("question");
    submit(fx.human, [{ kind: "undo" }], next());
    expect((await rowOf())?.["question"]).toMatchObject({ ref: "l4" });
    submit(fx.human, [{ kind: "task.patch", task, set: { reviewed_at: next() } }], at);
    submit(
      fx.claude,
      [{ kind: "log.add", task, body: "Fixture one more?", log_kind: "question" }],
      next(),
    );
    expect((await rowOf())?.["question"]).toMatchObject({ ref: "l5", by: "Claude Code · work" });
  });
});

describe("[A5.while-away.service.reads] a waiting question breaks no read of task rows", () => {
  test("the views' snapshot, Completed, search, status and a task's read, with one on an active, a completed and a dropped task", async () => {
    let at = START + 40 * DAY;
    const next = () => (at += 60_000);
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

    const host: OpsHost = {
      machine: { id: MACHINE.id },
      spaces: () => [
        {
          id: fx.spaceId,
          name: "Mira",
          state: "open",
          writer: undefined,
          reader: readerOf(fx.reader),
        },
      ],
      now: () => at,
      timeZone: () => "Europe/Lisbon",
    };
    const user: Caller = { class: "cli-interactive", env: {} };
    const call = (op: string, input: Record<string, unknown>) => opCall(host, user, { op, input });

    const snapshot = await readSnapshot(readerOf(fx.reader), undefined, at);
    expect(snapshot.tasks.find((t) => t["id"] === active)?.["question"]).toMatchObject({
      text: "Fixture which way?",
    });
    const completed = (await call("task.finished", { checked_off: true })) as {
      rows: Record<string, unknown>[];
    };
    const other = (await call("task.finished", { checked_off: false })) as {
      rows: Record<string, unknown>[];
    };
    expect(completed.rows.find((r) => r["id"] === done)?.["question"]).toMatchObject({
      text: "Fixture which way?",
    });
    expect(other.rows.find((r) => r["id"] === dropped)?.["question"]).toMatchObject({
      text: "Fixture which way?",
    });
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
