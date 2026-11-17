// The apply of an import plan (A7 3.15.5) and the idempotent re-import (3.15.6): the operations
// one import writes, decided from the plan and the space's state as one read found it. Pure: the
// service reads the state (the tasks that hold the plan's legacy IDs, their values, versions,
// folders, source links and recorded bases) and draws the new tasks' IDs, and this module decides.
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
// A completion or a reopen writes the lifecycle and the wrap-up together: when the person's value
// of either stands (kept or in conflict), the other is a conflict too, so neither overwrites it.
//
// Besides the task's own fields: a source the prototype names that no earlier import named is
// linked (never one it dropped, and never one the person removed); a changed evidence text adds an
// evidence entry. Areas and projects are placed by placeGroups and upserted by slug, only those an
// operation needs, and each item records where its task's groups landed for the next import.
//
// Folders on the machine that applies (folders.ts): a task's own folder is a compared field, and a
// project's folder is compared the same way, with its base recorded in the items of its tasks.
// Neither is ever cleared by an import. One that never had a folder on this machine and has no
// base takes the prototype's: setting a folder where there never was one overwrites nothing.
//
// The same input twice gives no operation: an import that changes nothing writes no exchange.
import { ownFolder, projectFolder, type FolderDecision } from "./folders.ts";
import type { ImportPlan, PlannedSource, PlannedSourceFields, PlannedTask } from "./plan.ts";
import { placeGroups, type SpaceState } from "./preview.ts";

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
  "folder",
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
  /**
   * Where the task's planned area and project landed in the space: each group's identity
   * (PlannedArea.key, PlannedProject.key) and its ID. A later import places the group there
   * (preview.ts: placeGroups). Absent for a group the space does not hold after the import.
   */
  readonly groups?: { readonly area?: LandedGroup; readonly project?: LandedGroup };
}

