// A7 3.8 M1.04 Verify: "Property test against a reference model with 3 actors: no lost update,
// every fv equals its latest change row." Three actors (Mira and two agents) read and write the
// same tasks in random order, each with the base of its own last read. A small reference model
// predicts every outcome: a write applies only when no field it touches changed after its base
// (A1 3.5), and then it changes exactly the fields whose final value differs, each in one change
// row that names the first operation that wrote it. After every step the space must equal the
// model, field by field and version by version, and the history must hold A1's invariants
// (write-helpers.ts: checkHistory). The model also keeps every group's order as a
// plain list, without positions, so the space's order by position must match it whatever the
// position format does.
//
// The authority changes too: a step moves the space to a new epoch, a new incarnation or both, as
// M1.06's restore claim and a transfer will, so a read from before is a stale base. A write sends
// its base in the wire form (with the incarnation's 8-character tag) or as an object (with the
// full ID), and now and then from the future. A stale base is EPOCH_CHANGED, whatever it asks.
//
// Receipts are on (A7 3.8 M1.05): a step sends an earlier request again with its request ID. The
// same intent, with its old base or a fresh one, returns the stored result marked replayed, and
// another intent under that ID is REQUEST_ID_REUSED. Neither changes the space: a retried request
// never applies twice and never changes the model.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import { decodeSpaceRow, type LineageEntry } from "../src/rows.ts";
import {
  formatAsOf,
  type AsOf,
  type Base,
  type Credential,
  type Operation,
  type WriteRequest,
  type WriteResult,
} from "../src/write/request.ts";

/** The operations the model knows: the five task operations. */
type TaskOperation = Extract<
  Operation,
  { kind: "task.create" | "task.patch" | "task.move" | "task.complete" | "task.reopen" }
