// `tasks import planning` (A7 3.15.4): the import of the Planning prototype, through the service's
// user-only entries `import.planning.*` (A3 3.2.3). This build has the dry run:
//
//   tasks import planning <folder> --dry-run [--me <name>] [--roots <id>=<folder>[,...]]
//         [--actions <export.json>] [--checked-as completed|review] [--include-orphans]
//         [--space <space>] [--json]
//
// The CLI resolves every folder and file against its working folder and sends it absolute. The
// service copies the prototype's inputs into a run folder in the space, writes report.md and
// report.json there, and answers with the report and, when nothing blocks, a preview token: a hash
// of what the apply depends on, no secret. Only the user runs it, in an interactive terminal.
import { isAbsolute, resolve } from "node:path";
import type { ImportPlanningPreviewResult } from "@tasks/contracts";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage, str } from "./output.ts";
import { asAppError, opCall } from "./verbs.ts";

/** `tasks import --help` and `tasks help import`. */
export const IMPORT_HELP = `Usage: tasks import planning <folder> --dry-run [options] [--space <space>] [--json]

Previews the import of the Planning prototype's folder into a space. Nothing is written to the
space: the run's folder in it holds a copy of the inputs, report.md and report.json.

  --me <name>                      The owner name that is you: those tasks get no owner
  --roots <id>=<folder>[,...]      Roots for the task folders, beside this machine's own
  --actions <file>                 The page's actions export (planning-actions-<date>.json)
  --checked-as completed|review    A checked task: completed (default) or kept in Review
  --include-orphans                Create metadata entries without a task line, in Backlog

The report ends with a preview token unless an error blocks it: fix the errors in the prototype
folder and run the dry run again. Only the user can run this, in an interactive terminal.
`;

const ROOT = /^([a-z0-9][a-z0-9_-]{0,31})=(.+)$/s;
/** A comma that starts the next `<id>=` of a --roots list: a folder may hold commas. */
const NEXT_ROOT = /,(?=[a-z0-9][a-z0-9_-]{0,31}=)/;

interface Parsed {
  readonly input: Record<string, unknown>;
}

function parse(io: Io, args: readonly string[]): Parsed {
  const at = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(io.cwd, p));
  const positional: string[] = [];
  let dryRun = false;
  let me: string | undefined;
  let actions: string | undefined;
  let checkedAs: string | undefined;
  let orphans = false;
  const roots: { id: string; folder: string }[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    const [flag, inline] =
      token.startsWith("--") && token.includes("=")
        ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
        : [token, undefined];
    const value = (): string => {
      const v = inline ?? args[(i += 1)];
      if (v === undefined || v === "") throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--me":
        me = value();
        break;
      case "--actions":
        actions = at(value());
        break;
      case "--checked-as":
        checkedAs = value();
        if (checkedAs !== "completed" && checkedAs !== "review") {
          throw new UsageError("--checked-as is completed or review");
        }
        break;
      case "--include-orphans":
        orphans = true;
        break;
      case "--roots":
        for (const part of value().split(NEXT_ROOT)) {
          const m = ROOT.exec(part);
          if (m === null) throw new UsageError("--roots takes <id>=<folder>, comma-separated");
          roots.push({ id: m[1] ?? "", folder: at(m[2] ?? "") });
        }
        break;
      case "--apply":
      case "--undo":
      case "--token":
        throw new UsageError(`tasks import planning ${flag} is not in this build yet`);
      default:
        if (token.startsWith("--")) {
          throw new UsageError(
            `tasks import planning has no option ${/^--[a-z-]{1,30}$/.test(flag) ? flag : "like that"}`,
          );
        }
        positional.push(token);
    }
  }
  const [folder] = positional;
  if (folder === undefined || positional.length > 1) {
    throw new UsageError("tasks import planning takes one folder: the prototype's");
  }
  if (!dryRun) throw new UsageError("tasks import planning needs --dry-run in this build");
  return {
    input: {
      folder: at(folder),
      ...(me === undefined ? {} : { me }),
      ...(roots.length === 0 ? {} : { roots }),
      ...(actions === undefined ? {} : { actions }),
      ...(checkedAs === undefined ? {} : { checked_as: checkedAs }),
      ...(orphans ? { include_orphans: true } : {}),
    },
  };
}

/** The report's summary for a person. Its values only: the whole report is in report.md. */
function summary(r: ImportPlanningPreviewResult): string {
  const c = r.counts;
  const lines: string[] = [];
  const add = (text = "") => lines.push(text);
  add("Dry run of the Planning prototype import: nothing was written to the space.");
  add(`Run ${r.run}. Report: ${str(r.folder)}`);
  add();
  add(
    `Task lines: ${String(c.todo_task_lines)} in TODO.md, ${String(c.done_task_lines)} in DONE.md. ` +
      `Metadata entries: ${String(c.metadata_entries)}, ${String(c.metadata_orphans)} without a task line.`,
  );
  add(
    `Tasks to create: ${String(c.tasks)} (${String(c.active)} active, ${String(c.completed)} completed), ` +
      `${String(c.aliases)} aliases. ${r.reconciled ? "Every task line is accounted for." : "The counts do not reconcile."}`,
  );
  add(
    `Areas ${String(c.areas)} (${String(c.areas_existing)} in the space), projects ${String(c.projects)} ` +
      `(${String(c.projects_existing)}), sources ${String(c.sources)} (${String(c.sources_existing)}), ` +
      `places ${String(c.places)} (${String(c.places_missing)} missing here).`,
  );
  if (c.actions_events > 0) {
    add(
      `Actions export: ${String(c.actions_events)} events, ${String(c.actions_added)} not in events/.`,
    );
  }
  add(`Inputs that changed during the run: ${String(c.source_changes)}.`);
  add();
  if (r.attention.length > 0) {
    add("Needs attention:");
    const width = Math.max(...r.attention.map((a) => a.code.length));
    for (const a of r.attention) {
      add(`  ${a.severity.padEnd(7)}  ${a.code.padEnd(width)}  ${String(a.count)}`);
    }
    add();
  }
  if (r.owners.length > 0) {
    add(`Owners: ${r.owners.map((o) => `${str(o.name)}${o.me ? " (you)" : ""}`).join(", ")}`);
  }
  for (const root of r.roots) {
    add(
      root.origin === "proposed"
        ? `Proposed root ${root.id} ${str(root.folder)}: ${String(root.places)} folders. Name it with --roots ${root.id}=<folder>.`
        : `Root ${root.id} ${str(root.folder)} (${root.origin}): ${String(root.places)} places, ${String(root.missing)} missing here.`,
    );
  }
  add();
  if (r.blocked || r.token === undefined) {
    add("Blocked: fix the errors above in the prototype folder, then run the dry run again.");
  } else {
    add(`Preview token: ${r.token}`);
    add(
      `Applying is not in this build yet. It will take: tasks import planning --apply ${r.run} --token ${r.token}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function importCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  connect: ConnectOptions,
): Promise<number> {
  const [what, ...rest] = args;
  let session: Session | undefined;
  try {
    if (what !== "planning") throw new UsageError("tasks import has planning");
    const { input } = parse(io, rest);
    session = await connectService(io, connect);
    const result = (await opCall(
      session,
      globals,
      "import.planning.preview",
      input,
    )) as ImportPlanningPreviewResult;
    io.stdout(globals.json ? `${JSON.stringify(result)}\n` : summary(result));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
