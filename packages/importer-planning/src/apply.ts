// The apply of an import plan (A7 3.15.5) and the idempotent re-import (3.15.6): the operations
// one import writes, decided from the plan and the space's state as one read found it. Pure: the
// service reads the state (the tasks that hold the plan's legacy IDs, their values, versions,
// places, source links and recorded bases) and draws the new tasks' IDs, and this module decides.
// The writer then checks, in its transaction, that nothing the decision read has changed: the
// preview token pins the matched tasks' versions and the rows the plan meets, and the request's
// base covers every field it changes (A1 3.5).
//
// Each legacy ID of the plan is one of these:
// - **new**: no task holds it, or the task that holds it was made by an import that was undone
//   (its create was inverted). The plan's operations create the task, with `dedupe: none`, and the
//   alias moves to it.
// - **deleted**: a person deleted the task since. It stays deleted: no operation, and the report
//   names it. A re-import never brings back what a person removed.
// - **matched**: the task is live. Each logical field compares the plan's value E, the base B and
//   the space's value C (A1 3.14's table): E = B is no change; E ≠ B with C unchanged since B's
//   import (its version at most that import's seq) applies E; E ≠ B with C changed is no change
//   when C = E, else a conflict that is shown and never applied. Without a base, a field where E
//   and C differ is a conflict, since nothing tells whose value C is.
//
// The base B of a field is the newest recorded item that holds it. An item records a field only
// when the space holds E for it once the import applies (written, or already equal): a field that
// conflicts, or that a person changed while E stayed B, keeps its older base, with that older
// import's seq, so a later import still sees the person's change as a change. An undone import's
// item gives no base for the fields its undo set back (`voided`).
//
// Besides the task's own fields: a source the prototype added since the last import is linked
// (never one it dropped, and never one the person removed); a place is set when its folder changed
// in the prototype and not in the space (never cleared); a changed evidence text adds an evidence
// entry. Areas and projects are upserted by slug, only those an operation needs.
//
// The same input twice gives no operation: an import that changes nothing writes no exchange.
import type { ImportPlan, PlannedSource, PlannedSourceFields, PlannedTask } from "./plan.ts";
import { placeProjects, type SpaceState } from "./preview.ts";

/** The logical fields a re-import compares (A1 3.4), in the order the report names them. */
export const BASE_FIELDS = [
  "title",
  "summary",
  "context",
  "status",
  "priority",
  "owner",
  "waiting_on",
  "source_at",
  "reviewed_at",
  "due",
  "focus",
  "grouping",
  "lifecycle",
  "wrap",
  "ext.planning",
  "place",
  "evidence",
] as const;
export type BaseField = (typeof BASE_FIELDS)[number];
/** What a re-import reports as changed: a compared field, or the task's sources. */
export type Changed = BaseField | "sources";

/**
 * The keys of `ext.planning` a re-import keeps as the first import wrote them and never compares:
 * where the prototype held the task then, and when it came in. A line added above a task moves
 * every later line, and is no change of the task (A7 3.15.6).
 */
export const FIRST_IMPORT_KEYS: ReadonlySet<string> = new Set([
  "legacy_id",
  "file",
  "line",
  "imported_at",
]);

/** What an exchange item records of one task (A1 3.14): the values this import settled. */
export interface ItemBase {
  readonly v: 1;
  readonly import: "planning";
  /** Each field the space holds E for once the import applies, with E. */
  readonly fields: Readonly<Partial<Record<BaseField, unknown>>>;
  /** The identities (key, else `@url`) of the plan's sources for the task. */
  readonly sources: readonly string[];
}

/** One recorded base of a task: its item's base and the seq of the import that recorded it. */
export interface RecordedBase {
  readonly seq: number;
  readonly base: ItemBase;
  /** The fields its import's undo set back since: they give no base. */
  readonly voided: ReadonlySet<string>;
}