>;
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkSpace } from "./space-rules.ts";
import { checkHistory, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("write-model");
// Each run gets its own copy of one fixture space, made once.
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

type Field = "title" | "summary" | "priority" | "status" | "grouping" | "lifecycle" | "wrap";
const FIELDS: readonly Field[] = [
  "title",
  "summary",
  "priority",
  "status",
  "grouping",
  "lifecycle",
  "wrap",
];
type AreaName = "lumen" | "home" | null;

interface ModelTask {
  id: Id<"t">;
  created: number;
  title: string;
  summary: string;
  priority: number;
  status: string;
  area: AreaName;
  lifecycle: "active" | "completed";
  wrapState: "pending" | "wrapped" | null;
  outcome: string | null;
  versions: Partial<Record<Field, number>>;
}

type OpSpec =
  | {
      k: "patch";
      t: number;
      set: { title?: string; summary?: string; priority?: number; status?: string };
    }
  | { k: "complete"; t: number; outcome: string | undefined }
  | { k: "reopen"; t: number }
  /** Sets the summary the task already has: a request of only these changes nothing. */
  | { k: "same"; t: number }
  | { k: "move"; t: number; area: AreaName }
  /** A move right after or before another task, into that task's group. */
  | { k: "beside"; t: number; s: number; side: "after" | "before" }
  | { k: "create"; title: string };

/** A group's key in the model: its area, or none. */
type GroupKey = Exclude<AreaName, null> | "none";
const groupKey = (area: AreaName): GroupKey => area ?? "none";

/** How the space's authority moves: to a new epoch, a new incarnation, or both. */
type AuthorityChange = "epoch" | "incarnation" | "both";

/**
 * A write reads first (`fresh`), as an agent's read-modify-write does, or uses its last read. It
 * sends the base in the wire form or as an object, and `ahead` commits past the read's seq when
 * above 0 (a base from the future).
 */
type Step =
  | { kind: "read"; actor: number }
  | {
      kind: "write";
      actor: number;
      fresh: boolean;
      form: "wire" | "object";
      ahead: number;
      ops: OpSpec[];
    }
  | { kind: "authority"; change: AuthorityChange }
  /**
   * Sends an earlier request again, with its request ID (M1.05, A1 3.8): the same intent, now and
   * then with a fresh base, which must replay the stored result, or (`reuse`) another intent,
   * which must be REQUEST_ID_REUSED. Neither may change the space.
   */
  | { kind: "retry"; want: WriteResult["status"]; pick: number; fresh: boolean; reuse: boolean };

const task = fc.nat({ max: 9 });
const opSpec: fc.Arbitrary<OpSpec> = fc.oneof(
  {
    arbitrary: fc.record({
      k: fc.constant("patch" as const),
      t: task,
      set: fc.record(
        {
          title: fc.constantFrom("Fix the export", "Review the export"),
          summary: fc.constantFrom("", "Next: compare totals"),
          priority: fc.integer({ min: 1, max: 4 }),
          status: fc.constantFrom("open", "waiting"),
        },
        { requiredKeys: [] },
      ),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("complete" as const),
      t: task,
      outcome: fc.option(fc.constantFrom("Shipped", "Dropped"), { nil: undefined }),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ k: fc.constant("reopen" as const), t: task }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("same" as const), t: task }), weight: 1 },
  {
    arbitrary: fc.record({
      k: fc.constant("move" as const),
      t: task,
      area: fc.constantFrom<AreaName>("lumen", "home", null),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("beside" as const),
      t: task,
      s: task,
      side: fc.constantFrom("after" as const, "before" as const),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("create" as const),
      title: fc.constantFrom("Book the dentist", "Plant bulbs"),
    }),
    weight: 1,
  },
);
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant("read" as const), actor: fc.nat({ max: 2 }) }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("write" as const),
      actor: fc.nat({ max: 2 }),
      fresh: fc.boolean(),
      form: fc.constantFrom("wire" as const, "object" as const),
      ahead: fc.oneof({ arbitrary: fc.constant(0), weight: 9 }, fc.integer({ min: 1, max: 3 })),
      ops: fc.array(opSpec, { minLength: 1, maxLength: 3 }),
    }),
    weight: 6,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("authority" as const),
      change: fc.constantFrom<AuthorityChange>("epoch", "incarnation", "both"),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("retry" as const),
      want: fc.constantFrom<WriteResult["status"]>("applied", "unchanged", "conflict", "rejected"),
      pick: fc.nat(),
      fresh: fc.boolean(),
      // One retry in four sends another intent.
      reuse: fc.constantFrom(false, false, false, true),
    }),
    weight: 3,
  },
);

/** What the model expects a request to do. */
type Expected =
  | { status: "rejected"; code: string }
  | { status: "conflict"; conflicts: string[] }
  | { status: "unchanged" }
  | {
      status: "applied";
      tasks: Map<Id<"t">, ModelTask>;
      groups: Map<GroupKey, Id<"t">[]>;
      /** Tasks a sibling move put somewhere else. */
      reordered: number;
      /**
       * The commit's change rows, `<task>|<field>` (`<task>|` for a create row), each with the
       * index of the first operation that wrote it, or that created the task.
       */
      changes: Map<string, number>;
    };

/** The 8-character tag of the wire form: the first characters of the incarnation ID's body. */
const tagOf = (incarnation: string): string => incarnation.slice("ai_".length, "ai_".length + 8);

class Model {
  tasks = new Map<Id<"t">, ModelTask>();
  order: Id<"t">[] = [];
  /** Each group's tasks in the order the space must show them, whatever their lifecycle. */
  groups = new Map<GroupKey, Id<"t">[]>();
  lastSeq: number;
  epoch: number;
  incarnation: Id<"ai">;

  constructor(asOf: AsOf) {
    this.lastSeq = asOf.seq;
    this.epoch = asOf.epoch;
    this.incarnation = asOf.incarnation;
  }

  /**
   * A1 3.5: a base names the current epoch and incarnation (the full ID, or its tag in the wire
   * form), and a seq the space has reached. Undefined when the base passes.
   */
  judgeBase(base: Base | undefined): Expected | undefined {
    if (base === undefined) return undefined;
    const incarnation = base.incarnation.startsWith("ai_")
      ? base.incarnation === this.incarnation
      : base.incarnation === tagOf(this.incarnation);
    if (base.epoch !== this.epoch || !incarnation) {
      return { status: "rejected", code: "EPOCH_CHANGED" };
    }
    if (base.seq > this.lastSeq) return { status: "rejected", code: "BASE_FROM_FUTURE" };
    return undefined;
  }

