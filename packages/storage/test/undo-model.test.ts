// A7 3.10 M3.02 Verify: "ABA property test: undo never changes a field whose version moved. Undo
// then redo restores the values the commit wrote." The human and two agents write a few fields of
// three tasks in random order, the human's writes on its undo stack, and the human undoes (now and
// then partially) and redoes. Values come from small sets, so an agent often sets a field back to
// the very value the human wrote: an undo must still refuse it (R2, provenance never equality).
//
// A small reference model predicts every outcome from A1 3.10.1's rules alone: which commit an
// undo or redo takes, which of its rows pass their provenance guard, what a field holds, its fv and
// its fp after each step, and each stack commit's status. On top of the model's prediction, each
// undo and redo is checked against the space itself: the only fields it changes are rows of the
// inverted commit whose provenance was the guard; a redo brings back exactly the after-values and
// the provenance of the commit it redoes; and no field's fv ever moves back. Each run ends with A1's
// history invariants (write-helpers.ts: checkHistory), among them that every field holds the value
// its provenance commit wrote.
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Credential, Operation } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, writeFixture, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo-model");
afterAll(temp.cleanup);

const FIELDS = ["summary", "priority", "status", "due", "lifecycle", "wrap"] as const;
type Field = (typeof FIELDS)[number];
const TASKS = 3;

/** A field's value as the model keeps it: the column that tells it, as text. */
interface Cell {
  value: string;
  fv: number;
  fp: number;
}

interface ModelChange {
  task: number;
  field: Field;
  before: string;
  after: string;
  beforeProv: number;
  afterProv: number;
}

interface ModelCommit {
  seq: number;
  /** On the human's undo stack. */
  stacked: boolean;
  status: "done" | "undone" | "dead" | null;
  undoneBy: number | null;
  rows: ModelChange[];
}

type Patchable = "summary" | "priority" | "status" | "due";
type Patch = Partial<Record<Patchable, string>>;

type Step =
  | { kind: "write"; actor: number; task: number; set: Patch }
  /** Completes an active task, reopens another: lifecycle and wrap-up change together. */
  | { kind: "lifecycle"; actor: number; task: number }
  /**
   * An agent sets a field away and back: the value is the same, the write is the agent's. The
   * field is one the human's newest undoable commit wrote (`pick` among them), so the next undo
   * meets it; a random one when that commit wrote none of the patchable fields.
   */
  | { kind: "aba"; actor: number; task: number; field: Patchable; pick: number }
  | { kind: "undo"; partial: boolean }
  | { kind: "redo" };

const VALUES: Readonly<Record<Patchable, readonly string[]>> = {
  summary: ["", "Next: compare totals", "Waiting on Tomas"],
  priority: ["1", "2", "4"],
  status: ["open", "waiting"],
  due: ["", "2026-11-20", "2026-11-27"],
};

const patch: fc.Arbitrary<Patch> = fc
  .record(
    {
      summary: fc.constantFrom(...VALUES.summary),
      priority: fc.constantFrom(...VALUES.priority),
      status: fc.constantFrom(...VALUES.status),
      due: fc.constantFrom(...VALUES.due),
    },
    { requiredKeys: [] },
    // A patch sets at least one field: an empty one is a shape error, not a no-op.
  )
  .filter((set) => Object.keys(set).length > 0);
// The human writes half of the time, so its stack has depth for undos to walk.
const actor = fc.constantFrom(0, 0, 0, 1, 2);
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("write" as const),
      actor,
      task: fc.nat({ max: TASKS - 1 }),
      set: patch,
    }),
    weight: 6,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("lifecycle" as const),
      actor,
      task: fc.nat({ max: TASKS - 1 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("aba" as const),
      actor: fc.constantFrom(1, 2),
      task: fc.nat({ max: TASKS - 1 }),
      field: fc.constantFrom<Patchable>("summary", "priority", "status", "due"),
      pick: fc.nat(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("undo" as const), partial: fc.boolean() }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("redo" as const) }), weight: 3 },
);

const key = (task: number, field: Field): string => `${String(task)}|${field}`;

class Model {
  cells = new Map<string, Cell>();
  commits = new Map<number, ModelCommit>();
  lastSeq: number;

  constructor(created: readonly number[], lastSeq: number) {
    this.lastSeq = lastSeq;
    created.forEach((seq, task) => {
      const start: Record<Field, string> = {
        summary: "",
        priority: "4",
        status: "open",
        due: "",
        lifecycle: "active",
        wrap: "",
      };
      for (const field of FIELDS) {
        this.cells.set(key(task, field), { value: start[field], fv: seq, fp: seq });
      }
    });
  }

