// Receipts (A1 3.7, 3.8, X12; A7 3.8 M1.05): every request the writer decides gets one durable
// receipt, keyed by its writer scope and request ID, in the request's own transaction. A retry
// with the same intent returns the stored result, whatever the state is now. Fixture text only.
import { join } from "node:path";
import { ReceiptGetResult, receiptResult } from "@ttasks/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { StorageError } from "../src/errors.ts";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { openSpace } from "../src/space.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { intentFingerprint, readReceipt } from "../src/write/receipts.ts";
import {
  WRITE_LIMITS,
  type Operation,
  type WriteRequest,
  type WriteResult,
} from "../src/write/request.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import {
  checkHistory,
  expectStatus,
  MACHINE,
  type Fixture,
  fixtureCopies,
} from "./write-helpers.ts";

const temp = tempFolders("receipts");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

const one = (sql: string, params = {}): unknown =>
  Object.values(fx.reader.prepare(sql).get(params) ?? {})[0];
const lastSeq = (): unknown => one("SELECT last_seq FROM space");
const receipts = (): unknown => one("SELECT count(*) FROM receipts");
const title = (id: string): unknown => one("SELECT title FROM tasks WHERE id = $id", { id });

/** A fresh request from Mira with the current base. */
const fresh = (ops: Operation[], extra: Partial<WriteRequest> = {}): WriteRequest =>
  fx.request(fx.human, ops, { base: fx.base(), ...extra });

/** Creates a task and returns its ID. */
function create(name = "Fix the export"): Id<"t"> {
  const id = newId("t");
  expectStatus(fx.writer.submit(fresh([{ kind: "task.create", id, title: name }])), "applied");
  return id;
}

/** The result a replay returns: the stored result, marked replayed. */
const replayOf = (result: WriteResult): WriteResult => ({ ...result, replayed: true });

