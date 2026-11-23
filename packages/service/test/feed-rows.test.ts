// What a task's compact row carries of its children (A5 3.6, A7 3.12 M5.06): its first three
// sources with their own text and URL, how many more it has, and where it opens on this machine,
// in the snapshot and in every batch that changes a source, a link or a folder of it or of its
// project. A real service in this process, real ttasks-local/1 sessions, fixture text and
// temporary folders.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TaskAddResult, TaskGetResult } from "@ttasks/contracts";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import type { RpcSession } from "@ttasks/bridge/protocol";
import type { WorkerConnection } from "@ttasks/storage";
import { startService, type RunningService } from "../src/hub/service.ts";
import { readBatch, readHead, readSnapshot, type FeedHere } from "../src/http/feed.ts";
import { classSession } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

let service: RunningService;
let home: string;
let cleanup: () => void;
let work: string;
let user: RpcSession;
let reader: WorkerConnection;
let here: FeedHere;

let n = 0;
const rid = () => `fixture-feed-row-${String((n += 1)).padStart(6, "0")}`;
const call = (op: string, input: Record<string, unknown>) =>
  user.call("op/call", { op, input }, { timeoutMs: 30_000 });

const source = (i: number) => ({
  kind: "ticket" as const,
  key: `jira:LUM-${String(200 + i)}`,
  title: `Fixture ticket ${String(i)}`,
  who: "Fixture Person",
  url: `https://tickets.example/LUM-${String(200 + i)}`,
});

beforeAll(async () => {
  const temp = tempRoot("feed-rows");
  cleanup = temp.cleanup;
  home = join(temp.root, "h");
  work = join(temp.root, "workrootfeed");
  mkdirSync(join(work, "lumen", "portal"), { recursive: true });
  mkdirSync(join(work, "lumen", "api"), { recursive: true });
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  user = await classSession(home, service.endpoint.path, "cli-interactive");
  await user.call(
    "space/create",
    { name: "Mira", path: join(temp.root, "spaces", "mira"), ref_prefix: "M" },
    { timeoutMs: 60_000 },
  );
  const served = service.ops.spaces().find((s) => s.reader !== undefined)?.reader;
  if (served === undefined) throw new Error("no space is served");
  reader = served;
  here = {
    machine: service.ops.machine.id,
    home: service.ops.home,
    platform: process.platform,
  };
}, 120_000);

afterAll(async () => {
  user.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
});

type Rows = readonly Readonly<Record<string, unknown>>[];
const byTitle = (rows: Rows, title: string) => rows.find((r) => r["title"] === title);

