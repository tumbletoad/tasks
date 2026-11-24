// Undo and redo beside A4's run records (A1 3.6, 3.10, 3.11.4; A4 3.11): a run's commits are never
// on an undo stack, a run keeps its task's create from being undone in any state, an inversion
// never writes a run, so it never re-attaches one that redaction detached, and a space at 0.2,
// which has no runs table, undoes as before. Fixture text only.
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { planInversions, readChanges } from "../src/write/history.ts";
import {
  RequestProblem,
  type Credential,
  type Operation,
  type WriteRequest,
  type WriteResult,
} from "../src/write/request.ts";
import type { RunState } from "../src/write/runs.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import { openSpaceAt, STEPS_0_2 } from "./revisions.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import {
  checkHistory,
  expectStatus,
  MACHINE,
  steppingClock,
  type Fixture,
  fixtureCopies,
} from "./write-helpers.ts";

const temp = tempFolders("undo-runs");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

let fx: Fixture;
let ui: Credential;
beforeEach(async () => {
  fx = await fixture();
  // A run is the person's (R7): the service writes it with the person's UI credential.
  ui = { ...fx.human, scope_id: "ui:fixture", origin: "ui" };
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

type Row = Record<string, unknown>;
const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
const row = (sql: string, params = {}): Row => fx.reader.prepare(sql).get(params) ?? {};
const commitAt = (seq: number): Row => row("SELECT * FROM commits WHERE seq = $seq", { seq });
const changesAt = (seq: number): Row[] =>
  fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq ORDER BY n").all({ seq });
const task = (id: Id<"t">): Row => row("SELECT * FROM tasks WHERE id = $id", { id });
const runRow = (id: string): Row => row("SELECT * FROM runs WHERE id = $id", { id });

function applied(result: WriteResult): WriteResult {
  expectStatus(result, "applied");
  return result;
}

/** The person's write, undoable as the service sends it. */
const write = (ops: Operation[]): WriteResult =>
  fx.writer.submit(fx.request(fx.human, ops, { base: fx.base(), undoable: true }));

function create(): Id<"t"> {
  const id = newId("t");
  applied(write([{ kind: "task.create", id, title: "Fix the export" }]));
  return id;
}

const undo = (extra: { commit?: Id<"op">; partial?: boolean } = {}): WriteResult =>
  fx.writer.submit(fx.request(fx.human, [{ kind: "undo", ...extra }]));
const redo = (extra: { commit?: Id<"op"> } = {}): WriteResult =>
  fx.writer.submit(fx.request(fx.human, [{ kind: "redo", ...extra }]));

/** A run request, as the execution store sends it: never undoable. */
const submitRun = (ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
  fx.writer.submit(fx.request(ui, ops, extra));

function startRun(taskId: Id<"t">, place: Id<"pl"> | null = null): WriteResult {
  return applied(
    submitRun([
      {
        kind: "run.create",
        task: taskId,
        instance: "codex-work",
        adapter: "codex",
        place,
        request: "Check the export and fix the time zone.",
        brief_hash: "a1b2c3d4".repeat(8),
        permission: "full-access",
        limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
      },
    ]),
  );
}

/** A run's own move, which the run machine writes as the run: its start, progress and end. */
const move = (run: string, expect: RunState, next: RunState, more: Row = {}): WriteResult =>
  applied(transition(run, expect, next, more, { ...ui, run_id: run as Id<"ru"> }));

/** The person's Stop of a queued run, which the run machine writes as the person. */
const stop = (run: string): WriteResult => applied(transition(run, "queued", "cancelled", {}, ui));

const transition = (
  run: string,
  expect: RunState,
  next: RunState,
  more: Row,
  by: Credential,
): WriteResult =>
  fx.writer.submit(
    fx.request(by, [
      {
        kind: "run.transition",
        run: run as Id<"ru">,
        expect,
        expect_version: Number(runRow(run)["version"]),
        next,
        ...more,
      },
    ]),
  );

const RESULT = {
  ok: true,
  outcome: "success",
  exit_code: 0,
  signal: null,
  native_id: "0199a3f2-7c41-7d20-9b6e-3f1c2a4b5d6e",
  text: "Fixed the time zone in the export.",
  error: null,
  usage: { input_tokens: 1200, output_tokens: 300 },
  app_tools: "connected",
  declined: 0,
  permission_denials: 0,
  duration_ms: 64_000,
};

/** A second connection between the writer's requests, for a state no operation of this build makes. */
async function raw(fn: (conn: Connection) => void): Promise<void> {
  const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
  try {
    conn.transaction("immediate", () => {
      fn(conn);
    });
  } finally {
    conn.close();
  }
}

describe("[A1.5.history.runs] undo and redo beside run records", () => {
  test("a run's commits are never on an undo stack, never undone, and refused when named", () => {
    const id = create();
    const mine = applied(write([{ kind: "task.patch", task: id, set: { summary: "Mine" } }]));
    const created = startRun(id);
    const run = String(created.results[0]?.id);
    const started = move(run, "queued", "starting");
    for (const seq of [created.seq, started.seq]) {
      expect(commitAt(seq)["undo_status"]).toBeNull();
    }
    // A run request never joins the stack, and holds run operations only: no commit changes a
    // task and a run together, and no request both moves a run and undoes.
    const step: Operation = {
      kind: "run.transition",
      run: run as Id<"ru">,
      expect: "starting",
      expect_version: Number(runRow(run)["version"]),
      next: "running",
    };
    expect(submitRun([step], { undoable: true }).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "undoable",
    });
    for (const other of [
      { kind: "task.patch", task: id, set: { summary: "Both" } },
      { kind: "undo" },
    ] as Operation[]) {
      expect(submitRun([step, other]).error).toMatchObject({
        code: "VALIDATION_FAILED",
        field: "ops",
      });
      expect(submitRun([other, step]).error).toMatchObject({
        code: "VALIDATION_FAILED",
        field: "ops",
      });
    }
    expect(runRow(run)["state"]).toBe("starting");

    // An undo that names the run's commit is refused, decided and with its receipt: the stack's
    // newest is the person's patch.
    const runCommit = created.commit;
    if (runCommit === undefined) throw new Error("no commit");
    const named = fx.request(fx.human, [{ kind: "undo", commit: runCommit }]);
    const refused = fx.writer.submit(named);
    expect(refused.error).toMatchObject({ code: "INVALID_TRANSITION", field: "commit" });
    expect(fx.writer.submit(named)).toEqual({ ...refused, replayed: true });

    // Undo takes the patch, never the run.
    const u = applied(undo());
    expect(commitAt(u.seq)["undo_of"]).toBe(mine.seq);
    expect(changesAt(u.seq).map((c) => [c["entity"], c["field"]])).toEqual([["tasks", "summary"]]);
    expect(runRow(run)).toMatchObject({ state: "starting", task_id: id });
    // A run's commit between an undo and its redo does not end the redo, and a redo that names it
    // is refused like any commit that is not the next to redo.
    move(run, "starting", "running");
    expect(redo({ commit: runCommit }).error).toMatchObject({
      code: "INVALID_TRANSITION",
    });
    applied(redo());
    expect(task(id)["summary"]).toBe("Mine");

    // The history engine refuses a commit that holds a run's rows whole, as a decided refusal.
    for (const seq of [created.seq, started.seq]) {
      let problem: unknown;
      try {
        planInversions(fx.reader, readChanges(fx.reader, seq), {
          creating: new Set([seq]),
          refPrefix: "M",
          partial: true,
          op: 0,
          principal: fx.human.principal_id,
          applied: () => seq,
        });
      } catch (error) {
        problem = error;
      }
      expect(problem).toBeInstanceOf(RequestProblem);
      expect((problem as RequestProblem).problem.code).toBe("VALIDATION_FAILED");
    }
  });

  test("a run keeps its task's create from being undone, in any state", () => {
    const id = newId("t");
    const made = applied(
      write([
        { kind: "task.create", id, title: "Fix the export" },
        { kind: "note.add", task: id, body: "The zone is lost on import." },
      ]),
    );
    const created = startRun(id);
    const run = String(created.results[0]?.id);
    const refusal = (version: number, state: string): WriteResult => {
      const refused = undo();
      expectStatus(refused, "conflict");
      expect(refused.error?.code).toBe("UNDO_CONFLICT");
      // Named once, by its state, with its newest change and its state now: the person's run.
      expect(refused.conflicts).toEqual([
        expect.objectContaining({
          entity: "runs",
          id: run,
          task: id,
          ref: "M-1",
          field: "state",
          value: expect.objectContaining({ state }) as unknown,
          version,
          by: expect.objectContaining({ actor: fx.human.principal_id, kind: "human" }) as unknown,
        }),
      ]);
      return refused;
    };
    refusal(created.seq, "queued");
    move(run, "queued", "starting");
    const running = move(run, "starting", "running");
    refusal(running.seq, "running");
    const done = move(run, "running", "succeeded", { result: RESULT });
    refusal(done.seq, "succeeded");
    expect(task(id)["deleted_at"]).toBeNull();
    expect(commitAt(made.seq)["undo_status"]).toBe("done");

    // A partial undo takes back the rest of the commit and keeps the task with its run.
    const u = applied(undo({ partial: true }));
    expect(u.conflicts).toEqual([expect.objectContaining({ entity: "runs", id: run })]);
    expect(changesAt(u.seq).map((c) => [c["entity"], c["field"]])).toEqual([["notes", "deleted"]]);
    expect(task(id)["deleted_at"]).toBeNull();
    expect(runRow(run)).toMatchObject({ task_id: id, state: "succeeded" });
    expect(commitAt(made.seq)["undo_status"]).toBe("undone");

    // A run cancelled in the queue holds the person's request too.
    const other = create();
    const queued = String(startRun(other).results[0]?.id);
    stop(queued);
    expect(undo().conflicts).toEqual([expect.objectContaining({ entity: "runs", id: queued })]);
  });

  test("a run the person queued and stopped is theirs: it keeps no Undo or Redo from closing the task", () => {
    // Checked off, reopened, a run queued and stopped while queued, and the reopen undone.
    const done = create();
    applied(write([{ kind: "task.complete", task: done }]));
    applied(write([{ kind: "task.reopen", task: done }]));
    stop(String(startRun(done).results[0]?.id));
    expect(applied(undo()).newer).toBeUndefined();
    expect(task(done)["lifecycle"]).toBe("completed");

    // Archived, the archive undone, a run queued and stopped, and the archive redone.
    const archived = create();
    applied(write([{ kind: "task.archive", task: archived }]));
    applied(undo());
    stop(String(startRun(archived).results[0]?.id));
    applied(redo());
    expect(task(archived)["lifecycle"]).toBe("archived");
  });

  test("a run the person queued is their own: it keeps no Undo or Redo from closing the task or putting it in the Trash", () => {
    // Checked off, reopened, a run queued, and the reopen undone: done again, the run still queued.
    const done = create();
    applied(write([{ kind: "task.complete", task: done }]));
    applied(write([{ kind: "task.reopen", task: done }]));
    const queued = String(startRun(done).results[0]?.id);
    const undone = applied(undo());
    expect(undone.newer).toBeUndefined();
    expect(task(done)["lifecycle"]).toBe("completed");
    expect(runRow(queued)).toMatchObject({ task_id: done, state: "queued" });

    // Archived, the archive undone, a run queued, and the archive redone.
    const archived = create();
    applied(write([{ kind: "task.archive", task: archived }]));
    applied(undo());
    startRun(archived);
    applied(redo());
    expect(task(archived)["lifecycle"]).toBe("archived");

    // In the Trash the same way, as when the person deletes a task with a run queued.
    const trashed = create();
    applied(write([{ kind: "task.delete", task: trashed }]));
    applied(undo());
    startRun(trashed);
    applied(redo());
    expect(task(trashed)["deleted_at"]).not.toBeNull();
  });

  test("a run's own progress since is newer work: the Undo that would close its task again is refused, naming the run", () => {
    const id = create();
    applied(write([{ kind: "task.complete", task: id }]));
    applied(write([{ kind: "task.reopen", task: id }]));
    const run = String(startRun(id).results[0]?.id);
    const started = move(run, "queued", "starting");
    const late = undo();
    expectStatus(late, "conflict");
    expect(late.conflicts).toEqual([
      expect.objectContaining({ entity: "runs", id: run, field: "state", version: started.seq }),
    ]);
    expect(late.newer?.work).toEqual([expect.objectContaining({ task: id, run: true })]);
    expect(task(id)["lifecycle"]).toBe("active");
  });

  test("a run created and advanced since is named by its advance: who, when, and its state now", () => {
    const id = create();
    applied(write([{ kind: "task.delete", task: id }]));
    applied(undo());
    const run = String(startRun(id).results[0]?.id);
    const started = move(run, "queued", "starting");
    const late = redo();
    expectStatus(late, "conflict");
    expect(late.conflicts).toEqual([
      expect.objectContaining({
        entity: "runs",
        id: run,
        field: "state",
        version: started.seq,
        value: expect.objectContaining({ state: "starting" }) as unknown,
      }),
    ]);
  });

  test("Undo of a redone restore counts only what changed after the Redo", () => {
    const id = create();
    const run = String(startRun(id).results[0]?.id);
    applied(write([{ kind: "task.delete", task: id }]));
    applied(write([{ kind: "task.restore", task: id }]));
    applied(undo());
    // The run makes progress while its task is in the Trash; the person then brings it back.
    move(run, "queued", "starting");
    applied(redo());
    expect(task(id)["deleted_at"]).toBeNull();
    applied(undo());
    expect(task(id)["deleted_at"]).not.toBeNull();
  });

  test("a task its create's undo tombstoned takes no run, and its redo brings it back without one", () => {
    const id = create();
    applied(undo());
    expect(
      submitRun([
        {
          kind: "run.create",
          task: id,
          instance: "codex-work",
          adapter: "codex",
          place: null,
          request: "Check the export.",
          brief_hash: "a1b2c3d4".repeat(8),
          permission: "full-access",
          limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
        },
      ]).error,
    ).toMatchObject({ code: "DELETED", field: "task" });
    applied(redo());
    expect(one("SELECT count(*) FROM runs")).toBe(0);
    startRun(id);
    expect(undo().error?.code).toBe("UNDO_CONFLICT");
  });

  test("an undo and a redo never re-attach a run that redaction detached", async () => {
    const id = newId("t");
    const made = applied(
      write([
        { kind: "task.create", id, title: "Fix the export" },
        { kind: "place.set", task: id, root: "home", path: "garden" },
      ]),
    );
    const place = String(one("SELECT id FROM places WHERE owner_id = $id", { id }));
    const run = String(startRun(id, place as Id<"pl">).results[0]?.id);
    // Entity redaction (A1 3.11.4, M3.14) detaches the run: no task, no place of the task, no
    // request. This is the part of it the run's row takes.
    await raw((conn) => {
      conn
        .prepare("UPDATE runs SET task_id = NULL, place_id = NULL, request = NULL WHERE id = $run")
        .run({ run });
    });
    const detached = runRow(run);

    // A detached run names no task, so it keeps no create: the undo takes back the task and its
    // place, and the run stays exactly as it was.
    const u = applied(undo());
    expect(commitAt(u.seq)["undo_of"]).toBe(made.seq);
    expect(task(id)["deleted_at"]).not.toBeNull();
    expect(runRow(run)).toEqual(detached);
    const r = applied(redo());
    expect(task(id)["deleted_at"]).toBeNull();
    expect(row("SELECT deleted_at FROM places WHERE id = $place", { place })).toEqual({
      deleted_at: null,
    });
    expect(runRow(run)).toEqual(detached);
    // Neither commit wrote a run row.
    for (const seq of [u.seq, r.seq]) {
      expect(changesAt(seq).filter((c) => c["entity"] === "runs")).toEqual([]);
    }
    // The detached run still settles.
    stop(run);
    expect(runRow(run)).toMatchObject({ task_id: null, place_id: null, state: "cancelled" });
  });

  test("a session bound to the task holds no task text and keeps no create", async () => {
    const id = create();
    const session = "se_0000000000000000000000000s";
    // No operation writes a session yet (A1 3.4): a row as binding will write it.
    await raw((conn) => {
      conn
        .prepare(
          "INSERT INTO sessions (id, task_id, kind, instance_id, machine_id, state, created_at, " +
            "created_seq, version) VALUES ($session, $task, 'interactive', 'codex-work', " +
            "$machine, 'live', 0, 1, 1)",
        )
        .run({ session, task: id, machine: TEST_MACHINE });
    });
    const before = row("SELECT * FROM sessions WHERE id = $session", { session });
    applied(undo());
    expect(task(id)["deleted_at"]).not.toBeNull();
    applied(redo());
    expect(row("SELECT * FROM sessions WHERE id = $session", { session })).toEqual(before);
    // The fixture row has no history of its own: the history check covers written rows only.
    await raw((conn) => {
      conn.prepare("DELETE FROM sessions WHERE id = $session").run({ session });
    });
  });

  test("a space at 0.2 has no runs table and undoes and redoes as before it", async () => {
    const created = await createFixtureSpace(temp.make(), "mira", {}, STEPS_0_2);
    const checked = await checkedDriver();
    const writer = SpaceWriter.open(
      openSpaceAt(checked, created.folder, { role: "writer" }, STEPS_0_2),
      { machine: MACHINE, now: steppingClock() },
    );
    const reader = openSpaceAt(checked, created.folder, { role: "reader" }, STEPS_0_2).conn;
    try {
      expect(
        reader.prepare("SELECT name FROM sqlite_schema WHERE name IN ('runs', 'sessions')").all(),
      ).toEqual([]);
      const human: Credential = {
        scope_id: "cli:fixture",
        principal_id: created.actors.human,
        actor_kind: "human",
        machine_id: TEST_MACHINE,
        origin: "cli",
      };
      let n = 0;
      const send = (ops: Operation[], extra: Partial<WriteRequest> = {}): WriteResult =>
        writer.submit({
          space_id: created.space.spaceId,
          request_id: `undo-runs-0-2-${String((n += 1)).padStart(6, "0")}`,
          actor: human,
          ops,
          ...extra,
        });
      const id = newId("t");
      applied(send([{ kind: "task.create", id, title: "Fix the export" }], { undoable: true }));
      applied(send([{ kind: "undo" }]));
      const deleted = (): unknown =>
        reader.prepare("SELECT deleted_at FROM tasks WHERE id = $id").get({ id })?.["deleted_at"];
      expect(deleted()).not.toBeNull();
      applied(send([{ kind: "redo" }]));
      expect(deleted()).toBeNull();
      checkHistory(reader);
    } finally {
      reader.close();
      writer.close();
    }
  });
});
