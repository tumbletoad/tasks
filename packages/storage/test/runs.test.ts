// The run records' operations (A4 3.11, 3.16; A7 3.13 M6.01): run.create and run.transition
// through the write path, with their checks, history, receipts and reads. The execution store's
// contract suite runs in packages/launch against the same operations. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { RUN_EDGES, RUN_REASONS, RUN_SQL, RUN_STATES, type RunState } from "../src/write/runs.ts";
import { TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("runs");
afterAll(temp.cleanup);

let fx: Fixture;
let ui: Credential;
let time: number;
beforeEach(async () => {
  fx = await writeFixture(temp.make());
  time = Date.UTC(2026, 10, 13, 9, 0, 0);
  fx.reopen({ now: () => time });
  ui = { ...fx.human, scope_id: "ui:fixture", origin: "ui" };
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
const lastSeq = (): number => Number(one("SELECT last_seq FROM space"));
const HASH = "a1b2c3d4".repeat(8);
const LIMITS = { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 };

const submit = (ops: Operation[], actor: Credential = ui, extra = {}): WriteResult =>
  fx.writer.submit(fx.request(actor, ops, extra));

function task(): Id<"t"> {
  const id = newId("t");
  expectStatus(submit([{ kind: "task.create", id, title: "Fix the export" }], fx.human), "applied");
  return id;
}

const createOp = (extra: Record<string, unknown> = {}): Operation => ({
  kind: "run.create",
  instance: "codex-work",
  adapter: "codex-exec",
  place: null,
  request: "Check the export\r\nand fix the time zone.",
  brief_hash: HASH,
  permission: "full-access",
  limits: LIMITS,
  ...extra,
});

function create(extra: Record<string, unknown> = { task: task() }): Id<"ru"> {
  const result = submit([createOp(extra)]);
  expectStatus(result, "applied");
  return result.results[0]?.id as Id<"ru">;
}

/** A run.transition on the run's current version, unless `more` names another. */
const move = (
  run: string,
  expect: RunState,
  next: RunState,
  more: Record<string, unknown> = {},
): WriteResult =>
  submit([
    {
      kind: "run.transition",
      run: run as Id<"ru">,
      expect,
      expect_version: fx.writer.run(run)?.version ?? 1,
      next,
      ...more,
    },
  ]);

const RESULT = {
  ok: true,
  outcome: "success",
  exit_code: 0,
  signal: null,
  native_id: "0199a3f2-7c41-7d20-9b6e-3f1c2a4b5d6e",
  text: "Fixed the time zone in the export.",
  error: null,
  usage: { input_tokens: 1200, output_tokens: 300, cost_usd: 0.02 },
  app_tools: "connected",
  declined: 0,
  permission_denials: 0,
  duration_ms: 64_000,
};

describe("[A1.5.write.runs] run records through the write path", () => {
  test("run.create writes a queued record, its history and its receipt, and changes no task", () => {
    const taskId = task();
    const before = fx.reader
      .prepare("SELECT version, touched FROM tasks WHERE id = $id")
      .get({ id: taskId });
    const outbox = Number(one("SELECT count(*) FROM outbox"));
    const result = submit([createOp({ task: taskId })]);
    expectStatus(result, "applied");
    const id = result.results[0]?.id ?? "";
    expect(result.results[0]).toMatchObject({ status: "created", version: lastSeq() });
    expect(fx.writer.run(id)).toEqual({
      id,
      task_id: taskId,
      routine_id: null,
      session_id: null,
      instance_id: "codex-work",
      machine_id: TEST_MACHINE,
      adapter: "codex-exec",
      place_id: null,
      // Stored as A1 3.7 normalises every text.
      request: "Check the export\nand fix the time zone.",
      spec: { brief_hash: HASH, permission: "full-access", limits: LIMITS },
      state: "queued",
      reason: null,
      attempt: 1,
      evidence: {},
      at: { queued: time },
      result: null,
      queued_at: time,
      started_at: null,
      ended_at: null,
      version: lastSeq(),
    });
    // One create change, which carries no task: a run is not a child of its task.
    const changes = fx.reader
      .prepare("SELECT entity, action, task_id FROM changes WHERE seq = $seq")
      .all({ seq: lastSeq() });
    expect(changes).toEqual([{ entity: "runs", action: "create", task_id: null }]);
    expect(
      fx.reader.prepare("SELECT version, touched FROM tasks WHERE id = $id").get({ id: taskId }),
    ).toEqual(before);
    expect(Number(one("SELECT count(*) FROM outbox"))).toBe(outbox);
    expect(
      one("SELECT json_extract(ops, '$[0].op') FROM commits WHERE seq = $s", { s: lastSeq() }),
    ).toBe("run.create");
  });

  test("a routine's run has no task; a run needs a task or a routine, never both", () => {
    const routine = newId("ro");
    const id = create({ routine, request: undefined, limits: { ...LIMITS, max_turns: 150 } });
    expect(fx.writer.run(id)).toMatchObject({ task_id: null, routine_id: routine, request: null });
    // A task's run takes the person's instruction; a routine's takes none (A4 3.11.7).
    expect(submit([createOp({ task: task(), request: undefined })]).error).toMatchObject({
      field: "ops[0].request",
    });
    expect(submit([createOp({ routine })]).error).toMatchObject({ field: "ops[0].request" });
    for (const extra of [{}, { task: task(), routine }]) {
      const refused = submit([createOp(extra)]);
      expectStatus(refused, "rejected");
      expect(refused.error).toMatchObject({ code: "VALIDATION_FAILED", field: "ops[0].task" });
    }
  });

  test("a run moves along A4's edges: claim, start, evidence, result and times", () => {
    const id = create();
    expectStatus(move(id, "queued", "starting"), "applied");
    time += 1_000;
    expectStatus(
      move(id, "starting", "starting", { evidence: { claim: "claim-1", claimed_at: time } }),
      "applied",
    );
    time += 1_000;
    expectStatus(
      move(id, "starting", "running", { evidence: { pid: 4242, pid_started_at: time } }),
      "applied",
    );
    const started = time;
    time += 1_000;
    expectStatus(
      move(id, "running", "running", { evidence: { native_id: "thread-1" } }),
      "applied",
    );
    time += 60_000;
    expectStatus(move(id, "running", "succeeded", { result: RESULT }), "applied");
    expect(fx.writer.run(id)).toMatchObject({
      state: "succeeded",
      reason: null,
      evidence: {
        claim: "claim-1",
        claimed_at: started - 1_000,
        pid: 4242,
        pid_started_at: started,
        native_id: "thread-1",
      },
      at: {
        queued: started - 2_000,
        starting: started - 2_000,
        running: started,
        succeeded: time,
      },
      result: RESULT,
      started_at: started,
      ended_at: time,
    });
    // A transition that changes nothing commits nothing.
    const seq = lastSeq();
    expectStatus(move(id, "succeeded", "succeeded"), "rejected");
    expect(lastSeq()).toBe(seq);
  });

  test("the compare-and-set refuses a stale state or version, other evidence and a second result", () => {
    const id = create();
    expectStatus(move(id, "queued", "starting"), "applied");
    const version = fx.writer.run(id)?.version ?? 0;
    expect(move(id, "queued", "starting").error).toMatchObject({
      code: "INVALID_TRANSITION",
      field: "expect",
    });
    expectStatus(move(id, "starting", "starting", { evidence: { claim: "claim-1" } }), "applied");
    expect(move(id, "starting", "running", { expect_version: version }).error).toMatchObject({
      code: "INVALID_TRANSITION",
      field: "expect_version",
    });
    // A Stop decided on the unclaimed record is refused once the claim moved its version, even with
    // the state unchanged, and a transition without a version is refused outright.
    expect(move(id, "starting", "cancelled", { expect_version: version }).error).toMatchObject({
      code: "INVALID_TRANSITION",
      field: "expect_version",
    });
    const unversioned = submit([
      { kind: "run.transition", run: id, expect: "starting", next: "cancelled" } as never,
    ]);
    expect(unversioned.error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "ops[0].expect_version",
    });
    expect(fx.writer.run(id)?.state).toBe("starting");
    expect(
      move(id, "starting", "starting", { evidence: { claim: "claim-2" } }).error,
    ).toMatchObject({ code: "INVALID_TRANSITION", field: "evidence.claim" });
    // The same evidence again is no change.
    expectStatus(move(id, "starting", "starting", { evidence: { claim: "claim-1" } }), "unchanged");
    expectStatus(move(id, "starting", "unknown", { reason: "lost" }), "applied");
    expectStatus(
      move(id, "unknown", "failed", { reason: "agent_error", result: { ...RESULT, ok: false } }),
      "applied",
    );
    const settled = fx.writer.run(id);
    expect(settled).toMatchObject({ state: "failed", reason: "agent_error" });
    expect(settled?.result?.ok).toBe(false);
  });

  test("only A4's edges, a reason exactly when entering failed, timed_out or unknown, a result only entering a final state", () => {
    const id = create();
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        if (RUN_EDGES[from].includes(to)) continue;
        const refused = move(id, from, to);
        expect(refused.error, `${from} -> ${to}`).toMatchObject({
          code: "VALIDATION_FAILED",
          field: "next",
        });
      }
    }
    expectStatus(move(id, "queued", "starting"), "applied");
    expect(move(id, "starting", "failed").error).toMatchObject({ field: "reason" });
    expect(move(id, "starting", "failed", { reason: "wall" }).error).toMatchObject({
      field: "reason",
    });
    expect(move(id, "starting", "running", { reason: "lost" }).error).toMatchObject({
      field: "reason",
    });
    expect(move(id, "starting", "running", { result: RESULT }).error).toMatchObject({
      field: "result",
    });
    expect(move(newId("ru"), "starting", "running").error).toMatchObject({
      code: "NOT_FOUND",
      field: "run",
    });
    expect(move(id, "starting", "cancelled", { result: RESULT }).error).toBeUndefined();
    expect(Object.keys(RUN_REASONS).sort()).toEqual(["failed", "timed_out", "unknown"]);
  });

  test("a run request holds IDs, codes and its own texts only, from a person or the system", () => {
    const taskId = task();
    const refused = (ops: Operation[], extra = {}, actor = ui): string | undefined => {
      const result = submit(ops, actor, extra);
      expectStatus(result, "rejected");
      return result.error?.field;
    };
    expect(refused([createOp({ task: taskId })], {}, fx.codex)).toBe("actor.actor_kind");
    expect(refused([createOp({ task: taskId })], { undoable: true })).toBe("undoable");
    expect(refused([createOp({ task: taskId })], { reason: "Because" })).toBe("reason");
    expect(
      refused([createOp({ task: taskId }), { kind: "note.add", task: taskId, body: "x" }]),
    ).toBe("ops");
    expect(refused([createOp({ task: taskId, permission: "inherit" })])).toBe("ops[0].permission");
    expect(refused([createOp({ task: taskId, adapter: "t3-thread" })])).toBe("ops[0].adapter");
    expect(refused([createOp({ task: taskId, limits: { ...LIMITS, max_turns: 0 } })])).toBe(
      "ops[0].limits.max_turns",
    );
    expect(refused([createOp({ task: taskId, limits: { ...LIMITS, extra: 1 } })])).toBe(
      "ops[0].limits",
    );
    expect(refused([createOp({ task: taskId, request: "x".repeat(65 * 1024) })])).toBe(
      "ops[0].request",
    );
    const id = create({ task: taskId });
    expectStatus(move(id, "queued", "starting"), "applied");
    const version = fx.writer.run(id)?.version;
    for (const [bad, field] of [
      [{ ...RESULT, cwd: "/home/x" }, "ops[0].result"],
      [{ ...RESULT, signal: "kill me" }, "ops[0].result.signal"],
      [{ ...RESULT, text: "x".repeat(9 * 1024) }, "ops[0].result.text"],
      [{ ...RESULT, usage: { tokens: 1 } }, "ops[0].result.usage"],
      [{ ...RESULT, outcome: "fine" }, "ops[0].result.outcome"],
    ] as const) {
      expect(
        refused([
          {
            kind: "run.transition",
            run: id,
            expect: "starting",
            expect_version: version,
            next: "failed",
            reason: "spawn_failed",
            result: bad,
          } as unknown as Operation,
        ]),
        field,
      ).toBe(field);
    }
    expect(
      refused([
        {
          kind: "run.transition",
          run: id,
          expect: "starting",
          expect_version: version,
          next: "starting",
          evidence: { cwd: "/home/x" },
        } as unknown as Operation,
      ]),
    ).toBe("ops[0].evidence");
  });

  test("a place must be live and this machine's; openRuns lists a machine's open runs oldest first", () => {
    const taskId = task();
    expect(submit([createOp({ task: taskId, place: newId("pl") })]).error).toMatchObject({
      code: "NOT_FOUND",
      field: "place",
    });
    const placed = submit(
      [{ kind: "place.set", task: taskId, root: "work", path: "lumen/portal" }],
      fx.human,
    ).results[0]?.id;
    const a = create({ task: taskId, place: placed });
    expect(fx.writer.run(a)?.place_id).toBe(placed);
    time += 1;
    const b = create({ task: taskId });
    time += 1;
    const c = create({ task: taskId });
    expectStatus(move(c, "queued", "cancelled"), "applied");
    // A stop that timed out stays listed, because a later exit still settles it; a lost run not.
    const stopped = (reason: string): Id<"ru"> => {
      time += 1;
      const id = create({ task: taskId });
      expectStatus(move(id, "queued", "starting"), "applied");
      expectStatus(move(id, "starting", "cancelling"), "applied");
      expectStatus(move(id, "cancelling", "unknown", { reason }), "applied");
      return id;
    };
    const waits = stopped("stop_timed_out");
    stopped("lost");
    expect(fx.writer.openRuns(TEST_MACHINE).map((r) => r.id)).toEqual([a, b, waits]);
    expect(fx.writer.openRuns(newId("m"))).toEqual([]);
    expect(fx.writer.openRuns("not a machine")).toEqual([]);
    expect(fx.writer.run("not a run")).toBeUndefined();
    // The read uses the partial index 0003 made for it, whose condition it repeats.
    const plan = fx.reader
      .prepare(`EXPLAIN QUERY PLAN ${RUN_SQL.open}`)
      .all<{ detail: string }>({ machine: TEST_MACHINE })
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("USING INDEX runs_open");
  });

  test("a repeated run.create replays its run, and the request ID with other input is refused", () => {
    const taskId = task();
    const request = fx.request(ui, [createOp({ task: taskId })]);
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    const again = fx.writer.submit(request);
    expect(again.results[0]?.id).toBe(first.results[0]?.id);
    const other = fx.writer.submit({ ...request, ops: [createOp({ task: taskId, request: "x" })] });
    expect(other.error).toMatchObject({ code: "REQUEST_ID_REUSED" });
  });
});