describe("[A5.3.6.http.row-children] a task's row carries its sources and where it opens here", () => {
  test("the snapshot: three sources with their own text, how many more, a folder here and one missing", async () => {
    await call("folder.manage", {
      action: "add_project",
      project: "Portal",
      area: "Client work",
      folder: join(work, "lumen", "portal"),
      request_id: rid(),
    });
    const added = TaskAddResult.parse(
      await call("task.add", {
        tasks: [
          {
            title: "Fixture four sources",
            area: "Client work",
            project: "Portal",
            sources: [source(1), source(2), source(3), source(4)],
          },
          { title: "Fixture gone folder" },
          { title: "Fixture plain" },
        ],
        request_id: rid(),
      }),
    );
    await call("folder.manage", {
      action: "set",
      task: added.tasks[1]?.ref,
      folder: join(work, "lumen", "api"),
      request_id: rid(),
    });
    rmSync(join(work, "lumen", "api"), { recursive: true });

    const snapshot = await readSnapshot(reader, here);
    const four = byTitle(snapshot.tasks, "Fixture four sources");
    const shown = (four?.["sources"] ?? []) as Record<string, unknown>[];
    for (const source of shown) expect(source["id"]).toMatch(/^s_[0-9a-z]{26}$/u);
    expect(shown.map((source) => ({ ...source, id: undefined }))).toEqual(
      [1, 2, 3].map((i) => ({
        id: undefined,
        kind: "ticket",
        title: `Fixture ticket ${String(i)}`,
        who: "Fixture Person",
        ref: `LUM-${String(200 + i)}`,
        url: `https://tickets.example/LUM-${String(200 + i)}`,
      })),
    );
    expect(four?.["sources_more"]).toBe(1);
    expect(four?.["place"]).toEqual({ state: "here" });
    expect(byTitle(snapshot.tasks, "Fixture gone folder")?.["place"]).toEqual({
      state: "missing",
    });
    const plain = byTitle(snapshot.tasks, "Fixture plain");
    expect(plain).toBeDefined();
    for (const key of ["sources", "sources_more", "place"]) expect(plain).not.toHaveProperty(key);
    // No absolute path rides on a row: the state only.
    expect(JSON.stringify(snapshot)).not.toContain(work);

    // A feed that names no machine shows no place, and still the sources.
    const bare = await readSnapshot(reader);
    expect(byTitle(bare.tasks, "Fixture four sources")).not.toHaveProperty("place");
    expect(byTitle(bare.tasks, "Fixture four sources")?.["sources_more"]).toBe(1);
  });

  test("a batch that changes a source, a link or a folder of a task, or its project's folder, carries the task's row with it", async () => {
    const start = (await readHead(reader)).cursor.seq;
    const read = TaskGetResult.parse(await call("task.get", { task: "M-3" }));
    await call("task.update", {
      task: "M-3",
      add_sources: [source(9)],
      base: read.as_of,
      request_id: rid(),
    });
    const asOf = async () => ((await call("space.status", {})) as { as_of: string }).as_of;
    await call("folder.manage", {
      action: "clear",
      task: "M-2",
      base: await asOf(),
      request_id: rid(),
    });
    rmSync(join(work, "lumen", "portal"), { recursive: true });
    mkdirSync(join(work, "lumen", "portal-next"), { recursive: true });
    await call("folder.manage", {
      action: "set",
      project: "Portal",
      folder: join(work, "lumen", "portal-next"),
      base: await asOf(),
      request_id: rid(),
    });
    const { batch } = await readBatch(reader, start, { here });
    expect(batch.events).toHaveLength(3);
    const [link, unplace, moved] = batch.events;
    const taskOf = (event: (typeof batch.events)[number] | undefined) =>
      event?.entities.find((e) => e.type === "task");
    // A source and its link were added; the task's row came with them, naming no field of it.
    expect(link?.entities.map((e) => e.type)).toEqual(["source", "task", "link"]);
    expect(taskOf(link)).toMatchObject({ changed: [] });
    const row = taskOf(link)?.row;
    expect(row).toMatchObject({ title: "Fixture plain", touched: link?.seq });
    expect((row?.["sources"] as readonly { title: string }[]).map((s) => s.title)).toEqual([
      "Fixture ticket 9",
    ]);
    expect(row).not.toHaveProperty("sources_more");
    expect(row).not.toHaveProperty("place");
    expect(unplace?.entities.map((e) => e.type)).toEqual(["folder", "task"]);
    expect(taskOf(unplace)?.row).not.toHaveProperty("place");
    expect(taskOf(unplace)?.row).toMatchObject({ title: "Fixture gone folder" });
    // The project's folder changed: the rows of its tasks come with it, as they are now.
    expect(taskOf(moved)?.row).toMatchObject({
      title: "Fixture four sources",
      place: { state: "here" },
    });
  });
});

