// A7 3.10 M3.02 Verify: "ABA property test: undo never changes a field whose version moved. Undo
// then redo restores the values the commit wrote." Two humans and two agents create tasks, write a
// few fields of them, remove and restore them, add notes to them, link them to sources, and create
// areas and projects in them, in random order, the humans' writes on their own undo stacks, and
// each human undoes (now and then partially) and redoes. Values, slugs and source keys come from
// small sets, so an agent often sets a field back to the very value a human wrote (an undo must
// still refuse it: R2, provenance never equality), takes a slug or a key a human's undone step
// held, or adds to a task a human's undone removal would hide. The person also runs tasks (A4
// 3.11): a run's commits never join a stack and never end a redo, a run keeps its task's create
// from being undone (A1 3.10), and a tombstoned task takes no run.
//
// A reference model predicts every outcome from A1 3.10 and 3.10.1's rules alone: which commit an
// undo takes (the step applied last) and which a redo redoes (the oldest undone step it can, the
// older ones passed over and kept), which of its rows pass their guards (provenance; a key or a
// slug another live row holds; newer work by another on a row the step would hide, or on a task
// it would take out of the open list; a live child of a row it would un-create; two active holders
// of one key; a row or its owner out of sight), what each field holds with its fv and its fp after
// each step, and each stack commit's status. When a step and each row of it was last applied, the
// model records as it acts, so it checks the writer's choice instead of repeating it. On top of
// the prediction, each undo and redo is checked against the space itself: the only task fields it
// changes are rows of the inverted commit whose provenance was the guard; a redo brings back
// exactly the after-values and the provenance of the commit it redoes; and no field's fv ever
// moves back. After every step, the rules every write keeps (space-rules.ts), and each run ends
// with A1's history invariants (write-helpers.ts: checkHistory), among them that every field holds
// the value its provenance commit wrote.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newerBy } from "@ttasks/contracts/newer-work";
import { newId, type Id } from "../src/ids.ts";
import { openWriter } from "../src/open.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkSpace } from "./space-rules.ts";
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
/** Each actor as an answer's newer work names it: a person as "user", an agent by its label. */
const NAMES = ["user", "Codex · work", "Claude Code · work", "user"] as const;

/** The rows the model keeps: a task's fields, and the tombstone of each other row. */
type Entity = "tasks" | "notes" | "areas" | "projects" | "sources" | "links";
const TOMBSTONE: Readonly<Record<Entity, string>> = {
  tasks: "deleted",
  notes: "deleted",
  areas: "deleted",
  projects: "deleted",
  sources: "deleted",
  links: "removed",
};
/** A tombstone that is set: the row is out of sight. A live row's is "". */
const GONE = "x";

/** A field's value as the model keeps it: the column that tells it, as text. */
interface Cell {
  value: string;
  fv: number;
  fp: number;
}

/** A row other than a task's fields: what owns it, and the slug or key it holds. */
interface ModelRow {
  entity: Entity;
  id: number;
  created: number;
  /** The task its change rows name: a note's or a link's, a source's first link's. */
  task: number | null;
  owners: { entity: Entity; id: number }[];
  /** A source's key, an area's or a project's slug. */
  key?: string;
}

interface ModelChange {
  entity: Entity;
  id: number;
  field: string;
  task: number | null;
  before: string;
  after: string;
  beforeProv: number;
  afterProv: number;
  /** A create row: inverted by a tombstone, guarded by every field of its row and its children. */
  create?: true;
}

interface ModelCommit {
  seq: number;
  /** The human whose undo stack holds it, or null. */
  owner: number | null;
  status: "done" | "undone" | "dead" | null;
  undoneBy: number | null;
  /** Who wrote it, and as what: a run's commits are the first human's. */
  by: number;
  kind: "write" | "undo" | "redo" | "run";
  /** A run's task. */
  runTask?: number;
  rows: ModelChange[];
  /**
   * For a stack commit, when it was last applied, recorded as the model acts: its own seq, then
   * each redo of it, also one that wrote nothing.
   */
  last: number;
  /** When it last wrote each row's field, by `field` (a create's by its tombstone): its seq, or a redo that wrote that field again. */
  wrote: Map<string, number>;
}

type Patchable = "summary" | "priority" | "status" | "due";
type Patch = Partial<Record<Patchable, string>>;

type Step =
  | { kind: "write"; actor: number; task: number; set: Patch }
  /** The same patch to two tasks in one request: one commit, one step on a stack. */
  | { kind: "pair"; actor: number; task: number; other: number; set: Patch }
  /** Completes an active task, reopens another: lifecycle and wrap-up change together. */
  | { kind: "lifecycle"; actor: number; task: number }
  /** A new task, on its creator's stack when a human made it. */
  | { kind: "create"; actor: number }
  /** Moves a task to the Trash, or brings it back. */
  | { kind: "remove" | "restore"; actor: number; task: number }
  | { kind: "note"; actor: number; task: number }
  /** Links a task to the source of `key`, made when no live source has it. */
  | { kind: "link"; actor: number; task: number; key: number }
  | { kind: "area"; actor: number; slug: number }
  /** A project in one of the live areas (`area` among them), or in none. */
  | { kind: "project"; actor: number; slug: number; area: number }
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
  | { kind: "cycle"; who: number; partial: boolean; times: number }
  /**
   * The sequences a redo passes over: a human removes, restores and edits one task, undoes the
   * three, and an agent adds a note; or makes an area and a project in it, undoes both, and an
   * agent takes the area's slug; or links a task to a new source and another task to it, undoes
   * both, and an agent takes the key. Then the human redoes. Or (`held`) a human removes and
   * restores a task, an agent adds a note, and the human's partial undo of the restore leaves it,
   * a redo brings nothing back, and an undo tries again. Or (`finish`) a human checks a task off or
   * reopens it, undoes that, an agent adds a note, and the human redoes. Or (`split`) a human
   * edits two tasks together, an agent edits the second and Claude adds a note to the first, the
   * human's partial undo takes back the first alone and a redo writes it again, an agent edits the
   * first, and the human undoes: each task's newer work counts from when the step last wrote it.
   * Or (`ran`) a human creates a task, a run starts on it, and the human undoes the create.
   */
  | {
      kind: "story";
      who: number;
      story: "trash" | "groups" | "links" | "held" | "finish" | "split" | "ran";
      task: number;
      slot: number;
    };

