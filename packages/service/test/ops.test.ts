// The request path for operations (A2 3.6.4 op/call and op/list; A3 3.4, 3.5, 3.7.9; M1.10)
// through a real service in this process and real ttasks-local/1 sessions of each CLI class.
// Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EntryAddResult,
  findEntry,
  opSpec,
  ReceiptGetResult,
  registry,
  SpaceStatusResult,
  TaskAddResult,
  TaskFinishResult,
  TaskGetResult,
  TaskReopenResult,
  TaskUpdateResult,
  type AnyEntry,
} from "@ttasks/contracts";
import type { SpaceWriterHandle, WriteRequest } from "@ttasks/storage";
import { RpcError, type RpcSession } from "@ttasks/bridge/protocol";
import { startService, type RunningService } from "../src/hub/service.ts";
import type { ConnectionClass } from "../src/local/index.ts";
import { checkExposure } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { classSession, errorOf, type CliClass } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

let service: RunningService;
let home: string;
let cleanup: () => void;
let spaceFolder: string;
/** A folder of the person's work, outside the space's and the TTasks home. */
let workFolder: string;
const sessions: RpcSession[] = [];

const session = async (cls: CliClass, env: Record<string, string> = {}): Promise<RpcSession> => {
  const opened = await classSession(home, service.endpoint.path, cls, env);
  sessions.push(opened);
  return opened;
};

const call = (s: RpcSession, op: string, input: Record<string, unknown>, extra = {}) =>
  s.call("op/call", { op, input, ...extra }, { timeoutMs: 30_000 });

let n = 0;
const rid = () => `fixture-request-${String((n += 1)).padStart(6, "0")}`;

beforeAll(async () => {
  const temp = tempRoot("ops");
  cleanup = temp.cleanup;
  home = join(temp.root, "h");
  workFolder = join(temp.root, "work", "fixture");
  mkdirSync(join(workFolder, "two"), { recursive: true, mode: 0o700 });
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  spaceFolder = join(temp.root, "spaces", "mira");
  const user = await session("cli-interactive");
  const created = (await user.call(
    "space/create",
    { name: "Mira", path: spaceFolder, ref_prefix: "M" },
    { timeoutMs: 60_000 },
  )) as { space: { state: string; id: string } };
  expect(created.space.state).toBe("open");
}, 120_000);

afterAll(async () => {
  for (const s of sessions) s.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
});