/** A task of the space that holds a legacy ID of the plan as its planning alias. */
export interface MatchedTask {
  readonly id: string;
  /** Its reference, such as `M-12`. */
  readonly ref: string;
  /**
   * `live`; `deleted`, by a person; or `undone`: the import that created it was undone, so the
   * legacy ID is free for a new task.
   */
  readonly state: "live" | "deleted" | "undone";
  /** C: each compared field's value now, in the form of `expectedOf`. */
  readonly values: Readonly<Record<BaseField, unknown>>;
  /** Each compared field's physical version (A1 3.5). */
  readonly versions: Readonly<Record<BaseField, number>>;
  /** The identities (key, else `@url`) of its live source links. */
  readonly sources: ReadonlySet<string>;
  /** `ext.planning` as the task holds it: a patch keeps its first-import keys. */
  readonly planning: Readonly<Record<string, unknown>> | null;
  /** Its recorded bases, newest first. */
  readonly bases: readonly RecordedBase[];
}

/** The space as the apply's read found it. */
export interface ApplySpace {
  readonly state: SpaceState;
  /** By legacy ID. */
  readonly matched: ReadonlyMap<string, MatchedTask>;
  /** Legacy IDs live tasks hold as aliases that the plan does not name: gone from the prototype. */
  readonly gone: readonly string[];
}

/** An operation in the writer's request shape (storage: Operation). */
export type ApplyOp = { readonly kind: string } & Readonly<Record<string, unknown>>;

/** What happened to one legacy ID. */
export interface AppliedTask {
  readonly legacyId: string;
  readonly task?: string;
  readonly ref?: string;
  readonly outcome: "created" | "updated" | "unchanged" | "deleted";
  /** The fields this import changes, and `sources` when it links sources the prototype added. */
  readonly changed: readonly Changed[];
  /** The fields where the prototype and the space both changed: shown, never applied. */
  readonly conflicts: readonly BaseField[];
}

export interface ApplyDecision {
  /** Upserts, then each task's operations in plan order, then the exchange: or none at all. */
  readonly ops: readonly ApplyOp[];
  readonly tasks: readonly AppliedTask[];
  readonly gone: readonly string[];
}

export interface ApplyOptions {
  /** The run's ID: the exchange's. */
  readonly exchange: string;
  /** The exchange's folder in the space: the input copy. */
  readonly dir: string;
  /** The ID a new task of this legacy ID gets. */
  readonly idOf: (legacyId: string) => string;
  /** The instant the apply was made: `ext.planning.imported_at` of a task it creates. */
  readonly importedAt: number;
}

/** E: the values the plan gives a task, in the form the base and the space's values take. */
export interface Expected {
  readonly values: Record<BaseField, unknown>;
  /** Its sources by identity. */
  readonly sources: ReadonlyMap<string, PlannedSourceFields>;
  /** The completion's instant, when the plan completes it. */
  readonly completedAt?: number;
  /** The evidence entry's instant. */
  readonly evidenceAt?: number;
}

/** A source's identity in a task: its key, else its URL. */
export const sourceIdentity = (s: { key?: string; url: string }): string => s.key ?? `@${s.url}`;

