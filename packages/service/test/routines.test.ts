// Routines a person does, through the request path on a tree space: a service in this process
// whose storage worker decides by a clock the test moves (clock-worker.ts), callers of the
// person's and an agent's class, the feed read after each change, and fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, findEntry } from "@ttasks/contracts";
import {
  CheckedDriver,
  createSpace,
  DEFAULT_DRIVER,
  loadDriver,
  StorageWorker,
  type WorkerConnection,
} from "@ttasks/storage";
import { startService, type RunningService } from "../src/hub/service.ts";
import { readBatch, readSnapshot } from "../src/http/feed.ts";
import type { CompactRow } from "../src/ops/task-rows.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { classSession } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

const USER: Caller = { class: "cli-interactive", env: {} };
const AGENT: Caller = { class: "cli-script", env: {} };
const ZONE = "Europe/Amsterdam";

/** 10:00 in Amsterdam on a day of December 2026, or of January 2027 past the 31st. */
const day = (n: number): number =>
  n > 31
    ? Date.parse(`2027-01-${String(n - 31).padStart(2, "0")}T10:00:00+01:00`)
    : Date.parse(`2026-12-${String(n).padStart(2, "0")}T10:00:00+01:00`);

const clock = new SharedArrayBuffer(8);
const now = new Float64Array(clock);
now[0] = day(2);
/**
 * The writer's clock: Wednesday 2 December 2026 is day 2, and 2 January 2027 day 33. It only moves
 * on (the writer's own rule), so each test starts after the one before.
 */
const on = (n: number): void => {
  now[0] = day(n);
};

let service: RunningService;
let cleanup: () => void;
let tree: string;
let today: string;
let reader: WorkerConnection;

beforeAll(async () => {
  const temp = tempRoot("routines");
  cleanup = temp.cleanup;
  const home = join(temp.root, "h");
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
    spaceOptions: {
      startWorker: () =>
        StorageWorker.start({
          driver: DEFAULT_DRIVER,
          entry: new URL("./clock-worker.ts", import.meta.url),
          clock,
        }),
    },
  });
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const person = await classSession(home, service.endpoint.path, "cli-interactive");
  mkdirSync(join(temp.root, "s"), { recursive: true });
  const open = async (name: string, isTree: boolean) => {
    const folder = join(temp.root, "s", name.toLowerCase());
    createSpace(checked, folder, {
      name,
      refPrefix: "M",
      machineId: service.ops.machine.id as `m_${string}`,
      ownerLabel: "user",
      ...(isTree ? { tree: true } : {}),
    });
    const opened = (await person.call("space/open", { path: folder })) as { space: { id: string } };
    return opened.space.id;
  };
  try {
    tree = await open("Mira", true);
    today = await open("Okafor", false);
  } finally {
    person.close();
  }
  const served = service.ops.spaces().find((s) => s.id === tree)?.reader;
  if (served === undefined) throw new Error("the tree space is not served");
  reader = served;
}, 120_000);

afterAll(async () => {
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
});

let n = 0;
const rid = () => `fixture-routines-${String((n += 1)).padStart(6, "0")}`;