describe("[A2.3.6.ops.request-path] op/call and op/list", () => {
  test("op/list names every entry", async () => {
    const s = await session("cli-script");
    const list = (await s.call("op/list", {})) as { entries: { name: string }[] };
    expect(list.entries.map((e) => e.name)).toContain("task.add");
  });

  test("a write, its reads and its receipt, each matching its contract", async () => {
    const s = await session("cli-script");
    const added = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [{ title: "Fixture task one", priority: 2, due: "2026-11-20", log: "Started." }],
        request_id: rid(),
      }),
    );
    const task = added.tasks[0];
    expect(task).toMatchObject({ result: "created", ref: "M-1", log_added: true });

    const shown = TaskGetResult.parse(await call(s, "task.get", { task: "M-1" }));
    expect(shown.view).toBe("digest");
    if (shown.view !== "digest") return;
    expect(shown.task).toMatchObject({ ref: "M-1", priority: 2, due: "2026-11-20" });
    expect(shown.task.log).toHaveLength(1);
    expect(shown.task.log[0]).toMatchObject({ ref: "l1", kind: "progress", author: "script" });

    const updateId = rid();
    const updated = TaskUpdateResult.parse(
      await call(s, "task.update", {
        task: "M-1",
        set: { summary: "Next step", priority: 1 },
        base: shown.as_of,
        request_id: updateId,
      }),
    );
    expect(updated).toMatchObject({ result: "updated", task: "M-1" });
    expect([...updated.fields].sort()).toEqual(["priority", "summary"]);

    // The same request again replays, whatever happened since.
    await call(s, "entry.add", { task: "M-1", kind: "evidence", text: "Seen.", request_id: rid() });
    const again = TaskUpdateResult.parse(
      await call(s, "task.update", {
        task: "M-1",
        set: { summary: "Next step", priority: 1 },
        base: shown.as_of,
        request_id: updateId,
      }),
    );
    expect(again).toEqual({ ...updated, replayed: true });

    const receipt = ReceiptGetResult.parse(await call(s, "receipt.get", { request: updateId }));
    expect(receipt).toMatchObject({ found: true, status: "applied", as_of: updated.as_of });
    // Another class has another writer scope: it finds nothing.
    const other = await session("cli-agent", { CLAUDECODE: "1" });
    expect(await call(other, "receipt.get", { request: updateId }, { space: "Mira" })).toEqual({
      found: false,
    });

    const status = SpaceStatusResult.parse(await call(s, "space.status", { include: ["today"] }));
    expect(status.space).toMatchObject({ name: "Mira", ref_prefix: "M" });
    expect(status.session.state).toBe("unbound");

    const sections = TaskGetResult.parse(
      await call(s, "task.get", { task: "M-1", sections: ["log", "history"], log_limit: 1 }),
    );
    expect(sections).toMatchObject({ view: "sections", before: "l2" });

    const fresh = TaskGetResult.parse(await call(s, "task.get", { task: "M-1" }));
    const finished = TaskFinishResult.parse(
      await call(s, "task.finish", {
        task: "M-1",
        outcome: "Done in the fixture.",
        follow_ups: [{ title: "Fixture follow-up" }],
        base: fresh.as_of,
        request_id: rid(),
      }),
    );
    expect(finished).toMatchObject({ result: "completed", wrap_state: "wrapped" });
    expect(finished.follow_ups[0]?.ref).toBe("M-2");

    const after = TaskGetResult.parse(await call(s, "task.get", { task: "M-1" }));
    const reopened = TaskReopenResult.parse(
      await call(s, "task.reopen", {
        task: "M-1",
        reason: "Fixture reason.",
        base: after.as_of,
        request_id: rid(),
      }),
    );
    expect(reopened).toMatchObject({ result: "reopened", lifecycle: "active", status: "open" });

    const user = await session("cli-interactive");
    const note = EntryAddResult.parse(
      await call(user, "entry.add", {
        task: "M-1",
        kind: "note",
        text: "For agents.",
        for_agents: true,
        request_id: rid(),
      }),
    );
    expect(note.entry).toBe("n1");
  });

  test("a draft with focus is starred for today, in the one create", async () => {
    const s = await session("cli-interactive");
    const added = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [{ title: "Fixture starred capture", focus: true, inbox: true }],
        request_id: rid(),
      }),
    );
    const ref = added.tasks[0]?.ref ?? "";
    const shown = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    expect(shown.view === "digest" && shown.task.focus).toBe(true);
  });

  test("errors become the contract's bodies", async () => {
    const s = await session("cli-script");
    const unknown = errorOf(await call(s, "task.nothing", {}).catch((e: unknown) => e));
    expect(unknown.code).toBe("op_unknown");

    const shape = errorOf(
      await call(s, "task.add", { tasks: [], request_id: rid() }).catch((e: unknown) => e),
    );
    expect(shape.code).toBe("invalid_input");

    const large = errorOf(
      await call(s, "task.add", { tasks: [{ title: "x".repeat(201) }], request_id: rid() }).catch(
        (e: unknown) => e,
      ),
    );
    expect(large.code).toBe("too_large");

    const missing = errorOf(await call(s, "task.get", { task: "M-999" }).catch((e: unknown) => e));
    expect(missing.code).toBe("not_found");
    const elsewhere = errorOf(await call(s, "task.get", { task: "W-1" }).catch((e: unknown) => e));
    expect(elsewhere.code).toBe("not_found");

    const old = TaskGetResult.parse(await call(s, "task.get", { task: "M-1" }));
    await call(s, "task.update", {
      task: "M-1",
      set: { summary: "Changed once" },
      base: old.as_of,
      request_id: rid(),
    });
    const stale = errorOf(
      await call(s, "task.update", {
        task: "M-1",
        set: { summary: "Changed twice" },
        base: old.as_of,
        request_id: rid(),
      }).catch((e: unknown) => e),
    );
    expect(stale.code).toBe("conflict");
    expect(stale.data).toMatchObject({ cause: "VERSION_CONFLICT" });

    const unbound = errorOf(
      await call(s, "entry.add", { text: "x", request_id: rid() }).catch((e: unknown) => e),
    );
    expect(unbound.code).toBe("unbound");

    // An agent may not address a note to agents (A3 3.2.1): forbidden, rule user_only.
    const forAgents = errorOf(
      await call(s, "entry.add", {
        task: "M-1",
        kind: "note",
        text: "x",
        for_agents: true,
        request_id: rid(),
      }).catch((e: unknown) => e),
    );
    expect(forAgents).toMatchObject({ code: "forbidden", data: { rule: "user_only" } });

    // An agent's CLI gets no default space (A2 3.10.5).
    const agent = await session("cli-agent", { CODEX_THREAD_ID: "fixture" });
    const noSpace = errorOf(await call(agent, "space.status", {}).catch((e: unknown) => e));
    expect(noSpace.code).toBe("invalid_input");
    const viaEnv = await session("cli-agent", { CODEX_THREAD_ID: "fixture", TTASKS_SPACE: "Mira" });
    SpaceStatusResult.parse(await call(viaEnv, "space.status", {}));
    const notServed = errorOf(
      await call(s, "space.status", {}, { space: "Nowhere" }).catch((e: unknown) => e),
    );
    expect(notServed).toMatchObject({ code: "space_unavailable", data: { reason: "not_served" } });
  });

  test("a replay answers what the first answer said: fields and status come from the commit", async () => {
    const s = await session("cli-script");
    const added = TaskAddResult.parse(
      await call(s, "task.add", { tasks: [{ title: "Fixture replay task" }], request_id: rid() }),
    );
    const ref = added.tasks[0]?.ref ?? "";
    const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }));

    // Setting a field to its current value is no change (A3 3.4.6): only summary changed.
    const updateId = rid();
    const update = {
      task: ref,
      set: { title: "Fixture replay task", summary: "Fixture summary" },
      base: read.as_of,
      request_id: updateId,
    };
    const updated = TaskUpdateResult.parse(await call(s, "task.update", update));
    expect(updated).toMatchObject({ result: "updated", fields: ["summary"] });

    const done = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    await call(s, "task.finish", {
      task: ref,
      outcome: "Fixture outcome.",
      base: done.as_of,
      request_id: rid(),
    });
    const finished = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    const reopenId = rid();
    const reopen = {
      task: ref,
      reason: "Fixture reason.",
      base: finished.as_of,
      request_id: reopenId,
    };
    const reopened = TaskReopenResult.parse(await call(s, "task.reopen", reopen));
    expect(reopened).toMatchObject({ result: "reopened", status: "open" });

    // The task changes after both: the replays still answer as the first answers did.
    const now = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    await call(s, "task.update", {
      task: ref,
      set: { status: "waiting", title: "Fixture replay task, renamed" },
      base: now.as_of,
      request_id: rid(),
    });
    expect(TaskReopenResult.parse(await call(s, "task.reopen", reopen))).toEqual({
      ...reopened,
      replayed: true,
    });
    expect(TaskUpdateResult.parse(await call(s, "task.update", update))).toEqual({
      ...updated,
      replayed: true,
    });
  });

  test("update changes an active task only: wrong_tool, decided and receipted (A3 3.4.6)", async () => {
    const s = await session("cli-script");
    const added = TaskAddResult.parse(
      await call(s, "task.add", { tasks: [{ title: "Fixture finished task" }], request_id: rid() }),
    );
    const ref = added.tasks[0]?.ref ?? "";
    const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    // A finished task is not a status: complete_task is the call.
    const asStatus = errorOf(
      await call(s, "task.update", {
        task: ref,
        set: { status: "done" },
        base: read.as_of,
        request_id: rid(),
      }).catch((e: unknown) => e),
    );
    expect(asStatus).toMatchObject({
      code: "wrong_tool",
      data: { issues: [{ path: "set.status" }] },
    });

    await call(s, "task.finish", {
      task: ref,
      outcome: "Fixture outcome.",
      base: read.as_of,
      request_id: rid(),
    });
    const done = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    const update = {
      task: ref,
      set: { summary: "Fixture after the end" },
      base: done.as_of,
      request_id: rid(),
    };
    const refused = errorOf(await call(s, "task.update", update).catch((e: unknown) => e));
    expect(refused).toMatchObject({
      code: "wrong_tool",
      hint: expect.stringContaining("reopen") as unknown,
      data: { cause: "TASK_NOT_ACTIVE" },
    });
    const unchanged = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    expect(unchanged.as_of).toBe(done.as_of);

    // The writer decided it, so it has a receipt: after a reopen the same request answers the same.
    await call(s, "task.reopen", {
      task: ref,
      reason: "Fixture reason.",
      base: done.as_of,
      request_id: rid(),
    });
    expect(errorOf(await call(s, "task.update", update).catch((e: unknown) => e))).toMatchObject({
      code: "wrong_tool",
      data: { cause: "TASK_NOT_ACTIVE", replayed: true },
    });
    expect(
      ReceiptGetResult.parse(await call(s, "receipt.get", { request: update.request_id })),
    ).toMatchObject({ found: true, status: "rejected", error: { cause: "TASK_NOT_ACTIVE" } });
  });

  test("a source that exists keeps its metadata, and the reply names what differs", async () => {
    const s = await session("cli-interactive");
    const source = { kind: "ticket", title: "Fixture ticket", key: "jira:FIX-1" };
    const added = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [{ title: "Fixture sourced task", sources: [source] }],
        request_id: rid(),
      }),
    );
    expect(added.warnings).toEqual([]);
    const ref = added.tasks[0]?.ref ?? "";
    const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }));
    const update = {
      task: ref,
      add_sources: [{ ...source, title: "Fixture ticket, renamed" }],
      base: read.as_of,
      request_id: rid(),
    };
    const updated = TaskUpdateResult.parse(await call(s, "task.update", update));
    expect(updated).toMatchObject({ result: "no_change", fields: [] });
    expect(updated.warnings).toHaveLength(1);
    expect(updated.warnings[0]).toContain("add_sources.0");
    expect(updated.warnings[0]).toContain("title");
    expect(updated.warnings[0]).not.toContain("Fixture");
    // A replay warns the same, from the stored result.
    expect(TaskUpdateResult.parse(await call(s, "task.update", update))).toEqual({
      ...updated,
      replayed: true,
    });
    // A draft names its own source path. Its key matches the task (A1 3.6), and add_sources
    // links its sources there: the source exists, so the reply names what differs.
    const second = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [
          {
            title: "Fixture second task",
            sources: [{ ...source, who: "Fixture person" }],
            on_existing: "add_sources",
          },
        ],
        request_id: rid(),
      }),
    );
    expect(second.tasks[0]).toMatchObject({ result: "exists", ref });
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain("tasks.0.sources.0");
  });

  test("a retry from another folder is the same request: cwd is no part of the intent", async () => {
    const s = await session("cli-script");
    const request = { tasks: [{ title: "Fixture folder task" }], request_id: rid() };
    const first = TaskAddResult.parse(
      await call(s, "task.add", { ...request, cwd: join(spaceFolder, "one") }),
    );
    const again = TaskAddResult.parse(
      await call(s, "task.add", { ...request, cwd: join(spaceFolder, "two") }),
    );
    expect(again).toEqual({ ...first, replayed: true });
  });

  test("status lists a task once, in its first section (A3 3.4.2)", async () => {
    const s = await session("cli-interactive");
    const added = TaskAddResult.parse(
      await call(s, "task.add", {
        tasks: [{ title: "Fixture due today", due: "today", inbox: true }],
        request_id: rid(),
      }),
    );
    const id = added.tasks[0]?.id;
    const status = SpaceStatusResult.parse(
      await call(s, "space.status", { include: ["today", "inbox", "changes"] }),
    );
    const sections = status.sections ?? [];
    const shown = sections.flatMap((section) => section.tasks.map((task) => task.id));
    expect(shown.filter((found) => found === id)).toHaveLength(1);
    expect(sections[0]?.tasks.map((task) => task.id)).toContain(id);
  });

  test("a status section counts all its tasks, not the eight it lists, and says when its read stopped short", async () => {
    const s = await session("cli-interactive");
    const add = async (n: number, due: string) => {
      for (let done = 0; done < n; done += 25) {
        const tasks = Array.from({ length: Math.min(25, n - done) }, (_, i) => ({
          title: `Fixture counted ${due} ${String(done + i)}`,
          due,
          inbox: true,
        }));
        await call(s, "task.add", { tasks, request_id: rid() });
      }
    };
    const section = async (name: "inbox" | "week") =>
      SpaceStatusResult.parse(await call(s, "space.status", { include: [name] })).sections?.[0];
    // The tests above leave a few tasks in the Inbox and due this week.
    const before = {
      inbox: (await section("inbox"))?.total ?? 0,
      week: (await section("week"))?.total ?? 0,
    };
    expect(before.inbox).toBeLessThan(8);
    await add(12, "+3d");
    const inbox = await section("inbox");
    expect(inbox?.tasks).toHaveLength(8);
    expect(inbox?.total).toBe(before.inbox + 12);
    expect(inbox?.more).toBeUndefined();
    // Exactly as many as the read takes: all counted, none past it.
    await add(48 - before.inbox - 12, "+4d");
    const full = await section("inbox");
    expect(full).toMatchObject({ total: 48 });
    expect(full?.more).toBeUndefined();
    await add(1, "+4d");
    expect(await section("inbox")).toMatchObject({ total: 48, more: true });
    // The week is the page's This week, read whole: every task in it is counted.
    const week = await section("week");
    expect(week?.tasks).toHaveLength(8);
    expect(week).toMatchObject({ total: before.week + 49 - before.inbox });
    expect(week?.more).toBeUndefined();
  }, 120_000);

  test("the user-only space verbs refuse the script and agent classes", async () => {
    for (const [cls, env] of [
      ["cli-script", {}],
      ["cli-agent", { CLAUDECODE: "1" }],
    ] as const) {
      const s = await session(cls, env);
      for (const method of ["space/restore", "space/claim", "space/recover", "space/backup"]) {
        const error = await s.call(method, { space: "Mira" }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect(errorOf(error)).toMatchObject({ code: "forbidden" });
      }
    }
  });

  // Last: it adds spaces, and the tests above use the one space as the default.
  test("two creates at once take different reference prefixes", async () => {
    const user = await session("cli-interactive");
    const create = (name: string) =>
      user.call(
        "space/create",
        { name, path: join(spaceFolder, "..", name.toLowerCase()) },
        { timeoutMs: 120_000 },
      ) as Promise<{ space: { ref_prefix?: string; state: string } }>;
    const [mole, moss] = await Promise.all([create("Mole"), create("Moss")]);
    expect(mole.space.state).toBe("open");
    expect(moss.space.state).toBe("open");
    expect(mole.space.ref_prefix).toBeDefined();
    expect(mole.space.ref_prefix).not.toBe(moss.space.ref_prefix);
    expect([mole.space.ref_prefix, moss.space.ref_prefix]).not.toContain("M");
  }, 120_000);
});