  cell(task: number, field: Field): Cell {
    const found = this.cells.get(key(task, field));
    if (found === undefined) throw new Error("no cell");
    return found;
  }

  /** A write: one change row per field whose value moves; none is `unchanged`. */
  write(
    task: number,
    values: Partial<Record<Field, string>>,
    human: boolean,
  ): ModelCommit | undefined {
    const seq = this.lastSeq + 1;
    const rows: ModelChange[] = [];
    for (const [field, value] of Object.entries(values) as [Field, string][]) {
      const cell = this.cell(task, field);
      if (cell.value === value) continue;
      rows.push({
        task,
        field,
        before: cell.value,
        after: value,
        beforeProv: cell.fp,
        afterProv: seq,
      });
    }
    if (rows.length === 0) return undefined;
    for (const row of rows)
      this.cells.set(key(task, row.field), { value: row.after, fv: seq, fp: seq });
    if (human) {
      // A human's new undoable action ends what it could redo (A1 3.10.1).
      for (const c of this.commits.values()) if (c.status === "undone") c.status = "dead";
    }
    const commit: ModelCommit = {
      seq,
      stacked: human,
      status: human ? "done" : null,
      undoneBy: null,
      rows,
    };
    this.commits.set(seq, commit);
    this.lastSeq = seq;
    return commit;
  }

  undoTarget(): ModelCommit | undefined {
    let newest: ModelCommit | undefined;
    for (const c of this.commits.values()) {
      if (c.stacked && c.status === "done" && (newest === undefined || c.seq > newest.seq)) {
        newest = c;
      }
    }
    return newest;
  }

  redoTarget(): ModelCommit | undefined {
    const after = this.undoTarget()?.seq ?? 0;
    let oldest: ModelCommit | undefined;
    for (const c of this.commits.values()) {
      if (
        c.stacked &&
        c.status === "undone" &&
        c.seq > after &&
        (oldest === undefined || c.seq < oldest.seq)
      ) {
        oldest = c;
      }
    }
    return oldest;
  }

  /** The rows of `rows` whose guard fails, and with `partial` their lifecycle or wrap partner. */
  failing(rows: readonly ModelChange[], partial: boolean): Set<ModelChange> {
    const failed = new Set(rows.filter((r) => this.cell(r.task, r.field).fp !== r.afterProv));
    if (partial) {
      for (const r of rows) {
        const partner =
          r.field === "lifecycle" ? "wrap" : r.field === "wrap" ? "lifecycle" : undefined;
        if (partner === undefined) continue;
        if (rows.some((o) => o.task === r.task && o.field === partner && failed.has(o)))
          failed.add(r);
      }
    }
    return failed;
  }

  /** Inverts `rows` but `skip` as commit lastSeq + 1 (A1 3.10). */
  invert(rows: readonly ModelChange[], skip: ReadonlySet<ModelChange>): ModelCommit {
    const seq = this.lastSeq + 1;
    const inverted: ModelChange[] = [];
    for (const row of rows) {
      if (skip.has(row)) continue;
      const cell = this.cell(row.task, row.field);
      inverted.push({
        task: row.task,
        field: row.field,
        before: cell.value,
        after: row.before,
        beforeProv: row.afterProv,
        afterProv: row.beforeProv,
      });
      this.cells.set(key(row.task, row.field), { value: row.before, fv: seq, fp: row.beforeProv });
    }
    const commit: ModelCommit = {
      seq,
      stacked: false,
      status: null,
      undoneBy: null,
      rows: inverted,
    };
    this.commits.set(seq, commit);
    this.lastSeq = seq;
    return commit;
  }
}

type Seen = Record<string, number>;
const count = (seen: Seen, label: string): void => {
  seen[label] = (seen[label] ?? 0) + 1;
};

/** The space's fields of every task, as the model keeps them. */
function snapshot(fx: Fixture, ids: readonly Id<"t">[]): Map<string, Cell> {
  const out = new Map<string, Cell>();
  ids.forEach((id, task) => {
    const t = fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
    const fv = JSON.parse(String(t["fv"])) as Record<string, number>;
    const fp = JSON.parse(String(t["fp"])) as Record<string, number>;
    const created = Number(t["created_seq"]);
    const text = (v: unknown): string =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    const values: Record<Field, string> = {
      summary: text(t["summary"]),
      priority: text(t["priority"]),
      status: text(t["status"]),
      due: text(t["due_date"]),
      lifecycle: text(t["lifecycle"]),
      wrap: text(t["wrap_state"]),
    };
    for (const field of FIELDS) {
      out.set(key(task, field), {
        value: values[field],
        fv: fv[field] ?? created,
        fp: fp[field] ?? created,
      });
    }
  });
  return out;
}

