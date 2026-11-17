// import.planning.preview: the dry run of the Planning prototype import, for the user only
// (op/call's gate refuses every other class first). It writes no operation. In the space's folder
// it makes one run folder, `exchange/planning/<run>/`: the input copy (`input/`), the actions
// export's copy (`actions.json`), `report.json` and `report.md`. It reads the prototype folder only
// to copy it, and never runs or evaluates a file of it.
//
//   folder and options checked → run folder → copy (copyInput, copyActions) → read the copy →
//   parse → plan → the rows of the space the plan meets (one snapshot) → what each task's folder
//   is on this machine → the folders the import gives → the source checked again (verifySource,
//   verifyActions) → report and token → report.json and report.md written
//
// Every error blocks: the report then has no token. A folder that is not there, options that are
// not usable, a prototype folder that holds the space's run folders, and a run folder parent that
// is a link are refused before anything is written.
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AppError,
  PREVIEW_ROWS,
  type ImportPlanningApplyResult,
  type ImportPlanningPreviewResult,
  type ImportPlanningUndoResult,
} from "@tasks/contracts";
import {
  checkMappingOptions,
  comparedPlanning,
  copyActions,
  copyInput,
  decideApply,
  folderDecisionOf,
  hashInputs,
  judgedNames,
  mapPrototype,
  MappingOptionsError,
  parsePrototype,
  placeGroups,
  previewOf,
  previewPinned,
  previewToken,
  readCopy,
  readInput,
  renderPreview,
  sourceIdentity,
  verifyActions,
  verifySource,
  type ApplySpace,
  type BaseField,
  type FolderFact,
  type ImportPlan,
  type InputFile,
  type ItemBase,
  type MappingOptions,
  type MatchedTask,
  type PreviewRun,
  type Problem,
  type ProjectFolderState,
  type RecordedBase,
  type SpaceState,
} from "@tasks/importer-planning";
import {
  formatTaskRef,
  isId,
  newId,
  StorageError,
  type Id,
  type PreviewGuard,
  type Row,
  type SpaceWriterHandle,
  type WorkerConnection,
  type WriteRequest,
  type WriteResult,
} from "@tasks/storage";
import { createFile, makeDir } from "@tasks/files";
import { invalid, resultFailure, storageFailure } from "./errors.ts";
import { checkFolder, osOf, storedForm, type FolderHost } from "./folders.ts";
import {
  readApplyRows,
  readCommitFields,
  readImportCommit,
  readImportOutcome,
  readImportRows,
  type ApplyRows,
  type ImportRows,
} from "./read.ts";

/** The run folders of an import, inside the space's folder (A7 3.15.1). */
export const RUNS_FOLDER = ["exchange", "planning"] as const;

export interface PlanningPreviewCall extends FolderHost {
  /** The space's folder on this machine. */
  readonly folder: string;
  readonly reader: WorkerConnection;
  /** The input after the contract. */
  readonly input: Record<string, unknown>;
  /** The import machine's IANA zone: days are placed in it. */
  readonly timeZone: string;
}

const text = (input: Record<string, unknown>, key: string): string | undefined =>
  typeof input[key] === "string" ? input[key] : undefined;

/** An absolute path the CLI resolved: never one relative to the service's own folder. */
function absolute(value: string, path: string): string {
  if (!isAbsolute(value)) throw invalid(path, "Expected an absolute path");
  return resolve(value);
}

/**
 * What this machine says of each task's folder path, by legacy ID: its stored form when it is a
 * folder here, else why not. Each distinct path is looked at once, each look bounded.
 */
export async function folderFacts(
  plan: ImportPlan,
  host: FolderHost,
): Promise<Map<string, FolderFact>> {
  const looked = new Map<string, FolderFact>();
  const facts = new Map<string, FolderFact>();
  for (const t of plan.tasks) {
    if (t.folder === undefined) continue;
    let fact = looked.get(t.folder.path);
    if (fact === undefined) {
      fact = await folderFact(t.folder.path, host);
      looked.set(t.folder.path, fact);
    }
    facts.set(t.legacyId, fact);
  }
  return facts;
}

async function folderFact(path: string, host: FolderHost): Promise<FolderFact> {
  const form = storedForm(path, host.home, host.platform);
  if (form === "not_absolute") return { state: "other_machine" };
  if (typeof form === "string") return { state: "missing" };
  const problem = await checkFolder(form, {
    home: host.home,
    platform: host.platform,
    reserved: host.reserved,
  });
  if (problem === undefined) return { state: "present", stored: form.stored };
  return { state: problem.reason === "folder_reserved" ? "reserved" : "missing" };
}