describe("[A1.5.write.receipts] a repeated request ID returns the stored result", () => {
  test("an applied request, retried, returns its stored result and applies once", () => {
    const request = fresh([{ kind: "task.create", title: "Fix the export" }]);
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    const seq = lastSeq();
    // The same request again, and again with a newer base: the base is not part of the intent.
    expect(fx.writer.submit(request)).toEqual(replayOf(first));
    create("Book the dentist");
    expect(fx.writer.submit({ ...request, base: fx.base() })).toEqual(replayOf(first));
    expect(one("SELECT count(*) FROM tasks WHERE title = 'Fix the export'")).toBe(1);
    expect(lastSeq()).toBe(Number(seq) + 1);
  });

  test("a no-op, retried, returns its stored result", () => {
    const task = create();
    const request = fresh([{ kind: "task.patch", task, set: { title: "Fix the export" } }]);
    const first = fx.writer.submit(request);
    expectStatus(first, "unchanged");
    expect(first.replayed).toBeUndefined();
    const seq = lastSeq();
    expect(fx.writer.submit(request)).toEqual(replayOf(first));
    // A no-op writes only its receipt: no commit and no new seq (A1 3.8).
    expect(lastSeq()).toBe(seq);
    expect(one("SELECT seq FROM receipts WHERE request_id = $id", { id: request.request_id })).toBe(
      null,
    );
  });

  test("a different intent under the same request ID is REQUEST_ID_REUSED and writes nothing", () => {
    const task = create();
    const request = fresh([{ kind: "task.patch", task, set: { title: "Review the export" } }]);
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    const [seq, count] = [lastSeq(), receipts()];
    const other = fx.writer.submit({
      ...request,
      ops: [{ kind: "task.patch", task, set: { title: "Plan the offsite" } }],
    });
    expectStatus(other, "rejected");
    expect(other.error).toMatchObject({ code: "REQUEST_ID_REUSED", field: "request_id" });
    // The time of the original, which A3 3.5 returns with request_id_conflict.
    expect(other.error?.at).toBe(
      one("SELECT at FROM receipts WHERE request_id = $id", {
        id: request.request_id,
      }),
    );
    expect([lastSeq(), receipts(), title(task)]).toEqual([seq, count, "Review the export"]);
    // A reason is part of the intent too, and the original still replays.
    expectStatus(fx.writer.submit({ ...request, reason: "Another reason" }), "rejected");
    expect(fx.writer.submit(request)).toEqual(replayOf(first));
  });

  test("warnings the caller found before the writer go with an accepted result and replay with it", () => {
    const warning = "set.place: the place has no remote check (PLACE_REMOTE_UNREADABLE).";
    const request = fresh([{ kind: "task.create", title: "Fix the export" }], {
      warnings: [warning],
    });
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    expect(first.warnings).toEqual([warning]);
    // A retry that found none (or others) is the same intent: it gets the stored result.
    expect(fx.writer.submit({ ...request, warnings: [] })).toEqual(replayOf(first));
    const without: WriteRequest = { ...request };
    delete without.warnings;
    expect(fx.writer.submit(without)).toEqual(replayOf(first));
    // A no-op says them too; a refusal does not.
    const task = create();
    const noop = fx.writer.submit(
      fresh([{ kind: "task.patch", task, set: { title: "Fix the export" } }], {
        warnings: [warning],
      }),
    );
    expectStatus(noop, "unchanged");
    expect(noop.warnings).toEqual([warning]);
    const refusal = fx.writer.submit(
      fresh([{ kind: "task.patch", task: newId("t"), set: { title: "Gone" } }], {
        warnings: [warning],
      }),
    );
    expectStatus(refusal, "rejected");
    expect(refusal.warnings).toEqual([]);
    // One per operation at most, as many as a request may hold.
    const full = fx.writer.submit(
      fresh([{ kind: "task.create", title: "Full" }], {
        warnings: Array.from({ length: WRITE_LIMITS.ops }, () => warning),
      }),
    );
    expect(full.warnings).toHaveLength(WRITE_LIMITS.ops);
    // One line each, at most one per operation: anything else is a shape error, decided nowhere.
    for (const warnings of [
      ["two\nlines"],
      [""],
      Array.from({ length: WRITE_LIMITS.ops + 1 }, () => warning),
      ["x".repeat(501)],
      [3],
    ]) {
      const bad = fx.writer.submit({ ...fresh([{ kind: "task.create", title: "Bad" }]), warnings });
      expect(bad.error, JSON.stringify(warnings).slice(0, 40)).toMatchObject({
        code: "VALIDATION_FAILED",
        field: "warnings",
      });
    }
  });

  test("what the caller decided before the writer replays with the result, also for a request that changes nothing", () => {
    const answer = { moved: 1, followed: [{ kind: "task", ref: "M-1", folder: "~/work/new/a" }] };
    const request = fresh([{ kind: "task.create", title: "Fix the export" }], { answer });
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    expect(first.answer).toEqual(answer);
    // A retry that decided otherwise, or nothing, is the same intent: it gets the first answer.
    expect(fx.writer.submit({ ...request, answer: { moved: 0 } })).toEqual(replayOf(first));
    // A request with no operation is kept when it is an entry's: the caller found nothing to do.
    const intent = { entry: "group.manage", input: { action: "create", path: "Garden" } };
    const found = { group: { kind: "area", id: newId("a"), name: "Garden" } };
    const seq = lastSeq();
    const none = fresh([], { intent, answer: found });
    const noop = fx.writer.submit(none);
    expectStatus(noop, "unchanged");
    expect([noop.results, noop.answer, lastSeq()]).toEqual([[], found, seq]);
    expect(fx.writer.submit({ ...none, answer: { group: { kind: "area" } } })).toEqual(
      replayOf(noop),
    );
    // Without an intent, a request of no operation is a shape error, decided nowhere.
    expect(fx.writer.submit(fresh([], { answer: found })).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "ops",
    });
    // A refusal says no answer: nothing happened that the caller's answer could be about.
    const refusal = fx.writer.submit(
      fresh([{ kind: "task.patch", task: newId("t"), set: { title: "Gone" } }], { answer }),
    );
    expectStatus(refusal, "rejected");
    expect(refusal.answer).toBeUndefined();
    for (const bad of [[1], "moved", null]) {
      const shaped = { ...fresh([{ kind: "task.create", title: "Bad" }]), answer: bad };
      expect(fx.writer.submit(shaped).error).toMatchObject({
        code: "VALIDATION_FAILED",
        field: "answer",
      });
    }
  });

  test("a receipt that keeps no answer, as an earlier build wrote it, replays as it was", () => {
    const request = fresh([{ kind: "task.create", title: "Fix the export" }]);
    const first = fx.writer.submit(request);
    expect(first.answer).toBeUndefined();
    expect(fx.writer.submit({ ...request, answer: { moved: 1 } })).toEqual(replayOf(first));
  });

  test("a no-op retried after the state changed replays the no-op", () => {
    const task = create();
    const noop = fresh([{ kind: "task.patch", task, set: { title: "Fix the export" } }]);
    expectStatus(fx.writer.submit(noop), "unchanged");
    expectStatus(
      fx.writer.submit(fresh([{ kind: "task.patch", task, set: { title: "Review the export" } }])),
      "applied",
    );
    // Run again, the same patch would now change the title back. The retry replays the no-op.
    const seq = lastSeq();
    const retry = fx.writer.submit({ ...noop, base: fx.base() });
    expectStatus(retry, "unchanged");
    expect(retry.replayed).toBe(true);
    expect([lastSeq(), title(task)]).toEqual([seq, "Review the export"]);
  });
});

