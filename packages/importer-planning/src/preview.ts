// The dry run's report and its preview token (A7 3.15.4). Pure: the service gathers what only the
// space and this machine can tell (the space's state the plan meets, the folders that are missing
// here) and the run's copy, and this module judges, counts and hashes.
//
// The report has A7's six sections: counts and reconciliation, the status mapping, the roots
// (with proposals for paths under none), needs attention (every problem, errors first), each task,
// and what is not imported. Every error blocks: a blocked report has no token.
//
// The token pins everything the apply depends on, so the apply (M7.05) recomputes it and refuses
// any difference: the run, the space it was judged against (ID, authority epoch and incarnation),
// the hash of every input and of the actions export, the options, the plan's hash, and the rows of
// the space the plan meets (the aliases of its legacy IDs, the sources of its keys, the areas and
// projects of its slugs) with their versions. It is a hash, no secret.

import { createHash } from "node:crypto";
import {
  IMPORT_PROBLEM_CODES,
  PREVIEW_ROWS,
  type ImportPlanningPreviewResult,
  type ImportProblemCode,
} from "@tasks/contracts";
import { ACTIONS_FILE } from "./events.ts";
import type { InputFile } from "./input-copy.ts";
import type { MappingOptions } from "./mapping.ts";
import { METADATA_FILE, STATUSES, type PrototypeStatus } from "./metadata.ts";
import type { ImportPlan, PlannedTask, PlannedTaskCreate } from "./plan.ts";
import { isAbsolutePath, ROOT_ID, split } from "./places.ts";
import { problem, type Problem } from "./problems.ts";
import type { PrototypeParse } from "./prototype.ts";

/** The rows of the space the plan meets, as the dry run read them in one snapshot. */
export interface SpaceState {
  readonly id: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly refPrefix: string;
  /** The reference the space gives its next task. */
  readonly nextRef: number;
  /** Planning aliases of the plan's legacy IDs: an earlier import made these tasks. */
  readonly aliases: readonly {
    readonly alias: string;
    readonly task: string;
    readonly version: number;
  }[];
  /** Live sources with one of the plan's keys: the apply links them. */
  readonly sources: readonly {
    readonly key: string;
    readonly id: string;
    readonly version: number;
  }[];
  /** Live areas and projects with one of the plan's slugs: the apply reuses them. */
  readonly areas: readonly {
    readonly slug: string;
    readonly id: string;
    readonly version: number;
  }[];
  readonly projects: readonly {
    readonly slug: string;
    readonly id: string;
    readonly version: number;
  }[];
}

/** A root the mapping used: this machine's (machine.toml) or one `--roots` gave. */
export interface PreviewRoot {
  readonly id: string;
  readonly folder: string;
  readonly origin: "machine" | "given";
}

/** One dry run's facts beside its parse and plan. */
export interface PreviewRun {
  readonly run: string;
  /** The run's folder in the space. */
  readonly folder: string;
  /** What was copied: the prototype folder and the actions export, as given. */
  readonly source: { readonly folder: string; readonly actions?: string };
  /** The options the plan was made with; `roots` holds every root of `roots` below. */
  readonly options: MappingOptions;
  readonly roots: readonly PreviewRoot[];
  /** The input copy's files, in copy order. */
  readonly inputs: readonly InputFile[];
  /** The actions export's copy, when one was given. */
  readonly actions?: InputFile;
  /** The copy's and the read's problems, before the parse. */
  readonly problems: readonly Problem[];
  /** The source checked again after the plan (`verifySource`, `verifyActions`). */
  readonly verified: readonly Problem[];
  readonly space: SpaceState;
  /** Legacy IDs whose place's folder is not on this machine. */
  readonly missing: ReadonlySet<string>;
}

export interface Preview {
  /** The whole report: report.json. */
  readonly report: ImportPlanningPreviewResult;
  /** The entry's result: the report with at most PREVIEW_ROWS tasks and problems. */
  readonly result: ImportPlanningPreviewResult;
}

// ---------------------------------------------------------------------------------------------
// Hashing

/**
 * JSON with every object's keys in code-point order and no spaces: one text per value. Own keys
 * only, `__proto__` included, as JSON.stringify would write them. Undefined members are left out.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === "function") return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** The plan's hash: SHA-256 of its canonical JSON, lower-case hex. */