/** One group an import landed: the planned group's identity and the group's ID. */
export interface LandedGroup {
  readonly key: string;
  readonly id: string;
  /** A project's folder on the applying machine this import settled: the next import's base. */
  readonly folder?: FolderValue;
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

/** A live project's folder on the applying machine, as the apply's read found it. */
export interface ProjectFolderState {
  /** Its live folder here, as stored. */
  readonly path: string | null;
  /** The version of its newest folder change here, a removal included; 0 when it never had one. */
  readonly version: number;
  /** The folder the newest import that is not undone settled for it, with that import's seq. */
  readonly base?: { readonly folder: string | null; readonly seq: number };
}

/** The space as the apply's read found it. */
export interface ApplySpace {
  readonly state: SpaceState;
  /** By legacy ID. */
  readonly matched: ReadonlyMap<string, MatchedTask>;
  /** Legacy IDs live tasks hold as aliases that the plan does not name: gone from the prototype. */
  readonly gone: readonly string[];
  /** By project ID, for the live projects. */
  readonly projectFolders?: ReadonlyMap<string, ProjectFolderState>;
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

/** A project whose folder the import set, or left as the space has it against the prototype. */
export interface AppliedProject {
  /** Its planned slug. */
  readonly slug: string;
  readonly outcome: "set" | "conflict";
}

export interface ApplyDecision {
  /**
   * Upserts, then the projects' folders, then each task's operations in plan order, then the
   * exchange: or none at all.
   */
  readonly ops: readonly ApplyOp[];
  readonly tasks: readonly AppliedTask[];
  readonly projects: readonly AppliedProject[];
  readonly gone: readonly string[];
}

export interface ApplyOptions {
  /** The run's ID: the exchange's. */
  readonly exchange: string;
  /** The exchange's folder in the space: the input copy. */
  readonly dir: string;
  /** The ID a new task of this legacy ID gets. */
  readonly idOf: (legacyId: string) => string;
  /** The ID a new area or project of this identity gets (PlannedArea.key, PlannedProject.key). */
  readonly groupIdOf: (kind: "area" | "project", key: string) => string;
  /** The instant the apply was made: `ext.planning.imported_at` of a task it creates. */
  readonly importedAt: number;
  /** The folders the import gives on this machine (preview.ts: folderDecisionOf). */
  readonly folders: FolderDecision;
  /** This machine's ID: a folder and its base are of one machine. */
  readonly machine: string;
}

/**
 * The value of a folder field: one machine's folder, or none there. A base is of the machine that
 * recorded it: another machine's folder says nothing about this one's.
 */
export interface FolderValue {
  readonly machine: string;
  readonly path: string | null;
}

const folderValue = (value: unknown): FolderValue | undefined =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FolderValue).machine === "string" &&
  ((value as FolderValue).path === null || typeof (value as FolderValue).path === "string")
    ? (value as FolderValue)
    : undefined;

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

/**
 * E for one planned task, with the area and project slugs its placement gives and its own folder on
 * this machine (folders.ts: ownFolder).
 */
export function expectedOf(
  task: PlannedTask,
  area: string,
  project: string | undefined,
  folder: FolderValue,
): Expected {
  const create = task.ops[0];
  if (create?.kind !== "task.create") throw new Error("A planned task starts with its create");
  let completedAt: number | undefined;
  let outcome: string | null = null;
  let evidence: string | null = null;
  let evidenceAt: number | undefined;
  const sources = new Map<string, PlannedSourceFields>();
  let completed = false;
  for (const op of task.ops) {
    if (op.kind === "task.complete") {
      completed = true;
      completedAt = op.at;
      outcome = op.outcome ?? null;
    } else if (op.kind === "source.add") sources.set(sourceIdentity(op.source), op.source);
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
      grouping: { area, project: project ?? null },
      lifecycle: completed ? "completed" : "active",
      wrap: completed ? outcome : null,
      "ext.planning": compared(create.ext.planning),
      folder,
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

/**
 * B for one field: the newest recorded value that is not voided, with its import's seq. For the
 * folder, the newest of `machine`'s.
 */
function baseOf(
  task: MatchedTask,
  field: BaseField,
  machine: string,
): { value: unknown; seq: number } | undefined {
  for (const recorded of task.bases) {
    if (recorded.voided.has(field)) continue;
    if (!Object.hasOwn(recorded.base.fields, field)) continue;
    const value = recorded.base.fields[field];
    if (field === "folder" && folderValue(value)?.machine !== machine) continue;
    return { value, seq: recorded.seq };
  }
  return undefined;
}

/** What a re-import does with one field (the module header). */
type Verdict = "apply" | "settle" | "keep" | "conflict";

/** The three-way compare of E, the space's C at `version`, and the base B. */
function threeWay(
  e: unknown,
  c: unknown,
  b: { value: unknown; seq: number } | undefined,
  version: number,
): Verdict {
  if (same(e, c)) return "settle";
  if (b === undefined) return "conflict";
  if (same(e, b.value)) return "keep";
  return version <= b.seq ? "apply" : "conflict";
}

/**
 * A folder's verdict on one machine: the three-way compare of the paths, but a folder an import
 * would clear stays, and an owner that never had a folder on this machine and has no base takes E.
 */
function folderVerdict(
  e: string | null,
  c: string | null,
  b: { value: unknown; seq: number } | undefined,
  version: number,
): Verdict {
  const base = b === undefined ? undefined : { value: folderValue(b.value)?.path, seq: b.seq };
  const v =
    base === undefined && c === null && version === 0 && e !== null
      ? "apply"
      : threeWay(e, c, base, version);
  return v === "apply" && e === null ? "keep" : v;
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
  const { areas: areaPlacements, projects: placements } = placeGroups(plan, space.state);
  const areaSlug = (slug: string): string => areaPlacements.get(slug)?.slug ?? slug;
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
  /** Each task's item, with its planned area's and project's slugs in the plan. */
  const items: { task: string; file: string; base: ItemBase; area: string; project?: string }[] =
    [];
  const tasks: AppliedTask[] = [];
  /** The groups the operations name: upserted before them. */
  const areas = new Set<string>();
  const projects = new Set<string>();
  /** Whether a live task's base moves although no operation changes it. */
  let refreshed = false;

  for (const task of plan.tasks) {
    const area = areaSlug(task.area);
    const project = projectSlug(task.project);
    const folder = ownFolder(options.folders, task.legacyId);
    const expected = expectedOf(task, area, project, { machine: options.machine, path: folder });
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
            area,
            ...(project === undefined ? {} : { project }),
            ext: { planning: { ...op.ext.planning, imported_at: options.importedAt } },
          });
          if (folder !== null) taskOps.push({ kind: "task.folder_set", task: id, path: folder });
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
        area: task.area,
        ...(task.project === undefined ? {} : { project: task.project }),
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
      area: task.area,
      ...(task.project === undefined ? {} : { project: task.project }),
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

  // Each project's folder here: E from the decision, C and the base from the space. A project the
  // import creates has neither, and takes E. Only a project with a task in this import: the items of
  // its tasks record its base.
  const applied: AppliedProject[] = [];
  /** The projects whose folder this import sets, and the folder each settles: the next base. */
  const setFolder = new Map<string, string>();
  const settledFolder = new Map<string, FolderValue>();
  const recorded = new Set(items.flatMap((i) => (i.project === undefined ? [] : [i.project])));
  for (const p of plan.projects) {
    if (!recorded.has(p.slug)) continue;
    const e = projectFolder(options.folders, p.slug);
    const reuses = placements.get(p.slug)?.reuses;
    if (reuses === undefined) {
      if (!projects.has(p.slug)) continue;
      if (e !== null) {
        setFolder.set(p.slug, e);
        applied.push({ slug: p.slug, outcome: "set" });
      }
      settledFolder.set(p.slug, { machine: options.machine, path: e });
      continue;
    }
    const now = space.projectFolders?.get(reuses);
    const base =
      now?.base === undefined
        ? undefined
        : { value: { machine: options.machine, path: now.base.folder }, seq: now.base.seq };
    const v = folderVerdict(e, now?.path ?? null, base, now?.version ?? 0);
    if (v === "apply" && e !== null) {
      setFolder.set(p.slug, e);
      applied.push({ slug: p.slug, outcome: "set" });
    }
    if (v === "conflict") applied.push({ slug: p.slug, outcome: "conflict" });
    if (v === "apply" || v === "settle") {
      settledFolder.set(p.slug, { machine: options.machine, path: e });
      if (v === "settle" && (base === undefined || base.value.path !== e)) refreshed = true;
    }
  }

  // The same input twice: nothing to write, not even the exchange. An import that changes no task
  // still records where the prototype and the space came to agree (a field both set to one value):
  // from then on a person's change of it counts from this import.
  if (taskOps.length === 0 && setFolder.size === 0 && !refreshed) {
    return { ops: [], tasks, projects: applied, gone: space.gone };
  }

  // The groups the operations need that the space lacks, at the slugs their placement gives, with
  // IDs of the apply's own, so the items can record where each group landed.
  const upserts: ApplyOp[] = [];
  /** Each planned group the space holds once the import applies: its identity and its ID. */
  const landedAreas = new Map<string, LandedGroup>();
  const landedProjects = new Map<string, LandedGroup>();
  for (const a of plan.areas) {
    const placed = areaPlacements.get(a.slug);
    if (placed === undefined) continue;
    if (placed.reuses !== undefined) {
      landedAreas.set(a.slug, { key: a.key, id: placed.reuses });
    } else if (areas.has(a.slug)) {
      const id = options.groupIdOf("area", a.key);
      upserts.push({ kind: "area.upsert", slug: placed.slug, title: a.title, id });
      landedAreas.set(a.slug, { key: a.key, id });
    }
  }
  const folderOps: ApplyOp[] = [];
  for (const p of plan.projects) {
    const placed = placements.get(p.slug);
    if (placed === undefined) continue;
    let id: string;
    if (placed.reuses !== undefined) id = placed.reuses;
    else if (projects.has(p.slug)) {
      id = options.groupIdOf("project", p.key);
      upserts.push({
        kind: "project.upsert",
        slug: placed.slug,
        title: p.title,
        area: areaSlug(p.area),
        id,
      });
    } else continue;
    const settled = settledFolder.get(p.slug);
    landedProjects.set(p.slug, {
      key: p.key,
      id,
      ...(settled === undefined ? {} : { folder: settled }),
    });
    const path = setFolder.get(p.slug);
    if (path !== undefined) folderOps.push({ kind: "project.folder_set", project: id, path });
  }
  const exchange: ApplyOp = {
    kind: "exchange.create",
    id: options.exchange,
    dir: options.dir,
    applied: true,
    items: items.map(({ task, file, base, area, project }) => {
      const a = landedAreas.get(area);
      const p = project === undefined ? undefined : landedProjects.get(project);
      const groups = {
        ...(a === undefined ? {} : { area: a }),
        ...(p === undefined ? {} : { project: p }),
      };
      return {
        task,
        file,
        base: Object.keys(groups).length === 0 ? base : { ...base, groups },
      };
    }),
  };
  // A project's folder before its tasks' own: a change of a project's folder moves the task folders
  // inside the old one along, and a task's folder the import then sets is the prototype's.
  return {
    ops: [...upserts, ...folderOps, ...taskOps, exchange],
    tasks,
    projects: applied,
    gone: space.gone,
  };
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
  /**
   * Whether to apply E, settle (record E), or neither, for each field. Each verdict is decided
   * once, below, and an operation is only ever emitted from the final one: a later rule may turn
   * an apply into a keep or a conflict, never a conflict or a keep into anything else.
   */
  const verdict = new Map<BaseField, Verdict>();
  const folder = expected.values.folder as FolderValue;
  const base = (field: BaseField) => baseOf(found, field, folder.machine);
  for (const field of BASE_FIELDS) {
    const e = expected.values[field];
    const c = found.values[field];
    const b = base(field);
    if (field === "evidence") {
      // An evidence entry is only ever added, so no person's change can meet it: a changed text
      // adds one, a text the prototype dropped adds nothing, and without a base the first import
      // wrote it.
      verdict.set(
        field,
        b === undefined || same(e, b.value) ? "settle" : e === null ? "keep" : "apply",
      );
      continue;
    }
    verdict.set(
      field,
      field === "folder"
        ? folderVerdict(folder.path, folderValue(c)?.path ?? null, b, found.versions[field])
        : threeWay(e, c, b, found.versions[field]),
    );
  }
  // A completion or a reopen writes the lifecycle and the wrap-up together, and a wrap-up needs
  // the lifecycle the person left: when either is the person's (kept or in conflict), applying
  // the other would overwrite it, so that one is a conflict too.
  const lifecycleV = verdict.get("lifecycle") ?? "keep";
  const wrapV = verdict.get("wrap") ?? "keep";
  const personal = (v: Verdict) => v === "keep" || v === "conflict";
  if (lifecycleV === "apply" && personal(wrapV)) verdict.set("lifecycle", "conflict");
  if (wrapV === "apply" && personal(lifecycleV)) verdict.set("wrap", "conflict");
  // A changed outcome alone wraps the finished task up again. An outcome the prototype dropped
  // stays: an import never unwraps a task, as it never removes a folder or an evidence entry.
  if (verdict.get("wrap") === "apply" && verdict.get("lifecycle") !== "apply") {
    const done = (found.values.lifecycle as string) !== "active";
    if (expected.values.wrap === null || !done) verdict.set("wrap", "keep");
  }

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

  // A completion carries its outcome, a reopen clears the wrap-up: either way the space holds E's
  // wrap-up after it.
  const outcome = expected.values.wrap as string | null;
  if (verdict.get("lifecycle") === "apply") {
    if (expected.values.lifecycle === "completed") {
      ops.push({
        kind: "task.complete",
        task: id,
        ...(outcome === null ? {} : { outcome }),
        ...(expected.completedAt === undefined ? {} : { at: expected.completedAt }),
      });
    } else ops.push({ kind: "task.reopen", task: id });
  } else if (verdict.get("wrap") === "apply" && outcome !== null) {
    ops.push({ kind: "task.wrap_up", task: id, outcome });
  }

  if (verdict.get("folder") === "apply") {
    ops.push({ kind: "task.folder_set", task: id, path: folder.path });
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
  // Sources the prototype names that the task does not link and that no earlier import named: a
  // source an import named was linked then, so one that is not linked now was taken off by a
  // person, also when an import in between left it out. An undo that set links back voids its
  // import's list.
  // A limit, accepted: when an import is undone and the person then takes off, with Ctrl+Z, a
  // source they had linked by hand that the import also named, no record remembers that source
  // any more, so a later import links it again while the prototype still names it.
  const before = new Set(
    found.bases.flatMap((b) => (b.voided.has("sources") ? [] : b.base.sources)),
  );
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
      const b = base(field);
      if (b === undefined || !same(b.value, expected.values[field])) refreshed = true;
    }
  }
  if (linked) changed.push("sources");
  return { ops, settled, changed, conflicts, refreshed };
}
