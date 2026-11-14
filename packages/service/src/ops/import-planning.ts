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
// Every error blocks: the report then has no token. A folder that is not there, or options that
// are not usable, are refused before anything is written.
import { closeSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AppError, type ImportPlanningPreviewResult } from "@tasks/contracts";
import {
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

  // The run folder, user-only like the space (A6 3.16.6). A new run never meets an old one.
  const runs = join(call.folder, ...RUNS_FOLDER);
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
  let plan: ImportPlan;
  try {
    plan = mapPrototype(parse, options);
  } catch (error) {
    if (error instanceof MappingOptionsError) throw invalid("input", "An option is not usable");
    throw error;
  }

  const rows = await readImportRows(call.reader, {
    aliases: plan.tasks.map((t) => t.legacyId),
    keys: plan.sources.flatMap((s) => (s.key === undefined ? [] : [s.key])),
    areas: plan.areas.map((a) => a.slug),
    projects: plan.projects.map((p) => p.slug),
  });

  // Which places resolve here: through the launch package's own resolution, as Open would.
  const rootFolders = roots.map((r) => ({ id: r.id, path: r.folder }));
  const missing = new Set<string>();
  for (const t of plan.tasks) {
    if (t.place === undefined) continue;
    const found = await resolvePlace(t.place, rootFolders, { platform: call.platform });
    if (found.status !== "ok") missing.add(t.legacyId);
  }

  // The source again, after everything was read from the copy: it fails closed.
  const verified = [
    ...(copied.files.length === 0 && !copied.ok ? [] : await verifySource(source, copied.files)),
    ...(actionsSource === undefined || actions === undefined
      ? []
      : await verifyActions(actionsSource, actions)),
  ];

  const preview = previewOf(parse, plan, {
    run,
    folder,
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