describe("[M6.page.run-feed] a run's change carries its task's row, which shows the run", () => {
  test("queued and running show working, a question needs you, the end shows none; each batch names the run's task", async () => {
    const added = TaskAddResult.parse(
      await call("task.add", { tasks: [{ title: "Fixture run" }], request_id: rid() }),
    );
    const task = added.tasks[0]?.id ?? "";
    const served = service.ops.spaces().find((s) => s.writer !== undefined);
    const writer = served?.writer;
    if (writer === undefined || served?.id === undefined) throw new Error("no space is open");
    const machine = service.ops.machine.id;
    const store = new SpaceExecutionStore({
      writer,
      spaceId: served.id,
      credential: {
        scope_id: `runs:${machine}`,
        principal_id: await writer.actor("human", "user"),
        actor_kind: "human",
        machine_id: machine,
        origin: "ui",
      },
    });
    const runOf = async (from: number) => {
      const { batch } = await readBatch(reader, from, { here });
      const run = batch.events.flatMap((e) => e.entities).filter((e) => e.type === "run");
      const rows = batch.events.flatMap((e) => e.entities).filter((e) => e.type === "task");
      return { run, row: rows.at(-1)?.row };
    };
    const input = {
      task,
      routine: null,
      machine,
      instance: "codex-work",
      adapter: "codex" as const,
      place: null,
      request: "Fixture request",
      briefHash: "0123456789abcdef".repeat(4),
      permission: "full-access" as const,
      limits: RUN_LIMITS.task,
    };
    const asks = (run: { readonly id: string; readonly version: number }) =>
      store.transitionRun(run.id, { state: "queued", version: run.version }, "failed", {
        reason: "needs_input",
        result: {
          ok: false,
          outcome: "needs_input",
          exitCode: 0,
          signal: null,
          nativeId: null,
          text: "Fixture question?",
          error: null,
          usage: null,
          appTools: null,
          declined: 0,
          permissionDenials: 0,
          durationMs: 1,
        },
      });
    let from = (await readHead(reader)).cursor.seq;
    const queued = await store.createRun(input, rid());
    let seen = await runOf(from);
    expect(seen.run.map((e) => e.task)).toEqual([task]);
    expect(seen.row).toMatchObject({ run: { state: "working", instance: "codex-work" } });
    from = (await readHead(reader)).cursor.seq;
    await asks(queued);
    seen = await runOf(from);
    expect(seen.run.map((e) => e.task)).toEqual([task]);
    expect(seen.row).toMatchObject({ run: { state: "needs_you", instance: "codex-work" } });
    // The snapshot holds the same.
    const snapshot = await readSnapshot(reader, here);
    expect(snapshot.tasks.find((r) => r["id"] === task)).toMatchObject({
      run: { state: "needs_you" },
    });
    // A follow-up stopped before it started does not hide the run that still works.
    await store.createRun(input, rid());
    const followUp = await store.createRun(input, rid());
    from = (await readHead(reader)).cursor.seq;
    await store.transitionRun(
      followUp.id,
      { state: "queued", version: followUp.version },
      "cancelled",
      {},
    );
    seen = await runOf(from);
    expect(seen.row).toMatchObject({ run: { state: "working", instance: "codex-work" } });
    // A newer run's question waits beside the older run that still works.
    const question = await store.createRun(input, rid());
    from = (await readHead(reader)).cursor.seq;
    await asks(question);
    seen = await runOf(from);
    expect(seen.row).toMatchObject({
      run: { state: "working", instance: "codex-work" },
      questions: [{ ref: question.id, text: "Fixture question?" }],
    });
  });
});

describe("[A5.3.5.http.waiting-since] a waiting task's row says when its wait began", () => {
  test("from its creation or from the change to waiting; a new person keeps it; open has none", async () => {
    const added = TaskAddResult.parse(
      await call("task.add", {
        tasks: [
          { title: "Fixture waits from the start", status: "waiting", waiting_on: "Fixture One" },
          { title: "Fixture waits later" },
        ],
        request_id: rid(),
      }),
    );
    const [first, later] = added.tasks.map((t) => t.ref);
    if (first === undefined || later === undefined) throw new Error("the tasks were not added");
    const rowOf = async (title: string) => byTitle((await readSnapshot(reader)).tasks, title);

    const fromStart = await rowOf("Fixture waits from the start");
    expect(fromStart?.["waiting_since"]).toBe(fromStart?.["created_at"]);
    expect(await rowOf("Fixture waits later")).not.toHaveProperty("waiting_since");

    const update = async (set: Record<string, unknown>) => {
      const read = TaskGetResult.parse(await call("task.get", { task: later }));
      await call("task.update", { task: later, set, base: read.as_of, request_id: rid() });
    };
    const before = Date.now();
    await update({ status: "waiting", waiting_on: "Fixture Two" });
    const after = Date.now();
    const since = (await rowOf("Fixture waits later"))?.["waiting_since"];
    expect(typeof since).toBe("number");
    expect(since as number).toBeGreaterThanOrEqual(before);
    expect(since as number).toBeLessThanOrEqual(after);

    // Waiting on someone else is the same wait.
    await update({ waiting_on: "Fixture Three" });
    expect((await rowOf("Fixture waits later"))?.["waiting_since"]).toBe(since);
    // A batch carries it too.
    const start = (await readHead(reader)).cursor.seq;
    await update({ priority: 2 });
    const { batch } = await readBatch(reader, start, { here });
    const row = batch.events
      .flatMap((e) => e.entities)
      .find((e) => e.type === "task" && e.row?.["title"] === "Fixture waits later")?.row;
    expect(row?.["waiting_since"]).toBe(since);

    await update({ status: "open" });
    expect(await rowOf("Fixture waits later")).not.toHaveProperty("waiting_since");
  });
});
