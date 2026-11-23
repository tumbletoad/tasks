// A7 3.10 M3.02 Verify: "ABA property test: undo never changes a field whose version moved. Undo
// then redo restores the values the commit wrote." Two humans and two agents create tasks and write
// a few fields of them in random order, the humans' writes on their own undo stacks, and each human
// undoes (now and then partially) and redoes. Values come from small sets, so an agent often sets a
// field back to the very value a human wrote: an undo must still refuse it (R2, provenance never
// equality). A human's create is undone by a tombstone, which every later write of another keeps
// away, and a write to a tombstoned task is refused. The person also runs tasks (A4 3.11): a run's
// commits never join a stack and never end a redo, a run keeps its task's create from being undone
// (A1 3.10), and a tombstoned task takes no run.
//
// A small reference model predicts every outcome from A1 3.10 and 3.10.1's rules alone: which
// commit an undo or redo takes from whose stack, which of its rows pass their provenance guard,
// what a field holds, its fv and its fp after each step, and each stack commit's status. On top of
// the model's prediction, each undo and redo is checked against the space itself: the only fields
// it changes are rows of the inverted commit whose provenance was the guard; a redo brings back
// exactly the after-values and the provenance of the commit it redoes; and no field's fv ever moves
// back. Each run ends with A1's history invariants (write-helpers.ts: checkHistory), among them
// that every field holds the value its provenance commit wrote.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import type { Credential, Operation } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkHistory, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo-model");
// Each run gets its own copy of one fixture space, made once.
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

const FIELDS = ["summary", "priority", "status", "due", "lifecycle", "wrap", "deleted"] as const;
type Field = (typeof FIELDS)[number];
/** Three tasks Codex created before the steps, and at most this many in all. */
const START_TASKS = 3;
const MAX_TASKS = 6;
/** The actors by index: the two humans, each with a stack of its own, and the two agents. */
const HUMANS = [0, 3] as const;
const isHuman = (actor: number): boolean => (HUMANS as readonly number[]).includes(actor);

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
  /** A create row: inverted by a tombstone (field `deleted`), guarded by every field of the task. */
  create?: true;
}