function expectModel(fx: Fixture, ids: readonly Id<"t">[], model: Model): void {
  expect(Object.fromEntries(snapshot(fx, ids))).toEqual(Object.fromEntries(model.cells));
  expect(Number(fx.reader.prepare("SELECT last_seq FROM space").get()?.["last_seq"])).toBe(
    model.lastSeq,
  );
  const stack = fx.reader
    .prepare("SELECT seq, undo_status FROM commits WHERE undo_status IS NOT NULL ORDER BY seq")
    .all<{ seq: number; undo_status: string }>();
  const expected = [...model.commits.values()]
    .filter((c) => c.stacked)
    .map((c) => ({ seq: c.seq, undo_status: c.status }));
  expect(stack).toEqual(expected);
}

const toValues = (set: Patch): Partial<Record<Field, string>> => set;

/** The operation of a patch step. */
function patchOp(id: Id<"t">, set: Patch): Operation {
  const values: Record<string, unknown> = {};
  if (set.summary !== undefined) values["summary"] = set.summary;
  if (set.priority !== undefined) values["priority"] = Number(set.priority);
  if (set.status !== undefined) values["status"] = set.status;
  if (set.due !== undefined) values["due"] = set.due === "" ? null : { date: set.due };
  return { kind: "task.patch", task: id, set: values };
}

