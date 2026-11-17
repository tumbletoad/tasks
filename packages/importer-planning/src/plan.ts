// The import plan (A7 3.15.3): what one import of a prototype folder writes, as A1 operations.
// The mapping (mapping.ts) builds it from a PrototypeParse, purely: no I/O, no clock and no random
// source, so the same input and options give the same plan, which the preview token hashes
// (A7 3.15.4) and the apply recomputes (3.15.5).
//
// The plan names each task it creates by a draft handle, its legacy ID, because a task's `t_` ID
// is 128 random bits (A1 3.3) that the apply draws: `bindOperations` turns the handles into IDs.
// Areas and projects are named by slug and are upserts: the apply reuses a live area or project
// with that slug and creates the others (the shared sources' rule, A7 3.15.3).
//
// The operations are A1's (A1 3.6), in the writer's request shape (storage: Operation). The
// importer never imports storage (A7 3.2), so the shapes are written out here, as launch writes
// its own. Some fields and kinds are not in the writer yet: the apply (M7.05) adds them, and each
// is marked "Apply:" below.

import type { Problem } from "./problems.ts";
import type { PlannedSourceKind } from "./sources.ts";

/** A task the plan creates, before the apply gives it its `t_` ID: its legacy ID. */
export interface Draft {
  readonly draft: string;
}

export const CHECKED_AS = ["completed", "review"] as const;
export type CheckedAs = (typeof CHECKED_AS)[number];

/** The text of the log entry every imported task gets (A7 3.15.3). */
export const IMPORT_LOG = "Imported from the Planning prototype";

/** `ext.planning`: what the import keeps of the prototype beyond the space's fields. */
export interface PlanningExt {
  readonly legacy_id: string;
  readonly file: "TODO.md" | "DONE.md" | "data/metadata.json";
  /** Absent for a metadata entry without a task line (`--include-orphans`). */
  readonly line?: number;
  /** The agent of the `(added …)` clause. */
  readonly added_by?: string;
  /** `delegated`: the prototype status the space's `waiting` stands for. */
  readonly status?: "delegated";
  readonly rank?: number;
  readonly confidence?: string;
  /** Every path but the first absolute one, which is the task's folder (PlannedTask.folder). */
  readonly paths?: readonly string[];
  /** A completion without a date: completed at the import time. */
  readonly done_date_unknown?: true;
  /** The unknown metadata keys, each as `ext.planning.<key>`, with its JSON value. */
  readonly [extra: string]: unknown;
}

/** The keys `ext.planning` holds of its own; an unknown metadata key never takes one. */
export const PLANNING_EXT_KEYS: ReadonlySet<string> = new Set([
  "legacy_id",
  "file",
  "line",
  "imported_at",
  "added_by",
  "status",
  "rank",
  "confidence",
  "paths",
  "done_date_unknown",
]);

/**
 * `task.create` with `dedupe: "none"`: every legacy task is its own task, so a shared key never
 * merges two legacy tasks or attaches one to a task the space has (A1 3.6).
 */
export interface PlannedTaskCreate {
  readonly kind: "task.create";
  readonly task: Draft;
  readonly title: string;
  readonly summary?: string;
  readonly context?: string;
  readonly status: "open" | "waiting" | "review" | "backlog";
  readonly priority: 1 | 2 | 3;
  readonly owner?: string;
  readonly waiting_on?: string;
  readonly source_at?: number;
  readonly reviewed_at?: number;
  readonly due?: { readonly date: string };
  /** The star's day (`focus_on`). */
  readonly focus?: string;
  /** An area slug. */
  readonly area: string;
  /** A project slug in that area. */
  readonly project?: string;
  readonly dedupe: "none";
  /** Apply: the creation instant, 09:00 on the `(added …)` day. Absent: the commit's instant. */
  readonly created_at?: number;
  /** Apply: `ext.planning`, one logical field (A1 3.4), plus `imported_at`, the commit's instant. */
  readonly ext: { readonly planning: PlanningExt };
}

/** Apply: the alias `(planning, <legacy id>)`, which `tasks show <legacy id>` resolves (A1 3.3). */
export interface PlannedAliasAdd {
  readonly kind: "alias.add";
  readonly task: Draft;
  readonly namespace: "planning";
  readonly alias: string;
}

export interface PlannedSourceFields {
  readonly kind: PlannedSourceKind;
  readonly title: string;
  readonly key?: string;
  readonly url: string;
  readonly ref?: string;
}

/** `source.add` with role `origin`: one source row per key, found or created by the writer. */
export interface PlannedSourceAdd {
  readonly kind: "source.add";
  readonly task: Draft;
  readonly source: PlannedSourceFields;
  readonly role: "origin";
}

export interface PlannedLogAdd {
  readonly kind: "log.add";
  readonly task: Draft;
  readonly body: string;
  readonly log_kind: "evidence" | "progress";
  /** Apply: the entry's instant, 09:00 on `source_date` for evidence. Absent: the commit's. */
  readonly at?: number;
}

