// Routines on the tree writer, as a person and the service use them: a weekly chore checked off
// early, late after two missed Saturdays, skipped, paused and resumed, undone, finished for good and
// put in the Trash; an agent's daily routine claimed by the service once its time has passed, never
// twice, retried after a start that failed, done for its own due time, checked off by the person
// and run once after a week with the computer off. The clock is one the tests move. Fixture text
// only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId } from "../src/ids.ts";
import { TreeWriter, type TreeActor, type TreeResult } from "../src/tree/core.ts";
import { claimRequestId, RETRY_MS } from "../src/tree/routines.ts";
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

  test("the weekly chore: checked off early, late after two missed Saturdays, and skipped", () => {
    const id = chore();
    // Watered on Friday: Saturday's time is done and the next Saturday comes.
    now = t(4);
    expect(ok(send("routine.done", { routine: id }))["routine"]).toMatchObject({
      due: { due_date: "2026-12-12", due_at: null },
    });
    // Two Saturdays pass unchecked: the open time stays the first of them, and one check-off logs
    // one entry and moves to the next Saturday after now.
    now = t(23);
    expect(open(id)).toEqual({ due_date: "2026-12-12", due_at: null });
    ok(send("routine.done", { routine: id }));
    expect(open(id)).toEqual({ due_date: "2026-12-26", due_at: null });
    now = t(26);
    ok(send("routine.skip", { routine: id }));
    expect(open(id)).toEqual({ due_date: "2027-01-02", due_at: null });
    expect(entries(id)).toEqual([
      expect.objectContaining({ due_date: "2026-12-05", state: "done", why: null }),
      expect.objectContaining({ due_date: "2026-12-12", state: "done", why: null }),
      expect.objectContaining({ due_date: "2026-12-26", state: "skipped", why: "you" }),
    ]);
    // A stale second click is held to what the person saw.
    const seen = fx.asOf();
    now = t(27);
    ok(send("routine.done", { routine: id }, { base: seen }));
    expect(send("routine.done", { routine: id }, { base: seen }).status).toBe("conflict");
    // It is found as a task is, holds notes, and is no task: no task command takes it and it holds
    // no task.
    expect(searchTree(fx.conn, "plants")).toEqual([{ kind: "task", entityId: id, nodeId: id }]);
    ok(send("note.add", { on: id, body: "The fern needs less." }));
    expect(send("task.finish", { task: id }).error?.code).toBe("NOT_FOUND");
    expect(send("tasks.add", { tasks: [{ title: "Buy soil", under: id }] }).error?.field).toBe(
      "tasks.0.under",
    );
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

  test("a retried start: a second start replays the claim, and a start that failed is tried again", () => {
    const id = daily();
    now = t(7, "07:00") + 30_000;
    const due = t(7, "07:00");
    const request_id = claimRequestId(id, due, 1);
    const first = ok(claimNow(id, { request_id })) as { run: { id: string } };
    expect(claimNow(id, { request_id })).toMatchObject({ status: "applied", replayed: true });
    expect(runs(id)).toHaveLength(1);
    move(first.run.id, "queued", "starting");
    move(first.run.id, "starting", "failed", { reason: "spawn_failed" });
    now += 4 * MINUTE;
    expect(claimNow(id, { request_id: claimRequestId(id, due, 2) }).result).toMatchObject({
      claimed: false,
      why: "waiting",
    });
    now += RETRY_MS;
    const second = ok(claimNow(id, { request_id: claimRequestId(id, due, 2) + "x" })) as {
      run: { id: string };
    };
    expect(runs(id).map((r) => r["attempt"])).toEqual([1, 2]);
    expect(JSON.parse(String(runs(id)[1]?.["spec"]))).toMatchObject({ due_at: due });
    expect(second.run.id).not.toBe(first.run.id);
  });

  test("a run's done is bound to its own due time, also when the next time has come", () => {
    const id = daily();
    now = t(7, "07:00") + 30_000;
    const claimed = ok(claimNow(id)) as { run: { id: string } };
    move(claimed.run.id, "queued", "starting");
    move(claimed.run.id, "starting", "running");
    now = t(8, "07:30");
    const done = (due: number) =>
      send(
        "routine.done",
        { routine: id, run: claimed.run.id, due, note: "Read the mail; added two tasks." },
        { who: { ...fx.agent, run_id: claimed.run.id as never }, base: null },
      );
    expect(done(t(8, "07:00")).error?.field).toBe("due");
    ok(done(t(7, "07:00")));
    expect(entries(id)).toEqual([
      {
        due_date: "2026-12-07",
        due_at: t(7, "07:00"),
        state: "done",
        why: null,
        run_id: claimed.run.id,
        note: "Read the mail; added two tasks.",
      },
    ]);
    // The slot that passed while it worked is the open time now, and the next look claims it once.
    expect(open(id)).toEqual({ due_date: "2026-12-08", due_at: t(8, "07:00") });
    expect(done(t(7, "07:00")).status).toBe("unchanged");
    move(claimed.run.id, "running", "succeeded");
    expect(ok(claimNow(id))["due"]).toEqual({ due_date: "2026-12-08", due_at: t(8, "07:00") });
  });

  test("a check-off by the person logs the time as theirs and cancels the queued run", () => {
    const id = daily();
    now = t(7, "07:00") + 30_000;
    const claimed = ok(claimNow(id)) as { run: { id: string } };
    ok(send("routine.done", { routine: id }));
    expect(entries(id)).toEqual([
      expect.objectContaining({ due_at: t(7, "07:00"), state: "done", run_id: null }),
    ]);
    expect(runs(id)[0]).toMatchObject({ id: claimed.run.id, state: "cancelled" });
    expect(open(id)).toEqual({ due_date: "2026-12-08", due_at: t(8, "07:00") });
    expect(claimNow(id).result).toMatchObject({ claimed: false, why: "not_due" });
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
