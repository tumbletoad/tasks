// The launch records' operations (A4 3.9, 3.16; A7 3.9 M2.05): launch.create and
// launch.transition through the write path, with their checks, history, receipts and reads. The
// execution store's contract suite runs in packages/launch against the same operations. Fixture
// text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { isLaunchRef, LAUNCH_EDGES } from "../src/write/launches.ts";
import {
  LAUNCH_STATES,
  type Credential,
  type LaunchState,
  type Operation,
  type WriteResult,
} from "../src/write/request.ts";
import { TEST_MACHINE, tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, type Fixture, fixtureCopies } from "./write-helpers.ts";

const temp = tempFolders("launches");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

let fx: Fixture;
let ui: Credential;
let time: number;
beforeEach(async () => {
  fx = await fixture();
  time = Date.UTC(2026, 10, 13, 9, 0, 0);
  fx.reopen({ now: () => time });
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
const lastSeq = (): number => Number(one("SELECT last_seq FROM space"));
const HASH = "a1b2c3d4".repeat(8);

const submit = (ops: Operation[], actor: Credential = ui, extra = {}): WriteResult =>
  fx.writer.submit(fx.request(actor, ops, extra));

function task(): Id<"t"> {
  const id = newId("t");
  expectStatus(submit([{ kind: "task.create", id, title: "Fix the export" }], fx.human), "applied");
  return id;
}

const createOp = (taskId: string, extra: Partial<Operation> = {}): Operation =>
  ({
    kind: "launch.create",
    task: taskId,
    instance: "codex-work",
    route: "terminal",
    place: null,
    task_version: 3,
    brief_hash: HASH,
    ...extra,
  }) as Operation;

function create(taskId = task(), extra: Partial<Operation> = {}): Id<"la"> {
  const result = submit([createOp(taskId, extra)]);
  expectStatus(result, "applied");
  return result.results[0]?.id as Id<"la">;
}

const move = (
  launch: string,
  expect: LaunchState,
  next: LaunchState,
  more: {
    reason?: string;
    evidence?: Record<string, string | number | boolean>;
    expect_version?: number;
  } = {},
): WriteResult =>
  submit([{ kind: "launch.transition", launch: launch as Id<"la">, expect, next, ...more }]);

describe("[A1.5.write.launches] launch records through the write path", () => {
  test("launch.create writes a Prepared record with a reference, its history and its receipt", () => {
    const taskId = task();
    const before = row("SELECT version, touched FROM tasks WHERE id = $id", { id: taskId });
    const outbox = Number(one("SELECT count(*) FROM outbox"));
    const result = submit([createOp(taskId, { evidence: { folder_id: "2049:131077" } })]);
    expectStatus(result, "applied");
    const id = result.results[0]?.id ?? "";
    expect(result.results[0]).toMatchObject({ status: "created", version: lastSeq() });
    const launch = fx.writer.launch(id);
    expect(launch).toMatchObject({
      task_id: taskId,
      session_id: null,
      instance_id: "codex-work",
      machine_id: TEST_MACHINE,
      route: "terminal",
      place_id: null,
      task_version: 3,
      brief_hash: HASH,
      state: "prepared",
      reason: null,
      evidence: { folder_id: "2049:131077" },
      at: { prepared: time },
      created_at: time,
      updated_at: time,
      version: lastSeq(),
    });
    expect(isLaunchRef(launch?.reference)).toBe(true);
    // One create change, which carries no task: a launch is not a child of its task.
    const changes = fx.reader.prepare("SELECT * FROM changes WHERE seq = $seq").all({
      seq: lastSeq(),
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entity: "launches", entity_id: id, action: "create" });
    expect(changes[0]?.["task_id"]).toBeNull();
    expect(row("SELECT version, touched FROM tasks WHERE id = $id", { id: taskId })).toEqual(
      before,
    );
    expect(Number(one("SELECT count(*) FROM outbox"))).toBe(outbox);
    expect(row("SELECT * FROM commits WHERE seq = $seq", { seq: lastSeq() })).toMatchObject({
      kind: "ops",
      origin: "ui",
      undo_status: null,
    });
    expect(one("SELECT status FROM receipts WHERE seq = $seq", { seq: lastSeq() })).toBe("applied");
  });

  test("a repeated request replays; a second click gets the launch still opening, and only that one", () => {
    const taskId = task();
    const request = fx.request(ui, [createOp(taskId)]);
    const first = fx.writer.submit(request);
    const replay = fx.writer.submit(request);
    expect(replay).toMatchObject({ replayed: true, results: [{ id: first.results[0]?.id }] });
    const seq = lastSeq();
    time += 60_000;
    const focused = submit([createOp(taskId)]);
    expectStatus(focused, "unchanged");
    expect(focused.results[0]).toMatchObject({ id: first.results[0]?.id, status: "unchanged" });
    expect(lastSeq()).toBe(seq);
    const other = submit([createOp(taskId, { instance: "claude-work" })]);
    expect(other.results[0]?.id).not.toBe(first.results[0]?.id);
    const id = first.results[0]?.id ?? "";
    expectStatus(move(id, "prepared", "dispatching"), "applied");
    expect(submit([createOp(taskId)]).results[0]?.id).toBe(id);
    expectStatus(move(id, "dispatching", "dispatched"), "applied");
    expect(submit([createOp(taskId)]).results[0]?.id).toBe(id);
    // Settled: a click at once opens a new session.
    expectStatus(move(id, "dispatched", "confirmed"), "applied");
    const fresh = submit([createOp(taskId)]);
    expectStatus(fresh, "applied");
    expect(fresh.results[0]?.id).not.toBe(id);
    // A link that asked its app holds no click.
    const link = create(taskId, { instance: "claude-link", route: "link" });
    expectStatus(move(link, "prepared", "dispatching"), "applied");
    expectStatus(move(link, "dispatching", "dispatched"), "applied");
    expect(
      submit([createOp(taskId, { instance: "claude-link", route: "link" })]).results[0]?.id,
    ).not.toBe(link);
  });

  test("launch.transition is a compare-and-set that records one change of `state`", () => {
    const id = create();
    time += 1_000;
    const result = move(id, "prepared", "dispatching", { evidence: { grant: "grant-7" } });
    expectStatus(result, "applied");
    const change = row("SELECT * FROM changes WHERE seq = $seq", { seq: lastSeq() });
    expect(change).toMatchObject({
      entity: "launches",
      entity_id: id,
      action: "set",
      field: "state",
    });
    expect(JSON.parse(String(change["after"]))).toMatchObject({
      state: "dispatching",
      reason: null,
      updated_at: time,
    });
    expect(fx.writer.launch(id)).toMatchObject({
      state: "dispatching",
      evidence: { grant: "grant-7" },
      at: { prepared: time - 1_000, dispatching: time },
    });
    const seq = lastSeq();
    const stale = move(id, "prepared", "dispatching");
    expectStatus(stale, "rejected");
    expect(stale.error).toMatchObject({ code: "INVALID_TRANSITION", field: "expect", op: 0 });
    expect(lastSeq()).toBe(seq);
    expect(fx.writer.launch(id)?.state).toBe("dispatching");
    expectStatus(move(id, "dispatching", "unknown", { reason: "lost" }), "applied");
    expect(fx.writer.launch(id)).toMatchObject({ state: "unknown", reason: "lost" });
  });

  test("evidence only grows: a claim is written once, and the same evidence changes nothing", () => {
    const id = create();
    expectStatus(move(id, "prepared", "dispatching"), "applied");
    expectStatus(
      move(id, "dispatching", "dispatched", { evidence: { claim: "claim-1", claimed_at: time } }),
      "applied",
    );
    const seq = lastSeq();
    const again = move(id, "dispatched", "dispatched", { evidence: { claim: "claim-2" } });
    expectStatus(again, "rejected");
    expect(again.error).toMatchObject({ code: "INVALID_TRANSITION", field: "evidence.claim" });
    expectStatus(
      move(id, "dispatched", "dispatched", { evidence: { claim: "claim-1" } }),
      "unchanged",
    );
    expect(lastSeq()).toBe(seq);
    expectStatus(move(id, "dispatched", "dispatched", { evidence: { pid: 31337 } }), "applied");
    expect(fx.writer.launch(id)).toMatchObject({
      state: "dispatched",
      evidence: { claim: "claim-1", claimed_at: time, pid: 31337 },
    });
  });

  test("a transition on the version it read is stale once the record changed", () => {
    const id = create();
    expectStatus(move(id, "prepared", "dispatching"), "applied");
    const read = fx.writer.launch(id)?.version ?? 0;
    expectStatus(
      move(id, "dispatching", "dispatched", {
        evidence: { claim: "claim-1", claimed_at: time },
        expect_version: read,
      }),
      "applied",
    );
    const seq = lastSeq();
    for (const more of [
      { reason: "not_claimed" },
      { evidence: { claim: "claim-1", claimed_at: time } },
    ]) {
      const next = "reason" in more ? "failed" : "dispatched";
      const stale = move(id, "dispatched", next, { ...more, expect_version: read });
      expectStatus(stale, "rejected");
      expect(stale.error).toMatchObject({ code: "INVALID_TRANSITION", field: "expect_version" });
    }
    expect(lastSeq()).toBe(seq);
    const now = fx.writer.launch(id)?.version ?? 0;
    expectStatus(
      move(id, "dispatched", "unknown", { reason: "lost", expect_version: now }),
      "applied",
    );
    const bad = move(id, "unknown", "failed", { reason: "refused", expect_version: -1 });
    expect(bad.error).toMatchObject({ code: "VALIDATION_FAILED", field: "ops[0].expect_version" });
  });

  test("evidence takes A4's keys with their kinds, and a reason comes from its state's list", () => {
    const taskId = task();
    for (const evidence of [
      { prompt: "fix-the-export" },
      { token: "a1b2c3d4e5f6" },
      { pid: "not-a-pid" },
      { claim: 5 },
      { folder_checked: 1 },
      { claimed_at: true },
      { exit_code: 2_147_483_648 },
    ]) {
      const result = submit([createOp(taskId, { evidence })]);
      expectStatus(result, "rejected");
      expect(result.error, JSON.stringify(evidence)).toMatchObject({
        code: "VALIDATION_FAILED",
        field: "ops[0].evidence",
      });
    }
    expect(Number(one("SELECT count(*) FROM launches"))).toBe(0);
    const id = create(taskId);
    for (const reason of ["lost", "made_up"]) {
      const result = move(id, "prepared", "failed", { reason });
      expect(result.error, reason).toMatchObject({ code: "VALIDATION_FAILED", field: "reason" });
    }
    expectStatus(move(id, "prepared", "dispatching"), "applied");
    const wrong = move(id, "dispatching", "unknown", { reason: "expired" });
    expect(wrong.error).toMatchObject({ code: "VALIDATION_FAILED", field: "reason" });
    const text = move(id, "dispatching", "dispatched", { evidence: { prompt: "read-the-task" } });
    expect(text.error).toMatchObject({ code: "VALIDATION_FAILED", field: "ops[0].evidence" });
    expectStatus(move(id, "dispatching", "unknown", { reason: "no_answer" }), "applied");
  });

  test("a launch's state times are the wall clock's, also while commit instants stand still", () => {
    const taskId = task();
    create(taskId);
    time -= 3_600_000;
    const later = create(taskId, { instance: "claude-work" });
    expect(fx.writer.launch(later)).toMatchObject({
      created_at: Number(one("SELECT max(at) FROM commits")),
      at: { prepared: time },
    });
  });

  test("only A4's edges move a launch, and only Failed and Unknown take a reason", () => {
    const paths: Record<LaunchState, [LaunchState, LaunchState, string?][]> = {
      prepared: [],
      dispatching: [["prepared", "dispatching"]],
      dispatched: [
        ["prepared", "dispatching"],
        ["dispatching", "dispatched"],
      ],
      confirmed: [
        ["prepared", "dispatching"],
        ["dispatching", "dispatched"],
        ["dispatched", "confirmed"],
      ],
      failed: [["prepared", "failed", "cancelled"]],
      unknown: [
        ["prepared", "dispatching"],
        ["dispatching", "unknown", "no_answer"],
      ],
    };
    for (const from of LAUNCH_STATES) {
      const id = create(task());
      for (const [a, b, reason] of paths[from]) {
        expectStatus(move(id, a, b, reason === undefined ? {} : { reason }), "applied");
      }
      for (const to of LAUNCH_STATES) {
        if (LAUNCH_EDGES[from].includes(to)) continue;
        const result = move(id, from, to, to === from ? { evidence: { pid: 1 } } : {});
        expectStatus(result, "rejected");
        expect(result.error, `${from} -> ${to}`).toMatchObject({
          code: "VALIDATION_FAILED",
          field: "next",
        });
      }
      expect(fx.writer.launch(id)?.state).toBe(from);
    }
    const id = create();
    for (const [expect_, next, more] of [
      ["prepared", "failed", {}],
      ["prepared", "dispatching", { reason: "expired" }],
    ] as const) {
      const result = move(id, expect_, next, more);
      expectStatus(result, "rejected");
      expect(result.error).toMatchObject({ code: "VALIDATION_FAILED", field: "reason" });
    }
    expect(move(newId("la"), "prepared", "dispatching").error).toMatchObject({
      code: "NOT_FOUND",
      field: "launch",
    });
    expect(fx.writer.launch(id)?.state).toBe("prepared");
  });

  test("R7: an agent cannot write a launch, and a launch is never undoable", () => {
    const taskId = task();
    for (const [actor, extra, field] of [
      [fx.codex, {}, "actor.actor_kind"],
      [ui, { undoable: true }, "undoable"],
    ] as const) {
      const result = submit([createOp(taskId)], actor, extra);
      expectStatus(result, "rejected");
      expect(result.error).toMatchObject({ code: "VALIDATION_FAILED", field });
    }
    expect(Number(one("SELECT count(*) FROM launches"))).toBe(0);
  });

  test("a launch holds IDs and codes only: text, paths and unknown routes are refused", () => {
    const taskId = task();
    for (const [extra, field] of [
      [{ route: "carrier-pigeon" }, "ops[0].route"],
      [{ brief_hash: "not a hash" }, "ops[0].brief_hash"],
      [{ instance: "Codex · work" }, "ops[0].instance"],
      [{ place: "/home/mira/work" }, "ops[0].place"],
      [{ evidence: { title: "Fix the export" } }, "ops[0].evidence"],
      [{ evidence: { "Fix the export": 1 } }, "ops[0].evidence"],
      [{ evidence: { thread: "has spaces in it" } }, "ops[0].evidence"],
      [{ brief: "Read the task" }, "ops[0]"],
    ] as const) {
      const result = submit([createOp(taskId, extra as Partial<Operation>)]);
      expectStatus(result, "rejected");
      expect(result.error).toMatchObject({ code: "VALIDATION_FAILED", field });
      expect(JSON.stringify(result.error)).not.toContain("Fix the export");
    }
    expect(Number(one("SELECT count(*) FROM launches"))).toBe(0);
  });

  test("a launch request stores no free text, whatever field of the request or its operation carries it", () => {
    // Round 3, finding 4: a launch.create whose envelope reason held composer text and a Windows
    // path was applied, and the commit kept the text.
    const taskId = task();
    const launch = create(taskId);
    const SENTINELS = [
      "Sentinel composer text: rewrite the invoice export",
      "C:\\Users\\Sentinel\\Projects\\private-client",
    ];
    const FRAGMENTS = ["Sentinel", "invoice export", "private-client"];
    type Request = Record<string, unknown>;
    const creating = (): Request => ({ ...fx.request(ui, [createOp(taskId)]) });
    const moving = (): Request => ({
      ...fx.request(ui, [
        { kind: "launch.transition", launch, expect: "prepared", next: "dispatching" },
      ]),
    });
    const withOp = (make: () => Request, change: Request): Request => {
      const request = make();
      const [op] = request["ops"] as Request[];
      return { ...request, ops: [{ ...op, ...change }] };
    };
    const withActor = (make: () => Request, change: Request): Request => {
      const request = make();
      return { ...request, actor: { ...(request["actor"] as Request), ...change } };
    };
    const variants: [string, (text: string) => Request][] = [];
    for (const [name, make] of [
      ["create", creating],
      ["transition", moving],
    ] as const) {
      for (const key of ["request_id", "space_id", "reason", "base", "undoable", "note"]) {
        variants.push([`${name}: ${key}`, (text) => ({ ...make(), [key]: text })]);
      }
      variants.push(
        [
          `${name}: intent input`,
          (text) => ({ ...make(), intent: { entry: "launch.open", input: { text } } }),
        ],
        [`${name}: intent entry`, (text) => ({ ...make(), intent: { entry: text, input: {} } })],
      );
      for (const key of [
        "scope_id",
        "earlier_scope_id",
        "principal_id",
        "author_id",
        "session_id",
        "run_id",
        "machine_id",
        "actor_kind",
        "origin",
        "label",
      ]) {
        variants.push([`${name}: actor.${key}`, (text) => withActor(make, { [key]: text })]);
      }
      variants.push(
        [`${name}: an extra key`, (text) => withOp(make, { note: text })],
        [`${name}: evidence value`, (text) => withOp(make, { evidence: { thread: text } })],
        [`${name}: evidence key`, (text) => withOp(make, { evidence: { [text]: 1 } })],
        [`${name}: a claim`, (text) => withOp(make, { evidence: { claim: text } })],
        [
          `${name}: beside an operation that holds text`,
          (text) => {
            const request = make();
            const ops = request["ops"] as Request[];
            return { ...request, ops: [...ops, { kind: "note.add", task: taskId, body: text }] };
          },
        ],
      );
    }
    for (const key of [
      "task",
      "instance",
      "route",
      "place",
      "task_version",
      "brief_hash",
      "session",
    ]) {
      variants.push([`create: ${key}`, (text) => withOp(creating, { [key]: text })]);
    }
    for (const key of ["launch", "expect", "next", "expect_version", "reason"]) {
      variants.push([`transition: ${key}`, (text) => withOp(moving, { [key]: text })]);
    }
    /** Every value of every table, as text. */
    const stored = (): string =>
      fx.reader
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((table) => {
          const rows = fx.reader.prepare(`SELECT * FROM "${String(table["name"])}"`).all();
          return rows
            .flatMap((r) => Object.values(r))
            .map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v)))
            .join("\n");
        })
        .join("\n");
    for (const text of SENTINELS) {
      for (const [name, variant] of variants) {
        const result = fx.writer.submit(variant(text));
        expect(result.status, name).toBe("rejected");
        expect(JSON.stringify(result), name).not.toContain("Sentinel");
      }
    }
    const everything = stored();
    for (const fragment of FRAGMENTS) expect(everything).not.toContain(fragment);
    // The same request without the sentinels is applied, and the scan sees text that is stored.
    expectStatus(fx.writer.submit(moving()), "applied");
    expectStatus(submit([{ kind: "task.create", title: SENTINELS[0] ?? "" }], fx.human), "applied");
    expect(stored()).toContain("Sentinel");
  });

  test("the task, the place and the machine are checked", () => {
    const missing = submit([createOp(newId("t"))]);
    expect(missing.error).toMatchObject({ code: "NOT_FOUND", field: "task" });
    const taskId = task();
    const noPlace = submit([createOp(taskId, { place: newId("pl") })]);
    expect(noPlace.error).toMatchObject({ code: "NOT_FOUND", field: "place" });
    const placed = submit(
      [{ kind: "place.set", task: taskId, root: "work", path: "lumen/portal" }],
      fx.human,
      { base: fx.base() },
    );
    const place = placed.results[0]?.id as Id<"pl">;
    const id = create(taskId, { place });
    expect(fx.writer.launch(id)?.place_id).toBe(place);
    // A launch moves only on the machine that dispatched it (A4 3.16.1).
    const elsewhere = submit(
      [{ kind: "launch.transition", launch: id, expect: "prepared", next: "dispatching" }],
      { ...ui, machine_id: newId("m") },
    );
    expect(elsewhere.error).toMatchObject({ code: "VALIDATION_FAILED", field: "launch" });
  });

  test("one request may create a launch and move it: its writes fold into the create", () => {
    const taskId = task();
    const created = submit([createOp(taskId)]);
    const launch = created.results[0]?.id as Id<"la">;
    const both = submit([
      { kind: "launch.transition", launch, expect: "prepared", next: "dispatching" },
      { kind: "launch.transition", launch, expect: "dispatching", next: "dispatched" },
    ]);
    expectStatus(both, "applied");
    const changes = fx.reader
      .prepare("SELECT field FROM changes WHERE seq = $seq")
      .all({ seq: lastSeq() });
    expect(changes).toEqual([{ field: "state" }]);
    expect(fx.writer.launch(launch)?.at).toMatchObject({ dispatching: time, dispatched: time });
  });

  test("openLaunches lists a machine's open launches oldest first", () => {
    const ids = [0, 1, 2, 3].map(() => {
      time += 1_000;
      return create();
    });
    const [a, b, c, d] = ids as [Id<"la">, Id<"la">, Id<"la">, Id<"la">];
    expectStatus(move(b, "prepared", "dispatching"), "applied");
    expectStatus(move(c, "prepared", "failed", { reason: "cancelled" }), "applied");
    expectStatus(move(d, "prepared", "dispatching"), "applied");
    expectStatus(move(d, "dispatching", "unknown", { reason: "no_answer" }), "applied");
    expect(fx.writer.openLaunches(TEST_MACHINE).map((l) => l.id)).toEqual([a, b]);
    expect(fx.writer.openLaunches(newId("m"))).toEqual([]);
    expect(fx.writer.openLaunches("not a machine")).toEqual([]);
    expect(fx.writer.launch("la_not-an-id")).toBeUndefined();
  });
});