const VALUES: Readonly<Record<Patchable, readonly string[]>> = {
  summary: ["", "Next: compare totals", "Waiting on Tomas"],
  priority: ["1", "2", "4"],
  status: ["open", "waiting"],
  due: ["", "2026-11-20", "2026-11-27"],
};
const SLUGS = ["model-a", "model-b"] as const;
const KEYS = ["model:FIX-1", "model:FIX-2"] as const;

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
const slot = fc.nat({ max: 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant("write" as const), actor, task, set: patch }),
    weight: 6,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("lifecycle" as const), actor, task }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("pair" as const),
      actor,
      task,
      other: task,
      set: patch,
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant("create" as const), actor }), weight: 3 },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom("remove" as const, "restore" as const),
      actor,
      task,
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("note" as const), actor, task }), weight: 2 },
  {
    arbitrary: fc.record({ kind: fc.constant("link" as const), actor, task, key: slot }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("area" as const), actor, slug: slot }), weight: 1 },
  {
    arbitrary: fc.record({ kind: fc.constant("project" as const), actor, slug: slot, area: slot }),
    weight: 1,
  },
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
  { arbitrary: fc.record({ kind: fc.constant("redo" as const), who: human }), weight: 4 },
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
  {
    arbitrary: fc.record({
      kind: fc.constant("story" as const),
      who: human,
      story: fc.constantFrom(
        "trash" as const,
        "groups" as const,
        "links" as const,
        "held" as const,
        "finish" as const,
        "split" as const,
        "ran" as const,
      ),
      task,
      slot,
    }),
    weight: 2,
  },
);

/** The steps a run takes: an `aba` with `then`, a `cycle` and a `story` stand for several. */
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
  if (s.kind === "story") {
    const undo = (n: number): Step[] =>
      Array.from({ length: n }, () => ({ kind: "undo", who: s.who, partial: false }));
    const redo: Step[] = [
      { kind: "redo", who: s.who },
      { kind: "redo", who: s.who },
    ];
    const other = (s.task + 1) % START_TASKS;
    if (s.story === "trash") {
      return [
        { kind: "remove", actor: s.who, task: s.task },
        { kind: "restore", actor: s.who, task: s.task },
        { kind: "write", actor: s.who, task: s.task, set: { summary: "Next: compare totals" } },
        ...undo(3),
        { kind: "note", actor: 1, task: s.task },
        ...redo,
      ];
    }
    if (s.story === "ran") {
      return [
        { kind: "create", actor: s.who },
        { kind: "run", newest: 0, moves: 0 },
        { kind: "undo", who: s.who, partial: false },
      ];
    }
    if (s.story === "split") {
      return [
        {
          kind: "pair",
          actor: s.who,
          task: s.task,
          other,
          set: { summary: "Next: compare totals" },
        },
        { kind: "write", actor: 1, task: other, set: { summary: "Waiting on Tomas" } },
        { kind: "note", actor: 2, task: s.task },
        { kind: "undo", who: s.who, partial: true },
        { kind: "redo", who: s.who },
        { kind: "write", actor: 1, task: s.task, set: { summary: "Waiting on Tomas" } },
        { kind: "undo", who: s.who, partial: false },
      ];
    }
    if (s.story === "finish") {
      return [
        { kind: "lifecycle", actor: s.who, task: s.task },
        { kind: "undo", who: s.who, partial: false },
        { kind: "note", actor: 1, task: s.task },
        { kind: "redo", who: s.who },
      ];
    }
    if (s.story === "held") {
      return [
        { kind: "remove", actor: s.who, task: s.task },
        { kind: "restore", actor: s.who, task: s.task },
        { kind: "note", actor: 1, task: s.task },
        { kind: "undo", who: s.who, partial: true },
        { kind: "redo", who: s.who },
        { kind: "undo", who: s.who, partial: false },
      ];
    }
    if (s.story === "groups") {
      return [
        { kind: "area", actor: s.who, slug: s.slot },
        { kind: "project", actor: s.who, slug: s.slot, area: -1 },
        ...undo(2),
        { kind: "area", actor: 1, slug: s.slot },
        ...redo,
      ];
    }
    return [
      { kind: "link", actor: s.who, task: s.task, key: s.slot },
      { kind: "link", actor: s.who, task: other, key: s.slot },
      ...undo(2),
      { kind: "link", actor: 2, task: (s.task + 2) % START_TASKS, key: s.slot },
      ...redo,
    ];
  }
  return [s];
}

/** A cell's key: a task's field, or another row's tombstone. */
const key = (entity: Entity, id: number, field: string): string =>
  `${entity}|${String(id)}|${field}`;

/** The cell a change row writes: a create's is its row's tombstone. */
const fieldKey = (row: ModelChange): string =>
  key(row.entity, row.id, row.create === true ? TOMBSTONE[row.entity] : row.field);

const START: Readonly<Record<Field, string>> = {
  summary: "",
  priority: "4",
  status: "open",
  due: "",
  lifecycle: "active",
  wrap: "",
  deleted: "",
};

/** What an inversion meets, as the writer names it: a row's field, or a task's run. */
type Named = string;

class Model {
  cells = new Map<string, Cell>();
  rows = new Map<string, ModelRow>();
  commits = new Map<number, ModelCommit>();
  /** How many runs each task has: a run is never removed. */
  runs = new Map<number, number>();
  tasks = 0;
  /** How many rows of each kind other than tasks there are: each one's ID is its index. */
  counts: Record<Exclude<Entity, "tasks">, number> = {
    notes: 0,
    areas: 0,
    projects: 0,
    sources: 0,
    links: 0,
  };
  /** A link's index by `task|source`. */
  links = new Map<string, number>();
  lastSeq: number;

  constructor(lastSeq: number) {
    this.lastSeq = lastSeq;
  }

  cell(entity: Entity, id: number, field: string): Cell {
    const found = this.cells.get(key(entity, id, field));
    if (found === undefined) throw new Error("no cell");
    return found;
  }

  live(entity: Entity, id: number): boolean {
    return this.cell(entity, id, TOMBSTONE[entity]).value === "";
  }

  deleted(task: number): boolean {
    return !this.live("tasks", task);
  }

  row(entity: Entity, id: number): ModelRow {
    const found = this.rows.get(`${entity}|${String(id)}`);
    if (found === undefined) throw new Error("no row");
    return found;
  }

  /** Whether a tombstoned task is in the Trash (trash.ts): removed on purpose, not un-created. */
  inTrash(task: number): boolean {
    const fp = this.cell("tasks", task, "deleted").fp;
    return this.deleted(task) && this.commits.get(fp)?.kind !== "undo";
  }

  /** The live source that holds `key`, if any. */
  sourceOf(key: string): number | undefined {
    for (const r of this.rows.values()) {
      if (r.entity === "sources" && r.key === key && this.live("sources", r.id)) return r.id;
    }
    return undefined;
  }

  slugTaken(entity: "areas" | "projects", slug: string, except: number): boolean {
    return [...this.rows.values()].some(
      (r) => r.entity === entity && r.key === slug && r.id !== except && this.live(entity, r.id),
    );
  }

