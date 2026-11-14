// The projection's outbox bookkeeping (A1 3.7 "Outbox consumers", A1 3.13 steps 5 and 6;
// write/outbox.ts): a rendered key is done only through the snapshot it was rendered at, and the
// watermark never covers a commit a task row still waits for. Fixture text only.
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Id } from "../src/ids.ts";
import { PROJECTION_ALL } from "../src/write/outbox.ts";
import type { Operation, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { expectStatus, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("outbox");
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await writeFixture(temp.make());
});
afterEach(() => {
  fx.close();
});

interface OutboxRow {
  key: string;
  first_seq: number;
  seq: number;
}

const rows = (): OutboxRow[] =>
  fx.reader
    .prepare("SELECT key, first_seq, seq FROM outbox WHERE topic = 'projection' ORDER BY key")
    .all<OutboxRow>();
const lastSeq = (): number =>
  Number(fx.reader.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);

function submit(ops: Operation[]): WriteResult {
  const result = fx.writer.submit(fx.request(fx.human, ops, { base: fx.base() }));
  expectStatus(result, "applied");
  return result;
}

const create = (title: string): Id<"t"> => {
  const id = submit([{ kind: "task.create", title }]).results[0]?.id;
  if (typeof id !== "string") throw new Error("no task");
  return id as Id<"t">;
};

describe("[A1.5.projection.outbox] the projection marks what it rendered, and the watermark covers only rendered commits", () => {
  test("a rendered key goes; one changed after the snapshot stays from T + 1; the rest keep their place", () => {
    const a = create("Fix appointment time zones");
    const b = create("Review the invoice export");
    const c = create("Draft the Q1 portal roadmap");
    const t = lastSeq();
    // A commit after the snapshot touches `a` again.
    submit([{ kind: "task.patch", task: a, set: { summary: "Next: compare the exports" } }]);
    const watermark = fx.writer.projected({ seq: t, keys: [a, b, PROJECTION_ALL] });
    const left = rows();
    expect(left.map((r) => r.key).sort()).toEqual([PROJECTION_ALL, a, c].sort());
    // `a` keeps its newer commit and waits from T + 1; `*` too.
    expect(left.find((r) => r.key === a)).toMatchObject({ first_seq: t + 1, seq: t + 1 });
    expect(left.find((r) => r.key === PROJECTION_ALL)).toMatchObject({ first_seq: t + 1 });
    // `c` was not reported: it keeps its first_seq, and the watermark stops below it.
    const cRow = left.find((r) => r.key === c);
    expect(watermark).toBe((cRow?.first_seq ?? 0) - 1);
  });

  test("the watermark is the snapshot once no task row waits from it or before", () => {
    const a = create("Fix appointment time zones");
    const t = lastSeq();
    expect(fx.writer.projected({ seq: t, keys: [a, PROJECTION_ALL] })).toBe(t);
    expect(rows()).toEqual([]);
    // Nothing to report still answers the watermark.
    expect(fx.writer.projected({ seq: t, keys: [] })).toBe(t);
  });

  test("a full rebuild queues every task from commit 1, so the watermark stays at 0 until all are rendered", () => {
    const a = create("Fix appointment time zones");
    const b = create("Review the invoice export");
    let t = lastSeq();
    fx.writer.projected({ seq: t, keys: [a, b, PROJECTION_ALL] });
    expect(fx.writer.queueProjection()).toBe(2);
    expect(rows().every((r) => r.first_seq === 1)).toBe(true);
    expect(
      rows()
        .map((r) => r.key)
        .sort(),
    ).toEqual([PROJECTION_ALL, a, b].sort());
    t = lastSeq();
    expect(fx.writer.projected({ seq: t, keys: [a] })).toBe(0);
    expect(fx.writer.projected({ seq: t, keys: [b, PROJECTION_ALL] })).toBe(t);
  });

  test("a batch from another thread is checked: its snapshot, its keys and their number", () => {
    const t = lastSeq();
    const refused = (batch: unknown): void => {
      expect(() => fx.writer.projected(batch as never)).toThrow(
        expect.objectContaining({ code: "STORAGE_MISUSE" }),
      );
    };
    refused({ seq: t + 1, keys: [] });
    refused({ seq: -1, keys: [] });
    refused({ seq: 1.5, keys: [] });
    refused({ seq: t, keys: ["../space.db"] });
    refused({ seq: t, keys: [PROJECTION_ALL, PROJECTION_ALL] });
    refused({ seq: t, keys: "*" });
    refused({ seq: t, keys: Array.from({ length: 202 }, (_, i) => `t_${String(i)}`) });
  });

  test("property: under interleaved commits and reports, the watermark never covers a commit a task still waits for, and never moves back", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("create" as const) }),
            fc.record({ kind: fc.constant("patch" as const), pick: fc.nat() }),
            fc.record({
              kind: fc.constant("report" as const),
              picks: fc.array(fc.nat(), { maxLength: 4 }),
            }),
          ),
          { minLength: 1, maxLength: 30 },
        ),
        (steps) => {
          const tasks: Id<"t">[] = [];
          // What the model knows: for each task, the newest commit and the newest one reported.
          const newest = new Map<string, number>();
          const reported = new Map<string, number>();
          let watermark = 0;
          let n = 0;
          for (const step of steps) {
            if (step.kind === "create" || tasks.length === 0) {
              n += 1;
              const id = create(`Fixture task ${String(n)}`);
              tasks.push(id);
              newest.set(id, lastSeq());
            } else if (step.kind === "patch") {
              const id = tasks[step.pick % tasks.length] as Id<"t">;
              n += 1;
              submit([{ kind: "task.patch", task: id, set: { summary: `Step ${String(n)}` } }]);
              newest.set(id, lastSeq());
            } else {
              const t = lastSeq();
              const keys = [...new Set(step.picks.map((p) => tasks[p % tasks.length] as string))];
              const w = fx.writer.projected({ seq: t, keys });
              for (const key of keys) reported.set(key, t);
              // Never backwards, and never past an unrendered commit of any task.
              expect(w).toBeGreaterThanOrEqual(watermark);
              for (const [id, seq] of newest) {
                if ((reported.get(id) ?? 0) < seq) expect(w).toBeLessThan(seq);
              }
              watermark = w;
            }
          }
          for (const row of rows()) expect(row.first_seq).toBeLessThanOrEqual(row.seq);
        },
      ),
      { numRuns: 20 },
    );
  });
});