/** `ext.planning` without the first-import keys: what a re-import compares. */
function compared(planning: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(planning ?? {})) {
    if (!FIRST_IMPORT_KEYS.has(key)) {
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

/** The space's value of `ext.planning` in the compared form. */
export const comparedPlanning = compared;

/** E for one planned task, with the project slug its placement gives. */
export function expectedOf(task: PlannedTask, project: string | undefined): Expected {
  const create = task.ops[0];
  if (create?.kind !== "task.create") throw new Error("A planned task starts with its create");
  let completedAt: number | undefined;
  let outcome: string | null = null;
  let place: { root: string; path: string } | null = null;
  let evidence: string | null = null;
  let evidenceAt: number | undefined;
  const sources = new Map<string, PlannedSourceFields>();
  let completed = false;
  for (const op of task.ops) {
    if (op.kind === "task.complete") {
      completed = true;
      completedAt = op.at;
      outcome = op.outcome ?? null;
    } else if (op.kind === "place.set") place = { root: op.root, path: op.path };
    else if (op.kind === "source.add") sources.set(sourceIdentity(op.source), op.source);
    else if (op.kind === "log.add" && op.log_kind === "evidence") {
      evidence = op.body;
      evidenceAt = op.at;
    }
  }
  return {
    values: {
      title: create.title,
      summary: create.summary ?? "",
      context: create.context ?? "",
      status: create.status,
      priority: create.priority,
      owner: create.owner ?? null,
      waiting_on: create.waiting_on ?? null,
      source_at: create.source_at ?? null,
      reviewed_at: create.reviewed_at ?? null,
      due: create.due?.date ?? null,
      focus: create.focus ?? null,
      grouping: { area: create.area, project: project ?? null },
      lifecycle: completed ? "completed" : "active",
      wrap: completed ? outcome : null,
      "ext.planning": compared(create.ext.planning),
      place,
      evidence,
    },
    sources,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(evidenceAt === undefined ? {} : { evidenceAt }),
  };
}

/** One spelling of a value, for equality: JSON with object keys in code-point order. */
function same(a: unknown, b: unknown): boolean {
  return spell(a) === spell(b);
}

function spell(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(spell).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${spell(record[k])}`).join(",")}}`;
}

/** B for one field: the newest recorded value that is not voided, with its import's seq. */
function baseOf(task: MatchedTask, field: BaseField): { value: unknown; seq: number } | undefined {
  for (const recorded of task.bases) {
    if (recorded.voided.has(field)) continue;
    if (Object.hasOwn(recorded.base.fields, field)) {
      return { value: recorded.base.fields[field], seq: recorded.seq };
    }
  }
  return undefined;
}

/** The fields a `task.patch` sets, by base field. */
const PATCHED: ReadonlySet<BaseField> = new Set([
  "title",
  "summary",
  "context",
  "status",
  "priority",
  "owner",
  "waiting_on",
  "source_at",
  "reviewed_at",
  "due",
  "focus",
]);

/** Decides the operations of one import (the module header). */
export function decideApply(
  plan: ImportPlan,
  space: ApplySpace,
  options: ApplyOptions,
): ApplyDecision {
  const { placements } = placeProjects(plan, space.state.projects);
  const projectSlug = (slug: string | undefined): string | undefined =>
    slug === undefined ? undefined : (placements.get(slug)?.slug ?? slug);
  const sourcesById = new Map<string, PlannedSource>(
    plan.sources.map((s) => [sourceIdentity(s), s]),
  );
  /** A source operation's fields, with the generic flag of a source it creates (A7 3.15.3). */
  const sourceFields = (fields: PlannedSourceFields): Record<string, unknown> => {
    const generic = sourcesById.get(sourceIdentity(fields))?.generic === true;
    return { ...fields, ...(generic ? { ext: { planning: { generic_title: true } } } : {}) };
  };

  const taskOps: ApplyOp[] = [];
  const items: { task: string; file: string; base: ItemBase }[] = [];
  const tasks: AppliedTask[] = [];
  /** The groups the operations name: upserted before them. */
  const areas = new Set<string>();
  const projects = new Set<string>();
  /** Whether a live task's base moves although no operation changes it. */
  let refreshed = false;

  for (const task of plan.tasks) {
    const project = projectSlug(task.project);
    const expected = expectedOf(task, project);
    const found = space.matched.get(task.legacyId);
    if (found?.state === "deleted") {
      tasks.push({
        legacyId: task.legacyId,
        task: found.id,
        ref: found.ref,
        outcome: "deleted",
        changed: [],
        conflicts: [],
      });
      continue;
    }
    if (found === undefined || found.state === "undone") {
      // A new task: the plan's operations, bound to its new ID.
      const id = options.idOf(task.legacyId);
      areas.add(task.area);
      if (project !== undefined) projects.add(task.project ?? "");
      for (const op of task.ops) {
        const { task: draft, ...rest } = structuredClone(op);
        if (draft.draft !== task.legacyId) throw new Error("An operation names another task");
        if (op.kind === "task.create") {
          const create = rest as Record<string, unknown>;
          taskOps.push({
            ...create,
            kind: "task.create",
            id,
            ...(project === undefined ? {} : { project }),
            ext: { planning: { ...op.ext.planning, imported_at: options.importedAt } },
          });
        } else if (op.kind === "source.add") {
          taskOps.push({ ...rest, kind: op.kind, task: id, source: sourceFields(op.source) });
        } else taskOps.push({ ...rest, kind: op.kind, task: id });
      }
      items.push({
        task: id,
        file: task.legacyId,
        base: {
          v: 1,
          import: "planning",
          fields: expected.values,
          sources: [...expected.sources.keys()],
        },
      });
      tasks.push({
        legacyId: task.legacyId,
        task: id,
        outcome: "created",
        changed: [],
        conflicts: [],
      });
      continue;
    }
    const decided = decideMatched(expected, found, sourceFields);
    if (decided.refreshed) refreshed = true;
    for (const op of decided.ops) {
      if (op.kind === "task.move") {
        areas.add(task.area);
        if (project !== undefined) projects.add(task.project ?? "");
      }
      taskOps.push(op);
    }
    items.push({
      task: found.id,
      file: task.legacyId,
      base: {
        v: 1,
        import: "planning",
        fields: decided.settled,
        sources: [...expected.sources.keys()],
      },
    });
    tasks.push({
      legacyId: task.legacyId,
      task: found.id,
      ref: found.ref,
      outcome: decided.ops.length > 0 ? "updated" : "unchanged",
      changed: decided.changed,
      conflicts: decided.conflicts,
    });
  }

  // The same input twice: nothing to write, not even the exchange. An import that changes no task
  // still records where the prototype and the space came to agree (a field both set to one value):
  // from then on a person's change of it counts from this import.
  if (taskOps.length === 0 && !refreshed) return { ops: [], tasks, gone: space.gone };

  const live = new Set(space.state.areas.map((a) => a.slug));
  const upserts: ApplyOp[] = [];
  for (const area of plan.areas) {
    if (areas.has(area.slug) && !live.has(area.slug)) {
      upserts.push({ kind: "area.upsert", slug: area.slug, title: area.title });
    }
  }
  for (const p of plan.projects) {
    const placed = placements.get(p.slug);
    if (!projects.has(p.slug) || placed === undefined || placed.reuses !== undefined) continue;
    upserts.push({ kind: "project.upsert", slug: placed.slug, title: p.title, area: p.area });
  }
  const exchange: ApplyOp = {
    kind: "exchange.create",
    id: options.exchange,
    dir: options.dir,
    applied: true,
    items,
  };
  return { ops: [...upserts, ...taskOps, exchange], tasks, gone: space.gone };
}

/** The three-way compare of one live task (the module header). */
function decideMatched(
  expected: Expected,
  found: MatchedTask,
  sourceFields: (fields: PlannedSourceFields) => Record<string, unknown>,
): {
  ops: ApplyOp[];
  settled: Partial<Record<BaseField, unknown>>;
  changed: Changed[];
  conflicts: BaseField[];
  refreshed: boolean;
} {
  const settled: Partial<Record<BaseField, unknown>> = {};
  const changed: Changed[] = [];
  const conflicts: BaseField[] = [];
  /** A field whose base this import moves: E is new to the record, and the space holds it. */
  let refreshed = false;
  /** Whether to apply E, settle (record E), or neither, for each field. */
  const verdict = new Map<BaseField, "apply" | "settle" | "keep" | "conflict">();
  for (const field of BASE_FIELDS) {
    const e = expected.values[field];
    const c = found.values[field];
    const b = baseOf(found, field);
    let v: "apply" | "settle" | "keep" | "conflict";
    if (b === undefined) v = same(e, c) ? "settle" : "conflict";
    else if (same(e, b.value)) v = same(e, c) ? "settle" : "keep";
    else if (found.versions[field] <= b.seq) v = same(e, c) ? "settle" : "apply";
    else v = same(e, c) ? "settle" : "conflict";
    verdict.set(field, v);
  }
  // Never deleted by an import: a place the prototype no longer names stays (A1 3.14).
  if (verdict.get("place") === "apply" && expected.values.place === null) {
    verdict.set("place", "keep");
  }
  // An evidence entry is only ever added, so no person's change can meet it: a changed text adds
  // one, a text the prototype dropped adds nothing, and without a base the first import wrote it.
  const evidence = baseOf(found, "evidence");
  verdict.set(
    "evidence",
    evidence === undefined || same(expected.values.evidence, evidence.value)
      ? "settle"
      : expected.values.evidence === null
        ? "keep"
        : "apply",
  );

  const ops: ApplyOp[] = [];
  const id = found.id;
  // The fields of one patch.
  const set: Record<string, unknown> = {};
  for (const field of PATCHED) {
    if (verdict.get(field) !== "apply") continue;
    const value = expected.values[field];
    set[field] = field === "due" ? (value === null ? null : { date: value }) : value;
  }
  if (verdict.get("ext.planning") === "apply") {
    // The compared keys from the plan, the first-import keys as the task holds them.
    const keep: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(found.planning ?? {})) {
      if (FIRST_IMPORT_KEYS.has(key)) keep[key] = value;
    }
    set["ext"] = {
      planning: { ...(expected.values["ext.planning"] as Record<string, unknown>), ...keep },
    };
  }
  if (Object.keys(set).length > 0) ops.push({ kind: "task.patch", task: id, set });
  if (verdict.get("grouping") === "apply") {
    const g = expected.values.grouping as { area: string; project: string | null };
    ops.push({ kind: "task.move", task: id, area: g.area, project: g.project });
  }

  // Lifecycle and wrap-up go together: a completion carries its outcome, a reopen clears it.
  const lifecycle = verdict.get("lifecycle");
  let wrap = verdict.get("wrap");
  const outcome = expected.values.wrap as string | null;
  if (lifecycle === "apply") {
    if (expected.values.lifecycle === "completed") {
      ops.push({
        kind: "task.complete",
        task: id,
        ...(outcome === null ? {} : { outcome }),
        ...(expected.completedAt === undefined ? {} : { at: expected.completedAt }),
      });
    } else ops.push({ kind: "task.reopen", task: id });
    // The space holds E's wrap-up once the lifecycle applies: E's outcome, or none.
    wrap = "settle";
  } else if (wrap === "apply") {
    // A changed outcome wraps the finished task up again. An outcome the prototype dropped stays:
    // an import never unwraps a task, as it never removes a place or an evidence entry.
    const done = (found.values.lifecycle as string) !== "active";
    if (outcome !== null && done) ops.push({ kind: "task.wrap_up", task: id, outcome });
    else wrap = "keep";
  }
  verdict.set("wrap", wrap ?? "keep");

  if (verdict.get("place") === "apply") {
    const place = expected.values.place as { root: string; path: string };
    ops.push({ kind: "place.set", task: id, root: place.root, path: place.path });
  }
  if (verdict.get("evidence") === "apply") {
    ops.push({
      kind: "log.add",
      task: id,
      body: expected.values.evidence,
      log_kind: "evidence",
      ...(expected.evidenceAt === undefined ? {} : { at: expected.evidenceAt }),
    });
  }
  // Sources the prototype added since the last import, that the task does not link: never one
  // the last import named already, which a person may have taken off since.
  const recorded = found.bases.find((b) => !b.voided.has("sources"));
  const before = new Set(recorded?.base.sources ?? []);
  let linked = false;
  for (const [identity, fields] of expected.sources) {
    if (found.sources.has(identity) || before.has(identity)) continue;
    ops.push({ kind: "source.add", task: id, source: sourceFields(fields), role: "origin" });
    linked = true;
  }

  for (const field of BASE_FIELDS) {
    const v = verdict.get(field);
    if (v === "apply" || v === "settle") settled[field] = expected.values[field];
    if (v === "apply") changed.push(field);
    if (v === "conflict") conflicts.push(field);
    if (v === "settle") {
      const b = baseOf(found, field);
      if (b === undefined || !same(b.value, expected.values[field])) refreshed = true;
    }
  }
  if (linked) changed.push("sources");
  return { ops, settled, changed, conflicts, refreshed };
}