describe("[A1.5.write.receipts] one receipt per decided request, in its own transaction", () => {
  test("every decided outcome has one receipt with its status, seq and authority", () => {
    const task = create();
    const summary = (text: string): Operation[] => [
      { kind: "task.patch", task, set: { summary: text } },
    ];
    const requests: [() => WriteRequest, WriteResult["status"]][] = [
      [() => fresh(summary("Next: compare")), "applied"],
      [() => fresh(summary("Next: compare")), "unchanged"],
      [
        () => fx.request(fx.codex, summary("Later"), { base: { ...fx.writer.asOf(), seq: 1 } }),
        "conflict",
      ],
      [() => fresh([{ kind: "task.complete", task: "M-99" }]), "rejected"],
    ];
    for (const [make, status] of requests) {
      const request = make();
      const result = fx.writer.submit(request);
      expectStatus(result, status);
      const stored = readReceipt(fx.reader, {
        scope_id: request.actor.scope_id,
        request_id: request.request_id,
      });
      expect(stored).toMatchObject({
        status,
        seq: status === "applied" ? result.seq : null,
        epoch: result.epoch,
        incarnation: result.incarnation,
      });
      expect(stored?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    // One receipt per request: the fixture's create, then the four above.
    expect(receipts()).toBe(5);
    // Every commit but the machine's own has the receipt of its request (A1 3.8).
    expect(
      one(
        "SELECT count(*) FROM commits k LEFT JOIN receipts r " +
          "ON r.scope_id = k.scope_id AND r.request_id = k.request_id AND r.seq = k.seq " +
          "WHERE k.scope_id <> 'system' AND r.seq IS NULL",
      ),
    ).toBe(0);
  });

  test("a conflict replays as a conflict, and its receipt keeps no task text", () => {
    const task = create();
    const base = fx.base();
    expectStatus(
      fx.writer.submit(
        fx.request(fx.codex, [{ kind: "task.patch", task, set: { title: "Review the export" } }], {
          base: fx.base(),
        }),
      ),
      "applied",
    );
    const request = fx.request(
      fx.claude,
      [{ kind: "task.patch", task, set: { title: "Plan the offsite" } }],
      { base },
    );
    const first = fx.writer.submit(request);
    expectStatus(first, "conflict");
    // The reply carries the current value, as A1 3.5 asks.
    expect(first.conflicts[0]?.value).toBe("Review the export");
    // The receipt keeps who and when, not the value: a replay is no fresh read.
    const replay = fx.writer.submit(request);
    expect(replay).toEqual({
      ...replayOf(first),
      conflicts: first.conflicts.map((conflict) => {
        const kept = { ...conflict };
        delete kept.value;
        return kept;
      }),
    });
    const stored = String(
      one("SELECT result FROM receipts WHERE request_id = $id", {
        id: request.request_id,
      }),
    );
    expect(stored).not.toContain("Review the export");
    expect(stored).not.toContain("Plan the offsite");
    expect(title(task)).toBe("Review the export");
  });

  test("a rejection the writer decided replays, even when the request would now apply", () => {
    const task = create();
    expectStatus(fx.writer.submit(fresh([{ kind: "task.complete", task }])), "applied");
    const again = fresh([{ kind: "task.complete", task }]);
    const first = fx.writer.submit(again);
    expectStatus(first, "rejected");
    expect(first.error?.code).toBe("INVALID_TRANSITION");
    expectStatus(fx.writer.submit(fresh([{ kind: "task.reopen", task }])), "applied");
    const seq = lastSeq();
    expect(fx.writer.submit({ ...again, base: fx.base() })).toEqual(replayOf(first));
    expect(lastSeq()).toBe(seq);
    expect(one("SELECT lifecycle FROM tasks WHERE id = $id", { id: task })).toBe("active");
  });

  test("an undecided request stores nothing: a retry with the same ID runs normally", () => {
    const task = create();
    const count = receipts();
    const valid: Operation[] = [{ kind: "task.patch", task, set: { title: "Review the export" } }];
    // A shape error before the transaction (A1 3.8: the same input always fails the same way).
    const request = fresh([{ kind: "task.patch", task, set: { title: "" } }]);
    expect(fx.writer.submit(request).error?.code).toBe("VALIDATION_FAILED");
    // The request names another space: the request is not this space's to decide.
    const elsewhere = { ...request, ops: valid, space_id: newId("sp") };
    expect(fx.writer.submit(elsewhere).error?.code).toBe("SPACE_MISMATCH");
    // A principal the space does not know: the credential is the service's, not the intent.
    const stranger = {
      ...request,
      ops: valid,
      actor: { ...request.actor, principal_id: newId("ac") },
    };
    expect(fx.writer.submit(stranger).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "actor.principal_id",
    });
    expect(receipts()).toBe(count);
    const fixed = fx.writer.submit({ ...request, ops: valid });
    expectStatus(fixed, "applied");
    expect(fixed.replayed).toBeUndefined();
  });

  test("SPACE_READ_ONLY stores nothing", async () => {
    const request = fresh([{ kind: "task.create", title: "Fix the export" }]);
    fx.writer.close();
    const other = { ...MACHINE, id: newId("m") };
    const readOnly = SpaceWriter.open(
      openSpace(await checkedDriver(), fx.folder, { role: "writer" }),
      { machine: other },
    );
    try {
      // With its reason, which A3 3.5's read_only carries (A2 3.1 names it not_authority).
      expect(readOnly.submit(request).error).toMatchObject({
        code: "SPACE_READ_ONLY",
        reason: "not_authority",
      });
    } finally {
      readOnly.close();
    }
    fx.reopen();
    expectStatus(fx.writer.submit(request), "applied");
  });

  test("the receipt and the commit are written in one transaction", async () => {
    // A trigger refuses the receipt: the request's commit, rows and seq must go with it.
    const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
    try {
      conn.exec(
        "CREATE TRIGGER refuse_receipt BEFORE INSERT ON receipts " +
          "BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );
      const request = fresh([{ kind: "task.create", title: "Fix the export" }]);
      const seq = lastSeq();
      expect(() => fx.writer.submit(request)).toThrow(StorageError);
      expect([lastSeq(), one("SELECT count(*) FROM tasks")]).toEqual([seq, 0]);
      expect(
        one("SELECT count(*) FROM commits WHERE request_id = $id", { id: request.request_id }),
      ).toBe(0);
      conn.exec("DROP TRIGGER refuse_receipt");
      expectStatus(fx.writer.submit(request), "applied");
      expect(one("SELECT count(*) FROM tasks")).toBe(1);
    } finally {
      conn.close();
    }
  });
});

describe("[A1.5.write.receipts] the intent, the writer scope and receipt.get", () => {
  test("the fingerprint covers the normalised intent, never the base or the key order", () => {
    const task = create();
    const request = fresh([{ kind: "task.patch", task, set: { context: "Line one\r\nLine two" } }]);
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    // The same intent with LF line endings, the keys in another order and another base.
    const same: WriteRequest = {
      ops: [{ set: { context: "Line one\nLine two" }, task, kind: "task.patch" }],
      actor: request.actor,
      request_id: request.request_id,
      space_id: request.space_id,
      base: fx.base(),
    };
    expect(fx.writer.submit(same)).toEqual(replayOf(first));
    const fingerprint = (input: unknown) =>
      intentFingerprint({ space_id: fx.spaceId, entry: "task.update", input, reason: null });
    expect(fingerprint({ a: 1, b: [1, "x"] })).toBe(fingerprint({ b: [1, "x"], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).not.toBe(
      intentFingerprint({
        space_id: newId("sp"),
        entry: "task.update",
        input: { a: 1 },
        reason: null,
      }),
    );
  });

  test("an entry's intent: the input as sent, not the operations it expanded into", () => {
    const task = create();
    // The handler turned "fri" into a date. After midnight it would turn into another one.
    const intent = { entry: "task.update", input: { task: "M-1", set: { due: "fri" } } };
    const request = fresh([{ kind: "task.patch", task, set: { due: { date: "2026-11-13" } } }], {
      intent,
    });
    const first = fx.writer.submit(request);
    expectStatus(first, "applied");
    const later = {
      ...request,
      ops: [{ kind: "task.patch", task, set: { due: { date: "2026-11-20" } } }] as Operation[],
    };
    expect(fx.writer.submit(later)).toEqual(replayOf(first));
    expect(one("SELECT due_date FROM tasks WHERE id = $id", { id: task })).toBe("2026-11-13");
    // Another input under the same ID is another intent.
    const changed = {
      ...request,
      intent: { ...intent, input: { task: "M-1", set: { due: "mon" } } },
    };
    expect(fx.writer.submit(changed).error?.code).toBe("REQUEST_ID_REUSED");
  });

  test("receipts are keyed by writer scope: another scope never sees them", () => {
    const request = fx.request(fx.codex, [{ kind: "task.create", title: "Fix the export" }]);
    expectStatus(fx.writer.submit(request), "applied");
    // The same request ID in another scope is another request.
    const other = { ...request, actor: fx.claude };
    const second = fx.writer.submit(other);
    expectStatus(second, "applied");
    expect(second.replayed).toBeUndefined();
    expect(one("SELECT count(*) FROM tasks")).toBe(2);
    expect(
      fx.writer.receipt({ scope_id: "grant:nobody", request_id: request.request_id }),
    ).toBeUndefined();
    expect(
      fx.writer.receipt({ scope_id: fx.codex.scope_id, request_id: request.request_id }),
    ).toMatchObject({ status: "applied", scope_id: fx.codex.scope_id });
    // The writer's own scope is not a caller's.
    const system = { ...request, actor: { ...fx.codex, scope_id: "system" } };
    expect(fx.writer.submit(system).error).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "actor.scope_id",
    });
  });

  test("the fingerprint leaves out the envelope fields of an entry's input", () => {
    const task = create();
    // The service passes the entry's parsed input, which still holds request_id and base.
    const ops: Operation[] = [{ kind: "task.patch", task, set: { title: "Review the export" } }];
    const request = fresh(ops);
    const input = (base: string) => ({
      task: "M-1",
      set: { title: "Review the export" },
      base,
      request_id: request.request_id,
    });
    const first = fx.writer.submit({
      ...request,
      intent: { entry: "task.update", input: input(request.base as string) },
    });
    expectStatus(first, "applied");
    // A retry with a newer base is the same intent (A1 3.8, A3 3.4.1).
    const newer = fx.base();
    expect(
      fx.writer.submit({
        ...request,
        base: newer,
        intent: { entry: "task.update", input: input(newer) },
      }),
    ).toEqual(replayOf(first));
    // Only the top level's envelope is left out: a nested field of that name is input.
    const nested = fx.writer.submit({
      ...request,
      intent: {
        entry: "task.update",
        input: { ...input(newer), set: { title: "Review the export", base: "x" } },
      },
    });
    expect(nested.error?.code).toBe("REQUEST_ID_REUSED");
    // Both envelope fields are left out, whatever they hold.
    const print = (input: unknown) =>
      intentFingerprint({ space_id: fx.spaceId, entry: "task.update", input, reason: null });
    expect(print({ a: 1, request_id: "another-request-0001", base: "1.2.47wma9v0" })).toBe(
      print({ a: 1 }),
    );
  });

  test("the fingerprint takes an intent's strings as sent: it never merges two the writer could tell apart", () => {
    const task = create();
    // The registry has normalised the entry's text fields (SafeText). What is left, such as cwd,
    // is opaque: café in NFC and in NFD are two folders on disk, which may sit under two roots.
    const e = String.fromCodePoint(0xe9);
    const acute = String.fromCodePoint(0x301);
    const intent = (cwd: string) => ({
      entry: "task.add",
      input: { tasks: [{ title: "Visit", place: "cwd" }], cwd },
    });
    const request = fresh([{ kind: "task.patch", task, set: { title: "Visit" } }], {
      intent: intent(`/home/mira/caf${e}`),
    });
    expectStatus(fx.writer.submit(request), "applied");
    const other = { ...request, intent: intent(`/home/mira/cafe${acute}`) };
    expect(fx.writer.submit(other).error?.code).toBe("REQUEST_ID_REUSED");
    // Nor a control, a line ending or a lone surrogate, which a path on disk can hold.
    const print = (text: string) =>
      intentFingerprint({ space_id: fx.spaceId, entry: "a.b", input: [text], reason: null });
    const replacement = String.fromCodePoint(0xfffd);
    for (const [a, b] of [
      [`a${String.fromCodePoint(0)}b`, "ab"],
      ["a\r\nb", "a\nb"],
      [`x${String.fromCharCode(0xd800)}`, `x${replacement}`],
      [`caf${e}`, `cafe${acute}`],
    ] as const) {
      expect(print(a), JSON.stringify(a)).not.toBe(print(b));
    }
  });

  test("the entry is part of the intent: the same input under another entry is another intent", () => {
    const task = create();
    const ops: Operation[] = [{ kind: "note.add", task, body: "Ask Tomas." }];
    const input = { task: "M-1", text: "Ask Tomas." };
    const request = fresh(ops, { intent: { entry: "entry.add", input } });
    expectStatus(fx.writer.submit(request), "applied");
    const elsewhere = { ...request, intent: { entry: "task.update", input } };
    expect(fx.writer.submit(elsewhere).error?.code).toBe("REQUEST_ID_REUSED");
    // Without an intent, the same operations are another intent too: no entry is not an entry.
    const bare: WriteRequest = { ...request };
    delete bare.intent;
    expect(fx.writer.submit(bare).error?.code).toBe("REQUEST_ID_REUSED");
  });

  test("a stored receipt is receipt.get's result: each outcome fits the registry's schema", () => {
    const task = create();
    const stale = fx.base();
    expectStatus(
      fx.writer.submit(fresh([{ kind: "task.patch", task, set: { title: "Review" } }])),
      "applied",
    );
    const requests = [
      fresh([
        { kind: "note.add", task, body: "Ask Tomas." },
        {
          kind: "source.add",
          task,
          source: { kind: "ticket", title: "LUM-212", key: "jira:LUM-212" },
        },
      ]),
      fresh([{ kind: "task.patch", task, set: { title: "Review" } }]),
      fx.request(fx.codex, [{ kind: "task.patch", task, set: { title: "Plan" } }], { base: stale }),
      fresh([{ kind: "task.reopen", task }]),
    ];
    const statuses = requests.map((request) => {
      fx.writer.submit(request);
      const stored = fx.writer.receipt({
        scope_id: request.actor.scope_id,
        request_id: request.request_id,
      });
      const output = receiptResult(stored);
      expect(ReceiptGetResult.safeParse(output).error).toBeUndefined();
      return output.found ? output.status : "none";
    });
    expect(statuses).toEqual(["applied", "unchanged", "conflict", "rejected"]);
    const none = receiptResult(
      fx.writer.receipt({ scope_id: "cli:other", request_id: requests[0]?.request_id ?? "" }),
    );
    expect(none).toEqual({ found: false });
  });

  test("an undo conflict's receipt names the commit it met, so a caller whose reply was lost can name it next", () => {
    const task = create();
    const mine = fx.writer.submit(
      fx.request(fx.human, [{ kind: "task.patch", task, set: { title: "Review" } }], {
        base: fx.base(),
        undoable: true,
      }),
    );
    expectStatus(mine, "applied");
    expectStatus(
      fx.writer.submit(
        fx.request(fx.codex, [{ kind: "task.patch", task, set: { title: "Plan" } }], {
          base: fx.base(),
        }),
      ),
      "applied",
    );
    const undo = fx.request(fx.human, [{ kind: "undo" }]);
    const refused = fx.writer.submit(undo);
    expectStatus(refused, "conflict");
    expect(refused.target).toBe(mine.commit);
    const output = receiptResult(
      fx.writer.receipt({ scope_id: undo.actor.scope_id, request_id: undo.request_id }),
    );
    expect(ReceiptGetResult.safeParse(output).error).toBeUndefined();
    expect(output).toMatchObject({ found: true, status: "conflict", target: mine.commit });
    // A receipt another build stored with fields this one does not name still reads.
    const stored = fx.writer.receipt({
      scope_id: undo.actor.scope_id,
      request_id: undo.request_id,
    });
    if (stored === undefined) throw new Error("no receipt");
    const older = {
      ...stored,
      result: {
        ...stored.result,
        setAside: [mine.commit],
        conflicts: stored.result.conflicts.map((c) => ({ ...c, more: 2 })),
      },
    };
    const read = receiptResult(older);
    expect(ReceiptGetResult.safeParse(read).error).toBeUndefined();
    expect(read).toMatchObject({ found: true, status: "conflict", target: mine.commit });
  });

  test("receipt.get through the writer worker returns the stored result, or nothing", async () => {
    const request = fx.request(fx.human, [{ kind: "task.create", title: "Fix the export" }]);
    const first = fx.writer.submit(request);
    fx.writer.close();
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const writer = await worker.openSpaceWriter(fx.folder, { machine: MACHINE });
      const found = await writer.receipt({
        scope_id: fx.human.scope_id,
        request_id: request.request_id,
      });
      expect(found?.result).toEqual(replayOf(first));
      expect(
        await writer.receipt({ scope_id: fx.codex.scope_id, request_id: request.request_id }),
      ).toBeUndefined();
      expect(await writer.submit(request)).toEqual(replayOf(first));
      await writer.close();
    } finally {
      await worker.close();
      fx.reopen();
    }
  });
});
