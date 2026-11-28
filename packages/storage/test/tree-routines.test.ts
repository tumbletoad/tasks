// Routines on the tree writer, as a person and the service use them, walked through a month with a
// clock the tests move: a weekly chore, a weekday agent routine, a monthly one from the 31st, and a
// routine in a project that is archived. After every step of a walk the routine holds its open time
// and exactly one entry for each time. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId } from "../src/ids.ts";
import { TreeWriter, type TreeActor, type TreeResult } from "../src/tree/core.ts";
import { claimRequestId } from "../src/tree/routines.ts";
import { searchTree } from "../src/tree/search.ts";
import { checkedDriver, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-routines");
afterAll(temp.cleanup);

const ZONE = "Europe/Amsterdam";
/** An instant in December 2026, when Amsterdam is an hour ahead of UTC. */
const t = (day: number, time = "10:00") =>
  Date.parse(`2026-12-${String(day).padStart(2, "0")}T${time}:00+01:00`);
const MINUTE = 60_000;
const HASH = "a1b2c3d4".repeat(8);
const RUN = {
  adapter: "codex",
  folder: null,
  brief_hash: HASH,
  permission: "full-access",
  limits: { max_turns: 150, wall_ms: 1_800_000, idle_ms: 600_000 },
};

interface Send {
  who: TreeActor;
  base: string | null;
  request_id: string;
}

describe("[S2.tree.routines] routines on the tree writer, by a person and by the service", () => {
  let fx: TreeFixture;
  let now = t(2);
  let writer: TreeWriter;
  let service: TreeActor;

  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
    now = t(2);
    writer = new TreeWriter(fx.conn, { machineId: TEST_MACHINE, clock: () => now });
    service = { ...fx.human, scope_id: "service:clock", origin: "system" };
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const send = (command: string, input: Record<string, unknown>, more: Partial<Send> = {}) =>
    writer.submit({
      space_id: fx.spaceId,
      request_id: more.request_id ?? newId("op").slice(3),
      actor: more.who ?? fx.human,
      command,
      input,
      ...(more.base === null || command === "undo" || command === "redo"
        ? {}
        : { base: more.base ?? fx.asOf() }),
    });
  const ok = (result: TreeResult): Record<string, unknown> => {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("applied");
    return (result.result ?? {}) as Record<string, unknown>;
  };
  const routine = (id: string) =>
    fx.conn.prepare("SELECT * FROM routines WHERE id = $id").get({ id }) ?? {};
  const open = (id: string) => {
    const r = routine(id);
    return { due_date: r["due_date"], due_at: r["due_at"] };
  };
  const entries = (id: string) =>
    fx.conn
      .prepare(
        "SELECT due_date, due_at, state, why, run_id, note FROM occurrences " +
          "WHERE routine_id = $id AND deleted_at IS NULL ORDER BY at, id",
      )
      .all({ id });
  const runs = (id: string) =>
    fx.conn
      .prepare("SELECT * FROM runs WHERE task_id = $id ORDER BY queued_at, attempt")
      .all({ id });

  /** Water the plants every Saturday, made on Wednesday 2 December. */
  const chore = (): string => {
    const made = ok(
      send("routine.set", { title: "Water the plants", rule: "FREQ=WEEKLY;BYDAY=SA", tz: ZONE }),
    ) as { routine: { id: string; ref: string; due: unknown } };
    expect(made.routine.due).toEqual({ due_date: "2026-12-05", due_at: null });
    return made.routine.id;
  };

  /** Read the mail into tasks every day at 07:00 by an agent, made on Monday 7 December 06:00. */
  const daily = (): string => {
    now = t(7, "06:00");
    const made = ok(
      send("routine.set", {
        title: "Read the mail",
        rule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
        tz: ZONE,
        instance: "codex-work",
        instruction: "Read the new mail into tasks.",
      }),
    ) as { routine: { id: string } };
    expect(open(made.routine.id)).toEqual({ due_date: "2026-12-07", due_at: t(7, "07:00") });
    return made.routine.id;
  };
  const claimNow = (id: string, more: Partial<Send> = {}) =>
    send("routine.claim", { routine: id, run: RUN }, { who: service, base: null, ...more });
  const move = (run: string, expect_: string, next: string, more: Record<string, unknown> = {}) => {
    const version = Number(
      fx.conn.prepare("SELECT version FROM runs WHERE id = $id").get({ id: run })?.["version"],
    );
    return ok(
      send(
        "run.transition",
        { run, expect: expect_, expect_version: version, next, ...more },
        { base: null },
      ),
    );
  };

  /** A time as the log shows it: its date, and its local time when it has one. */
  const timeText = (date: unknown, at: unknown): string =>
    typeof at === "number"
      ? `${String(date)} ${new Date(at).toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" })}`
      : String(date);
  /**
   * What must hold after every step of a walk: the routine's open time, and its live entries in
   * order of their times, exactly one for each time.
   */
  const holds = (id: string, openTime: string, log: string[]): void => {
    const r = routine(id);
    expect(timeText(r["due_date"], r["due_at"])).toBe(openTime);
    const live = fx.conn
      .prepare(
        "SELECT due_date, due_at, state FROM occurrences WHERE routine_id = $id " +
          "AND deleted_at IS NULL ORDER BY due_date, due_at",
      )
      .all({ id })
      .map((e) => `${timeText(e["due_date"], e["due_at"])} ${String(e["state"])}`);
    expect(live).toEqual(log);
    const times = live.map((e) => e.slice(0, e.lastIndexOf(" ")));
    expect(new Set(times).size).toBe(times.length);
  };
  /** The service's look, with the request ID it sends: one more attempt than the runs for the time. */
  const look = (id: string) => {
    const due = Number(routine(id)["due_at"]);
    const count = fx.conn
      .prepare(
        "SELECT count(*) AS n FROM runs WHERE task_id = $id AND json_extract(spec, '$.due_at') = $due",
      )
      .get({ id, due })?.["n"];
    const request_id = claimRequestId(id, due, Number(count) + 1);
    return { request_id, result: claimNow(id, { request_id }) };
  };
  const claimed = (id: string): string => {
    const said = ok(look(id).result) as { claimed: boolean; run: { id: string } };
    expect(said.claimed).toBe(true);
    return said.run.id;
  };
  const idle = (id: string, why: string): void => {
    expect(look(id).result.result).toMatchObject({ claimed: false, why });
  };
  /** The agent's done from inside its run: the run in its envelope, only the routine named. */
  const agentDone = (id: string, run: string) =>
    send(
      "routine.done",
      { routine: id, note: "Read the mail." },
      { who: { ...fx.agent, run_id: run as never }, base: null },
    );
  const running = (run: string): void => {
    move(run, "queued", "starting");
    move(run, "starting", "running");
  };

  test("the weekly chore's month: early, paused and resumed, late, skipped, undone", () => {
    const id = chore();
    holds(id, "2026-12-05", []);
    // Watered on Friday: Saturday's time is done, and a pause and resume that day keep it done.
    now = t(4);
    ok(send("routine.done", { routine: id }));
    holds(id, "2026-12-12", ["2026-12-05 done"]);
    ok(send("routine.pause", { routine: id }));
    ok(send("routine.resume", { routine: id }));
    holds(id, "2026-12-12", ["2026-12-05 done"]);
    // Saturday the 12th passes unchecked: it stays open, late, until the Wednesday after.
    now = t(13);
    holds(id, "2026-12-12", ["2026-12-05 done"]);
    now = t(16);
    ok(send("routine.done", { routine: id }));
    holds(id, "2026-12-19", ["2026-12-05 done", "2026-12-12 done"]);
    now = t(19);
    ok(send("routine.skip", { routine: id }));
    holds(id, "2026-12-26", ["2026-12-05 done", "2026-12-12 done", "2026-12-19 skipped"]);
    now = t(26);
    ok(send("routine.done", { routine: id }));
    const month = ["2026-12-05 done", "2026-12-12 done", "2026-12-19 skipped", "2026-12-26 done"];
    holds(id, "2027-01-02", month);
    ok(send("undo", {}));
    holds(id, "2026-12-26", month.slice(0, 3));
    ok(send("redo", {}));
    holds(id, "2027-01-02", month);
    // A new start that leaves the next date where it was still keeps the done's Undo back.
    ok(send("routine.set", { routine: id, start: "2026-12-30" }));
    holds(id, "2027-01-02", month);
    expect(send("undo", {})).toMatchObject({ status: "unchanged", result: { kept: {} } });
    holds(id, "2027-01-02", month);
    // A stale second click is held to what the person saw.
    const seen = fx.asOf();
    now = Date.parse("2027-01-02T10:00:00+01:00");
    ok(send("routine.done", { routine: id }, { base: seen }));
    expect(send("routine.done", { routine: id }, { base: seen }).status).toBe("conflict");
    holds(id, "2027-01-09", [...month, "2027-01-02 done"]);
    // It is found as a task is, holds notes, and is no task: no task command takes it, and it holds
    // no task.
    expect(searchTree(fx.conn, "plants")).toEqual([{ kind: "task", entityId: id, nodeId: id }]);
    ok(send("note.add", { on: id, body: "The fern needs less." }));
    expect(send("task.finish", { task: id }).error?.code).toBe("NOT_FOUND");
    expect(send("tasks.add", { tasks: [{ title: "Buy soil", under: id }] }).error?.field).toBe(
      "tasks.0.under",
    );
  });

  test("a weekday agent routine's month: retries, check-offs by hand, a late done and a question", () => {
    now = t(6, "06:00");
    const made = ok(
      send("routine.set", {
        title: "Read the mail",
        rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0",
        tz: ZONE,
        instance: "codex-work",
        instruction: "Read the new mail into tasks.",
      }),
    ) as { routine: { id: string } };
    const id = made.routine.id;
    holds(id, "2026-12-07 07:00", []);
    // Monday: the start fails; the look four minutes on queues nothing and keeps no receipt, so the
    // same request a quarter of an hour on queues the retry, and a second start replays that one.
    now = t(7, "07:00") + 30_000;
    const first = claimed(id);
    move(first, "queued", "starting");
    move(first, "starting", "failed", { reason: "spawn_failed" });
    now = t(7, "07:04");
    const retry = look(id);
    expect(retry.result.result).toMatchObject({ claimed: false, why: "waiting" });
    now = t(7, "07:16") + 30_000;
    const again = ok(claimNow(id, { request_id: retry.request_id })) as { run: { id: string } };
    expect(claimNow(id, { request_id: retry.request_id })).toMatchObject({ replayed: true });
    expect(runs(id).map((r) => r["attempt"])).toEqual([1, 2]);
    idle(id, "working");
    running(again.run.id);
    now = t(7, "07:40");
    ok(agentDone(id, again.run.id));
    holds(id, "2026-12-08 07:00", ["2026-12-07 07:00 done"]);
    move(again.run.id, "running", "succeeded");
    // Tuesday: checked off by hand while its run is queued, which cancels it; the Undo opens the
    // time again for a fresh claim, and a check-off while that run works is the only Tuesday entry.
    now = t(8, "07:00") + 30_000;
    const queued = claimed(id);
    now = t(8, "07:05");
    ok(send("routine.done", { routine: id }));
    expect(runs(id).find((r) => r["id"] === queued)?.["state"]).toBe("cancelled");
    holds(id, "2026-12-09 07:00", ["2026-12-07 07:00 done", "2026-12-08 07:00 done"]);
    ok(send("undo", {}));
    holds(id, "2026-12-08 07:00", ["2026-12-07 07:00 done"]);
    const fresh = claimed(id);
    running(fresh);
    now = t(8, "07:20");
    ok(send("routine.done", { routine: id }));
    now = t(8, "07:30");
    expect(agentDone(id, fresh).status).toBe("unchanged");
    holds(id, "2026-12-09 07:00", ["2026-12-07 07:00 done", "2026-12-08 07:00 done"]);
    move(fresh, "running", "succeeded");
    // Wednesday's run works past Thursday 07:00: its done is Wednesday's, and Thursday is claimed.
    now = t(9, "07:00") + 30_000;
    const long = claimed(id);
    running(long);
    now = t(10, "07:30");
    ok(agentDone(id, long));
    move(long, "running", "succeeded");
    const week = ["2026-12-07 07:00 done", "2026-12-08 07:00 done", "2026-12-09 07:00 done"];
    holds(id, "2026-12-10 07:00", week);
    const thursday = claimed(id);
    running(thursday);
    // Thursday's run asks the person: nothing is claimed or skipped for two working days.
    move(thursday, "running", "failed", { reason: "needs_input" });
    now = t(11, "07:00") + 30_000;
    idle(id, "question");
    now = t(14, "07:00") + 30_000;
    idle(id, "question");
    holds(id, "2026-12-10 07:00", week);
    // The person replies; the reply's run carries Thursday's time and its done is Thursday's. The
    // slots missed meanwhile run once: Monday's.
    now = t(14, "08:00");
    ok(send("note.add", { on: id, body: "Archive the newsletters." }));
    const reply = ok(
      send(
        "run.create",
        {
          ...RUN,
          task: id,
          instance: "codex-work",
          request: "Archive the newsletters.",
          due_at: t(10, "07:00"),
        },
        { base: null },
      ),
    ) as { run: { id: string } };
    idle(id, "working");
    running(reply.run.id);
    ok(agentDone(id, reply.run.id));
    move(reply.run.id, "running", "succeeded");
    expect(ok(look(id).result)["due"]).toEqual({ due_date: "2026-12-14", due_at: t(14, "07:00") });
    holds(id, "2026-12-14 07:00", [...week, "2026-12-10 07:00 done"]);
  });

  test("a monthly routine from the 31st falls on each month's last day", () => {
    const day = (date: string) => Date.parse(`${date}T10:00:00+01:00`);
    now = day("2027-01-31");
    const made = ok(
      send("routine.set", { title: "Pay the rent", rule: "FREQ=MONTHLY;BYMONTHDAY=31", tz: ZONE }),
    ) as { routine: { id: string } };
    const id = made.routine.id;
    holds(id, "2027-01-31", []);
    ok(send("routine.done", { routine: id }));
    holds(id, "2027-02-28", ["2027-01-31 done"]);
    now = day("2027-02-28");
    ok(send("routine.done", { routine: id }));
    holds(id, "2027-03-31", ["2027-01-31 done", "2027-02-28 done"]);
    now = day("2027-04-01");
    ok(send("routine.done", { routine: id }));
    holds(id, "2027-04-30", ["2027-01-31 done", "2027-02-28 done", "2027-03-31 done"]);
  });

  test("archiving a project pauses its routines, and neither Undo nor unarchive switches them on", () => {
    now = t(6, "06:00");
    const project = ok(send("project.create", { title: "Library" })) as {
      project: { id: string };
    };
    const library = project.project.id;
    const made = ok(
      send("routine.set", {
        title: "Tidy the library",
        under: library,
        rule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
        tz: ZONE,
        instance: "codex-work",
        instruction: "Tidy the library.",
      }),
    ) as { routine: { id: string } };
    const id = made.routine.id;
    ok(send("project.archive", { project: library }));
    expect(routine(id)["paused"]).toBe(1);
    now = t(7, "07:00") + 30_000;
    idle(id, "paused");
    ok(send("undo", {}));
    const archived = fx.conn.prepare("SELECT archived_at FROM nodes WHERE id = $id");
    expect(archived.get({ id: library })).toEqual({ archived_at: null });
    expect(routine(id)["paused"]).toBe(1);
    ok(send("project.archive", { project: library }));
    ok(send("project.unarchive", { project: library }));
    expect(routine(id)["paused"]).toBe(1);
    ok(send("routine.resume", { routine: id }));
    holds(id, "2026-12-08 07:00", []);
  });

  test("a pause over two weeks, and a resume at the next time after now", () => {
    const id = chore();
    now = t(3);
    ok(send("routine.pause", { routine: id }));
    expect(routine(id)["paused"]).toBe(1);
    now = t(16);
    ok(send("routine.resume", { routine: id }));
    expect(routine(id)["paused"]).toBe(0);
    expect(open(id)).toEqual({ due_date: "2026-12-19", due_at: null });
    expect(entries(id)).toEqual([]);
  });

  test("Undo takes back a done and a skip, unless the routine changed since", () => {
    const id = chore();
    now = t(4);
    ok(send("routine.done", { routine: id }));
    ok(send("undo", {}));
    expect(open(id)).toEqual({ due_date: "2026-12-05", due_at: null });
    expect(entries(id)).toEqual([]);
    ok(send("redo", {}));
    expect(open(id)).toEqual({ due_date: "2026-12-12", due_at: null });
    expect(entries(id)).toHaveLength(1);
    now = t(12);
    ok(send("routine.skip", { routine: id }));
    // Two Undos walk back the skip, then the done.
    ok(send("undo", {}));
    expect(open(id)).toEqual({ due_date: "2026-12-12", due_at: null });
    ok(send("undo", {}));
    expect(open(id)).toEqual({ due_date: "2026-12-05", due_at: null });
    expect(entries(id)).toEqual([]);
    // A done, then a new schedule: the done's Undo is kept back.
    ok(send("routine.done", { routine: id }));
    ok(send("routine.set", { routine: id, rule: "FREQ=WEEKLY;BYDAY=SU" }));
    expect(open(id)).toEqual({ due_date: "2026-12-13", due_at: null });
    const kept = send("undo", {});
    expect(kept).toMatchObject({ status: "unchanged", result: { kept: {} } });
    expect(entries(id)).toHaveLength(1);
  });

  test("finishing for good is the person's, and its Undo brings the routine back", () => {
    const id = chore();
    expect(send("routine.finish", { routine: id }, { who: fx.agent }).error?.code).toBe(
      "USER_ONLY",
    );
    ok(send("routine.finish", { routine: id }));
    expect(fx.conn.prepare("SELECT lifecycle FROM tasks WHERE id = $id").get({ id })).toEqual({
      lifecycle: "completed",
    });
    expect(send("routine.done", { routine: id }).error?.code).toBe("INVALID_TRANSITION");
    ok(send("undo", {}));
    expect(fx.conn.prepare("SELECT lifecycle FROM tasks WHERE id = $id").get({ id })).toEqual({
      lifecycle: "active",
    });
    ok(send("routine.done", { routine: id }));
  });

  test("a task becomes a routine you do with its reference and notes, unless it has subtasks or a task above", () => {
    const made = ok(
      send("tasks.add", {
        tasks: [
          { title: "Water the plants", due: { date: "2026-12-03" }, inbox: true },
          { title: "Plan the garden" },
        ],
      }),
    ) as { tasks: { id: string; ref: string }[] };
    const [plants, garden] = made.tasks.map((x) => x.id) as [string, string];
    ok(send("note.add", { on: plants, body: "The fern needs less." }));
    ok(send("tasks.add", { tasks: [{ title: "Buy seeds", under: garden }] }));
    const said = ok(
      send("routine.set", { task: made.tasks[0]?.ref, rule: "FREQ=WEEKLY;BYDAY=SA", tz: ZONE }),
    ) as { routine: { id: string; ref: string; due: unknown } };
    expect(said.routine).toEqual({
      id: plants,
      ref: made.tasks[0]?.ref,
      due: { due_date: "2026-12-05", due_at: null },
    });
    expect(
      fx.conn
        .prepare(
          "SELECT n.kind, t.due_date, t.inbox FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
        )
        .get({ id: plants }),
    ).toEqual({ kind: "routine", due_date: null, inbox: 0 });
    expect(
      fx.conn.prepare("SELECT count(*) AS n FROM notes WHERE owner_id = $id").get({ id: plants }),
    ).toEqual({ n: 1 });
    ok(send("routine.done", { routine: plants }));
    holds(plants, "2026-12-12", ["2026-12-05 done"]);
    const refused = (task: unknown) =>
      send("routine.set", { task, rule: "FREQ=DAILY", tz: ZONE }).error;
    expect(refused(garden)).toMatchObject({ code: "VALIDATION_FAILED", field: "task" });
    const below = String(
      fx.conn.prepare("SELECT id FROM nodes WHERE parent_id = $id").get({ id: garden })?.["id"],
    );
    expect(refused(below)).toMatchObject({ code: "VALIDATION_FAILED", field: "task" });
    expect(refused(plants)).toMatchObject({ code: "NOT_FOUND", field: "task" });
  });

  test("an extra time is an entry without a due time, and the open time stays", () => {
    const id = chore();
    now = t(3);
    ok(send("routine.done", { routine: id, extra: true }));
    expect(entries(id)).toEqual([
      { due_date: null, due_at: null, state: "done", why: null, run_id: null, note: null },
    ]);
    expect(open(id)).toEqual({ due_date: "2026-12-05", due_at: null });
    ok(send("routine.done", { routine: id }));
    expect(open(id)).toEqual({ due_date: "2026-12-12", due_at: null });
  });

  test("the Trash pauses a routine, and Restore or Undo brings it back paused", () => {
    const id = chore();
    ok(send("nodes.trash", { task: id }));
    expect(routine(id)["paused"]).toBe(1);
    expect(send("routine.resume", { routine: id }).error?.code).toBe("DELETED");
    ok(send("undo", {}));
    expect(routine(id)["paused"]).toBe(1);
    ok(send("nodes.trash", { task: id }));
    ok(send("nodes.restore", { task: id }));
    expect(routine(id)["paused"]).toBe(1);
    ok(send("routine.resume", { routine: id }));
  });

  test("an agent's routine is the person's to make, change, pause and switch on", () => {
    const made = send(
      "routine.set",
      {
        title: "Tidy the library",
        rule: "FREQ=MONTHLY;BYMONTHDAY=1",
        tz: ZONE,
        instance: "codex-work",
        instruction: "Tidy the library.",
      },
      { who: fx.agent },
    );
    expect(made.error?.code).toBe("USER_ONLY");
    const own = chore();
    const id = daily();
    for (const [command, input] of [
      ["routine.set", { routine: id, rule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0" }],
      ["routine.pause", { routine: id }],
    ] as const) {
      expect(send(command, input, { who: fx.agent }).error?.code).toBe("USER_ONLY");
    }
    expect(routine(id)["enabled_by"]).toBe(fx.human.principal_id);
    // An agent may set the schedule of a routine the person does.
    ok(send("routine.set", { routine: own, rule: "FREQ=WEEKLY;BYDAY=SU" }, { who: fx.agent }));
  });

  test("the claim: once its time has passed, never while its run is queued or working or a question waits", () => {
    const id = daily();
    now = t(7, "06:30");
    expect(claimNow(id).result).toMatchObject({ claimed: false, why: "not_due" });
    // Only the service claims, as the person who switched the routine on.
    now = t(7, "07:00") + 30_000;
    expect(claimNow(id, { who: { ...service, origin: "mcp" } }).error?.field).toBe("routine");
    expect(claimNow(id, { who: { ...fx.agent, origin: "system" } }).error?.field).toBe(
      "actor.principal_id",
    );
    const first = ok(claimNow(id)) as { run: { id: string }; due: unknown };
    expect(first.due).toEqual({ due_date: "2026-12-07", due_at: t(7, "07:00") });
    const [run] = runs(id);
    expect(run).toMatchObject({
      id: first.run.id,
      attempt: 1,
      request: "Read the new mail into tasks.",
    });
    expect(JSON.parse(String(run?.["spec"]))).toMatchObject({ due_at: t(7, "07:00") });
    expect(claimNow(id).result).toMatchObject({ claimed: false, why: "working" });
    move(first.run.id, "queued", "starting");
    move(first.run.id, "starting", "running");
    now += MINUTE;
    expect(claimNow(id).result).toMatchObject({ claimed: false, why: "working" });
    // It ends asking the person: nothing is claimed or skipped while the question waits, also
    // after the next slot has passed.
    move(first.run.id, "running", "failed", { reason: "needs_input" });
    now = t(8, "07:30");
    expect(claimNow(id).result).toMatchObject({ claimed: false, why: "question" });
    expect(entries(id)).toEqual([]);
    expect(open(id)).toEqual({ due_date: "2026-12-07", due_at: t(7, "07:00") });
  });

  test("after a week with the computer off, one claim for the latest time; a failed run's time is skipped", () => {
    const id = daily();
    now = t(14, "08:00");
    const late = ok(claimNow(id)) as { run: { id: string } };
    expect(late).toMatchObject({ due: { due_date: "2026-12-14", due_at: t(14, "07:00") } });
    expect(runs(id)).toHaveLength(1);
    expect(entries(id)).toEqual([]);
    // Its run ends without completing and nobody acts: the next slot logs it skipped and is claimed.
    move(late.run.id, "queued", "starting");
    move(late.run.id, "starting", "running");
    move(late.run.id, "running", "failed", { reason: "agent_error" });
    expect(claimNow(id).result).toMatchObject({ claimed: false, why: "waiting" });
    now = t(15, "07:00") + 30_000;
    ok(claimNow(id));
    expect(entries(id)).toEqual([
      expect.objectContaining({ due_at: t(14, "07:00"), state: "skipped", why: "run_failed" }),
    ]);
    expect(
      runs(id).map((r) => (JSON.parse(String(r["spec"])) as { due_at: number }).due_at),
    ).toEqual([t(14, "07:00"), t(15, "07:00")]);
  });
});
