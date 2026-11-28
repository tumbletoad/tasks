// The phone's outbox: what waits, what the computer answered, and what the screen hides on top of
// the feed, kept in the app's storage. In memory here; against the real service in the service's
// tests (client-outbox.test.ts, client-outbox.prop.test.ts).
import { describe, expect, test } from "vitest";
import { answerOf, Outbox, type Keep } from "./outbox.ts";

function memory(): Keep {
  const values = new Map<string, string>();
  return {
    read: (name) => values.get(name) ?? null,
    write: (name, text) => {
      values.set(name, text);
    },
  };
}

const PIN = "A".repeat(43);
const OTHER = "B".repeat(43);
const TASK = { task: "t_1", title: "Water the plants" };
const finish = { kind: "finish" as const, ...TASK, base: "1.4.abcdefgh" };
const cursor = (seq: number) => ({ epoch: 1, incarnation: "in_abcdefghij", seq });

describe("[S5.phone.outbox] the phone's outbox keeps what waits until the computer answers it for good", () => {
  test("it is kept under the computer's pin and the space: another computer with the space gets none of it", () => {
    const keep = memory();
    new Outbox(keep, PIN, "sp_1").add(finish, "r1-0000000000000000", 1);
    expect(new Outbox(keep, PIN, "sp_1").waiting.map((e) => e.request)).toEqual([
      "r1-0000000000000000",
    ]);
    expect(new Outbox(keep, OTHER, "sp_1").waiting).toEqual([]);
    expect(new Outbox(keep, PIN, "sp_2").waiting).toEqual([]);
  });

  test("Undo of a check-off never sent takes it out, and nothing is hidden", () => {
    const box = new Outbox(memory(), PIN, "sp_1");
    box.add(finish, "r1-0000000000000000", 1);
    expect(box.hidden()).toEqual(new Set(["t_1"]));
    expect(box.undo("r1-0000000000000000", TASK, "r2-0000000000000000", 2, "1.5.abcdefgh")).toBe(
      true,
    );
    expect(box.waiting).toEqual([]);
    expect(box.hidden()).toEqual(new Set());
  });

  test("Undo of a check-off on its way is a reopening that goes from where the check-off landed", () => {
    const box = new Outbox(memory(), PIN, "sp_1");
    box.add(finish, "r1-0000000000000000", 1);
    box.tried("r1-0000000000000000");
    box.undo("r1-0000000000000000", TASK, "r2-0000000000000000", 2, "1.5.abcdefgh");
    expect(box.hidden()).toEqual(new Set());
    box.answered("r1-0000000000000000", { kind: "applied", asOf: "1.9.abcdefgh" });
    const next = box.next();
    expect(next?.kind).toBe("reopen");
    if (next === undefined) return;
    expect(box.bodyOf(next).body).toEqual({
      task: "t_1",
      base: "1.9.abcdefgh",
      request_id: "r2-0000000000000000",
    });
  });

  test("check off, Undo, check off again: each goes from where the one before it landed", () => {
    const box = new Outbox(memory(), PIN, "sp_1");
    box.add(finish, "r1-0000000000000000", 1);
    box.tried("r1-0000000000000000");
    box.undo("r1-0000000000000000", TASK, "r2-0000000000000000", 2, "1.4.abcdefgh");
    box.add({ ...finish, base: "1.4.abcdefgh" }, "r3-0000000000000000", 3);
    box.answered("r1-0000000000000000", { kind: "applied", asOf: "1.9.abcdefgh" });
    box.answered("r2-0000000000000000", { kind: "applied", asOf: "1.10.abcdefgh" });
    const next = box.next();
    if (next === undefined) throw new Error("nothing waits");
    expect(box.bodyOf(next).body).toEqual({
      task: "t_1",
      base: "1.10.abcdefgh",
      request_id: "r3-0000000000000000",
    });
    expect(box.hidden()).toEqual(new Set(["t_1"]));
  });

  test("an applied check-off stays hidden until the feed's cursor covers it", () => {
    const box = new Outbox(memory(), PIN, "sp_1");
    box.add(finish, "r1-0000000000000000", 1);
    box.tried("r1-0000000000000000");
    box.answered("r1-0000000000000000", { kind: "applied", asOf: "1.9.abcdefgh" });
    expect(box.hidden()).toEqual(new Set(["t_1"]));
    box.covered(cursor(8));
    expect(box.hidden()).toEqual(new Set(["t_1"]));
    box.covered(cursor(9));
    expect(box.hidden()).toEqual(new Set());
  });

  test("a refusal moves to the refusals in the same write, takes its Undo with it, and outlasts a restart", () => {
    const keep = memory();
    const box = new Outbox(keep, PIN, "sp_1");
    box.add(finish, "r1-0000000000000000", 1);
    box.tried("r1-0000000000000000");
    box.undo("r1-0000000000000000", TASK, "r2-0000000000000000", 2, "1.5.abcdefgh");
    box.answered("r1-0000000000000000", { kind: "refused", why: "No task has this ID." });
    const again = new Outbox(keep, PIN, "sp_1");
    expect(again.waiting).toEqual([]);
    expect(again.refused).toEqual([
      {
        request: "r1-0000000000000000",
        kind: "finish",
        words: "Water the plants",
        why: "No task has this ID.",
      },
    ]);
    again.dismiss("r1-0000000000000000");
    expect(new Outbox(keep, PIN, "sp_1").refused).toEqual([]);
  });

  test("an answer is definite only when it says so: a 5xx is tried again unless it says it never will work", () => {
    expect(answerOf(200, { result: { as_of: "1.2.abcdefgh" } })).toEqual({
      kind: "applied",
      asOf: "1.2.abcdefgh",
    });
    expect(answerOf(409, { error: { message: "changed" } })).toEqual({
      kind: "refused",
      why: "changed",
    });
    expect(answerOf(503, { error: { message: "busy" } })).toEqual({ kind: "again" });
    expect(answerOf(503, { error: { message: "gone", data: { retryable: false } } })).toEqual({
      kind: "refused",
      why: "gone",
    });
    expect(answerOf(0, undefined)).toEqual({ kind: "again" });
  });
});
