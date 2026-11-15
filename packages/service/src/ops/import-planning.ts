// import.planning.preview (A7 3.15.4): the dry run of the Planning prototype import, for the user
// only (op/call's gate refuses every other class first). It writes no operation. In the space's
// folder it makes one run folder, `exchange/planning/<run>/`, which A7 3.15.1 allows: the input
// copy (`input/`), the actions export's copy (`actions.json`), `report.json` and `report.md`. It
// reads the prototype folder only to copy it, and never runs or evaluates a file of it.
//
//   folder and options checked → run folder → copy (copyInput, copyActions) → read the copy →
//   parse → plan → the rows of the space the plan meets (one snapshot) → which places resolve on
//   this machine → the source checked again (verifySource, verifyActions) → report and token →
//   report.json and report.md written
//
// Every error blocks: the report then has no token. A folder that is not there, options that are
// not usable, a prototype folder that holds the space's run folders, and a run folder parent that
// is a link are refused before anything is written.
import { closeSync, lstatSync, realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError, type ImportPlanningPreviewResult } from "@tasks/contracts";
import {
  checkMappingOptions,
  copyActions,
  copyInput,
  mapPrototype,
  MappingOptionsError,
  parsePrototype,
  previewOf,
  readCopy,
  readInput,
  renderPreview,
  ROOT_ID,
  verifyActions,
  verifySource,
  type ImportPlan,
  type InputFile,
  type MappingOptions,
  type PreviewRoot,
  type Problem,
} from "@tasks/importer-planning";
import { resolvePlace, type Root } from "@tasks/launch";
import { newId, type WorkerConnection } from "@tasks/storage";
import { createFile, makeDir } from "@tasks/files";
import { invalid } from "./errors.ts";
import { readImportRows } from "./read.ts";

/** The run folders of an import, inside the space's folder (A7 3.15.1). */
export const RUNS_FOLDER = ["exchange", "planning"] as const;

export interface PlanningPreviewCall {
  /** The space's folder on this machine. */
  readonly folder: string;
  readonly reader: WorkerConnection;
  /** The input after the contract. */
  readonly input: Record<string, unknown>;
  /** This machine's roots (machine.toml). */
  readonly roots: readonly Root[];
  readonly platform: NodeJS.Platform;
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

const same = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The roots the mapping uses: this machine's, and the given ones, which may not rename a root. */
function rootsOf(call: PlanningPreviewCall): PreviewRoot[] {
  const out: PreviewRoot[] = call.roots.map((r) => ({
    id: r.id,
    folder: r.path,
    origin: "machine",
  }));
  const given = (call.input["roots"] ?? []) as { id: string; folder: string }[];
  for (const [i, r] of given.entries()) {
    if (!ROOT_ID.test(r.id)) throw invalid(`roots.${String(i)}.id`, "Not a root ID");
    const folder = absolute(r.folder, `roots.${String(i)}.folder`);
    const known = out.find((o) => o.id === r.id);
    if (known === undefined) out.push({ id: r.id, folder, origin: "given" });
    else if (!same(resolve(known.folder), folder, call.platform)) {
      throw invalid(
        `roots.${String(i)}.id`,
        "This machine has a root with that ID in another folder",
        "Use another ID, or leave the root out: this machine's own roots are used.",
      );
    }
  }
  return out;
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
  } finally {
    closeSync(fd);
  }
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
  const roots = rootsOf(call);
  const checkedAs = text(input, "checked_as");
  const me = text(input, "me");
  const options: MappingOptions = {
    ...(me === undefined ? {} : { me }),
    roots: Object.fromEntries(roots.map((r) => [r.id, r.folder])),
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

  const rows = await readImportRows(call.reader, {
    aliases: plan.tasks.map((t) => t.legacyId),
    keys: plan.sources.flatMap((s) => (s.key === undefined ? [] : [s.key])),
    areas: plan.areas.map((a) => a.slug),
  });

  // Which places resolve here: through the launch package's own resolution, as Open would.
  const rootFolders = roots.map((r) => ({ id: r.id, path: r.folder }));
  const missing = new Set<string>();
  for (const t of plan.tasks) {
    if (t.place === undefined) continue;
    const found = await resolvePlace(t.place, rootFolders, { platform: call.platform });
    if (found.status !== "ok") missing.add(t.legacyId);
  }

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
    roots,
    inputs: copied.files,
    ...(actions === undefined ? {} : { actions }),
    problems,
    verified,
    space: {
      id: rows.spaceId,
      epoch: rows.epoch,
      incarnation: rows.incarnation,
      refPrefix: rows.refPrefix,
      nextRef: rows.nextRef,
      aliases: rows.aliases,
      sources: rows.sources,
      areas: rows.areas,
      projects: rows.projects,
    },
    missing,
  });
  writeNew(join(folder, "report.json"), `${JSON.stringify(preview.report, null, 2)}\n`);
  writeNew(join(folder, "report.md"), renderPreview(preview.report));
  return preview.result;
}