export function planHash(plan: ImportPlan): string {
  return sha256(canonicalJson(plan)).toString("hex");
}

/** What the token pins of the space: the rows the plan meets, each with its version, sorted. */
function judged(plan: ImportPlan, space: SpaceState) {
  const ids = new Set(plan.tasks.map((t) => t.legacyId));
  const keys = new Set(plan.sources.flatMap((s) => (s.key === undefined ? [] : [s.key])));
  const areas = new Set(plan.areas.map((a) => a.slug));
  const projects = new Set(plan.projects.map((p) => p.slug));
  const sorted = <T>(rows: T[], key: (row: T) => string) =>
    rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    aliases: sorted(
      space.aliases.filter((a) => ids.has(a.alias)).map((a) => [a.alias, a.task, a.version]),
      (r) => String(r[0]),
    ),
    sources: sorted(
      space.sources.filter((s) => keys.has(s.key)).map((s) => [s.key, s.id, s.version]),
      (r) => String(r[0]),
    ),
    areas: sorted(
      space.areas.filter((a) => areas.has(a.slug)).map((a) => [a.slug, a.id, a.version]),
      (r) => String(r[0]),
    ),
    projects: sorted(
      space.projects.filter((p) => projects.has(p.slug)).map((p) => [p.slug, p.id, p.version]),
      (r) => String(r[0]),
    ),
  };
}

/**
 * The preview token (A7 3.15.4): `pv1_` and the base64url SHA-256 of the canonical JSON of what
 * the apply depends on. The apply recomputes it from its own run and compares.
 */