  /** Turns op specs into operations, naming tasks by index among those that exist, drafts included. */
  build(specs: readonly OpSpec[]): TaskOperation[] {
    const order = [...this.order];
    const moved = new Set<Id<"t">>();
    const ops: TaskOperation[] = [];
    for (const spec of specs) {
      if (spec.k === "create") {
        const id = newId("t");
        order.push(id);
        ops.push({ kind: "task.create", id, title: spec.title });
        continue;
      }
      const target = order[spec.t % order.length];
      if (target === undefined) continue;
      switch (spec.k) {
        case "patch": {
          const set = Object.keys(spec.set).length > 0 ? spec.set : { title: "Fix the export" };
          ops.push({ kind: "task.patch", task: target, set });
          break;
        }
        case "complete":
          ops.push({
            kind: "task.complete",
            task: target,
            ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
          });
          break;
        case "reopen":
          ops.push({ kind: "task.reopen", task: target });
          break;
        case "same":
          ops.push({
            kind: "task.patch",
            task: target,
            set: { summary: this.tasks.get(target)?.summary ?? "" },
          });
          break;
        case "move":
          // One move per task per request. A second one could bring the task back to where it
          // started, and whether its position is then the same text depends on the position
          // format, which this model leaves out on purpose. The writer's own tests cover it.
          if (moved.has(target)) break;
          moved.add(target);
          ops.push({ kind: "task.move", task: target, area: spec.area });
          break;
        case "beside": {
          const sibling = order[spec.s % order.length];
          if (sibling === undefined || sibling === target || moved.has(target)) break;
          moved.add(target);
          ops.push(
            spec.side === "after"
              ? { kind: "task.move", task: target, after: sibling }
              : { kind: "task.move", task: target, before: sibling },
          );
          break;
        }
      }
    }
    return ops;
  }

