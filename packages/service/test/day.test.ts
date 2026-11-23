// An agent's status and digest against the table the page's Today is tested with (day-cases.ts):
// the same tasks in Today and in the week, in the same order, the same counts and the same stars.
// Against a real space in this thread, through the request path. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SpaceStatusResult, TaskGetResult } from "@ttasks/contracts";
import {
  DAY_CASES,
  DAY_CLOCK,
  DAY_COUNTS,
  DAY_STARRED,
  DAY_TODAY,
  DAY_WEEK,
} from "@ttasks/contracts/day-cases";
import { newId, type Operation } from "@ttasks/storage";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
/** The writer's clock: each case is created a moment after the one before it. */
let clock = DAY_CLOCK.now - 3_600_000;
/** The counts before the cases: the fixture's own tasks. */
let before: ReturnType<typeof SpaceStatusResult.parse>["counts"];

const host = (): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    { id: fx.spaceId, name: "Mira", state: "open", writer: undefined, reader: readerOf(fx.reader) },
  ],
  now: () => DAY_CLOCK.now,
  timeZone: () => DAY_CLOCK.timeZone,
});
const agent: Caller = { class: "cli-script", env: {} };
const call = async (op: string, input: Record<string, unknown>) =>
  opCall(host(), agent, { op, input });
const status = async (include: string[] = []) =>
  SpaceStatusResult.parse(await call("space.status", { include }));

const title = (name: string) => `Fixture ${name}`;
/** Each case's task ID, by its name. */
const ids = new Map<string, string>();

beforeAll(async () => {
  temp = tempRoot("day");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
  fx.reopen({ now: () => clock });
  before = (await status()).counts;
  for (const c of DAY_CASES) {
    clock += 1000;
    const id = newId("t");
    ids.set(c.name, id);
    const op: Operation = {
      kind: "task.create",
      id,
      title: title(c.name),
      area: fx.areas.home,
      status: c.status,
      inbox: c.inbox === true,
      ...(c.priority === undefined ? {} : { priority: c.priority }),
      ...(c.due_date === undefined ? {} : { due: { date: c.due_date } }),
      ...(c.due_at === undefined ? {} : { due: { at: c.due_at, tz: DAY_CLOCK.timeZone } }),
      ...(c.planned_for === undefined ? {} : { planned_for: c.planned_for }),
      ...(c.focus_on === undefined ? {} : { focus: c.focus_on }),
    };
    const result = fx.writer.submit(fx.request(fx.human, [op], { base: fx.base() }));
    if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
  }
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

describe("[A5.3.4.day.one-rule] an agent's day follows the page's rule", () => {
  test("today and week hold the page's tasks, in the page's order", async () => {
    const { sections } = await status(["today", "week"]);
    const [today, week] = sections ?? [];
    // A section lists 8 rows and counts the rest.
    expect(today?.tasks.map((t) => t.title)).toEqual(DAY_TODAY.slice(0, 8).map(title));
    expect(today?.total).toBe(DAY_TODAY.length);
    expect(week?.tasks.map((t) => t.title)).toEqual(DAY_WEEK.map(title));
    expect(week?.total).toBe(DAY_WEEK.length);
  });

  test("each active task counts once: the Inbox by its flag, else its status", async () => {
    const { counts } = await status();
    const of = (c: typeof counts, status: string) =>
      c.statuses.find((s) => s.status === status)?.count ?? 0;
    expect(counts.inbox - before.inbox).toBe(DAY_COUNTS.inbox);
    for (const key of ["open", "waiting", "review", "backlog"] as const) {
      expect(of(counts, key) - of(before, key), key).toBe(DAY_COUNTS[key]);
    }
  });

  test("the digest's focus is the page's star, which carries over until it is cleared", async () => {
    for (const { name } of DAY_CASES) {
      const read = TaskGetResult.parse(await call("task.get", { task: ids.get(name) }));
      expect(read.view === "digest" && read.task.focus, name).toBe(
        (DAY_STARRED as readonly string[]).includes(name),
      );
    }
  });
});