const property = (seen: Seen) =>
  fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 40 }), async (steps) => {
    const fx = await writeFixture(temp.make());
    try {
      const actors: Credential[] = [fx.human, fx.codex, fx.claude];
      // The tasks are Codex's, so the human's stack holds only its own edits.
      const ids = Array.from({ length: TASKS }, () => newId("t"));
      const made = fx.writer.submit(
        fx.request(
          fx.codex,
          ids.map((id, n) => ({ kind: "task.create", id, title: `Fixture task ${String(n + 1)}` })),
        ),
      );
      expect(made.status).toBe("applied");
      const model = new Model(
        ids.map(() => made.seq),
        made.seq,
      );
      for (const s of steps) {
        const before = snapshot(fx, ids);
        if (s.kind === "aba") {
          const rows = (model.undoTarget()?.rows ?? []).filter((r) =>
            Object.hasOwn(VALUES, r.field),
          );
          const row = rows[s.pick % Math.max(rows.length, 1)];
          const task = row?.task ?? s.task;
          const field = (row?.field ?? s.field) as Patchable;
          const id = ids[task] ?? ids[0];
          const credential = actors[s.actor] ?? fx.codex;
          const now = model.cell(task, field).value;
          const away = VALUES[field].find((v) => v !== now) ?? now;
          for (const value of [away, now]) {
            const result = fx.writer.submit(
              fx.request(credential, [patchOp(id as Id<"t">, { [field]: value })], {
                base: fx.base(),
              }),
            );
            expect(result.status, JSON.stringify(result.error)).toBe("applied");
            model.write(task, { [field]: value }, false);
          }
        } else if (s.kind === "write" || s.kind === "lifecycle") {
          const id = ids[s.task] ?? ids[0];
          const credential = actors[s.actor] ?? fx.human;
          const human = s.actor === 0;
          let op: Operation;
          let values: Partial<Record<Field, string>>;
          if (s.kind === "write") {
            op = patchOp(id as Id<"t">, s.set);
            values = toValues(s.set);
          } else if (model.cell(s.task, "lifecycle").value === "active") {
            op = { kind: "task.complete", task: id as Id<"t"> };
            values = { lifecycle: "completed", wrap: "pending" };
          } else {
            op = { kind: "task.reopen", task: id as Id<"t"> };
            values = { lifecycle: "active", wrap: "" };
          }
          const result = fx.writer.submit(
            fx.request(credential, [op], { base: fx.base(), ...(human ? { undoable: true } : {}) }),
          );
          const ended = [...model.commits.values()].some((c) => c.status === "undone");
          const commit = model.write(s.task, values, human);
          expect(result.status, JSON.stringify(result.error)).toBe(
            commit === undefined ? "unchanged" : "applied",
          );
          if (commit !== undefined && human && ended) count(seen, "redo ended");
        } else if (s.kind === "undo") {
          const target = model.undoTarget();
          const result = fx.writer.submit(
            fx.request(fx.human, [{ kind: "undo", ...(s.partial ? { partial: true } : {}) }]),
          );
          if (target === undefined) {
            expect(result.error?.code).toBe("NOTHING_TO_UNDO");
            count(seen, "NOTHING_TO_UNDO");
          } else {
            const failed = model.failing(target.rows, s.partial);
            const guard = model.failing(target.rows, false);
            if (guard.size > 0 && !s.partial) {
              expect(result.status).toBe("conflict");
              expect(result.error?.code).toBe("UNDO_CONFLICT");
              expect(
                result.conflicts
                  .map((c) => `${String(ids.indexOf(c.id as Id<"t">))}|${c.field}`)
                  .sort(),
              ).toEqual([...guard].map((r) => key(r.task, r.field)).sort());
              count(seen, "undo conflict");
              // R2: a field set back to the value the human wrote is still another's write.
              if ([...guard].some((r) => model.cell(r.task, r.field).value === r.after)) {
                count(seen, "aba refused");
              }
            } else {
              expect(result.status, JSON.stringify(result.error)).toBe("applied");
              const u = model.invert(target.rows, failed);
              target.status = "undone";
              target.undoneBy = u.seq;
              expect(result.seq).toBe(u.seq);
              expect(
                result.conflicts
                  .map((c) => `${String(ids.indexOf(c.id as Id<"t">))}|${c.field}`)
                  .sort(),
              ).toEqual([...failed].map((r) => key(r.task, r.field)).sort());
              count(seen, failed.size > 0 ? "partial undo" : "undo");
              // ABA: the undo changed only rows of the commit whose provenance was the guard.
              const after = snapshot(fx, ids);
              for (const [k, cell] of after) {
                const was = before.get(k);
                if (was === undefined) throw new Error("no cell");
                if (cell.value === was.value && cell.fv === was.fv && cell.fp === was.fp) continue;
                const row = target.rows.find((r) => key(r.task, r.field) === k);
                expect(row, `${k} changed but the commit never wrote it`).toBeDefined();
                expect(failed.has(row as ModelChange), `${k} changed against its guard`).toBe(
                  false,
                );
                expect(was.fp, `${k} held another write`).toBe(row?.afterProv);
              }
            }
          }
        } else {
          const target = model.redoTarget();
          const result = fx.writer.submit(fx.request(fx.human, [{ kind: "redo" }]));
          if (target === undefined) {
            expect(result.error?.code).toBe("NOTHING_TO_REDO");
            count(seen, "NOTHING_TO_REDO");
          } else {
            const undone = model.commits.get(target.undoneBy ?? 0);
            if (undone === undefined) throw new Error("no undo");
            const guard = model.failing(undone.rows, false);
            if (guard.size > 0) {
              expect(result.status).toBe("conflict");
              expect(result.error?.code).toBe("UNDO_CONFLICT");
              count(seen, "redo conflict");
            } else {
              expect(result.status, JSON.stringify(result.error)).toBe("applied");
              const r = model.invert(undone.rows, new Set());
              target.status = "done";
              target.undoneBy = null;
              expect(result.seq).toBe(r.seq);
              count(seen, "redo");
              // Undo then redo restores the values the commit wrote, with its own provenance.
              const after = snapshot(fx, ids);
              for (const row of undone.rows) {
                const wrote = target.rows.find((w) => w.task === row.task && w.field === row.field);
                const cell = after.get(key(row.task, row.field));
                expect(cell?.value).toBe(wrote?.after);
                expect(cell?.fp).toBe(target.seq);
              }
            }
          }
        }
        // Physical versions only grow.
        for (const [k, cell] of snapshot(fx, ids)) {
          expect(cell.fv, `${k} fv`).toBeGreaterThanOrEqual(before.get(k)?.fv ?? 0);
        }
        expectModel(fx, ids, model);
      }
      checkHistory(fx.reader);
    } finally {
      fx.close();
    }
  });

describe("[A1.5.history.property] undo and redo against a reference model", () => {
  test("undo never changes a field whose provenance moved, and undo then redo restores the commit's values", async () => {
    // A fixed seed, whose runs must reach every outcome, then fresh random runs.
    const seen: Seen = {};
    await fc.assert(property(seen), { numRuns: 60, seed: 20261114 });
    for (const outcome of [
      "undo",
      "partial undo",
      "undo conflict",
      "aba refused",
      "redo",
      "redo conflict",
      "redo ended",
      "NOTHING_TO_UNDO",
      "NOTHING_TO_REDO",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(3);
    }
    await fc.assert(property({}), { numRuns: 20 });
  }, 180_000);
});