  /** Predicts a request with `base` (undefined: no base). */
  predict(ops: readonly TaskOperation[], base: Base | undefined): Expected {
    const judged = this.judgeBase(base);
    if (judged !== undefined) return judged;
    const drafts = new Set<string>();
    const touched = new Map<string, { task: ModelTask; field: Field }>();
    for (const op of ops) {
      if (op.kind === "task.create") {
        drafts.add(op.id ?? "");
        continue;
      }
      if (drafts.has(op.task)) continue;
      const task = this.tasks.get(op.task as Id<"t">);
      if (task === undefined) throw new Error("the model lost a task");
      const fields: Field[] =
        op.kind === "task.patch"
          ? (Object.keys(op.set ?? {}) as Field[])
          : op.kind === "task.move"
            ? ["grouping"]
            : ["lifecycle", "wrap"];
      for (const field of fields) touched.set(`${task.id}|${field}`, { task, field });
    }
    if (touched.size > 0 && base === undefined)
      return { status: "rejected", code: "BASE_REQUIRED" };
    const conflicts = [...touched.values()]
      .filter(({ task, field }) => (task.versions[field] ?? task.created) > (base?.seq ?? 0))
      .map(({ task, field }) => `${task.id}|${field}`);
    if (conflicts.length > 0) return { status: "conflict", conflicts: conflicts.sort() };

    // Execute in order, with read-your-writes.
    const work = new Map(
      [...this.tasks].map(([id, t]) => [id, { ...t, versions: { ...t.versions } }]),
    );
    const groups = new Map([...this.groups].map(([key, ids]) => [key, [...ids]]));
    const list = (area: AreaName): Id<"t">[] => {
      const ids = groups.get(groupKey(area)) ?? [];
      groups.set(groupKey(area), ids);
      return ids;
    };
    const takeOut = (t: ModelTask): void => {
      const ids = list(t.area);
      ids.splice(ids.indexOf(t.id), 1);
    };
    // Tasks that got a new place: their position changes, so their grouping does.
    const repositioned = new Set<string>();
    let reordered = 0;
    const completed = new Set<string>();
    const wrapped = new Set<string>();
    const written = new Map<string, Set<Field>>();
    const firstOp = new Map<string, number>();
    const changes = new Map<string, number>();
    let i = -1;
    const write = (id: string, ...fields: Field[]): void => {
      const set = written.get(id) ?? new Set<Field>();
      for (const f of fields) {
        set.add(f);
        if (!firstOp.has(`${id}|${f}`)) firstOp.set(`${id}|${f}`, i);
      }
      written.set(id, set);
    };
    const seq = this.lastSeq + 1;
    for (const op of ops) {
      i += 1;
      if (op.kind === "task.create") {
        const id = op.id as Id<"t">;
        changes.set(`${id}|`, i);
        work.set(id, {
          id,
          created: seq,
          title: op.title,
          summary: "",
          priority: 4,
          status: "open",
          area: null,
          lifecycle: "active",
          wrapState: null,
          outcome: null,
          versions: {},
        });
        // A new task goes to the end of its group.
        list(null).push(id);
        continue;
      }
      const t = work.get(op.task as Id<"t">);
      if (t === undefined) throw new Error("the model lost a task");
      switch (op.kind) {
        case "task.patch":
          Object.assign(t, op.set);
          write(t.id, ...(Object.keys(op.set ?? {}) as Field[]));
          break;
        case "task.move": {
          const siblingId = op.after ?? op.before;
          if (siblingId === undefined) {
            // Another group: the end of it. The same group: the task stays where it is.
            const area = (op.area ?? null) as AreaName;
            if (t.area !== area) {
              takeOut(t);
              list(area).push(t.id);
              t.area = area;
              repositioned.add(t.id);
            }
          } else {
            // Right next to the sibling, in the sibling's group. A task already there stays.
            const sibling = work.get(siblingId as Id<"t">);
            if (sibling === undefined) throw new Error("the model lost a sibling");
            const side = op.after === undefined ? "before" : "after";
            const ids = list(sibling.area);
            const at = ids.indexOf(sibling.id);
            const neighbour = side === "after" ? ids[at + 1] : ids[at - 1];
            if (t.area !== sibling.area || neighbour !== t.id) {
              takeOut(t);
              const into = list(sibling.area);
              const index = into.indexOf(sibling.id);
              into.splice(side === "after" ? index + 1 : index, 0, t.id);
              t.area = sibling.area;
              repositioned.add(t.id);
              reordered += 1;
            }
          }
          write(t.id, "grouping");
          break;
        }
        case "task.complete":
          if (t.lifecycle !== "active") return { status: "rejected", code: "INVALID_TRANSITION" };
          t.lifecycle = "completed";
          t.wrapState = op.outcome === undefined ? "pending" : "wrapped";
          if (op.outcome !== undefined) {
            t.outcome = op.outcome;
            wrapped.add(t.id);
          }
          completed.add(t.id);
          write(t.id, "lifecycle", "wrap");
          break;
        case "task.reopen":
          if (t.lifecycle === "active") return { status: "rejected", code: "INVALID_TRANSITION" };
          t.lifecycle = "active";
          t.wrapState = null;
          write(t.id, "lifecycle", "wrap");
          break;
      }
    }
    // Coalesce: a field changed when its final value differs from its start value. A new
    // completion or wrap-up time always differs, because the test clock moves on every commit.
    let changed = drafts.size > 0;
    for (const [id, fields] of written) {
      const before = this.tasks.get(id as Id<"t">);
      const after = work.get(id as Id<"t">);
      if (before === undefined || after === undefined) continue;
      for (const field of fields) {
        const differs =
          field === "grouping"
            ? before.area !== after.area || repositioned.has(id)
            : field === "lifecycle"
              ? before.lifecycle !== after.lifecycle ||
                (after.lifecycle === "completed" && completed.has(id))
              : field === "wrap"
                ? before.wrapState !== after.wrapState ||
                  before.outcome !== after.outcome ||
                  wrapped.has(id)
                : before[field] !== after[field];
        if (differs) {
          after.versions[field] = seq;
          changes.set(`${id}|${field}`, firstOp.get(`${id}|${field}`) ?? -1);
          changed = true;
        }
      }
    }
    return changed
      ? { status: "applied", tasks: work, groups, reordered, changes }
      : { status: "unchanged" };
  }