describe("[A3.3.4.add.upsert] task.add upserts by source key (A3 3.4.5, A1 3.6)", () => {
  test("exists with how it matched, the log added to an active match, add_sources, create_new, an ambiguous match, follow-ups and the receipt", async () => {
    // The tests above add spaces: name the fixture's.
    const mira = { space: "Mira" };
    const s = await session("cli-script");
    const add = async (tasks: Record<string, unknown>[], request_id = rid()) =>
      TaskAddResult.parse(await call(s, "task.add", { tasks, request_id }, mira));
    const ticket = (n: number) => ({
      kind: "ticket",
      title: "Fixture upsert ticket",
      key: `jira:UPS-${String(n)}`,
    });
    const first = (await add([{ title: "Fixture upsert task", sources: [ticket(1)] }])).tasks[0];
    const ref = first?.ref ?? "";
    expect(first).toMatchObject({ result: "created", lifecycle: "active", log_added: false });

    // The same key: exists with the task's own title, and the draft's log entry is added to the
    // task, nothing else.
    const again = await add([
      { title: "Fixture upsert again", sources: [ticket(1)], log: "Fixture: seen again." },
    ]);
    expect(again.tasks).toEqual([
      {
        result: "exists",
        id: first?.id,
        ref,
        title: "Fixture upsert task",
        lifecycle: "active",
        matched_by: "source_key",
        log_added: true,
      },
    ]);
    const read = TaskGetResult.parse(await call(s, "task.get", { task: ref }, mira));
    if (read.view !== "digest") throw new Error("expected a digest");
    expect(read.task.log).toHaveLength(1);
    expect(read.task.title).toBe("Fixture upsert task");

    // create_new against an active match: a new task, and the key stays with the task that held
    // it, so a refresh without create_new still finds that one.
    const split = await add([
      { title: "Fixture split off", sources: [ticket(1)], on_existing: "create_new" },
    ]);
    expect(split.tasks[0]).toMatchObject({ result: "created", lifecycle: "active" });
    expect(split.tasks[0]?.ref).not.toBe(ref);
    expect((await add([{ title: "Fixture upsert", sources: [ticket(1)] }])).tasks[0]).toMatchObject(
      { result: "exists", ref },
    );

    // add_sources links the draft's other source, which then finds the task too.
    const linked = await add([
      { title: "Fixture upsert", sources: [ticket(1), ticket(2)], on_existing: "add_sources" },
    ]);
    expect(linked.tasks[0]).toMatchObject({ result: "exists", ref, log_added: false });
    expect((await add([{ title: "Fixture upsert", sources: [ticket(2)] }])).tasks[0]).toMatchObject(
      { result: "exists", ref },
    );

    // Two active tasks hold the draft's keys: their references, no task, and no log entry.
    const other = (await add([{ title: "Fixture other upsert", sources: [ticket(3)] }])).tasks[0];
    const otherRef = other?.ref ?? "";
    const both = await add([
      { title: "Fixture which", sources: [ticket(2), ticket(3)], log: "Fixture: which one?" },
    ]);
    expect(both.tasks).toEqual([
      {
        result: "exists",
        title: "Fixture which",
        lifecycle: "active",
        matched_by: "source_key",
        ambiguous: [ref, otherRef],
        log_added: false,
        log_left_out: true,
      },
    ]);

    // A follow-up upserts too: it matches the other task. One with a key of the task the call
    // completes is new work after it: it is created, and later drafts find it (A3 3.4.8).
    const before = TaskGetResult.parse(await call(s, "task.get", { task: ref }, mira));
    const finished = TaskFinishResult.parse(
      await call(
        s,
        "task.finish",
        {
          task: ref,
          outcome: "Fixture outcome.",
          follow_ups: [
            { title: "Fixture follow-up", sources: [ticket(3)] },
            { title: "Fixture follow-up of its ticket", sources: [ticket(2)] },
          ],
          base: before.as_of,
          request_id: rid(),
        },
        mira,
      ),
    );
    const followRef = finished.follow_ups[1]?.ref ?? "";
    expect(finished.follow_ups).toEqual([
      // A matched follow-up answers with the task's own title.
      {
        result: "exists",
        ref: otherRef,
        title: "Fixture other upsert",
        lifecycle: "active",
        log_added: false,
      },
      {
        result: "created",
        ref: followRef,
        title: "Fixture follow-up of its ticket",
        log_added: false,
      },
    ]);
    expect([ref, otherRef]).not.toContain(followRef);
    expect((await add([{ title: "Fixture upsert", sources: [ticket(2)] }])).tasks[0]).toMatchObject(
      { result: "exists", ref: followRef, lifecycle: "active" },
    );

    // A finished match: exists with its lifecycle, and nothing follows it. Its receipt holds the
    // existing results, and a retry replays them.
    const lateId = rid();
    const late = await add([{ title: "Fixture late", sources: [ticket(1)], log: "Late." }], lateId);
    expect(late.tasks[0]).toMatchObject({
      result: "exists",
      ref,
      lifecycle: "completed",
      log_added: false,
    });
    expect(
      ReceiptGetResult.parse(await call(s, "receipt.get", { request: lateId }, mira)),
    ).toMatchObject({
      found: true,
      status: "unchanged",
      results: [
        { i: 0, status: "existing", ref, matched_by: "source_key", lifecycle: "completed" },
        { i: 1, status: "existing", ref },
        { i: 2, status: "existing", ref },
      ],
    });
    expect(
      await add([{ title: "Fixture late", sources: [ticket(1)], log: "Late." }], lateId),
    ).toEqual({ ...late, replayed: true });
    // create_new beside the finished task: a new active task.
    const anew = await add([
      { title: "Fixture upsert anew", sources: [ticket(1)], on_existing: "create_new" },
    ]);
    expect(anew.tasks[0]).toMatchObject({ result: "created", lifecycle: "active" });
    expect(anew.tasks[0]?.ref).not.toBe(ref);
  });
});