/** `task.complete`: wrapped when it carries an outcome, else pending (A1 3.11.1). */
export interface PlannedTaskComplete {
  readonly kind: "task.complete";
  readonly task: Draft;
  readonly outcome?: string;
  /** Apply: `completed_at`. Absent: the commit's instant (the import time). */
  readonly at?: number;
}

export type PlannedOp =
  PlannedTaskCreate | PlannedAliasAdd | PlannedSourceAdd | PlannedLogAdd | PlannedTaskComplete;

export interface PlannedArea {
  readonly slug: string;
  /** As first written, cut to fit. */
  readonly title: string;
  /**
   * Its identity, from the whole title (slug.ts: groupKey): an import records where each group
   * landed in the space under it, and a later import finds the group by that record.
   */
  readonly key: string;
}

export interface PlannedProject {
  readonly slug: string;
  readonly title: string;
  /** Its area's slug. */
  readonly area: string;
  /** Its identity: its area's and its own whole title's (PlannedArea.key). */
  readonly key: string;
}

export interface PlannedSource extends PlannedSourceFields {
  /** The title is a short form of the URL: a later Refresh can improve it. Apply: kept on the
   * source as `ext.planning.generic_title`. */
  readonly generic: boolean;
  /** The legacy IDs of the tasks that link it, in plan order. More than one: a shared key. */
  readonly tasks: readonly string[];
}

/** One task of the plan: its operations, and what the report shows of it (A7 3.15.4 section 5). */
export interface PlannedTask {
  readonly legacyId: string;
  readonly file: PlanningExt["file"];
  readonly line?: number;
  /** False for a fallback ID. */
  readonly marked: boolean;
  readonly area: string;
  readonly project?: string;
  readonly status: PlannedTaskCreate["status"];
  readonly lifecycle: "active" | "completed";
  /** For a completed task. */
  readonly wrap?: "pending" | "wrapped";
  /**
   * The first absolute path of its metadata, as written, and its place in the file's list: its
   * folder, when it is one on the machine that applies the import (folders.ts).
   */
  readonly folder?: { readonly path: string; readonly index: number };
  /** Create, alias, sources, log entries, then the completion. */
  readonly ops: readonly PlannedOp[];
}

/** An owner as the report lists it (A7 3.15.3: every distinct owner). */
export interface PlannedOwner {
  /** As first written. */
  readonly name: string;
  /** It is the user (`--me`): no owner. */
  readonly me: boolean;
  readonly tasks: number;
}

/** The plan's counts for the report's first section (A7 3.15.4). */
export interface PlanCounts {
  readonly tasks: number;
  readonly active: number;
  readonly completed: number;
  readonly wrapped: number;
  readonly aliases: number;
  readonly areas: number;
  readonly projects: number;
  /** Distinct source rows the plan names. */
  readonly sources: number;
  readonly sourcesByKind: Readonly<Partial<Record<PlannedSourceKind, number>>>;
  readonly links: number;
  /** Tasks with a folder (PlannedTask.folder). */
  readonly folders: number;
  /** Later task lines with an ID an earlier line has (`duplicate-id`): not planned. */
  readonly duplicatesLeftOut: number;
  /** Metadata entries without a task line that `--include-orphans` creates. */
  readonly orphansIncluded: number;
}

export interface ImportPlan {
  /** In order of first appearance: TODO.md, then DONE.md, then included orphans. */
  readonly areas: readonly PlannedArea[];
  readonly projects: readonly PlannedProject[];
  readonly sources: readonly PlannedSource[];
  /**
   * In creation order: each group (an area, or a project in it) in order of first appearance,
   * and within it by rank, then file order, so the writer's appends give the prototype's order.
   */
  readonly tasks: readonly PlannedTask[];
  readonly owners: readonly PlannedOwner[];
  readonly counts: PlanCounts;
  /** The mapping's own problems. The parse's are in PrototypeParse.problems. */
  readonly problems: readonly Problem[];
}

/** An operation with its draft handles turned into IDs: the writer's request shape. */
export type BoundOp = Readonly<Record<string, unknown>> & { readonly kind: PlannedOp["kind"] };

/**
 * The plan's operations in order, each draft handle replaced by the ID `idOf` gives its legacy ID:
 * `task.create` takes it as `id`, every other operation as `task`. Pure: the apply draws the IDs.
 * The operations are copies, so the plan stays as it was hashed whatever the caller does with them,
 * and two tasks given one ID throw.
 */
export function bindOperations(
  plan: Pick<ImportPlan, "tasks">,
  idOf: (legacyId: string) => string,
): BoundOp[] {
  const ops: BoundOp[] = [];
  const given = new Set<string>();
  for (const task of plan.tasks) {
    const id = idOf(task.legacyId);
    if (given.has(id)) throw new Error("Two tasks of the plan were given one ID");
    given.add(id);
    for (const op of task.ops) {
      const { task: draft, ...rest } = structuredClone(op);
      if (draft.draft !== task.legacyId) throw new Error("An operation names another task's draft");
      ops.push(op.kind === "task.create" ? { ...rest, kind: op.kind, id } : { ...rest, task: id });
    }
  }
  return ops;
}