  commit(applied: Extract<Expected, { status: "applied" }>): void {
    this.lastSeq += 1;
    for (const id of applied.tasks.keys()) if (!this.tasks.has(id)) this.order.push(id);
    this.tasks = applied.tasks;
    this.groups = applied.groups;
  }
}

/**
 * Moves the space's authority as M1.06's restore claim or a transfer will: a new epoch, a new
 * incarnation or both, with its lineage entry, from the current seq on. The writer has no
 * operation for it yet, so a second connection writes the space row between the writer's
 * requests. Returns the new epoch and incarnation.
 */
async function moveAuthority(
  fx: Fixture,
  change: AuthorityChange,
): Promise<{ epoch: number; incarnation: Id<"ai"> }> {
  const conn = openWriter(await checkedDriver(), join(fx.folder, "space.db"));
  try {
    return conn.transaction("immediate", () => {
      const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
      const { authority } = space;
      const epoch = change === "incarnation" ? authority.epoch : authority.epoch + 1;
      const incarnation = change === "epoch" ? authority.incarnation : newId("ai");
      const entry: LineageEntry = {
        incarnation,
        epoch,
        kind: change === "incarnation" ? "restore_claim" : "transfer",
        parent: { incarnation: authority.incarnation, through_seq: space.lastSeq },
        machine_id: authority.machineId,
        at: space.createdAt,
      };
      conn
        .prepare(
          "UPDATE space SET authority_epoch = $epoch, authority_incarnation = $incarnation, " +
            "authority_since = last_seq, lineage = $lineage WHERE one = 1",
        )
        .run({
          epoch,
          incarnation,
          lineage: JSON.stringify({
            ...space.lineage,
            incarnations: [...space.lineage.incarnations, entry],
          }),
        });
      return { epoch, incarnation };
    });
  } finally {
    conn.close();
  }
}

/** The base a write sends for a read at `read`: the wire form, or an object with the full ID. */
function baseFor(
  read: AsOf,
  form: "wire" | "object",
  ahead: number,
): { sent: string | Base; judged: Base } {
  const asOf = { ...read, seq: read.seq + ahead };
  if (form === "object") return { sent: asOf, judged: asOf };
  const tag = tagOf(asOf.incarnation);
  return {
    sent: `${String(asOf.epoch)}.${String(asOf.seq)}.${tag}`,
    judged: { ...asOf, incarnation: tag },
  };
}

/** The space's tasks equal the model's, field by field and version by version. */
function expectModel(fx: Fixture, model: Model): void {
  const areas: Record<string, AreaName> = { [fx.areas.lumen]: "lumen", [fx.areas.home]: "home" };
  const rows = fx.reader
    .prepare("SELECT * FROM tasks ORDER BY ref")
    .all<Record<string, unknown> & { id: Id<"t">; fv: string }>();
  expect(rows.map((r) => r.id).sort()).toEqual([...model.tasks.keys()].sort());
  for (const row of rows) {
    const t = model.tasks.get(row.id);
    if (t === undefined) throw new Error("unknown task");
    expect({
      title: row["title"],
      summary: row["summary"],
      priority: row["priority"],
      status: row["status"],
      area: typeof row["area_id"] === "string" ? areas[row["area_id"]] : row["area_id"],
      lifecycle: row["lifecycle"],
      wrapState: row["wrap_state"],
      outcome: row["outcome"],
      created: row["created_seq"],
    }).toEqual({
      title: t.title,
      summary: t.summary,
      priority: t.priority,
      status: t.status,
      area: t.area,
      lifecycle: t.lifecycle,
      wrapState: t.wrapState,
      outcome: t.outcome,
      created: t.created,
    });
    const fv = JSON.parse(row.fv) as Record<string, number>;
    const expected: Record<string, number> = {};
    for (const field of FIELDS) {
      const version = t.versions[field];
      if (version !== undefined) expected[field] = version;
    }
    expect(fv).toEqual(expected);
  }
  // Every group, ordered by position, is the model's list, and no two tasks share a position.
  for (const [key, area] of [
    ["none", null],
    ["lumen", fx.areas.lumen],
    ["home", fx.areas.home],
  ] as const) {
    const placed = fx.reader
      .prepare(
        "SELECT id, position FROM tasks WHERE project_id IS NULL AND area_id IS $area " +
          "ORDER BY position",
      )
      .all<{ id: Id<"t">; position: string }>({ area });
    expect(
      placed.map((r) => r.id),
      `the order of ${key}`,
    ).toEqual(model.groups.get(key) ?? []);
    expect(new Set(placed.map((r) => r.position)).size, `positions in ${key}`).toBe(placed.length);
  }
}