/** The requests the spaces' writers receive through the request path, recorded as sent. */
function recordingHost(sent: WriteRequest[]): OpsHost {
  const wrapped = new WeakMap<SpaceWriterHandle, SpaceWriterHandle>();
  const wrap = (writer: SpaceWriterHandle): SpaceWriterHandle => {
    let proxy = wrapped.get(writer);
    if (proxy === undefined) {
      proxy = new Proxy(writer, {
        get(target, key) {
          if (key === "submit") {
            return (request: WriteRequest) => {
              sent.push(structuredClone(request));
              return target.submit(request);
            };
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      wrapped.set(writer, proxy);
    }
    return proxy;
  };
  return {
    machine: service.ops.machine,
    ...(service.ops.home === undefined ? {} : { home: service.ops.home }),
    ...(service.ops.dataFolder === undefined ? {} : { dataFolder: service.ops.dataFolder }),
    spaces: () =>
      service.ops
        .spaces()
        .map((s) => (s.writer === undefined ? s : { ...s, writer: wrap(s.writer) })),
  };
}

const isR7 = (kind: string): boolean => opSpec(kind)?.r7 === true;

describe("[A2.3.6.ops.launch-rule] launches stay the user's on the request path (R7)", () => {
  test("every operation op/call sends is one its entry declares and none is R7's, and each class writes as its own actor", async () => {
    const sent: WriteRequest[] = [];
    const host = recordingHost(sent);
    for (const [cls, kind] of [
      ["cli-interactive", "human"],
      ["cli-script", "agent"],
      ["cli-agent", "agent"],
    ] as const) {
      const caller = { class: cls, env: {} };
      const op = (entry: string, input: Record<string, unknown>) =>
        opCall(host, caller, { op: entry, input, space: "Mira" });
      const from = sent.length;
      // Every write entry of M1, with each part a draft can carry: a log entry, a source, a folder.
      const draft = (title: string) => ({
        title,
        log: "Fixture log.",
        sources: [{ kind: "ticket", title: "Fixture ticket", key: `fixture:${cls}:${title}` }],
        folder: workFolder,
      });
      const added = TaskAddResult.parse(
        await op("task.add", { tasks: [draft("Fixture rule task")], request_id: rid() }),
      );
      const ref = added.tasks[0]?.ref ?? "";
      const read = TaskGetResult.parse(await op("task.get", { task: ref }));
      const updated = TaskUpdateResult.parse(
        await op("task.update", {
          task: ref,
          set: { summary: "Fixture summary", folder: join(workFolder, "two") },
          add_sources: [{ kind: "ticket", title: "Fixture other", key: `fixture:${cls}:other` }],
          base: read.as_of,
          request_id: rid(),
        }),
      );
      await op("entry.add", { task: ref, kind: "evidence", text: "Seen.", request_id: rid() });
      const finished = TaskFinishResult.parse(
        await op("task.finish", {
          task: ref,
          outcome: "Fixture outcome.",
          follow_ups: [draft("Fixture follow-up")],
          base: updated.as_of,
          request_id: rid(),
        }),
      );
      await op("task.reopen", {
        task: ref,
        reason: "Fixture reason.",
        base: finished.as_of,
        request_id: rid(),
      });
      const requests = sent.slice(from);
      expect(requests.map((r) => r.intent?.entry)).toEqual([
        "task.add",
        "task.update",
        "entry.add",
        "task.finish",
        "task.reopen",
      ]);
      const kinds = new Set(requests.flatMap((r) => r.ops.map((o) => o.kind)));
      expect(kinds).toEqual(
        new Set([
          "task.create",
          "log.add",
          "source.add",
          "task.folder_set",
          "task.patch",
          "task.complete",
          // complete_task's outcome is the task's wrap-up (A3 3.4.8).
          "task.wrap_up",
          "task.reopen",
        ]),
      );
      for (const request of requests) {
        const entry = findEntry(request.intent?.entry ?? "");
        for (const o of request.ops) {
          expect(entry?.ops, `${String(request.intent?.entry)} sends ${o.kind}`).toContain(o.kind);
          expect(isR7(o.kind)).toBe(false);
        }
        // The class's own actor (A3 3.7.4): the human for the user, the agent actor otherwise.
        expect(request.actor.actor_kind).toBe(kind);
        // Every request here carries the registry intent, which a launch request may not hold.
        expect(request.intent).toBeDefined();
      }
    }
  });

  test("an entry that declares one of R7's operations is the user's, and op/call's gate refuses the script and agent classes", () => {
    for (const entry of registry) {
      if (entry.ops.some(isR7)) expect(entry.actors, entry.name).toBe("user");
    }
    // A launching entry, as a later step will define one: only the user's classes pass the gate
    // that op/call runs first, before any input is read or any space is consulted.
    const base = findEntry("task.add");
    if (base === undefined) throw new Error("task.add is not in the registry");
    const launching = { ...base, actors: "user", ops: ["launch.create"] } as AnyEntry;
    const gate = (cls: ConnectionClass): unknown => {
      try {
        checkExposure(launching, cls);
        return "passed";
      } catch (error) {
        return error;
      }
    };
    for (const cls of ["cli-script", "cli-agent"] as const) {
      expect(gate(cls)).toMatchObject({ code: "forbidden", data: { rule: "user_only" } });
    }
    for (const cls of ["cli-interactive", "ui"] as const) expect(gate(cls)).toBe("passed");
  });
});