type Json = Record<string, unknown>;
/** The as_of of the last answer from the tree space: what the caller saw. */
let seen: string | undefined;
const call = async (op: string, input: Json, who = USER, space = tree): Promise<Json> => {
  const entry = findEntry(op);
  const writes = entry?.kind === "write";
  const answer = (await opCall(service.ops, who, {
    op,
    space,
    input: {
      ...input,
      ...(writes && input["request_id"] === undefined ? { request_id: rid() } : {}),
    },
  })) as Json;
  if (space === tree && typeof answer["as_of"] === "string") seen = answer["as_of"];
  return answer;
};
const refused = async (op: string, input: Json, who = USER, space = tree): Promise<AppError> => {
  try {
    await call(op, input, who, space);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error(`${op} was not refused`);
};
const manage = (action: string, input: Json = {}) =>
  call("routine.manage", { action, ...input, ...(action === "make" ? {} : { base: seen }) });

interface Said {
  action: string;
  result: string;
  routine: {
    ref: string;
    state: string;
    next: { date: string };
    entries: number;
    repeat: string;
    last?: Json;
  };
}
const said = async (action: string, input: Json = {}): Promise<Said["routine"]> => {
  const answer = await manage(action, input);
  expect(findEntry("routine.manage")?.output.safeParse(answer).success).toBe(true);
  return (answer as unknown as Said).routine;
};

/** The feed, followed from a snapshot by its batches, against a fresh snapshot after each change. */
const feed = {
  cursor: 0,
  built: new Map<string, CompactRow>(),
  async start() {
    const snapshot = await readSnapshot(reader);
    this.cursor = snapshot.cursor.seq;
    this.built = new Map((snapshot.routines ?? []).map((r) => [r["id"] as string, r]));
  },
  /** The routines' rows as the batches built them: those a fresh snapshot sends. */
  async caughtUp(): Promise<CompactRow[]> {
    for (;;) {
      const { head, batch } = await readBatch(reader, this.cursor);
      for (const event of batch.events) {
        for (const entity of event.entities) {
          if (entity.type !== "routine") continue;
          const row = entity.row;
          if (row === null) throw new Error("a routine's row was withheld in a quiet space");
          if (row["deleted_at"] !== undefined || row["lifecycle"] !== "active") {
            this.built.delete(entity.id);
          } else this.built.set(entity.id, row);
        }
      }
      this.cursor = batch.through;
      if (this.cursor >= head.cursor.seq) break;
    }
    const byId = (rows: Iterable<CompactRow>) =>
      [...rows].sort((a, b) => (a["id"] as string).localeCompare(b["id"] as string));
    const fresh = byId((await readSnapshot(reader)).routines ?? []);
    expect(byId(this.built.values())).toEqual(fresh);
    return fresh;
  },
};

describe("[S2.tree.routines.service] a routine a person does, through the request path on a tree space", () => {
  test("the weekly chore's month: a week away, an early Done, two missed Saturdays, Skip, Undo, a later change that keeps Undo back, Pause, Finish, the Trash", async () => {
    on(2);
    await feed.start();
    const made = await said("make", {
      title: "Fixture water the plants",
      rule: "FREQ=WEEKLY;BYDAY=SA",
      tz: ZONE,
    });
    const ref = made.ref;
    expect(made).toMatchObject({
      state: "active",
      next: { date: "2026-12-05" },
      entries: 0,
      repeat: "Every Saturday",
    });
    const [row] = await feed.caughtUp();
    expect(row).toMatchObject({ kind: "routine", ref, due_date: "2026-12-05", paused: false });

    // Watered on Friday: Saturday's time is done, and the next Saturday shows.
    on(4);
    expect(await said("done", { routine: ref })).toMatchObject({
      next: { date: "2026-12-12" },
      entries: 1,
      last: { state: "done", due: { date: "2026-12-05" } },
    });
    await feed.caughtUp();

    // Away for a week and more: the 12th and the 19th pass unchecked, and stay one open time.
    on(20);
    const away = await call("task.get", { task: ref }, AGENT);
    expect(findEntry("task.get")?.output.safeParse(away).success).toBe(true);
    expect(away).toMatchObject({
      view: "routine",
      routine: { ref, repeat: "Every Saturday", next: { date: "2026-12-12" }, entries: 1 },
      history: [{ state: "done", due: { date: "2026-12-05" }, by: "user" }],
    });
    expect(String(away["say"])).toContain("Every Saturday");
    expect(await said("done", { routine: ref })).toMatchObject({
      next: { date: "2026-12-26" },
      entries: 2,
    });
    await feed.caughtUp();

    // Skipped on the day, and that Skip undone: the time is open again.
    on(26);
    expect(await said("skip", { routine: ref })).toMatchObject({
      next: { date: "2027-01-02" },
      last: { state: "skipped", why: "you" },
    });
    expect(await call("history.undo", {})).toMatchObject({ result: "undone" });
    const back = await call("task.get", { task: ref });
    expect(back).toMatchObject({ routine: { next: { date: "2026-12-26" }, entries: 2 } });
    await feed.caughtUp();

    // Done, then its schedule changes: the Undo of that Done is kept back.
    expect(await said("done", { routine: ref })).toMatchObject({ next: { date: "2027-01-02" } });
    await said("change", { routine: ref, rule: "FREQ=WEEKLY;BYDAY=SU" });
    const kept = await call("history.undo", {});
    expect(kept).toMatchObject({ result: "kept" });
    expect(await call("task.get", { task: ref })).toMatchObject({
      routine: { repeat: "Every Sunday", entries: 3 },
    });
    await feed.caughtUp();

    // Paused, it leaves the open times; resumed, it starts at the next time after now.
    on(36);
    expect(await said("pause", { routine: ref })).toMatchObject({ state: "paused" });
    expect((await feed.caughtUp())[0]).toMatchObject({ paused: true });
    on(40);
    expect(await said("resume", { routine: ref })).toMatchObject({
      state: "active",
      next: { date: "2027-01-10" },
    });
    await feed.caughtUp();

    // An extra time is logged without a due time and leaves the open time.
    expect(await said("extra", { routine: ref })).toMatchObject({
      next: { date: "2027-01-10" },
      entries: 4,
      last: { state: "done" },
    });
    expect((await said("extra", { routine: ref })).last?.["due"]).toBeUndefined();

    // Finished for good: it leaves the feed's routines, and Undo brings it back.
    expect(await said("finish", { routine: ref })).toMatchObject({ state: "finished" });
    expect(await feed.caughtUp()).toEqual([]);
    expect(await said("done", { routine: ref }).catch((e: unknown) => e)).toMatchObject({
      code: "conflict",
    });
    expect(await call("history.undo", {})).toMatchObject({ result: "undone" });
    expect((await feed.caughtUp())[0]).toMatchObject({ ref, lifecycle: "active" });

    // The Trash pauses it, and Restore brings it back paused.
    await call("task.delete", { tasks: [ref], base: seen });
    expect(await feed.caughtUp()).toEqual([]);
    await call("task.delete", { tasks: [ref], restore: true, base: seen });
    expect((await feed.caughtUp())[0]).toMatchObject({ ref, paused: true });
    expect(await said("resume", { routine: ref })).toMatchObject({ state: "active" });
    await feed.caughtUp();
  });

  test("a routine is made in the project the person names", async () => {
    on(42);
    await feed.start();
    await call("task.add", { tasks: [{ title: "Fixture fix the gate", area: "Fixture home" }] });
    const nodes = (await readSnapshot(reader)).nodes;
    const home = nodes.find((node) => node.title === "Fixture home")?.id;
    const made = await said("make", {
      title: "Fixture take out the bins",
      rule: "FREQ=WEEKLY;BYDAY=TU",
      tz: ZONE,
      under: home,
    });
    const rows = await feed.caughtUp();
    expect(rows.find((r) => r["ref"] === made.ref)).toMatchObject({ parent: home });
  });

  test("an agent makes a routine you do with repeat, turns a task into one, changes and pauses it", async () => {
    on(44);
    await feed.start();
    const added = (await call(
      "task.add",
      { tasks: [{ title: "Fixture send the weekly report", repeat: "every friday" }] },
      AGENT,
    )) as { tasks: Json[] };
    expect(findEntry("task.add")?.output.safeParse(added).success).toBe(true);
    expect(added.tasks[0]).toMatchObject({ result: "created", repeats: "Every Friday" });
    const report = String(added.tasks[0]?.["ref"]);
    expect(await call("task.get", { task: report }, AGENT)).toMatchObject({
      routine: { next: { date: "2027-01-15" } },
    });

    const plain = (await call("task.add", { tasks: [{ title: "Fixture back up the photos" }] }))[
      "tasks"
    ] as Json[];
    const photos = String(plain[0]?.["ref"]);
    await call("entry.add", { task: photos, kind: "note", text: "Fixture: the blue drive." });
    expect(
      await call(
        "task.update",
        { task: photos, repeat: "the first monday of every month", base: seen },
        AGENT,
      ),
    ).toMatchObject({ result: "updated", task: photos, fields: ["repeat"] });
    expect(await call("task.get", { task: photos }, AGENT)).toMatchObject({
      view: "routine",
      routine: {
        ref: photos,
        repeat: "The first Monday of every month",
        next: { date: "2027-02-01" },
      },
    });
    expect(
      await call("task.update", { task: report, repeat: "every thursday", base: seen }, AGENT),
    ).toMatchObject({
      result: "updated",
    });
    expect(
      await call("task.update", { task: report, repeat: "", base: seen }, AGENT),
    ).toMatchObject({
      result: "updated",
    });
    expect(await call("task.get", { task: report }, AGENT)).toMatchObject({
      routine: { repeat: "Every Thursday", state: "paused" },
    });
    await feed.caughtUp();

    // What an agent may not do with a routine is refused by name.
    expect(
      await refused(
        "task.add",
        { tasks: [{ title: "Fixture a", repeat: "every day" }, { title: "Fixture b" }] },
        AGENT,
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await refused("task.add", { tasks: [{ title: "Fixture c", repeat: "now and then" }] }, AGENT),
    ).toMatchObject({ code: "invalid_input" });
    const nowhere = { title: "Fixture d", repeat: "every day", project: "Fixture nowhere" };
    expect(await refused("task.add", { tasks: [nowhere] }, AGENT)).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.0.project" }] },
    });
    expect(
      await refused("routine.manage", { action: "done", routine: report }, AGENT),
    ).toMatchObject({ code: "forbidden" });
  });

  test("a space on today's storage refuses a routine's calls in one plain sentence", async () => {
    for (const [op, input] of [
      ["routine.manage", { action: "make", title: "Fixture a", rule: "FREQ=DAILY", tz: ZONE }],
      ["task.add", { tasks: [{ title: "Fixture b", repeat: "every day" }] }],
    ] as const) {
      const error = await refused(op, input, USER, today);
      expect(error.code).toBe("op_unknown");
      expect(error.message).toBe(
        "Routines work only on a space on the new storage, and this one is on today's.",
      );
    }
  });
});