/** How often each outcome was seen, so the property cannot pass on runs that never conflict. */
type Seen = Record<string, number>;

/** A result as its receipt stores it: a conflict without the value, which was a read (A1 3.8). */
function stored(result: WriteResult): WriteResult {
  return {
    ...result,
    conflicts: result.conflicts.map((conflict) => {
      const kept = { ...conflict };
      delete kept.value;
      return kept;
    }),
  };
}

const property = (seen: Seen) =>
  fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 40 }), async (steps) => {
    // 150 fresh spaces and thousands of commits: which writes apply does not depend on a flush.
    const fx = await fixture();
    try {
      const actors: Credential[] = [fx.human, fx.codex, fx.claude];
      const model = new Model(fx.writer.asOf());
      // Mira starts with three tasks.
      const seed = model.build([
        { k: "create", title: "Fix the export" },
        { k: "create", title: "Book the dentist" },
        { k: "create", title: "Plant bulbs" },
      ]);
      const first = model.predict(seed, undefined);
      if (first.status !== "applied") throw new Error("the seed request must apply");
      const seedRequest = fx.request(fx.human, seed);
      const seeded = fx.writer.submit(seedRequest);
      expect(seeded.status).toBe("applied");
      model.commit(first);
      /** Every request sent so far, with its result: what a retry sends again. */
      const sent: { request: WriteRequest; result: WriteResult }[] = [
        { request: seedRequest, result: seeded },
      ];
      const reads: (AsOf | undefined)[] = [undefined, undefined, undefined];
      /** A read, checked against the model: the space's as_of is the model's. */
      const read = (): AsOf => {
        const asOf = fx.writer.asOf();
        expect(asOf).toEqual({
          epoch: model.epoch,
          incarnation: model.incarnation,
          seq: model.lastSeq,
        });
        return asOf;
      };

      let space = checkSpace(fx.reader);
      for (const s of steps) {
        space = checkSpace(fx.reader, space);
        if (s.kind === "authority") {
          const moved = await moveAuthority(fx, s.change);
          model.epoch = moved.epoch;
          model.incarnation = moved.incarnation;
          seen[`authority ${s.change}`] = (seen[`authority ${s.change}`] ?? 0) + 1;
          continue;
        }
        if (s.kind === "read") {
          reads[s.actor] = read();
          continue;
        }
        if (s.kind === "retry") {
          // With receipts on, a retried request never applies twice and never changes the model.
          // An earlier request with the outcome the step wants, so every kind of receipt replays.
          const wanted = sent.filter((x) => x.result.status === s.want);
          const pool = wanted.length > 0 ? wanted : sent;
          const earlier = pool[s.pick % pool.length];
          const target = model.order[0];
          if (earlier === undefined || target === undefined) continue;
          const again: WriteRequest = s.reuse
            ? {
                ...earlier.request,
                ops: [{ kind: "task.patch", task: target, set: { title: "Retitled on reuse" } }],
              }
            : s.fresh
              ? { ...earlier.request, base: formatAsOf(fx.writer.asOf()) }
              : earlier.request;
          const result = fx.writer.submit(again);
          if (s.reuse) {
            expect(result.status).toBe("rejected");
            expect(result.error?.code).toBe("REQUEST_ID_REUSED");
            seen["reused"] = (seen["reused"] ?? 0) + 1;
          } else {
            expect(result).toEqual({ ...stored(earlier.result), replayed: true });
            const label = `replayed ${earlier.result.status}`;
            seen[label] = (seen[label] ?? 0) + 1;
          }
          read();
          expectModel(fx, model);
          continue;
        }
        const ops = model.build(s.ops);
        if (ops.length === 0) continue;
        if (s.fresh) reads[s.actor] = read();
        const last = reads[s.actor];
        const base = last === undefined ? undefined : baseFor(last, s.form, s.ahead);
        const expected = model.predict(ops, base?.judged);
        const actor = actors[s.actor];
        if (actor === undefined) throw new Error("no actor");
        const request = fx.request(actor, ops, base === undefined ? {} : { base: base.sent });
        const result = fx.writer.submit(request);
        sent.push({ request, result });
        if (last !== undefined && expected.status === "rejected") {
          // Which way the base was stale, so the runs must reach each on its own.
          const epoch = last.epoch !== model.epoch;
          const incarnation = last.incarnation !== model.incarnation;
          const way = epoch && incarnation ? "both" : epoch ? "epoch" : "incarnation";
          const label = `stale ${way}, ${s.form}`;
          if (epoch || incarnation) seen[label] = (seen[label] ?? 0) + 1;
        }
        expect(result.status, JSON.stringify(result.error)).toBe(expected.status);
        const label = expected.status === "rejected" ? expected.code : expected.status;
        seen[label] = (seen[label] ?? 0) + 1;
        if (expected.status === "rejected") expect(result.error?.code).toBe(expected.code);
        if (expected.status === "conflict") {
          expect(result.conflicts.map((c) => `${c.id}|${c.field}`).sort()).toEqual(
            expected.conflicts,
          );
        }
        if (expected.status === "applied") {
          model.commit(expected);
          seen["reordered"] = (seen["reordered"] ?? 0) + expected.reordered;
          // One change row per changed (task, field), naming the first operation that wrote it.
          const rows = fx.reader
            .prepare(
              "SELECT entity_id || '|' || coalesce(field, '') AS key, op FROM changes " +
                "WHERE seq = $seq",
            )
            .all<{ key: string; op: number }>({ seq: result.seq });
          expect(new Map(rows.map((r) => [r.key, r.op]))).toEqual(expected.changes);
          expect(rows.length).toBe(expected.changes.size);
        }
        // The result's as_of is the new commit, or the state the request was judged on.
        expect(result.seq).toBe(model.lastSeq);
        expect([result.epoch, result.incarnation]).toEqual([model.epoch, model.incarnation]);
        expectModel(fx, model);
      }
      checkSpace(fx.reader, space);
      checkHistory(fx.reader);
    } finally {
      fx.close();
    }
  });

describe("[A1.5.write.lost-update] three actors against a reference model", () => {
  test("no lost update: every write applies, conflicts or is refused as the model says, and every fv equals its latest change row", async () => {
    // A fixed seed, whose runs must reach every outcome, then fresh random runs.
    const seen: Seen = {};
    await fc.assert(property(seen), { numRuns: 120, seed: 20261113 });
    for (const outcome of [
      "applied",
      "unchanged",
      "conflict",
      "BASE_REQUIRED",
      "INVALID_TRANSITION",
      "reordered",
      "EPOCH_CHANGED",
      "BASE_FROM_FUTURE",
      "stale epoch, wire",
      "stale epoch, object",
      "stale incarnation, wire",
      "stale incarnation, object",
      "replayed applied",
      "replayed unchanged",
      "replayed conflict",
      "replayed rejected",
      "reused",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(5);
    }
    await fc.assert(property({}), { numRuns: 30 });
  }, 180_000);
});