interface ModelCommit {
  seq: number;
  /** The human whose undo stack holds it, or null. */
  owner: number | null;
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
  /** A new task, on its creator's stack when a human made it. */
  | { kind: "create"; actor: number }
  /**
   * An agent sets a field away and back: the value is the same, the write is the agent's. The
   * field is one that the commit the `of` human's next undo (or redo) would invert wrote (`pick`
   * among them), so that undo or redo meets it; a random field of its task when none is
   * patchable. With `then`, that human's undo or redo follows at once.
   */
  | {
      kind: "aba";
      actor: number;
      of: number;
      on: "undo" | "redo";
      then: boolean;
      task: number;
      field: Patchable;
      pick: number;
    }
  | { kind: "undo"; who: number; partial: boolean }
  | { kind: "redo"; who: number }
  /**
   * The first human runs one of the two newest tasks (`newest` back from the last), which those
   * humans most often created, and the run then moves `moves` times: never on a stack.
   */
  | { kind: "run"; newest: number; moves: number }
  /** An undo and a redo of the same human, `times` in a row. */
  | { kind: "cycle"; who: number; partial: boolean; times: number };

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
// The humans write more than half of the time, so their stacks have depth for undos to walk.
const actor = fc.constantFrom(0, 0, 3, 3, 1, 2);
const human = fc.constantFrom(...HUMANS);
const task = fc.nat({ max: MAX_TASKS - 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant("write" as const), actor, task, set: patch }),
    weight: 6,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("lifecycle" as const), actor, task }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("create" as const), actor }), weight: 3 },
  {
    arbitrary: fc.record({
      kind: fc.constant("aba" as const),
      actor: fc.constantFrom(1, 2),
      of: human,
      on: fc.constantFrom("undo" as const, "redo" as const),
      then: fc.boolean(),
      task,
      field: fc.constantFrom<Patchable>("summary", "priority", "status", "due"),
      pick: fc.nat(),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("undo" as const), who: human, partial: fc.boolean() }),
    weight: 5,
  },
  { arbitrary: fc.record({ kind: fc.constant("redo" as const), who: human }), weight: 3 },
  {
    arbitrary: fc.record({
      kind: fc.constant("run" as const),
      newest: fc.nat({ max: 1 }),
      moves: fc.nat({ max: 2 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("cycle" as const),
      who: human,
      partial: fc.boolean(),
      times: fc.integer({ min: 1, max: 3 }),
    }),
    weight: 2,
  },
);

/** The steps a run takes: an `aba` with `then` and a `cycle` stand for several. */
function expand(s: Step): Step[] {
  if (s.kind === "cycle") {
    return Array.from({ length: s.times }, (): Step[] => [
      { kind: "undo", who: s.who, partial: s.partial },
      { kind: "redo", who: s.who },
    ]).flat();
  }
  if (s.kind === "aba" && s.then) {
    return [
      s,
      s.on === "undo" ? { kind: "undo", who: s.of, partial: false } : { kind: "redo", who: s.of },
    ];
  }
  return [s];
}

/** A cell, or with `runs` what keeps a create from being undone: one of the task's runs. */
const key = (task: number, field: Field | "runs"): string => `${String(task)}|${field}`;

const START: Readonly<Record<Field, string>> = {
  summary: "",
  priority: "4",
  status: "open",
  due: "",
  lifecycle: "active",
  wrap: "",
  deleted: "",
};

class Model {
  cells = new Map<string, Cell>();
  commits = new Map<number, ModelCommit>();
  /** How many runs each task has: a run is never removed. */
  runs = new Map<number, number>();
  tasks = 0;
  lastSeq: number;

  constructor(lastSeq: number) {
    this.lastSeq = lastSeq;
  }

  cell(task: number, field: Field): Cell {
    const found = this.cells.get(key(task, field));
    if (found === undefined) throw new Error("no cell");
    return found;
  }

  deleted(task: number): boolean {
    return this.cell(task, "deleted").value !== "";
  }

  /** A human's new undoable action ends what that human could redo (A1 3.10.1). */
  #stack(seq: number, owner: number | null, rows: ModelChange[]): ModelCommit {
    if (owner !== null) {
      for (const c of this.commits.values()) {
        if (c.owner === owner && c.status === "undone") c.status = "dead";
      }
    }
    const commit: ModelCommit = {
      seq,
      owner,
      status: owner === null ? null : "done",
      undoneBy: null,
      rows,
    };
    this.commits.set(seq, commit);
    this.lastSeq = seq;
    return commit;
  }

  /** A run's commit (its create when `task` is given, else a move): on no stack, no cell. */
  run(task?: number): ModelCommit {
    if (task !== undefined) this.runs.set(task, (this.runs.get(task) ?? 0) + 1);
    return this.#stack(this.lastSeq + 1, null, []);
  }

  /** Tasks made by one commit, `owner`'s when a human made it. */
  create(count: number, owner: number | null): ModelCommit {
    const seq = this.lastSeq + 1;
    const rows: ModelChange[] = [];
    for (let n = 0; n < count; n += 1) {
      const task = this.tasks;
      this.tasks += 1;
      for (const field of FIELDS) {
        this.cells.set(key(task, field), { value: START[field], fv: seq, fp: seq });
      }
      rows.push({
        task,
        field: "deleted",
        before: "",
        after: "",
        beforeProv: seq,
        afterProv: seq,
        create: true,
      });
    }
    return this.#stack(seq, owner, rows);
  }

  /** A write: one change row per field whose value moves; none is `unchanged`. */
  write(
    task: number,
    values: Partial<Record<Field, string>>,
    owner: number | null,
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
    for (const row of rows) {
      this.cells.set(key(task, row.field), { value: row.after, fv: seq, fp: seq });
    }
    return this.#stack(seq, owner, rows);
  }

  undoTarget(owner: number): ModelCommit | undefined {
    let newest: ModelCommit | undefined;
    for (const c of this.commits.values()) {
      if (
        c.owner === owner &&
        c.status === "done" &&
        (newest === undefined || c.seq > newest.seq)
      ) {
        newest = c;
      }
    }
    return newest;
  }

  redoTarget(owner: number): ModelCommit | undefined {
    const after = this.undoTarget(owner)?.seq ?? 0;
    let oldest: ModelCommit | undefined;
    for (const c of this.commits.values()) {
      if (
        c.owner === owner &&
        c.status === "undone" &&
        c.seq > after &&
        (oldest === undefined || c.seq < oldest.seq)
      ) {
        oldest = c;
      }
    }
    return oldest;
  }

  /**
   * The fields that keep a row from being inverted: a set row's own field unless it holds the
   * row's write; for a create row, each field of its task that holds another's write, and each of
   * the task's runs (`runs`), which are always another commit's.
   */
  blocking(row: ModelChange): (Field | "runs")[] {
    if (row.create === true) {
      return [
        ...FIELDS.filter((f) => this.cell(row.task, f).fp !== row.afterProv),
        ...Array.from({ length: this.runs.get(row.task) ?? 0 }, () => "runs" as const),
      ];
    }
    return this.cell(row.task, row.field).fp === row.afterProv ? [] : [row.field];
  }

  /**
   * The rows of `rows` that do not pass, and with `partial` their lifecycle or wrap partner; and
   * the conflicts the writer names, as task|field keys.
   */
  failing(
    rows: readonly ModelChange[],
    partial: boolean,
  ): { failed: Set<ModelChange>; named: string[] } {
    const failed = new Set(rows.filter((r) => this.blocking(r).length > 0));
    const named = rows.flatMap((r) => this.blocking(r).map((f) => key(r.task, f)));
    if (partial) {
      for (const r of rows) {
        const partner =
          r.field === "lifecycle" ? "wrap" : r.field === "wrap" ? "lifecycle" : undefined;
        if (partner === undefined || failed.has(r)) continue;
        if (rows.some((o) => o.task === r.task && o.field === partner && failed.has(o))) {
          failed.add(r);
          named.push(key(r.task, r.field));
        }
      }
    }
    return { failed, named };
  }

  /**
   * A refused redo's step is set aside, and with it each later undone step of its owner whose redo
   * writes a field the step's redo writes, or anything of a task whose tombstone it writes.
   */
  setAside(step: ModelCommit): void {
    const written = new Set<string>();
    const write = (rows: readonly ModelChange[]) => {
      for (const r of rows) {
        written.add(key(r.task, r.field));
        if (r.field === "deleted") written.add(`${String(r.task)}|*`);
      }
    };
    write(this.commits.get(step.undoneBy ?? 0)?.rows ?? []);
    step.status = "dead";
    const later = [...this.commits.values()]
      .filter((c) => c.owner === step.owner && c.status === "undone" && c.seq > step.seq)
      .sort((a, b) => a.seq - b.seq);
    for (const c of later) {
      const rows = this.commits.get(c.undoneBy ?? 0)?.rows ?? [];
      if (
        !rows.some((r) => written.has(key(r.task, r.field)) || written.has(`${String(r.task)}|*`))
      ) {
        continue;
      }
      write(rows);
      c.status = "dead";
    }
  }

  /** Inverts `rows` but `skip` as commit lastSeq + 1 (A1 3.10): a create by its tombstone. */
  invert(rows: readonly ModelChange[], skip: ReadonlySet<ModelChange>): ModelCommit {
    const seq = this.lastSeq + 1;
    const inverted: ModelChange[] = [];
    for (const row of rows) {
      if (skip.has(row)) continue;
      const cell = this.cell(row.task, row.field);
      if (row.create === true) {
        inverted.push({
          task: row.task,
          field: "deleted",
          before: cell.value,
          after: "deleted",
          beforeProv: cell.fp,
          afterProv: seq,
        });
        this.cells.set(key(row.task, "deleted"), { value: "deleted", fv: seq, fp: seq });
        continue;
      }
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
    const commit: ModelCommit = { seq, owner: null, status: null, undoneBy: null, rows: inverted };
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
      deleted: t["deleted_at"] === null ? "" : "deleted",
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
    .prepare(
      "SELECT seq, principal_id, undo_status FROM commits WHERE undo_status IS NOT NULL ORDER BY seq",
    )
    .all<{ seq: number; principal_id: string; undo_status: string }>();
  const expected = [...model.commits.values()]
    .filter((c) => c.owner !== null)
    .map((c) => ({ seq: c.seq, owner: c.owner, undo_status: c.status }));
  expect(
    stack.map((c) => ({
      seq: c.seq,
      owner: c.principal_id === fx.human.principal_id ? 0 : 3,
      undo_status: c.undo_status,
    })),
  ).toEqual(expected);
}

/** The operation of a patch step. */
function patchOp(id: Id<"t">, set: Patch): Operation {
  const values: Record<string, unknown> = {};
  if (set.summary !== undefined) values["summary"] = set.summary;
  if (set.priority !== undefined) values["priority"] = Number(set.priority);
  if (set.status !== undefined) values["status"] = set.status;
  if (set.due !== undefined) values["due"] = set.due === "" ? null : { date: set.due };
  return { kind: "task.patch", task: id, set: values };
}

/** A second human of the fixture space, with an actors row of its own. */
async function secondHuman(fx: Fixture): Promise<Credential> {
  const id = newId("ac");
  const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
  try {
    conn.transaction("immediate", () => {
      conn
        .prepare(
          "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
            "VALUES ($id, 'human', 'Fixture partner', NULL, NULL, 0)",
        )
        .run({ id });
    });
  } finally {
    conn.close();
  }
  return { ...fx.human, principal_id: id, scope_id: "cli:partner" };
}

/**
 * The keys of the conflicts a result names, by task index: a run by its task's, as `runs`. A
 * conflict that counts more rows (`more`) stands for each of them.
 */
const named = (
  ids: readonly Id<"t">[],
  conflicts: readonly { entity: string; id: string; task?: string; field: string; more?: number }[],
) =>
  conflicts
    .flatMap((c) =>
      Array.from({ length: 1 + (c.more ?? 0) }, () =>
        c.entity === "runs"
          ? `${String(ids.indexOf(c.task as Id<"t">))}|runs`
          : `${String(ids.indexOf(c.id as Id<"t">))}|${c.field}`,
      ),
    )
    .sort();

const property = (seen: Seen) =>
  fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 50 }), async (generated) => {
    const steps = generated.flatMap(expand);
    // 80 fresh spaces and thousands of commits: which writes apply does not depend on a flush.
    const fx = await fixture();
    try {
      const actors: Credential[] = [fx.human, fx.codex, fx.claude, await secondHuman(fx)];
      const as = (n: number): Credential => actors[n] ?? fx.codex;
      // The first tasks are Codex's, so the humans' stacks hold only their own actions.
      const ids: Id<"t">[] = Array.from({ length: START_TASKS }, () => newId("t"));
      const made = fx.writer.submit(
        fx.request(
          fx.codex,
          ids.map((id, n) => ({ kind: "task.create", id, title: `Fixture task ${String(n + 1)}` })),
        ),
      );
      expect(made.status).toBe("applied");
      const model = new Model(made.seq - 1);
      model.create(START_TASKS, null);
      expect(model.lastSeq).toBe(made.seq);

      for (const s of steps) {
        const before = snapshot(fx, ids);
        if (s.kind === "create") {
          if (ids.length >= MAX_TASKS) continue;
          const id = newId("t");
          const result = fx.writer.submit(
            fx.request(
              as(s.actor),
              [{ kind: "task.create", id, title: `Fixture task ${String(ids.length + 1)}` }],
              isHuman(s.actor) ? { undoable: true } : {},
            ),
          );
          expect(result.status, JSON.stringify(result.error)).toBe("applied");
          ids.push(id);
          model.create(1, isHuman(s.actor) ? s.actor : null);
        } else if (s.kind === "run") {
          // The execution store's requests: the person's, never undoable (A1 3.6).
          const task = Math.max(0, ids.length - 1 - s.newest);
          const id = ids[task] as Id<"t">;
          const created = fx.writer.submit(
            fx.request(fx.human, [
              {
                kind: "run.create",
                task: id,
                instance: "codex-work",
                adapter: "codex",
                place: null,
                request: "Fixture instruction.",
                brief_hash: "a1b2c3d4".repeat(8),
                permission: "full-access",
                limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
              },
            ]),
          );
          if (model.deleted(task)) {
            expect(created.error?.code).toBe("DELETED");
            count(seen, "run refused on a tombstone");
          } else {
            expect(created.status, JSON.stringify(created.error)).toBe("applied");
            model.run(task);
            count(seen, "run");
            const run = created.results[0]?.id as Id<"ru">;
            const states = ["queued", "starting", "running"] as const;
            for (let m = 0; m < s.moves; m += 1) {
              const version = Number(
                fx.reader.prepare("SELECT version FROM runs WHERE id = $run").get({ run })?.[
                  "version"
                ],
              );
              const moved = fx.writer.submit(
                fx.request(fx.human, [
                  {
                    kind: "run.transition",
                    run,
                    expect: states[m] ?? "queued",
                    expect_version: version,
                    next: states[m + 1] ?? "starting",
                  },
                ]),
              );
              expect(moved.status, JSON.stringify(moved.error)).toBe("applied");
              model.run();
            }
          }
        } else if (s.kind === "aba") {
          // A task the commit wrote or created, and the field it wrote when that is patchable.
          const rows =
            (s.on === "undo"
              ? model.undoTarget(s.of)?.rows
              : model.commits.get(model.redoTarget(s.of)?.undoneBy ?? 0)?.rows) ?? [];
          const row = rows[s.pick % Math.max(rows.length, 1)];
          const task = row?.task ?? s.task % ids.length;
          const field =
            row !== undefined && row.create !== true && Object.hasOwn(VALUES, row.field)
              ? (row.field as Patchable)
              : s.field;
          // Another human's redo can write a tombstoned task (A1 3.10), never an agent's patch.
          if (model.deleted(task)) continue;
          const id = ids[task] ?? ids[0];
          const now = model.cell(task, field).value;
          const away = VALUES[field].find((v) => v !== now) ?? now;
          for (const value of [away, now]) {
            const result = fx.writer.submit(
              fx.request(as(s.actor), [patchOp(id as Id<"t">, { [field]: value })], {
                base: fx.base(),
              }),
            );
            expect(result.status, JSON.stringify(result.error)).toBe("applied");
            model.write(task, { [field]: value }, null);
          }
        } else if (s.kind === "write" || s.kind === "lifecycle") {
          const task = s.task % ids.length;
          const id = ids[task] ?? ids[0];
          const owner = isHuman(s.actor) ? s.actor : null;
          let op: Operation;
          let values: Partial<Record<Field, string>>;
          if (s.kind === "write") {
            op = patchOp(id as Id<"t">, s.set);
            values = s.set;
          } else if (model.cell(task, "lifecycle").value === "active") {
            op = { kind: "task.complete", task: id as Id<"t"> };
            values = { lifecycle: "completed", wrap: "pending" };
          } else {
            op = { kind: "task.reopen", task: id as Id<"t"> };
            values = { lifecycle: "active", wrap: "" };
          }
          const result = fx.writer.submit(
            fx.request(as(s.actor), [op], {
              base: fx.base(),
              ...(owner === null ? {} : { undoable: true }),
            }),
          );
          if (model.deleted(task)) {
            // A tombstoned task takes no write but an undo's or a redo's.
            expect(result.error?.code).toBe("DELETED");
            count(seen, "write refused on a tombstone");
          } else {
            const ended = [...model.commits.values()].some(
              (c) => c.owner === owner && owner !== null && c.status === "undone",
            );
            const commit = model.write(task, values, owner);
            expect(result.status, JSON.stringify(result.error)).toBe(
              commit === undefined ? "unchanged" : "applied",
            );
            if (commit !== undefined && ended) count(seen, "redo ended");
          }
        } else if (s.kind === "undo") {
          const target = model.undoTarget(s.who);
          const result = fx.writer.submit(
            fx.request(as(s.who), [{ kind: "undo", ...(s.partial ? { partial: true } : {}) }]),
          );
          if (target === undefined) {
            expect(result.error?.code).toBe("NOTHING_TO_UNDO");
            count(seen, "NOTHING_TO_UNDO");
          } else {
            const guard = model.failing(target.rows, false);
            const creates = target.rows.some((r) => r.create === true);
            if (guard.named.some((k) => k.endsWith("|runs"))) count(seen, "create kept by a run");
            if (guard.failed.size > 0 && !s.partial) {
              expect(result.status).toBe("conflict");
              expect(result.error?.code).toBe("UNDO_CONFLICT");
              expect(named(ids, result.conflicts)).toEqual([...guard.named].sort());
              count(seen, creates ? "create kept" : "undo conflict");
              // R2: a field set back to the value the human wrote is still another's write.
              if (
                [...guard.failed].some(
                  (r) => r.create !== true && model.cell(r.task, r.field).value === r.after,
                )
              ) {
                count(seen, "aba refused");
              }
            } else {
              const { failed, named: left } = model.failing(target.rows, s.partial);
              expect(result.status, JSON.stringify(result.error)).toBe("applied");
              const u = model.invert(target.rows, failed);
              target.status = "undone";
              target.undoneBy = u.seq;
              expect(result.seq).toBe(u.seq);
              expect(named(ids, result.conflicts)).toEqual([...left].sort());
              count(seen, failed.size > 0 ? "partial undo" : "undo");
              if (s.who === 3) count(seen, "second human's undo");
              if (target.rows.some((r) => r.create === true && !failed.has(r))) {
                count(seen, "create undone");
              }
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
        } else if (s.kind === "redo") {
          const target = model.redoTarget(s.who);
          const result = fx.writer.submit(fx.request(as(s.who), [{ kind: "redo" }]));
          if (target === undefined) {
            expect(result.error?.code).toBe("NOTHING_TO_REDO");
            count(seen, "NOTHING_TO_REDO");
          } else {
            const undone = model.commits.get(target.undoneBy ?? 0);
            if (undone === undefined) throw new Error("no undo");
            const guard = model.failing(undone.rows, false);
            if (guard.failed.size > 0) {
              expect(result.status).toBe("conflict");
              expect(result.error?.code).toBe("UNDO_CONFLICT");
              expect(named(ids, result.conflicts)).toEqual([...guard.named].sort());
              model.setAside(target);
              count(seen, "redo conflict");
            } else {
              expect(result.status, JSON.stringify(result.error)).toBe("applied");
              const r = model.invert(undone.rows, new Set());
              target.status = "done";
              target.undoneBy = null;
              expect(result.seq).toBe(r.seq);
              count(seen, "redo");
              if (undone.rows.some((w) => w.field === "deleted")) count(seen, "create redone");
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
      "second human's undo",
      "create undone",
      "create redone",
      "create kept",
      "write refused on a tombstone",
      "run",
      "create kept by a run",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(3);
    }
    await fc.assert(property({}), { numRuns: 20 });
  }, 180_000);
});
