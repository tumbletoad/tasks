// When a waiting task's wait began, as its compact row says it (the Waiting view's age), across an
// undo: the wait an undo brings back keeps the day it began. Against a real space in this thread,
// with the writer's clock set per request. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, type Id, type Operation } from "@tasks/storage";
import { writeFixture, type Fixture } from "@tasks/storage/write-helpers";
import { readSnapshot } from "../src/http/feed.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
const DAY = 86_400_000;
/**
 * Monday 09:00 UTC of a week after the fixture's writes, one week per test: the writer's commit
 * times only move forward.
 */
const mondayOf = (week: number): number => {
  const day = new Date(Date.now() + 7 * (week + 1) * DAY);
  day.setUTCHours(9, 0, 0, 0);
  return day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY;
};
let clock = mondayOf(0) - DAY;

beforeAll(async () => {
  temp = tempRoot("waiting-since");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
  fx.reopen({ now: () => clock });
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

/** The person's own change at `at`, on their undo stack; an undo carries no base. */
function submit(ops: Operation[], at: number): void {
  clock = at;
  const undo = ops.some((op) => op.kind === "undo");
  const result = fx.writer.submit(
    fx.request(fx.human, ops, undo ? {} : { base: fx.base(), undoable: true }),
  );
  if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
}

const rowOf = async (id: string) =>
  (await readSnapshot(readerOf(fx.reader))).tasks.find((t) => t["id"] === id);

describe("[A5.3.5.service.waiting-undo] a wait an undo brings back keeps the day it began", () => {
  test("waiting since Monday, out of waiting on Wednesday, undone on Thursday: still Monday", async () => {
    const MONDAY = mondayOf(0);
    const [WEDNESDAY, THURSDAY] = [MONDAY + 2 * DAY, MONDAY + 3 * DAY];
    const task = newId("t");
    submit(
      [{ kind: "task.create", id: task, title: "Fixture waits", area: fx.areas.home }],
      MONDAY - DAY,
    );
    submit(
      [{ kind: "task.patch", task, set: { status: "waiting", waiting_on: "Fixture One" } }],
      MONDAY,
    );
    expect((await rowOf(task))?.["waiting_since"]).toBe(MONDAY);
    submit([{ kind: "task.patch", task, set: { status: "open" } }], WEDNESDAY);
    expect(await rowOf(task)).not.toHaveProperty("waiting_since");
    submit([{ kind: "undo" }], THURSDAY);
    expect((await rowOf(task))?.["waiting_since"]).toBe(MONDAY);
  });

  test("a task made waiting keeps its creation as the start when an undo brings the wait back", async () => {
    const MONDAY = mondayOf(1);
    const [WEDNESDAY, THURSDAY] = [MONDAY + 2 * DAY, MONDAY + 3 * DAY];
    const task: Id<"t"> = newId("t");
    submit(
      [
        {
          kind: "task.create",
          id: task,
          title: "Fixture waits from the start",
          status: "waiting",
          waiting_on: "Fixture Two",
          area: fx.areas.home,
        },
      ],
      MONDAY,
    );
    submit([{ kind: "task.patch", task, set: { status: "open" } }], WEDNESDAY);
    submit([{ kind: "undo" }], THURSDAY);
    expect((await rowOf(task))?.["waiting_since"]).toBe(MONDAY);
  });
});