export function previewToken(plan: ImportPlan, run: PreviewRun): string {
  const o = run.options;
  const pinned = {
    v: 1,
    run: run.run,
    space: { id: run.space.id, epoch: run.space.epoch, incarnation: run.space.incarnation },
    inputs: run.inputs.map((f) => [f.path, f.sha256]),
    actions: run.actions?.sha256 ?? null,
    options: {
      me: o.me ?? null,
      roots: Object.entries(o.roots ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      checked_as: o.checkedAs ?? "completed",
      include_orphans: o.includeOrphans === true,
      time_zone: o.timeZone,
    },
    plan: planHash(plan),
    judged: judged(plan, run.space),
  };
  return `pv1_${sha256(canonicalJson(pinned)).toString("base64url")}`;
}

// ---------------------------------------------------------------------------------------------
// Roots

/** Proposed roots for the task folders under none: their common folders, named (A7 3.15.4). */
export function proposeRoots(
  folders: readonly string[],
  taken: readonly string[],
): { id: string; folder: string; places: number }[] {
  // Grouped by the first three folders below the top (a drive counts as one more), which is the
  // depth of a person's own folder for work (`/home/<user>/<folder>`, `C:\Users\<user>\<folder>`).
  const groups = new Map<string, { folder: string; places: number }>();
  for (const path of folders) {
    const parts = split(path);
    if (parts === undefined || parts.segments.length === 0) continue;
    const depth = parts.windows ? 4 : 3;
    const head = parts.segments.slice(0, depth);
    const folder = parts.windows
      ? `${head.join("\\")}${head.length === 1 ? "\\" : ""}`
      : `/${head.join("/")}`;
    const key = parts.windows ? folder.toLowerCase() : folder;
    const group = groups.get(key) ?? { folder, places: 0 };
    group.places += 1;
    groups.set(key, group);
  }
  const used = new Set(taken);
  const out: { id: string; folder: string; places: number }[] = [];
  for (const { folder, places } of groups.values()) {
    const last =
      folder
        .split(/[\\/]/)
        .filter((s) => s !== "")
        .at(-1) ?? "";
    const base =
      last
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[-_]+/, "")
        .slice(0, 28)
        .replace(/[-_]+$/, "") || "root";
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${String(n)}`;
    if (!ROOT_ID.test(id)) continue;
    used.add(id);
    out.push({ id, folder, places });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The report

const KIND_ORDER = ["ticket", "email", "chat", "doc", "calendar", "pr", "issue", "session", "web"];
const STATUS_ORDER = ["open", "waiting", "review", "backlog"] as const;
const CODE_ORDER = Object.keys(IMPORT_PROBLEM_CODES) as ImportProblemCode[];

const createOf = (t: PlannedTask): PlannedTaskCreate => t.ops[0] as PlannedTaskCreate;

/** The dry run's own problems: what only the space and this machine can tell. */
function spaceProblems(plan: ImportPlan, run: PreviewRun): Problem[] {
  const out: Problem[] = [];
  const aliased = new Set(run.space.aliases.map((a) => a.alias));
  const held = new Set(run.space.sources.map((s) => s.key));
  for (const t of plan.tasks) {
    if (aliased.has(t.legacyId)) {
      out.push(problem("legacy-id-imported", { file: t.file, line: t.line, task: t.legacyId }));
    }
  }
  for (const s of plan.sources) {
    if (s.key !== undefined && held.has(s.key)) {
      out.push(
        problem("source-key-exists", { file: METADATA_FILE, task: s.tasks[0], field: "sources" }),
      );
    }
  }
  for (const t of plan.tasks) {
    if (t.place !== undefined && run.missing.has(t.legacyId)) {
      out.push(problem("place-missing", { file: METADATA_FILE, task: t.legacyId, field: "paths" }));
    }
  }
  return out;
}

/** Builds the report and, when nothing blocks, its token. */
export function previewOf(parse: PrototypeParse, plan: ImportPlan, run: PreviewRun): Preview {
  const problems = [
    ...run.problems,
    ...parse.problems,
    ...plan.problems,
    ...spaceProblems(plan, run),
    ...run.verified,
  ];
  const blocked = problems.some((p) => p.severity === "error");
  const count = (code: ImportProblemCode) => problems.filter((p) => p.code === code).length;

  const areaSlugs = new Set(run.space.areas.map((a) => a.slug));
  const projectSlugs = new Set(run.space.projects.map((p) => p.slug));
  const keys = new Set(run.space.sources.map((s) => s.key));
  const aliased = new Set(run.space.aliases.map((a) => a.alias));
  const c = plan.counts;
  const placesMissing = plan.tasks.filter(
    (t) => t.place !== undefined && run.missing.has(t.legacyId),
  ).length;

  // Statuses: the prototype's (none without one) and the space's, per pair.
  const pairs = new Map<string, number>();
  for (const t of plan.tasks) {
    const from = parse.metadata.get(t.legacyId)?.status ?? "none";
    const key = `${from}\u0000${t.status}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const fromOrder = [...STATUSES, "none"];
  const statuses = [...pairs]
    .map(([key, n]) => {
      const [prototype = "none", status = "open"] = key.split("\u0000");
      return {
        prototype: prototype as PrototypeStatus | "none",
        status: status as (typeof STATUS_ORDER)[number],
        count: n,
      };
    })
    .sort(
      (a, b) =>
        fromOrder.indexOf(a.prototype) - fromOrder.indexOf(b.prototype) ||
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
    );

  // Roots: the ones used, then proposals for the task folders under none.
  const missingByRoot = new Map<string, number>();
  for (const t of plan.tasks) {
    if (t.place !== undefined && run.missing.has(t.legacyId)) {
      missingByRoot.set(t.place.root, (missingByRoot.get(t.place.root) ?? 0) + 1);
    }
  }
  const outside = plan.tasks.flatMap((t) => {
    if (t.place !== undefined) return [];
    const first = parse.metadata.get(t.legacyId)?.paths.find(isAbsolutePath);
    return first === undefined ? [] : [first];
  });
  const roots = [
    ...run.roots.map((r) => ({
      id: r.id,
      folder: r.folder,
      origin: r.origin,
      places: Object.hasOwn(c.placesByRoot, r.id) ? (c.placesByRoot[r.id] ?? 0) : 0,
      missing: missingByRoot.get(r.id) ?? 0,
    })),
    ...proposeRoots(
      outside,
      run.roots.map((r) => r.id),
    ).map((p) => ({ ...p, origin: "proposed" as const, missing: 0 })),
  ];

  const attention = CODE_ORDER.map((code) => ({
    code,
    severity: IMPORT_PROBLEM_CODES[code],
    count: count(code),
  }))
    .filter((a) => a.count > 0)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

  const titleOf = (list: readonly { slug: string; title: string }[], slug: string | undefined) =>
    list.find((g) => g.slug === slug)?.title ?? slug ?? "";
  const tasks = plan.tasks.map((t, i) => {
    const create = createOf(t);
    return {
      legacy_id: t.legacyId,
      ref: `${run.space.refPrefix}-${String(run.space.nextRef + i)}`,
      area: titleOf(plan.areas, t.area),
      ...(t.project === undefined ? {} : { project: titleOf(plan.projects, t.project) }),
      status: t.status,
      lifecycle: t.lifecycle,
      ...(t.wrap === undefined ? {} : { wrap: t.wrap }),
      ...(t.place === undefined ? {} : { place: t.place }),
      ...(t.place !== undefined && run.missing.has(t.legacyId) ? { place_missing: true } : {}),
      ...(create.due === undefined ? {} : { due: create.due.date }),
      ...(create.focus === undefined ? {} : { focus: create.focus }),
      ...(aliased.has(t.legacyId) ? { imported: true } : {}),
    };
  });

  // What is not imported (A7 3.15.7). A web- event the actions export added is imported.
  const added = new Set(
    parse.events.applied.filter((e) => e.file === ACTIONS_FILE).map((e) => e.id),
  );
  const unready = parse.events.files.filter(
    (f) =>
      !f.counted && f.name.startsWith("web-") && (f.event === undefined || !added.has(f.event.id)),
  ).length;

  const report: ImportPlanningPreviewResult = {
    run: run.run,
    folder: run.folder,
    source: run.source,
    blocked,
    ...(blocked ? {} : { token: previewToken(plan, run) }),
    time_zone: run.options.timeZone,
    options: {
      ...(run.options.me === undefined ? {} : { me: run.options.me }),
      checked_as: run.options.checkedAs ?? "completed",
      include_orphans: run.options.includeOrphans === true,
    },
    counts: {
      todo_task_lines: parse.counts.todoTaskLines,
      done_task_lines: parse.counts.doneTaskLines,
      task_lines: parse.counts.taskLines,
      metadata_entries: parse.counts.metadataEntries,
      metadata_orphans: parse.counts.metadataOrphans,
      task_lines_without_metadata: parse.counts.taskLinesWithoutMetadata,
      event_files: parse.counts.eventFiles,
      ready_files: parse.counts.readyFiles,
      counted_event_files: parse.counts.countedEventFiles,
      events_not_ready: parse.counts.eventsNotReady,
      actions_events: parse.events.actions.events,
      actions_added: parse.events.actions.added,
      tasks: c.tasks,
      active: c.active,
      completed: c.completed,
      wrapped: c.wrapped,
      aliases: c.aliases,
      areas: c.areas,
      areas_existing: plan.areas.filter((a) => areaSlugs.has(a.slug)).length,
      projects: c.projects,
      projects_existing: plan.projects.filter((p) => projectSlugs.has(p.slug)).length,
      sources: c.sources,
      sources_existing: plan.sources.filter((s) => s.key !== undefined && keys.has(s.key)).length,
      links: c.links,
      places: c.places,
      places_missing: placesMissing,
      duplicates_left_out: c.duplicatesLeftOut,
      orphans_included: c.orphansIncluded,
      text_sanitised: count("text-sanitised"),
      source_changes: count("source-changed"),
    },
    reconciled:
      c.active + c.completed === c.tasks &&
      c.tasks - c.orphansIncluded + c.duplicatesLeftOut === parse.counts.taskLines,
    sources_by_kind: Object.entries(c.sourcesByKind)
      .map(([kind, n]) => ({ kind, count: n }))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
    statuses,
    roots,
    owners: plan.owners.map((o) => ({ name: o.name, me: o.me, tasks: o.tasks })),
    attention,
    problems,
    problems_more: 0,
    tasks,
    tasks_more: 0,
    not_imported: [
      { what: "code" },
      { what: "agent_rules" },
      { what: "snapshots" },
      { what: "notes" },
      { what: "ticket_inventory", count: parse.jira.tickets.length },
      { what: "audit" },
      { what: "unready_events", count: unready },
      { what: "raw_events", count: parse.events.applied.length },
      { what: "orphans", count: parse.orphans.length - c.orphansIncluded },
    ],
  };
  const result: ImportPlanningPreviewResult = {
    ...report,
    problems: problems.slice(0, PREVIEW_ROWS),
    problems_more: Math.max(0, problems.length - PREVIEW_ROWS),
    tasks: tasks.slice(0, PREVIEW_ROWS),
    tasks_more: Math.max(0, tasks.length - PREVIEW_ROWS),
  };
  return { report, result };
}