/** Whether `to` is `from` or lies under it, by whole path parts. */
function isInside(from: string, to: string): boolean {
  const rel = relative(from, to);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * `<space>/exchange/planning` through the space folder's real path. Each part that is there must
 * be a plain folder, never a link or a junction, so a run folder can only be inside the space.
 * Real paths come from the system's own resolution (`realpathSync.native`), as the copy's do: on
 * Windows it drops a `\\?\` prefix and spells short names and letter case as the disk does, so two
 * spellings of one folder compare equal.
 */
function runsFolder(space: string): string {
  let path = realpathSync.native(space);
  for (const part of RUNS_FOLDER) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new AppError({
        code: "space_unavailable",
        message: "A folder of the space's run folders is a link or no folder.",
        hint: "Make exchange and exchange/planning in the space's folder plain folders, then run the dry run again.",
        data: { reason: "not_served", retryable: false },
      });
    }
  }
  return path;
}

/** A new file with exactly 0600 holding `text`. */
function writeNew(path: string, body: string): void {
  const fd = createFile(path, 0o600);
  try {
    const bytes = Buffer.from(body, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } catch (error) {
    // A cut file would later pass for the whole answer.
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
}

export async function planningPreview(
  call: PlanningPreviewCall,
): Promise<ImportPlanningPreviewResult> {
  const { input } = call;
  const source = absolute(text(input, "folder") ?? "", "folder");
  if (statSync(source, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new AppError({
      code: "not_found",
      message: "No folder is there.",
      hint: "Name the prototype folder: the folder that holds TODO.md and DONE.md.",
    });
  }
  const actionsFile = text(input, "actions");
  const actionsSource = actionsFile === undefined ? undefined : absolute(actionsFile, "actions");
  const checkedAs = text(input, "checked_as");
  const me = text(input, "me");
  const options: MappingOptions = {
    ...(me === undefined ? {} : { me }),
    ...(checkedAs === "review" || checkedAs === "completed" ? { checkedAs } : {}),
    ...(input["include_orphans"] === true ? { includeOrphans: true } : {}),
    timeZone: call.timeZone,
  };
  try {
    checkMappingOptions(options);
  } catch (error) {
    if (error instanceof MappingOptionsError) throw invalid("input", "An option is not usable");
    throw error;
  }

  // The run folder, user-only like the space (A6 3.16.6). A new run never meets an old one. Before
  // anything is written: its parents in the space are plain folders, so the run stays inside the
  // space, and it lies outside the prototype folder, which the run only reads.
  const runs = runsFolder(call.folder);
  if (isInside(realpathSync.native(source), runs)) {
    throw invalid(
      "folder",
      "The space's run folders would be inside this folder",
      "Name the prototype folder itself: the folder that holds TODO.md and DONE.md.",
    );
  }
  makeDir(runs, 0o700, { platform: call.platform });
  const run = newId("ex");
  const folder = join(runs, run);
  makeDir(folder, 0o700, { recursive: false, platform: call.platform });

  const copied = await copyInput(source, join(folder, "input"));
  const problems: Problem[] = [...copied.problems];
  let actions: InputFile | undefined;
  let actionBytes: Buffer | undefined;
  if (actionsSource !== undefined) {
    const copy = await copyActions(actionsSource, join(folder, "actions.json"));
    problems.push(...copy.problems);
    actions = copy.file;
    if (actions !== undefined) actionBytes = await readCopy(join(folder, "actions.json"));
  }
  const read = await readInput(join(folder, "input"));
  problems.push(...read.problems);
  const parse = parsePrototype({
    ...read.input,
    ...(actionBytes === undefined ? {} : { actions: actionBytes }),
  });
  const plan: ImportPlan = mapPrototype(parse, options);

  const rows = await readImportRows(
    call.reader,
    {
      aliases: plan.tasks.map((t) => t.legacyId),
      keys: plan.sources.flatMap((s) => (s.key === undefined ? [] : [s.key])),
      areas: plan.areas.map((a) => a.slug),
    },
    call.machine,
  );
  const space = spaceState(rows);
  const os = osOf(call.platform);
  const folders = folderDecisionOf(plan, space, await folderFacts(plan, call), os);

  // The source again, after everything was read from the copy: it fails closed. What the copy
  // already reported (a file over its bound) is the same state, not a change.
  const verified = [
    ...(copied.files.length === 0 && !copied.ok
      ? []
      : await verifySource(source, copied.files, undefined, copied.problems)),
    ...(actionsSource === undefined || actions === undefined
      ? []
      : await verifyActions(actionsSource, actions)),
  ];

  const preview = previewOf(parse, plan, {
    run,
    folder,
    source: {
      folder: source,
      ...(actionsSource === undefined ? {} : { actions: actionsSource }),
    },
    options,
    folders,
    os,
    inputs: copied.files,
    ...(actions === undefined ? {} : { actions }),
    problems,
    verified,
    space,
  });
  writeNew(join(folder, "report.json"), `${JSON.stringify(preview.report, null, 2)}\n`);
  writeNew(join(folder, "report.md"), renderPreview(preview.report));
  return preview.result;
}

/** The rows the plan meets, as the importer judges them (preview.ts SpaceState). */
function spaceState(rows: ImportRows): SpaceState {
  return {
    id: rows.spaceId,
    epoch: rows.epoch,
    incarnation: rows.incarnation,
    refPrefix: rows.refPrefix,
    nextRef: rows.nextRef,
    aliases: rows.aliases,
    sources: rows.sources,
    areas: rows.areas,
    projects: rows.projects,
    landed: rows.landed,
    projectFolders: rows.projectFolders
      .filter((f) => f.removed === 0)
      .map((f) => ({ project: f.project, title: f.title, path: f.path })),
  };
}

// ---------------------------------------------------------------------------------------------
// import.planning.apply and import.planning.undo (A7 3.15.5, 3.15.6)
//
//   the run's folder and report → a receipt for its request ID? replay → the source checked again
//   (verifySource, verifyActions) → the plan made again from the copy → the task folders looked at
//   again → the space read in one snapshot → the folders the import gives → the token again → the
//   decision (apply.ts) → the request behind a verified barrier backup (the writer recomputes the
//   token inside its transaction) → apply.json in the run folder
//
// Nothing of the space is written before the writer's transaction, and the transaction is the one
// commit: everything, or nothing. A refusal before it changes nothing.

export interface PlanningApplyCall extends FolderHost {
  /** The space's folder on this machine. */
  readonly folder: string;
  readonly reader: WorkerConnection;
  readonly writer: SpaceWriterHandle;
  /** The input after the contract. */
  readonly input: Record<string, unknown>;
  /** The user, who applies it, and the import actor, who writes it. */
  readonly principal: Id<"ac">;
  /** The import actor's ID: it joins the space on its first act, so only when an apply writes. */
  readonly importer: () => Promise<Id<"ac">>;
  readonly scope: string;
  readonly earlierScope?: string;
  readonly machine: Id<"m">;
  /** The machine-local `backup.dir`, when set. */
  readonly backupDir?: string;
  readonly now?: () => number;
}

/** How long an apply may take, its barrier backup and trial restore included. */
export const APPLY_TIMEOUT_MS = 30 * 60_000;

/**
 * How often an apply reads and decides again when the space moved on between its read and its
 * barrier (SPACE_CHANGED, before any backup): the first import's actor registration is one such
 * move, a person's or an agent's write at that moment another.
 */
const APPLY_ATTEMPTS = 5;

/**
 * The writer's request ID of an apply: from the run and the token, so applying twice applies once
 * (A7 3.15.5).
 */
export const applyRequestId = (run: string, token: string): string =>
  `ip_${run.slice(3)}_${token.slice(4, 24)}`;

/** The writer's request ID of an undo: from the run, so undoing twice undoes once. */
export const undoRequestId = (run: string): string => `iu_${run.slice(3)}`;

/** The run's report: what the apply needs of it. */
interface RunReport {
  readonly token?: string;
  readonly blocked: boolean;
  readonly source: { readonly folder: string; readonly actions?: string };
  readonly options: {
    readonly me?: string;
    readonly checked_as: "completed" | "review";
    readonly include_orphans: boolean;
  };
  readonly time_zone: string;
}

/** The largest report.json an apply reads: a report of the input bounds' size (A7 3.15.2). */
const REPORT_MAX_BYTES = 512 * 1024 * 1024;

const notFound = (): AppError =>
  new AppError({
    code: "not_found",
    message: "No dry run has this run ID in this space.",
    hint: "Run the dry run: tasks import planning <folder> --dry-run.",
  });

/** A space that changed since the dry run, or a prototype folder that did. */
const stale = (what: string): AppError =>
  new AppError({
    code: "conflict",
    message: `${what} changed since the dry run, so nothing was applied.`,
    hint: "Run the dry run again, check its report, and apply its new token.",
    data: { cause: "PREVIEW_STALE" },
  });

/** The run's folder in the space: a plain folder, never a link (runsFolder). */
function runFolderOf(space: string, run: string): string {
  const folder = join(runsFolder(space), run);
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) throw notFound();
  return folder;
}

function readReport(folder: string): RunReport {
  const path = join(folder, "report.json");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) throw notFound();
  if (stat.size > REPORT_MAX_BYTES) throw invalid("run", "The run's report is over its limit");
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw invalid("run", "The run's report does not read");
  }
  const r = report as Partial<RunReport> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    typeof r.blocked !== "boolean" ||
    typeof r.time_zone !== "string" ||
    typeof r.source?.folder !== "string" ||
    typeof r.options !== "object"
  ) {
    throw invalid("run", "The run's report does not read");
  }
  return r as RunReport;
}

/** The mapping's options as the dry run made its plan: its report holds them. */
function optionsOf(report: RunReport): MappingOptions {
  const o = report.options;
  return {
    ...(o.me === undefined ? {} : { me: o.me }),
    ...(o.checked_as === "review" ? { checkedAs: "review" as const } : {}),
    ...(o.include_orphans ? { includeOrphans: true } : {}),
    timeZone: report.time_zone,
  };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The run's plan made again from its copy, after the source is checked again (A7 3.15.5). */
async function planAgain(
  folder: string,
  report: RunReport,
  options: MappingOptions,
): Promise<{ plan: ImportPlan; inputs: InputFile[]; actions?: InputFile }> {
  const input = join(folder, "input");
  const hashed = await hashInputs(input);
  const problems: Problem[] = [...hashed.problems];
  problems.push(
    ...(await verifySource(report.source.folder, hashed.files, undefined, hashed.problems)),
  );
  let actions: InputFile | undefined;
  let actionBytes: Buffer | undefined;
  if (report.source.actions !== undefined) {
    actionBytes = await readCopy(join(folder, "actions.json"));
    actions = { path: "actions.json", size: actionBytes.length, sha256: sha256(actionBytes) };
    problems.push(...(await verifyActions(report.source.actions, actions)));
  }
  const read = await readInput(input);
  const parse = parsePrototype({
    ...read.input,
    ...(actionBytes === undefined ? {} : { actions: actionBytes }),
  });
  const plan = mapPrototype(parse, options);
  const all = [...problems, ...read.problems, ...parse.problems, ...plan.problems];
  if (all.some((p) => p.severity === "error")) throw stale("The prototype folder");
  return { plan, inputs: hashed.files, ...(actions === undefined ? {} : { actions }) };
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A row's version map, `fv`. */
function versions(row: Row): Record<string, number> {
  try {
    const map: unknown = JSON.parse(textOf(row["fv"]) ?? "{}");
    return typeof map === "object" && map !== null ? (map as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The task fields of BASE_FIELDS: each a logical field of A1 3.4 with its version in `fv`. */
const TASK_BASE_FIELDS: readonly BaseField[] = [
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
];

/** What an undo's change rows set back, as the fields of BASE_FIELDS and `sources`. */
function voidedField(entity: string, field: string | null): string | undefined {
  if (entity === "tasks") return field ?? undefined;
  if (entity === "task_sources") return "sources";
  if (entity === "folders") return "folder";
  if (entity === "log_entries") return "evidence";
  return undefined;
}

/** A recorded base of the importer's own shape; another exchange's item gives none. */
function itemBase(text: unknown): ItemBase | undefined {
  try {
    const base = JSON.parse(String(text)) as Partial<ItemBase> | null;
    if (base?.v !== 1 || base.import !== "planning" || typeof base.fields !== "object") {
      return undefined;
    }
    return {
      v: 1,
      import: "planning",
      fields: base.fields ?? {},
      sources: Array.isArray(base.sources) ? base.sources.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return undefined;
  }
}

/** The tasks that hold the plan's legacy IDs, as the apply's decision reads them (apply.ts). */
function matchedOf(apply: ApplyRows, refPrefix: string, machine: string): Map<string, MatchedTask> {
  const byTask = <T>(rows: Row[], map: (row: Row) => T): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const row of rows) {
      const key = String(row["task"]);
      const list = out.get(key);
      if (list === undefined) out.set(key, [map(row)]);
      else list.push(map(row));
    }
    return out;
  };
  const folders = byTask(apply.folders, (r) => r);
  const links = byTask(apply.links, (r) =>
    sourceIdentity({
      ...(typeof r["key"] === "string" ? { key: r["key"] } : {}),
      url: textOf(r["url"]) ?? "",
    }),
  );
  const undone = new Map<string, Set<string>>();
  for (const row of apply.undone) {
    const key = `${String(row["seq"])}|${String(row["task"])}`;
    const field = voidedField(String(row["entity"]), textOf(row["field"]));
    if (field === undefined) continue;
    const set = undone.get(key) ?? new Set<string>();
    set.add(field);
    undone.set(key, set);
  }
  const bases = byTask(apply.bases, (r) => r);
  const matched = new Map<string, MatchedTask>();
  for (const row of apply.tasks) {
    const id = String(row["id"]);
    const created = num(row["created_seq"]);
    const fv = versions(row);
    const deleted = row["deleted_at"] !== null;
    const undoneCreate =
      deleted &&
      (row["deleted_kind"] === "revert" || row["deleted_kind"] === "undo") &&
      row["deleted_of"] === row["created_commit"];
    let planning: Record<string, unknown> | null = null;
    try {
      const ext = JSON.parse(textOf(row["ext"]) ?? "{}") as Record<string, unknown>;
      const value = ext["planning"];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        planning = value as Record<string, unknown>;
      }
    } catch {
      planning = null;
    }
    const own = folders.get(id) ?? [];
    const live = own.find((f) => f["deleted_at"] === null);
    // A folder row's version covers its path and its removal: a folder cleared and then brought
    // back (an undo of the clear) holds the same path, but it changed since. Without a live one,
    // the newest removal here; 0 when it never had a folder here.
    const folderVersion =
      live !== undefined ? num(live["version"]) : Math.max(0, ...own.map((f) => num(f["version"])));
    const values: Record<string, unknown> = {
      title: row["title"],
      summary: row["summary"],
      context: row["context"],
      status: row["status"],
      priority: row["priority"],
      owner: row["owner"] ?? null,
      waiting_on: row["waiting_on"] ?? null,
      source_at: row["source_at"] ?? null,
      reviewed_at: row["reviewed_at"] ?? null,
      due:
        row["due_at"] !== null && row["due_at"] !== undefined
          ? { at: row["due_at"], tz: row["due_tz"] }
          : (row["due_date"] ?? null),
      focus: row["focus_on"] ?? null,
      grouping: { area: row["area_slug"] ?? null, project: row["project_slug"] ?? null },
      lifecycle: row["lifecycle"],
      wrap: row["wrap_state"] === "wrapped" ? (row["outcome"] ?? null) : null,
      "ext.planning": comparedPlanning(planning),
      folder: { machine, path: live === undefined ? null : String(live["path"]) },
      evidence: null,
    };
    const fieldVersions: Record<string, number> = { folder: folderVersion, evidence: 0 };
    for (const field of TASK_BASE_FIELDS) fieldVersions[field] = fv[field] ?? created;
    const recorded: RecordedBase[] = [];
    for (const b of bases.get(id) ?? []) {
      const base = itemBase(b["base"]);
      if (base === undefined) continue;
      const by = b["undone"];
      const voided =
        typeof by === "number"
          ? (undone.get(`${String(by)}|${id}`) ?? new Set<string>())
          : new Set<string>();
      recorded.push({ seq: num(b["seq"]), base, voided });
    }
    matched.set(String(row["alias"]), {
      id,
      ref: formatTaskRef(refPrefix, num(row["ref"])),
      state: !deleted ? "live" : undoneCreate ? "undone" : "deleted",
      values: values as MatchedTask["values"],
      versions: fieldVersions as MatchedTask["versions"],
      sources: new Set(links.get(id) ?? []),
      planning,
      bases: recorded,
    });
  }
  return matched;
}

/**
 * Each live project's folder on this machine as the apply's decision reads it: its live folder,
 * the version of its newest folder change here, and the newest base an import that stands
 * recorded for it here.
 */
function projectFoldersOf(rows: ImportRows, apply: ApplyRows): Map<string, ProjectFolderState> {
  const out = new Map<string, { path: string | null; version: number; base?: ProjectBase }>();
  for (const f of rows.projectFolders) {
    const known = out.get(f.project) ?? { path: null, version: 0 };
    out.set(f.project, {
      ...known,
      path: f.removed === 0 ? f.path : known.path,
      version: Math.max(known.version, f.version),
    });
  }
  for (const b of apply.projectBases) {
    const project = textOf(b["project"]);
    if (project === null) continue;
    const seq = num(b["seq"]);
    const known = out.get(project) ?? { path: null, version: 0 };
    if (known.base !== undefined && known.base.seq >= seq) continue;
    out.set(project, { ...known, base: { folder: textOf(b["folder"]), seq } });
  }
  return out;
}

interface ProjectBase {
  readonly folder: string | null;
  readonly seq: number;
}

/** Each planned project's title as the space shows it: a project the import reuses keeps its own. */
function projectTitlesOf(plan: ImportPlan, state: SpaceState): Map<string, string> {
  const { projects } = placeGroups(plan, state);
  const live = new Map(state.projects.map((p) => [p.id, p.title]));
  return new Map(
    plan.projects.map((p) => {
      const reuses = projects.get(p.slug)?.reuses;
      return [p.slug, (reuses === undefined ? undefined : live.get(reuses)) ?? p.title];
    }),
  );
}

/**
 * One row per task of an apply's result, and the counts: every row, conflicts first, so a cut
 * answer (capped) never drops a conflict before a task that only changed.
 */
function applyResult(
  run: string,
  decision: ReturnType<typeof decideApply>,
  refs: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): Omit<ImportPlanningApplyResult, "status" | "as_of"> {
  const rows = decision.tasks.map((t) => {
    const ref = t.ref ?? (t.task === undefined ? undefined : refs.get(t.task));
    return {
      legacy_id: t.legacyId,
      ...(ref === undefined ? {} : { ref }),
      outcome: t.outcome,
      ...(t.changed.length === 0 ? {} : { changed: [...t.changed] }),
      ...(t.conflicts.length === 0 ? {} : { conflicts: [...t.conflicts] }),
    };
  });
  const listed = [
    ...rows.filter((r) => r.conflicts !== undefined),
    ...rows.filter((r) => r.conflicts === undefined && r.outcome !== "unchanged"),
  ];
  return {
    run,
    counts: {
      created: rows.filter((r) => r.outcome === "created").length,
      updated: rows.filter((r) => r.outcome === "updated").length,
      unchanged: rows.filter((r) => r.outcome === "unchanged").length,
      deleted: rows.filter((r) => r.outcome === "deleted").length,
      conflicts: rows.filter((r) => r.conflicts !== undefined).length,
      gone: decision.gone.length,
    },
    tasks: listed,
    tasks_more: 0,
    ...(decision.projects.length === 0
      ? {}
      : {
          projects: decision.projects.map((p) => ({
            project: titles.get(p.slug) ?? p.slug,
            outcome: p.outcome,
          })),
        }),
    gone: [...decision.gone],
  };
}

/**
 * The answer as the entry returns it: at most PREVIEW_ROWS tasks and gone IDs. The run's
 * apply.json keeps every one (A7 3.15.5).
 */
function capped<T extends Omit<ImportPlanningApplyResult, "status" | "as_of">>(full: T): T {
  return {
    ...full,
    tasks: full.tasks.slice(0, PREVIEW_ROWS),
    tasks_more: full.tasks_more + Math.max(0, full.tasks.length - PREVIEW_ROWS),
    ...(full.projects === undefined ? {} : { projects: full.projects.slice(0, PREVIEW_ROWS) }),
    gone: full.gone.slice(0, PREVIEW_ROWS),
  };
}

/** The answer of an apply this request ID decided before: its run's apply.json, when written. */
function replayOf(folder: string, result: WriteResult): ImportPlanningApplyResult | undefined {
  if (result.status !== "applied") return undefined;
  try {
    const stored = JSON.parse(
      readFileSync(join(folder, "apply.json"), "utf8"),
    ) as ImportPlanningApplyResult;
    return { ...capped(stored), replayed: true };
  } catch {
    return undefined;
  }
}

/**
 * A replay's answer when the run's apply.json is gone (a crash between the commit and the file, or
 * no room for it): what the commit did to each task of its exchange, read from the space, marked
 * `incomplete`, because which fields conflicted is in no record. They stay conflicts, so the next
 * dry run and apply list them again (A7 3.15.6).
 */
async function replayFromSpace(
  reader: WorkerConnection,
  run: string,
  result: WriteResult,
): Promise<ImportPlanningApplyResult> {
  let outcome: Awaited<ReturnType<typeof readImportOutcome>>;
  try {
    outcome = await readImportOutcome(reader, run);
  } catch (error) {
    throw storageFailure(error);
  }
  const count = (o: string) => outcome.filter((t) => t.outcome === o).length;
  const listed = outcome
    .filter((t) => t.outcome !== "unchanged")
    .map((t) => ({ legacy_id: t.legacy, ref: t.ref, outcome: t.outcome }));
  return {
    ...capped({
      run,
      counts: {
        created: count("created"),
        updated: count("updated"),
        unchanged: count("unchanged"),
        deleted: 0,
        conflicts: 0,
        gone: 0,
      },
      tasks: listed,
      tasks_more: 0,
      gone: [],
    }),
    status: "applied",
    ...(result.commit === undefined ? {} : { commit: result.commit }),
    as_of: result.as_of,
    replayed: true,
    incomplete: true,
  };
}

export async function planningApply(call: PlanningApplyCall): Promise<ImportPlanningApplyResult> {
  const run = String(call.input["run"]);
  const token = String(call.input["token"]);
  const folder = runFolderOf(call.folder, run);
  const requestId = applyRequestId(run, token);
  // A retry of an apply that was decided answers as it did: applying twice applies once.
  const receipt = await call.writer.receipt({
    scope_id: call.scope,
    ...(call.earlierScope === undefined ? {} : { earlier_scope_id: call.earlierScope }),
    request_id: requestId,
  });
  if (receipt !== undefined) {
    if (receipt.result.status !== "applied") throw resultFailure(receipt.result, HINTS);
    // An apply that was undone since is not applied again by its retry: a new dry run imports anew.
    let commit: Awaited<ReturnType<typeof readImportCommit>>;
    try {
      commit = await readImportCommit(call.reader, run);
    } catch (error) {
      throw storageFailure(error);
    }
    if (commit?.undone === true) {
      throw new AppError({
        code: "conflict",
        message: "This run was applied and then undone, so applying it again changes nothing.",
        hint: "Run the dry run again and apply its new token to import anew.",
        data: { cause: "INVALID_TRANSITION" },
      });
    }
    return (
      replayOf(folder, receipt.result) ?? (await replayFromSpace(call.reader, run, receipt.result))
    );
  }
  const report = readReport(folder);
  if (report.blocked || report.token === undefined) {
    throw invalid(
      "run",
      "The dry run was blocked",
      "Fix what it lists, then run the dry run again.",
    );
  }
  if (report.token !== token) {
    throw invalid("token", "The token is not this run's", "Use the token its dry run printed.");
  }
  const options = optionsOf(report);
  const { plan, inputs, actions } = await planAgain(folder, report, options);
  // The folders as they are on this machine now: one that came or went since the dry run gives
  // other folders, and the token tells.
  const facts = await folderFacts(plan, call);
  const os = osOf(call.platform);

  const names = judgedNames(plan, { areas: [], projects: [] });
  const ids = new Map<string, string>();
  const groupIds = new Map<string, string>();
  const now = (call.now ?? Date.now)();
  // The decision is made on one read, and the barrier serves it only while the space still stands
  // there: a write that came between (an edit in another window, an agent's change) makes it read
  // and decide again, before any backup. The first import that writes registers the import actor,
  // which is such a write.
  let decision: ReturnType<typeof decideApply> | undefined;
  let titles = new Map<string, string>();
  let submitted: { result: WriteResult; backup?: { name: string } } | undefined;
  for (let attempt = 1; submitted === undefined; attempt += 1) {
    const { rows, apply } = await readApplyRows(
      call.reader,
      { aliases: names.aliases, keys: names.keys, areas: names.areas },
      call.machine,
    );
    const state = spaceState(rows);
    const folders = folderDecisionOf(plan, state, facts, os);
    const previewRun: PreviewRun = {
      run,
      folder,
      source: report.source,
      options,
      folders,
      os,
      inputs,
      ...(actions === undefined ? {} : { actions }),
      problems: [],
      verified: [],
      space: state,
    };
    if (previewToken(plan, previewRun) !== token) {
      throw stale("The space, the prototype folder or a folder it names");
    }

    const planned = new Set(plan.tasks.map((t) => t.legacyId));
    const space: ApplySpace = {
      state,
      matched: matchedOf(apply, rows.refPrefix, call.machine),
      gone: apply.aliases.map((r) => String(r["alias"])).filter((a) => !planned.has(a)),
      projectFolders: projectFoldersOf(rows, apply),
    };
    titles = projectTitlesOf(plan, state);
    decision = decideApply(plan, space, {
      machine: call.machine,
      folders,
      exchange: run,
      dir: [...RUNS_FOLDER, run, "input"].join("/"),
      idOf: (legacy) => {
        const id = ids.get(legacy) ?? newId("t");
        ids.set(legacy, id);
        return id;
      },
      groupIdOf: (kind, key) => {
        const id = groupIds.get(`${kind}|${key}`) ?? newId(kind === "area" ? "a" : "p");
        groupIds.set(`${kind}|${key}`, id);
        return id;
      },
      importedAt: now,
    });
    if (decision.ops.length === 0) {
      return {
        ...capped(applyResult(run, decision, new Map(), titles)),
        status: "unchanged",
        as_of: rows.asOf,
      };
    }

    // The import actor joins the space on the first import that writes (A1 3.6, 3.21).
    let importer: Id<"ac">;
    try {
      importer = await call.importer();
    } catch (error) {
      throw storageFailure(error);
    }
    const request: WriteRequest = {
      space_id: call.writer.spaceId,
      request_id: requestId,
      actor: {
        scope_id: call.scope,
        ...(call.earlierScope === undefined ? {} : { earlier_scope_id: call.earlierScope }),
        principal_id: call.principal,
        actor_kind: "human",
        author_id: importer,
        machine_id: call.machine,
        origin: "import",
      },
      // The caller's base when it gave one (stricter: a field changed after it conflicts), else
      // the state this apply read and decided on.
      base: typeof call.input["base"] === "string" ? call.input["base"] : rows.asOf,
      preview: {
        token,
        pinned: previewPinned(plan, previewRun) as PreviewGuard["pinned"],
        ...judgedNames(plan, state),
      },
      ops: decision.ops as unknown as WriteRequest["ops"],
    };
    try {
      submitted = await call.writer.importSubmit(request, {
        ...(call.backupDir === undefined ? {} : { backupDir: call.backupDir }),
        expect: { seq: rows.seq, incarnation: rows.incarnation },
        timeoutMs: APPLY_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof StorageError && error.code === "SPACE_CHANGED")) {
        throw storageFailure(error);
      }
      if (attempt >= APPLY_ATTEMPTS) {
        throw new AppError({
          code: "conflict",
          message: "The space kept changing while the import was decided, so nothing was applied.",
          hint: "Apply it again when the space is quieter: the same command, the same token.",
          data: { cause: "SPACE_CHANGED" },
        });
      }
    }
  }
  const { result } = submitted;
  if (decision === undefined) throw new AppError({ code: "internal", message: "No decision." });
  if (result.status === "conflict" || result.status === "rejected") {
    throw resultFailure(result, HINTS);
  }
  if (result.replayed === true) {
    const replayed = replayOf(folder, result);
    if (replayed !== undefined) return replayed;
  }
  const refs = new Map<string, string>();
  for (const r of result.results) {
    if (r.task !== undefined && r.ref !== undefined) refs.set(r.task, r.ref);
  }
  const answer: ImportPlanningApplyResult = {
    ...applyResult(run, decision, refs, titles),
    status: result.status === "applied" ? "applied" : "unchanged",
    ...(result.commit === undefined ? {} : { commit: result.commit }),
    ...(submitted.backup === undefined ? {} : { backup: submitted.backup.name }),
    as_of: result.as_of,
  };
  // The whole answer beside the run's report, every task and gone ID, for the person and for a
  // retry's replay; the entry returns the first 2,000. The commit stands whether or not this file
  // can be written.
  try {
    writeNew(join(folder, "apply.json"), `${JSON.stringify(answer, null, 2)}\n`);
  } catch {
    // A file there already, or no room: the answer still goes back.
  }
  return capped(answer);
}

/** The hints of an apply's and an undo's refusals. */
const HINTS: Readonly<Record<string, string>> = {
  PREVIEW_STALE: "Run the dry run again, check its report, and apply its new token.",
  VERSION_CONFLICT: "The space changed while it applied: run the dry run again.",
  INVALID_TRANSITION: "This import is undone already: nothing more to undo.",
};

export interface PlanningUndoCall {
  /** The space's folder on this machine: the run's undo.json goes beside its report. */
  readonly folder?: string;
  readonly reader: WorkerConnection;
  readonly writer: SpaceWriterHandle;
  readonly input: Record<string, unknown>;
  readonly principal: Id<"ac">;
  readonly scope: string;
  readonly earlierScope?: string;
  readonly machine: Id<"m">;
  readonly origin: WriteRequest["actor"]["origin"];
  readonly refPrefix?: string;
}

/**
 * Undoes the import a run applied (A7 3.15.5): its commit reverted, partially, as one commit. A
 * task someone changed since stays as it is and is listed with what was changed.
 */
export async function planningUndo(call: PlanningUndoCall): Promise<ImportPlanningUndoResult> {
  const run = String(call.input["run"]);
  let commit: { id: string; seq: number } | undefined;
  try {
    commit = await readImportCommit(call.reader, run);
  } catch (error) {
    throw storageFailure(error);
  }
  if (commit === undefined || !isId(commit.id, "op")) {
    throw new AppError({
      code: "not_found",
      message: "This run was not applied in this space.",
      hint: "Name the run an apply printed.",
    });
  }
  const request: WriteRequest = {
    space_id: call.writer.spaceId,
    request_id: undoRequestId(run),
    actor: {
      scope_id: call.scope,
      ...(call.earlierScope === undefined ? {} : { earlier_scope_id: call.earlierScope }),
      principal_id: call.principal,
      actor_kind: "human",
      machine_id: call.machine,
      origin: call.origin,
    },
    ops: [{ kind: "import.undo", commit: commit.id }],
  };
  let result: WriteResult;
  try {
    result = await call.writer.submit(request, { timeoutMs: APPLY_TIMEOUT_MS });
  } catch (error) {
    throw storageFailure(error);
  }
  if (result.status === "conflict" || result.status === "rejected") {
    throw resultFailure(result, HINTS);
  }
  const changed = await readCommitFields(call.reader, result.seq);
  // A task removed is one whose own tombstone the undo set; any other task it changed, in a field
  // or a row of it (an evidence entry, a link, a place), is set back.
  const removed = new Set(
    changed.filter((c) => c.entity === "tasks" && c.field === "deleted").map((c) => c.task),
  );
  const restored = new Set(changed.filter((c) => !removed.has(c.task)).map((c) => c.task));
  const kept = new Map<string, Set<string>>();
  for (const c of result.conflicts) {
    if (c.ref === undefined) continue;
    const fields = kept.get(c.ref) ?? new Set<string>();
    fields.add(c.entity === "tasks" ? c.field : c.entity);
    kept.set(c.ref, fields);
  }
  const list = [...kept].map(([task, fields]) => ({ task, fields: [...fields] }));
  const answer: ImportPlanningUndoResult = {
    run,
    commit: must(result.commit),
    undone: commit.id,
    removed: removed.size,
    restored: restored.size,
    kept: list,
    kept_more: 0,
    as_of: result.as_of,
    ...(result.replayed === true ? { replayed: true } : {}),
  };
  // Every kept task beside the run's report, as apply.json holds every task of the apply; the
  // entry returns the first 2,000. The undo stands whether or not this file can be written, and
  // the answer says when it could not.
  let saved = false;
  if (call.folder !== undefined) {
    try {
      const file = join(runFolderOf(call.folder, run), "undo.json");
      writeNew(file, `${JSON.stringify(answer, null, 2)}\n`);
      saved = true;
    } catch (error) {
      // A file there already is this run's earlier undo, the same answer.
      saved = (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
    }
  }
  return {
    ...answer,
    kept: list.slice(0, PREVIEW_ROWS),
    kept_more: Math.max(0, list.length - PREVIEW_ROWS),
    ...(saved ? {} : { unsaved: true as const }),
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new AppError({ code: "internal", message: "A result is missing." });
  }
  return value;
}