  /** A human's new undoable action ends what that human could redo (A1 3.10.1). */
  #stack(
    seq: number,
    owner: number | null,
    rows: ModelChange[],
    by: number,
    kind: ModelCommit["kind"] = "write",
  ): ModelCommit {
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
      by,
      kind,
      rows,
      last: seq,
      wrote: new Map(),
    };
    this.commits.set(seq, commit);
    this.lastSeq = seq;
    return commit;
  }

  /** A run's commit, its create or a move of it: the first human's, on no stack, no cell. */
  run(task: number, create: boolean): ModelCommit {
    if (create) this.runs.set(task, (this.runs.get(task) ?? 0) + 1);
    const commit = this.#stack(this.lastSeq + 1, null, [], 0, "run");
    commit.runTask = task;
    return commit;
  }

  /** A new row of `seq`, live, with its create row. */
  #made(seq: number, made: Omit<ModelRow, "created">): ModelChange {
    this.rows.set(`${made.entity}|${String(made.id)}`, { ...made, created: seq });
    const tomb = TOMBSTONE[made.entity];
    this.cells.set(key(made.entity, made.id, tomb), { value: "", fv: seq, fp: seq });
    return {
      entity: made.entity,
      id: made.id,
      field: tomb,
      task: made.task,
      before: "",
      after: "",
      beforeProv: seq,
      afterProv: seq,
      create: true,
    };
  }

  /** Tasks made by one commit, `owner`'s when a human made it. */
  create(count: number, owner: number | null, by: number): ModelCommit {
    const seq = this.lastSeq + 1;
    const rows: ModelChange[] = [];
    for (let n = 0; n < count; n += 1) {
      const task = this.tasks;
      this.tasks += 1;
      for (const field of FIELDS) {
        this.cells.set(key("tasks", task, field), { value: START[field], fv: seq, fp: seq });
      }
      this.rows.set(`tasks|${String(task)}`, {
        entity: "tasks",
        id: task,
        created: seq,
        task,
        owners: [],
      });
      rows.push({
        entity: "tasks",
        id: task,
        field: "deleted",
        task,
        before: "",
        after: "",
        beforeProv: seq,
        afterProv: seq,
        create: true,
      });
    }
    return this.#stack(seq, owner, rows, by);
  }

  /** A write of a row's fields: one change row per field whose value moves. */
  write(
    entity: Entity,
    id: number,
    values: Partial<Record<string, string>>,
    owner: number | null,
    by: number,
  ): ModelCommit | undefined {
    return this.writeAll(entity, [{ id, values }], owner, by);
  }

  /** A write of the fields of several rows in one commit. */
  writeAll(
    entity: Entity,
    writes: readonly { id: number; values: Partial<Record<string, string>> }[],
    owner: number | null,
    by: number,
  ): ModelCommit | undefined {
    const seq = this.lastSeq + 1;
    const rows: ModelChange[] = [];
    for (const { id, values } of writes) {
      const task = entity === "tasks" ? id : this.row(entity, id).task;
      for (const [field, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const cell = this.cell(entity, id, field);
        if (cell.value === value) continue;
        rows.push({
          entity,
          id,
          field,
          task,
          before: cell.value,
          after: value,
          beforeProv: cell.fp,
          afterProv: seq,
        });
      }
    }
    if (rows.length === 0) return undefined;
    for (const row of rows) {
      this.cells.set(key(entity, row.id, row.field), { value: row.after, fv: seq, fp: seq });
    }
    return this.#stack(seq, owner, rows, by);
  }

  note(task: number, owner: number | null, by: number): ModelCommit {
    const seq = this.lastSeq + 1;
    const id = this.counts.notes++;
    const owners = [{ entity: "tasks" as const, id: task }];
    return this.#stack(seq, owner, [this.#made(seq, { entity: "notes", id, task, owners })], by);
  }

  area(slug: string, owner: number | null, by: number): ModelCommit {
    const seq = this.lastSeq + 1;
    const id = this.counts.areas++;
    return this.#stack(
      seq,
      owner,
      [this.#made(seq, { entity: "areas", id, task: null, owners: [], key: slug })],
      by,
    );
  }

  project(slug: string, area: number | null, owner: number | null, by: number): ModelCommit {
    const seq = this.lastSeq + 1;
    const id = this.counts.projects++;
    const owners = area === null ? [] : [{ entity: "areas" as const, id: area }];
    return this.#stack(
      seq,
      owner,
      [this.#made(seq, { entity: "projects", id, task: null, owners, key: slug })],
      by,
    );
  }

  /**
   * `source.add` on a task that exists: a link to the live source of the key, made or brought
   * back, or a new source with its link. Undefined when the link is live already.
   */
  link(
    task: number,
    sourceKey: string,
    owner: number | null,
    by: number,
  ): { commit: ModelCommit; source: number; made: boolean } | undefined {
    const seq = this.lastSeq + 1;
    const found = this.sourceOf(sourceKey);
    const rows: ModelChange[] = [];
    const source = found ?? this.counts.sources++;
    if (found === undefined) {
      rows.push(
        this.#made(seq, { entity: "sources", id: source, task, owners: [], key: sourceKey }),
      );
    }
    const pair = `${String(task)}|${String(source)}`;
    const link = this.links.get(pair);
    if (link !== undefined) {
      if (this.live("links", link)) return undefined;
      const commit = this.write("links", link, { removed: "" }, owner, by);
      if (commit === undefined) throw new Error("a removed link moves");
      return { commit, source, made: false };
    }
    const id = this.counts.links++;
    this.links.set(pair, id);
    const owners = [
      { entity: "tasks" as const, id: task },
      { entity: "sources" as const, id: source },
    ];
    rows.push(this.#made(seq, { entity: "links", id, task, owners }));
    return { commit: this.#stack(seq, owner, rows, by), source, made: found === undefined };
  }

  /** When `commit` last wrote `row`'s field, as recorded when it did (`ModelCommit.wrote`). */
  rowApplied(commit: ModelCommit, row: ModelChange): number {
    return commit.wrote.get(fieldKey(row)) ?? commit.seq;
  }

  /** A redo of `target` as commit `redo`: the step is applied again, and so is each row it wrote. */
  redone(target: ModelCommit, redo: ModelCommit): void {
    target.last = redo.seq;
    for (const row of redo.rows) target.wrote.set(fieldKey(row), redo.seq);
  }

  /** The step applied last (A1 3.10.1). */
  undoTarget(owner: number): ModelCommit | undefined {
    let newest: ModelCommit | undefined;
    for (const c of this.commits.values()) {
      if (c.owner !== owner || c.status !== "done") continue;
      if (newest === undefined || c.last > newest.last) newest = c;
    }
    return newest;
  }

  /** What a redo tries, in order: the human's undone steps, oldest first. */
  redoSteps(owner: number): ModelCommit[] {
    return [...this.commits.values()]
      .filter((c) => c.owner === owner && c.status === "undone")
      .sort((a, b) => a.seq - b.seq);
  }

  /** The live rows that `parent` owns, and a task's runs (`runs`), which are always another's. */
  children(entity: Entity, id: number): ModelRow[] {
    return [...this.rows.values()].filter(
      (r) => r.owners.some((o) => o.entity === entity && o.id === id) && this.live(r.entity, r.id),
    );
  }

  /**
   * Who changed `task`, or anything of it, after `since`, by the names an answer gives them: a
   * person as "user", an agent by its label, a run's progress as the run's. The principal's own
   * steps are no one's newer work.
   */
  authors(task: number, since: number, principal: number): string[] {
    const names = new Set<string>();
    for (const c of this.commits.values()) {
      if (c.seq <= since) continue;
      if (c.by === principal && (c.owner !== null || c.kind === "undo" || c.kind === "redo")) {
        continue;
      }
      if (c.runTask === task) names.add("run");
      else if (c.rows.some((r) => r.task === task)) names.add(NAMES[c.by] ?? "");
    }
    return [...names].sort();
  }

  /** Another's change to `row` (and for a task, to anything of it) after `since` (history.ts). */
  newer(change: ModelChange, since: number, principal: number): boolean {
    for (const c of this.commits.values()) {
      if (c.seq <= since) continue;
      if (c.by === principal && (c.owner !== null || c.kind === "undo" || c.kind === "redo")) {
        continue;
      }
      if (change.entity === "tasks" && c.runTask === change.id) return true;
      const touched = c.rows.some((r) =>
        change.entity === "tasks"
          ? r.task === change.id
          : r.entity === change.entity && r.id === change.id,
      );
      if (touched) return true;
    }
    return false;
  }

  /**
   * The rows of `rows` that do not pass their guards, and with `partial` their lifecycle or wrap
   * partner; what the writer names for a plain task field, as task|field keys, which is all it
   * names unless newer work keeps a task open (`open`): that work is named instead.
   */
  failing(
    rows: readonly ModelChange[],
    options: {
      partial: boolean;
      creating: number;
      /** When the step last wrote a row: others' changes after it are newer work. */
      since: (row: ModelChange) => number;
      principal: number;
    },
  ): { failed: Set<ModelChange>; named: Named[]; open: Set<number> } {
    const failed = new Set<ModelChange>();
    const named: Named[] = [];
    const open = new Set<number>();
    for (const r of rows) {
      const tomb = TOMBSTONE[r.entity];
      if (r.create === true) {
        const fields = r.entity === "tasks" ? FIELDS : [tomb];
        const theirs = fields.filter((f) => this.cell(r.entity, r.id, f).fp !== options.creating);
        const kids = this.children(r.entity, r.id).filter(
          (k) =>
            k.created !== options.creating ||
            this.cell(k.entity, k.id, TOMBSTONE[k.entity]).fp !== options.creating,
        );
        const runs = r.entity === "tasks" ? (this.runs.get(r.id) ?? 0) : 0;
        if (theirs.length > 0 || kids.length > 0 || runs > 0) failed.add(r);
        if (r.entity === "tasks") {
          named.push(...theirs.map((f) => key("tasks", r.id, f)));
          for (let n = 0; n < runs; n += 1) named.push(key("tasks", r.id, "runs"));
        }
        continue;
      }
      if (this.cell(r.entity, r.id, r.field).fp !== r.afterProv) {
        failed.add(r);
        named.push(key(r.entity, r.id, r.field));
        continue;
      }
      if (r.field === "lifecycle") {
        // An open task done again stays open when another changed anything of it since.
        const hides = r.before !== "active" && this.cell("tasks", r.id, r.field).value === "active";
        if (hides && this.newer(r, options.since(r), options.principal)) {
          failed.add(r);
          open.add(r.id);
        }
        continue;
      }
      if (r.field !== tomb) continue;
      if (r.before === "") {
        const row = this.row(r.entity, r.id);
        const taken =
          (r.entity === "sources" &&
            row.key !== undefined &&
            this.sourceOf(row.key) !== undefined) ||
          ((r.entity === "areas" || r.entity === "projects") &&
            this.slugTaken(r.entity, row.key ?? "", r.id));
        if (taken) failed.add(r);
      } else if (this.newer(r, options.since(r), options.principal)) {
        failed.add(r);
      }
    }
    // A task kept open keeps its wrap-up, unnamed: the work that keeps it is the conflict.
    for (const r of rows) if (r.field === "wrap" && open.has(r.id)) failed.add(r);
    if (options.partial) {
      for (const r of rows) {
        const partner =
          r.field === "lifecycle" ? "wrap" : r.field === "wrap" ? "lifecycle" : undefined;
        if (partner === undefined || failed.has(r)) continue;
        if (rows.some((o) => o.id === r.id && o.field === partner && failed.has(o))) {
          failed.add(r);
          named.push(key("tasks", r.id, r.field));
        }
      }
    }
    return { failed, named, open };
  }

  /** The cells as the inversion of `rows` but `skip` would leave them. */
  #after(rows: readonly ModelChange[], skip: ReadonlySet<ModelChange>): Map<string, Cell> {
    const cells = new Map(this.cells);
    for (const r of rows) {
      if (skip.has(r)) continue;
      const tomb = TOMBSTONE[r.entity];
      if (r.create === true) {
        cells.set(key(r.entity, r.id, tomb), { value: GONE, fv: 0, fp: 0 });
      } else {
        cells.set(key(r.entity, r.id, r.field), { value: r.before, fv: 0, fp: r.beforeProv });
      }
    }
    return cells;
  }

  /**
   * The rules across rows on the state the inversion makes (applyInversions): one active holder
   * of a key the inversion brings back, and for a redo no row or owner out of sight. Returns the
   * rows that break one; the writer's partial undo leaves them out and checks again.
   */
  broken(
    rows: readonly ModelChange[],
    skip: ReadonlySet<ModelChange>,
    options: { redo: false } | { redo: true; since: number; named?: Named[] },
  ): Set<ModelChange> {
    const cells = this.#after(rows, skip);
    const live = (entity: Entity, id: number) =>
      cells.get(key(entity, id, TOMBSTONE[entity]))?.value === "";
    const out = new Set<ModelChange>();
    const kept = rows.filter((r) => !skip.has(r));
    const back = kept.filter(
      (r) =>
        r.create !== true &&
        r.field === TOMBSTONE[r.entity] &&
        r.before === "" &&
        (r.entity === "tasks" || r.entity === "links" || r.entity === "sources"),
    );
    // One active holder of a key (A1 3.6): the sources the plan touches, by their tasks too.
    const touched = new Set<number>();
    for (const r of back) {
      if (r.entity === "sources") touched.add(r.id);
      if (r.entity === "links") touched.add(this.row("links", r.id).owners[1]?.id ?? -1);
      if (r.entity === "tasks") {
        for (const l of this.rows.values()) {
          if (l.entity === "links" && l.owners[0]?.id === r.id) touched.add(l.owners[1]?.id ?? -1);
        }
      }
    }
    for (const source of touched) {
      const row = this.rows.get(`sources|${String(source)}`);
      if (row?.key === undefined || !live("sources", source)) continue;
      const holders = [...this.rows.values()].filter(
        (l) =>
          l.entity === "links" &&
          l.owners[1]?.id === source &&
          live("links", l.id) &&
          live("tasks", l.owners[0]?.id ?? -1) &&
          cells.get(key("tasks", l.owners[0]?.id ?? -1, "lifecycle"))?.value === "active",
      );
      if (holders.length < 2) continue;
      const made = holders.flatMap((l) =>
        back.filter(
          (r) =>
            (r.entity === "tasks" && r.id === l.owners[0]?.id) ||
            (r.entity === "links" && r.id === l.id),
        ),
      );
      const sourceBack = back.filter((r) => r.entity === "sources" && r.id === source);
      if (made.length === 0 && sourceBack.length === 0) continue;
      for (const r of [...made, ...sourceBack]) out.add(r);
    }
    if (!options.redo) return out;
    // A redo writes nothing out of sight (history.ts, ownersLive).
    const fvOf = (entity: Entity, id: number): number =>
      this.cell(entity, id, TOMBSTONE[entity]).fv;
    const byRow = new Map<string, ModelChange[]>();
    for (const r of kept) {
      const k = `${r.entity}|${String(r.id)}`;
      byRow.set(k, [...(byRow.get(k) ?? []), r]);
    }
    for (const list of byRow.values()) {
      const first = list[0];
      if (first === undefined) continue;
      const tomb = TOMBSTONE[first.entity];
      const writes = list.filter((r) => r.field === tomb);
      if (writes.some((r) => r.create === true || r.before !== "")) continue;
      const brings = writes.length > 0;
      const gone = (entity: Entity, id: number, owner: boolean): boolean =>
        !live(entity, id) && ((brings && owner) || fvOf(entity, id) > options.since);
      const owners = first.entity === "tasks" ? [] : this.row(first.entity, first.id).owners;
      const away = [
        ...(gone(first.entity, first.id, false) ? [first] : []),
        ...owners.filter((o) => gone(o.entity, o.id, true)),
      ];
      if (away.length > 0) {
        options.named?.push(...away.map((o) => key(o.entity, o.id, TOMBSTONE[o.entity])));
        for (const r of list) out.add(r);
      }
    }
    return out;
  }

  /** Inverts `rows` but `skip` as commit lastSeq + 1 (A1 3.10): a create by its tombstone. */
  invert(
    rows: readonly ModelChange[],
    skip: ReadonlySet<ModelChange>,
    by: number,
    kind: "undo" | "redo",
  ): ModelCommit {
    const seq = this.lastSeq + 1;
    const inverted: ModelChange[] = [];
    for (const row of rows) {
      if (skip.has(row)) continue;
      const tomb = TOMBSTONE[row.entity];
      if (row.create === true) {
        const cell = this.cell(row.entity, row.id, tomb);
        if (cell.value !== "") continue;
        inverted.push({
          entity: row.entity,
          id: row.id,
          field: tomb,
          task: row.task,
          before: cell.value,
          after: GONE,
          beforeProv: cell.fp,
          afterProv: seq,
        });
        this.cells.set(key(row.entity, row.id, tomb), { value: GONE, fv: seq, fp: seq });
        continue;
      }
      const cell = this.cell(row.entity, row.id, row.field);
      inverted.push({
        entity: row.entity,
        id: row.id,
        field: row.field,
        task: row.task,
        before: cell.value,
        after: row.before,
        beforeProv: row.afterProv,
        afterProv: row.beforeProv,
      });
      this.cells.set(key(row.entity, row.id, row.field), {
        value: row.before,
        fv: seq,
        fp: row.beforeProv,
      });
    }
    const commit: ModelCommit = {
      seq,
      owner: null,
      status: null,
      undoneBy: null,
      by,
      kind,
      rows: inverted,
      last: seq,
      wrote: new Map(),
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

/** The real IDs of the model's rows. */
interface Ids {
  tasks: Id<"t">[];
  notes: string[];
  areas: string[];
  projects: string[];
  sources: string[];
  /** A link's `task_id|source_id`. */
  links: string[];
}

const TABLE: Readonly<Record<Entity, string>> = {
  tasks: "tasks",
  notes: "notes",
  areas: "areas",
  projects: "projects",
  sources: "sources",
  links: "task_sources",
};

/** The space's cells of every row the model knows, as the model keeps them. */
function snapshot(fx: Fixture, ids: Ids): Map<string, Cell> {
  const out = new Map<string, Cell>();
  const text = (v: unknown): string =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  const versions = (t: Record<string, unknown>) => ({
    fv: JSON.parse(String(t["fv"])) as Record<string, number>,
    fp: JSON.parse(String(t["fp"])) as Record<string, number>,
    created: Number(t["created_seq"]),
  });
  ids.tasks.forEach((id, task) => {
    const t = fx.reader.prepare("SELECT * FROM tasks WHERE id = $id").get({ id }) ?? {};
    const { fv, fp, created } = versions(t);
    const values: Record<Field, string> = {
      summary: text(t["summary"]),
      priority: text(t["priority"]),
      status: text(t["status"]),
      due: text(t["due_date"]),
      lifecycle: text(t["lifecycle"]),
      wrap: text(t["wrap_state"]),
      deleted: t["deleted_at"] === null ? "" : GONE,
    };
    for (const field of FIELDS) {
      out.set(key("tasks", task, field), {
        value: values[field],
        fv: fv[field] ?? created,
        fp: fp[field] ?? created,
      });
    }
  });
  for (const entity of ["notes", "areas", "projects", "sources", "links"] as const) {
    ids[entity].forEach((id, n) => {
      const [taskId = "", sourceId = ""] = id.split("|");
      const t =
        (entity === "links"
          ? fx.reader
              .prepare("SELECT * FROM task_sources WHERE task_id = $t AND source_id = $s")
              .get({ t: taskId, s: sourceId })
          : fx.reader.prepare(`SELECT * FROM ${TABLE[entity]} WHERE id = $id`).get({ id })) ?? {};
      const { fv, fp, created } = versions(t);
      const tomb = TOMBSTONE[entity];
      const column = entity === "links" ? "removed_at" : "deleted_at";
      out.set(key(entity, n, tomb), {
        value: t[column] === null ? "" : GONE,
        fv: fv[tomb] ?? created,
        fp: fp[tomb] ?? created,
      });
    });
  }
  return out;
}

function expectModel(fx: Fixture, ids: Ids, model: Model): void {
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

/** The keys of the task-field conflicts a result names, by task index: a run as its task's. */
const named = (ids: readonly Id<"t">[], conflicts: WriteResult["conflicts"]): Named[] =>
  [
    ...new Set(
      conflicts.map((c) =>
        c.entity === "runs"
          ? key("tasks", ids.indexOf(c.task as Id<"t">), "runs")
          : key("tasks", ids.indexOf(c.id as Id<"t">), c.field),
      ),
    ),
  ].sort();

const property = (seen: Seen) =>
  fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 50 }), async (generated) => {
    const steps = generated.flatMap(expand);
    // 80 fresh spaces and thousands of commits: which writes apply does not depend on a flush.
    const fx = await fixture();
    try {
      const actors: Credential[] = [fx.human, fx.codex, fx.claude, await secondHuman(fx)];
      const as = (n: number): Credential => actors[n] ?? fx.codex;
      // The first tasks are Codex's, so the humans' stacks hold only their own actions.
      const ids: Ids = {
        tasks: Array.from({ length: START_TASKS }, () => newId("t")),
        notes: [],
        areas: [],
        projects: [],
        sources: [],
        links: [],
      };
      const made = fx.writer.submit(
        fx.request(
          fx.codex,
          ids.tasks.map((id, n) => ({
            kind: "task.create",
            id,
            title: `Fixture task ${String(n + 1)}`,
          })),
        ),
      );
      expect(made.status).toBe("applied");
      const model = new Model(made.seq - 1);
      model.create(START_TASKS, null, 1);
      expect(model.lastSeq).toBe(made.seq);
      const commitId = (seq: number): unknown =>
        fx.reader.prepare("SELECT id FROM commits WHERE seq = $seq").get({ seq })?.["id"];
      /** A forward request of `who`: a human's joins its stack. */
      const send = (who: number, ops: Operation[], based = true): WriteResult =>
        fx.writer.submit(
          fx.request(as(who), ops, {
            ...(based ? { base: fx.base() } : {}),
            ...(isHuman(who) ? { undoable: true } : {}),
          }),
        );
      const owner = (who: number): number | null => (isHuman(who) ? who : null);
      /** Whether the model names what the writer names: task fields and runs alone. */
      const plain = (rows: readonly ModelChange[]): boolean =>
        rows.every(
          (r) =>
            r.entity === "tasks" &&
            (r.create === true
              ? model.children("tasks", r.id).length === 0
              : r.field !== "deleted"),
        );
      const sorted = (keys: readonly Named[]): Named[] => [...new Set(keys)].sort();
      /**
       * Who an undo's or a redo's answer says changed each task since (WriteResult.newer): for
       * each task a row held back is of, everyone who changed it after the step last wrote such a
       * row there. Checked when every row held back is a task's own: another row's conflict names
       * the row it met, which the model leaves to the writer.
       */
      const expectNewer = (
        result: WriteResult,
        held: readonly { row: ModelChange; since: number }[],
        principal: number,
      ): void => {
        if (held.some(({ row }) => row.entity !== "tasks")) return;
        const cut = new Map<number, number>();
        for (const { row, since } of held)
          cut.set(row.id, Math.min(cut.get(row.id) ?? since, since));
        const expected = [...cut]
          .map(([t, at]): [number, string[]] => [t, model.authors(t, at, principal)])
          .filter(([, names]) => names.length > 0);
        const named = new Map<number, Set<string>>();
        for (const w of result.newer?.work ?? []) {
          const t = ids.tasks.indexOf(w.task as Id<"t">);
          named.set(t, (named.get(t) ?? new Set()).add(newerBy(w.by, w.run)));
        }
        expect(
          [...named].map(([t, names]) => [t, [...names].sort()]).sort(),
          "who changed each task since",
        ).toEqual(expected.sort());
        if (expected.length > 0) count(seen, "newer work named");
      };
      /** A forward write the model predicts: applied with a commit, or no change. */
      const expectWrite = (result: WriteResult, commit: ModelCommit | undefined): void => {
        expect(result.status, JSON.stringify(result.error)).toBe(
          commit === undefined ? "unchanged" : "applied",
        );
        if (commit !== undefined) expect(result.seq).toBe(commit.seq);
      };

      let space = checkSpace(fx.reader);
      for (const s of steps) {
        space = checkSpace(fx.reader, space);
        const before = snapshot(fx, ids);
        if (s.kind === "create") {
          if (ids.tasks.length >= MAX_TASKS) continue;
          const id = newId("t");
          const result = send(
            s.actor,
            [{ kind: "task.create", id, title: `Fixture task ${String(ids.tasks.length + 1)}` }],
            false,
          );
          expect(result.status, JSON.stringify(result.error)).toBe("applied");
          ids.tasks.push(id);
          model.create(1, owner(s.actor), s.actor);
        } else if (s.kind === "run") {
          // The execution store's requests: the person's, never undoable (A1 3.6).
          const task = Math.max(0, ids.tasks.length - 1 - s.newest);
          const id = ids.tasks[task] as Id<"t">;
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
            model.run(task, true);
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
              model.run(task, false);
            }
          }
        } else if (s.kind === "aba") {
          // A task the commit wrote or created, and the field it wrote when that is patchable.
          const next =
            s.on === "undo"
              ? model.undoTarget(s.of)
              : model.commits.get(model.redoSteps(s.of)[0]?.undoneBy ?? 0);
          const rows = (next?.rows ?? []).filter((r) => r.entity === "tasks");
          const row = rows[s.pick % Math.max(rows.length, 1)];
          const task = row?.id ?? s.task % ids.tasks.length;
          const field =
            row !== undefined && row.create !== true && Object.hasOwn(VALUES, row.field)
              ? (row.field as Patchable)
              : s.field;
          // A tombstoned task takes no agent's patch.
          if (model.deleted(task)) continue;
          const id = ids.tasks[task] ?? ids.tasks[0];
          const now = model.cell("tasks", task, field).value;
          const away = VALUES[field].find((v) => v !== now) ?? now;
          for (const value of [away, now]) {
            const result = send(s.actor, [patchOp(id as Id<"t">, { [field]: value })]);
            expect(result.status, JSON.stringify(result.error)).toBe("applied");
            model.write("tasks", task, { [field]: value }, null, s.actor);
          }
        } else if (s.kind === "pair") {
          const pair = [s.task % ids.tasks.length, s.other % ids.tasks.length];
          const [a = 0, b = 0] = pair;
          if (a === b) continue;
          const result = send(
            s.actor,
            pair.map((t) => patchOp(ids.tasks[t] as Id<"t">, s.set)),
          );
          if (model.deleted(a) || model.deleted(b)) {
            expect(result.error?.code).toBe("DELETED");
            continue;
          }
          const commit = model.writeAll(
            "tasks",
            pair.map((id) => ({ id, values: s.set })),
            owner(s.actor),
            s.actor,
          );
          expectWrite(result, commit);
          if (commit !== undefined) count(seen, "two tasks in one step");
        } else if (s.kind === "write" || s.kind === "lifecycle") {
          const task = s.task % ids.tasks.length;
          const id = ids.tasks[task] ?? ids.tasks[0];
          let op: Operation;
          let values: Partial<Record<Field, string>>;
          if (s.kind === "write") {
            op = patchOp(id as Id<"t">, s.set);
            values = s.set;
          } else if (model.cell("tasks", task, "lifecycle").value === "active") {
            op = { kind: "task.complete", task: id as Id<"t"> };
            values = { lifecycle: "completed", wrap: "pending" };
          } else {
            op = { kind: "task.reopen", task: id as Id<"t"> };
            values = { lifecycle: "active", wrap: "" };
          }
          const result = send(s.actor, [op]);
          if (model.deleted(task)) {
            // A tombstoned task takes no write but an undo's or a redo's.
            expect(result.error?.code).toBe("DELETED");
            count(seen, "write refused on a tombstone");
          } else {
            const ended = model.redoSteps(s.actor).length > 0;
            const commit = model.write("tasks", task, values, owner(s.actor), s.actor);
            expectWrite(result, commit);
            if (commit !== undefined && ended) count(seen, "redo ended");
          }
        } else if (s.kind === "remove" || s.kind === "restore") {
          const task = s.task % ids.tasks.length;
          const id = ids.tasks[task] as Id<"t">;
          // A restore leaves a key another active task took with it: no link to weigh here.
          const linked = [...model.rows.values()].some(
            (r) => r.entity === "links" && r.owners[0]?.id === task && model.live("links", r.id),
          );
          if (s.kind === "restore" && linked) continue;
          const result = send(s.actor, [
            { kind: `task.${s.kind === "remove" ? "delete" : "restore"}`, task: id },
          ]);
          if (model.deleted(task) && !model.inTrash(task)) {
            expect(result.error).toMatchObject({ code: "NOT_FOUND", reason: "creation_undone" });
            count(seen, "creation undone, not in the Trash");
            continue;
          }
          const commit = model.write(
            "tasks",
            task,
            { deleted: s.kind === "remove" ? GONE : "" },
            owner(s.actor),
            s.actor,
          );
          expectWrite(result, commit);
          if (commit !== undefined) count(seen, s.kind === "remove" ? "removed" : "restored");
        } else if (s.kind === "note") {
          const task = s.task % ids.tasks.length;
          const result = send(s.actor, [
            { kind: "note.add", task: ids.tasks[task] as Id<"t">, body: "Fixture note." },
          ]);
          if (model.deleted(task)) {
            expect(result.error?.code).toBe("DELETED");
            continue;
          }
          const commit = model.note(task, owner(s.actor), s.actor);
          expectWrite(result, commit);
          ids.notes.push(String(result.results[0]?.id));
          count(seen, "note");
        } else if (s.kind === "link") {
          const task = s.task % ids.tasks.length;
          const sourceKey = KEYS[s.key] ?? KEYS[0];
          const result = send(s.actor, [
            {
              kind: "source.add",
              task: ids.tasks[task] as Id<"t">,
              source: { kind: "ticket", title: "Fixture ticket", key: sourceKey },
            },
          ]);
          if (model.deleted(task)) {
            expect(result.error?.code).toBe("DELETED");
            continue;
          }
          const linked = model.link(task, sourceKey, owner(s.actor), s.actor);
          expectWrite(result, linked?.commit);
          if (linked === undefined) continue;
          const source = String(result.results[0]?.id);
          if (linked.made) ids.sources.push(source);
          expect(source).toBe(ids.sources[linked.source]);
          const pair = `${ids.tasks[task] ?? ""}|${source}`;
          if (!ids.links.includes(pair)) ids.links.push(pair);
          count(seen, "link");
        } else if (s.kind === "area" || s.kind === "project") {
          const slug = `${s.kind === "area" ? "" : "p-"}${SLUGS[s.slug] ?? SLUGS[0]}`;
          const entity = s.kind === "area" ? "areas" : "projects";
          const liveAreas = [...model.rows.values()].filter(
            (r) => r.entity === "areas" && model.live("areas", r.id),
          );
          // A story's project goes in the newest area; another, in one of the live ones or none.
          const area =
            s.kind === "project"
              ? s.area < 0
                ? liveAreas.at(-1)
                : liveAreas[s.area % (liveAreas.length + 1)]
              : undefined;
          const id = s.kind === "area" ? newId("a") : newId("p");
          const op: Operation =
            s.kind === "area"
              ? { kind: "area.create", id: id as Id<"a">, title: "Fixture area", slug }
              : {
                  kind: "project.create",
                  id: id as Id<"p">,
                  title: "Fixture project",
                  slug,
                  ...(area === undefined ? {} : { area: ids.areas[area.id] ?? "" }),
                };
          const result = send(s.actor, [op]);
          if (model.slugTaken(entity, slug, -1)) {
            expect(result.status).toBe("rejected");
            count(seen, "slug taken");
            continue;
          }
          const commit =
            s.kind === "area"
              ? model.area(slug, owner(s.actor), s.actor)
              : model.project(slug, area?.id ?? null, owner(s.actor), s.actor);
          expectWrite(result, commit);
          ids[entity].push(id);
          count(seen, s.kind);
        } else if (s.kind === "undo") {
          const target = model.undoTarget(s.who);
          const result = fx.writer.submit(
            fx.request(as(s.who), [{ kind: "undo", ...(s.partial ? { partial: true } : {}) }]),
          );
          if (target === undefined) {
            expect(result.error?.code).toBe("NOTHING_TO_UNDO");
            count(seen, "NOTHING_TO_UNDO");
            continue;
          }
          const options = {
            partial: s.partial,
            creating: target.seq,
            since: (row: ModelChange) => model.rowApplied(target, row),
            principal: s.who,
          };
          const guard = model.failing(target.rows, { ...options, partial: false });
          const creates = target.rows.some((r) => r.create === true);
          if (guard.named.some((k) => k.endsWith("|runs"))) count(seen, "create kept by a run");
          let skip = s.partial ? model.failing(target.rows, options).failed : guard.failed;
          let broken = model.broken(target.rows, skip, { redo: false });
          if (!s.partial && (guard.failed.size > 0 || broken.size > 0)) {
            expect(result.status).toBe("conflict");
            expect(result.error?.code).toBe("UNDO_CONFLICT");
            if (plain(target.rows) && guard.open.size === 0) {
              expect(named(ids.tasks, result.conflicts)).toEqual(sorted(guard.named));
            }
            count(seen, creates ? "create kept" : "undo conflict");
            if (guard.open.size > 0) count(seen, "kept open by newer work");
            if (guard.failed.size > 0) {
              const held = [...guard.failed].map((row) => ({ row, since: options.since(row) }));
              expectNewer(result, held, s.who);
            }
            if (target.rows.some((r) => r.field === "deleted" && r.before === "")) {
              count(seen, "undo of a restore kept by newer work");
            }
            // Kept by work from before the step's newest redo, which did not bring that row back.
            if (
              [...guard.failed].some(
                (r) => r.field === TOMBSTONE[r.entity] && model.rowApplied(target, r) < target.last,
              )
            ) {
              count(seen, "undo kept past a redo that left the row");
            }
            // R2: a field set back to the value the human wrote is still another's write.
            if (
              [...guard.failed].some(
                (r) => r.create !== true && model.cell(r.entity, r.id, r.field).value === r.after,
              )
            ) {
              count(seen, "aba refused");
            }
            continue;
          }
          // A partial undo leaves out what breaks a rule across rows, and checks again.
          const crossed = broken.size > 0;
          while (broken.size > 0) {
            skip = new Set([...skip, ...broken]);
            broken = model.broken(target.rows, skip, { redo: false });
          }
          expect(result.status, JSON.stringify(result.error)).toBe("applied");
          const left = model.failing(target.rows, options);
          if (left.open.size > 0) count(seen, "kept open by newer work");
          if (!crossed) {
            const held = [...left.failed].map((row) => ({ row, since: options.since(row) }));
            expectNewer(result, held, s.who);
          }
          if (plain(target.rows) && left.open.size === 0) {
            expect(named(ids.tasks, result.conflicts)).toEqual(sorted(left.named));
          }
          const u = model.invert(target.rows, skip, s.who, "undo");
          target.status = "undone";
          target.undoneBy = u.seq;
          expect(result.seq).toBe(u.seq);
          expect(result.results[0]?.id).toBe(commitId(target.seq));
          count(seen, skip.size > 0 ? "partial undo" : "undo");
          if (s.who === 3) count(seen, "second human's undo");
          if (target.rows.some((r) => r.create === true && !skip.has(r))) {
            count(seen, "create undone");
          }
          // ABA: the undo changed only rows of the commit whose provenance was the guard.
          const after = snapshot(fx, ids);
          for (const [k, cell] of after) {
            const was = before.get(k);
            if (was === undefined) continue;
            if (cell.value === was.value && cell.fv === was.fv && cell.fp === was.fp) continue;
            const row = target.rows.find((r) => key(r.entity, r.id, r.field) === k);
            if (row === undefined) {
              // A create's inversion is its row's tombstone.
              const created = target.rows.find(
                (r) => r.create === true && key(r.entity, r.id, TOMBSTONE[r.entity]) === k,
              );
              expect(created, `${k} changed but the commit never wrote it`).toBeDefined();
              continue;
            }
            expect(skip.has(row), `${k} changed against its guard`).toBe(false);
            expect(was.fp, `${k} held another write`).toBe(row.afterProv);
          }
        } else if (s.kind === "redo") {
          const tried = model.redoSteps(s.who);
          const result = fx.writer.submit(fx.request(as(s.who), [{ kind: "redo" }]));
          if (tried.length === 0) {
            expect(result.error?.code).toBe("NOTHING_TO_REDO");
            count(seen, "NOTHING_TO_REDO");
            continue;
          }
          // The oldest undone step the guards and the rules across rows let through.
          const passed: ModelCommit[] = [];
          const names: Named[] = [];
          /** Tasks newer work kept open: that work is named, not their fields. */
          let open = 0;
          /** The rows that held back the steps passed over, and whether a rule across rows did. */
          const held: { row: ModelChange; since: number }[] = [];
          let crossed = false;
          let redone: { target: ModelCommit; undone: ModelCommit } | undefined;
          for (const target of tried) {
            const undone = model.commits.get(target.undoneBy ?? 0);
            if (undone === undefined) throw new Error("no undo");
            const options = {
              partial: false,
              creating: target.seq,
              since: () => undone.seq,
              principal: s.who,
            };
            const guard = model.failing(undone.rows, options);
            const across =
              guard.failed.size > 0
                ? 0
                : model.broken(undone.rows, new Set(), {
                    redo: true,
                    since: undone.seq,
                    named: names,
                  }).size;
            if (guard.failed.size === 0 && across === 0) {
              redone = { target, undone };
              break;
            }
            passed.push(target);
            names.push(...guard.named);
            open += guard.open.size;
            held.push(...[...guard.failed].map((row) => ({ row, since: undone.seq })));
            if (across > 0) crossed = true;
          }
          const all = passed.flatMap((c) => model.commits.get(c.undoneBy ?? 0)?.rows ?? []);
          if (passed.length > 0)
            count(seen, redone === undefined ? "redo conflict" : "redo past a step");
          if (
            passed.some((c) =>
              (model.commits.get(c.undoneBy ?? 0)?.rows ?? []).some(
                (r) => r.entity !== "tasks" && r.field === TOMBSTONE[r.entity] && r.before === "",
              ),
            )
          ) {
            count(seen, "redo kept from a row or key");
          }
          if (all.some((r) => r.entity === "tasks" && r.field === "deleted" && r.before !== "")) {
            count(seen, "redo of a removal kept by newer work");
          }
          expect(result.passed ?? []).toEqual(passed.map((c) => commitId(c.seq)));
          if (!crossed) expectNewer(result, held, s.who);
          if (open > 0) count(seen, "kept open by newer work");
          if (plain(all) && open === 0) {
            expect(named(ids.tasks, result.conflicts)).toEqual(sorted(names));
          }
          if (redone === undefined) {
            expect(result.status).toBe("conflict");
            expect(result.error?.code).toBe("UNDO_CONFLICT");
            continue;
          }
          const { target, undone } = redone;
          expect(result.status, JSON.stringify(result.error)).toBe("applied");
          expect(result.results[0]?.id).toBe(commitId(target.seq));
          const r = model.invert(undone.rows, new Set(), s.who, "redo");
          model.redone(target, r);
          target.status = "done";
          target.undoneBy = null;
          expect(result.seq).toBe(r.seq);
          count(seen, "redo");
          if (undone.rows.some((w) => w.entity === "tasks" && w.field === "deleted")) {
            count(seen, "create redone");
          }
          // Undo then redo restores the values the commit wrote, with its own provenance.
          const after = snapshot(fx, ids);
          for (const row of undone.rows) {
            if (row.entity !== "tasks") continue;
            const wrote = target.rows.find((w) => w.id === row.id && w.field === row.field);
            const cell = after.get(key("tasks", row.id, row.field));
            if (wrote === undefined) continue;
            expect(cell?.value).toBe(wrote.after);
            expect(cell?.fp).toBe(target.seq);
          }
        }
        // Physical versions only grow.
        for (const [k, cell] of snapshot(fx, ids)) {
          expect(cell.fv, `${k} fv`).toBeGreaterThanOrEqual(before.get(k)?.fv ?? 0);
        }
        expectModel(fx, ids, model);
      }
      checkSpace(fx.reader, space);
      checkHistory(fx.reader);
    } finally {
      fx.close();
    }
  });

describe("[A1.5.history.property] undo and redo against a reference model", () => {
  test("undo never changes a field whose provenance moved, undo then redo restores the commit's values, and redo passes over what it cannot bring back", async () => {
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
      "redo past a step",
      "redo of a removal kept by newer work",
      "undo kept past a redo that left the row",
      "redo kept from a row or key",
      "redo ended",
      "NOTHING_TO_UNDO",
      "NOTHING_TO_REDO",
      "second human's undo",
      "create undone",
      "create redone",
      "create kept",
      "write refused on a tombstone",
      "removed",
      "restored",
      "note",
      "link",
      "area",
      "project",
      "run",
      "create kept by a run",
      "kept open by newer work",
      "two tasks in one step",
      "newer work named",
    ]) {
      expect(seen[outcome] ?? 0, outcome).toBeGreaterThan(3);
    }
    await fc.assert(property({}), { numRuns: 20 });
  }, 300_000);
});
