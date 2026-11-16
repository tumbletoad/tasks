// `tasks import planning` (A7 3.15.4, 3.15.5): the import of the Planning prototype, through the
// service's user-only entries `import.planning.*` (A3 3.2.3):
//
//   tasks import planning <folder> --dry-run [--me <name>] [--roots <id>=<folder>[,...]]
//         [--actions <export.json>] [--checked-as completed|review] [--include-orphans]
//         [--space <space>] [--json]
//   tasks import planning --apply <run> --token <token> [--space <space>] [--json]
//   tasks import planning --undo <run> [--space <space>] [--json]
//
// The CLI resolves every folder and file against its working folder and sends it absolute. The
// dry run copies the prototype's inputs into a run folder in the space, writes report.md and
// report.json there, and answers with the report and, when nothing blocks, a preview token: a hash
// of what the apply depends on, no secret. The apply makes the plan again, checks the token against
// the space as it is, takes a verified backup and writes one commit. The undo reverts that commit,
// and keeps every task someone changed since. Only the user runs them, in an interactive terminal.
import { isAbsolute, resolve } from "node:path";
import type {
  ImportPlanningApplyResult,
  ImportPlanningPreviewResult,
  ImportPlanningUndoResult,
} from "@tasks/contracts";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage, str } from "./output.ts";
import { asAppError, opCall } from "./verbs.ts";

/** `tasks import --help` and `tasks help import`. */
export const IMPORT_HELP = `Usage: tasks import planning <folder> --dry-run [options] [--space <space>] [--json]
       tasks import planning --apply <run> --token <token> [--space <space>] [--json]
       tasks import planning --undo <run> [--space <space>] [--json]

Imports the Planning prototype's folder into a space, in two steps. The dry run writes nothing to
the space: the run's folder in it holds a copy of the inputs, report.md and report.json, and it
prints a preview token. The apply takes a verified backup, then writes everything in one change.
Run again over a space that holds an earlier import, it changes only what changed in the prototype
and never a field you changed since: such a field is listed as a conflict and kept as you have it.

  --me <name>                      The owner name that is you: those tasks get no owner
  --roots <id>=<folder>[,...]      Roots for the task folders, beside this machine's own
  --actions <file>                 The page's actions export (planning-actions-<date>.json)
  --checked-as completed|review    A checked task: completed (default) or kept in Review
  --include-orphans                Create metadata entries without a task line, in Backlog
  --apply <run> --token <token>    Apply the dry run with that run ID and token
  --undo <run>                     Undo that applied run; a task changed since stays as it is

The dry run's token stops being valid when the space or the prototype folder changes: run the dry
run again. Only the user can run this, in an interactive terminal.
`;

const ROOT = /^([a-z0-9][a-z0-9_-]{0,31})=(.+)$/s;
/** A comma that starts the next `<id>=` of a --roots list: a folder may hold commas. */
const NEXT_ROOT = /,(?=[a-z0-9][a-z0-9_-]{0,31}=)/;
const RUN = /^ex_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
/** Seconds an apply or an undo may take before the CLI stops waiting: the service's own limit. */
const LONG_CALL_S = 30 * 60;
const TOKEN = /^pv1_[A-Za-z0-9_-]{43}$/;

type Parsed =
  | { readonly action: "preview"; readonly input: Record<string, unknown> }
  | { readonly action: "apply"; readonly run: string; readonly token: string }
  | { readonly action: "undo"; readonly run: string };

function parse(io: Io, args: readonly string[]): Parsed {
  const at = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(io.cwd, p));
  const positional: string[] = [];
  let dryRun = false;
  let apply: string | undefined;
  let token: string | undefined;
  let undo: string | undefined;
  let me: string | undefined;
  let actions: string | undefined;
  let checkedAs: string | undefined;
  let orphans = false;
  const roots: { id: string; folder: string }[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    const value = (): string => {
      const v = inline ?? args[(i += 1)];
      if (v === undefined || v === "") throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--apply":
        apply = value();
        if (!RUN.test(apply)) throw new UsageError("--apply takes the run ID its dry run printed");
        break;
      case "--token":
        token = value();
        if (!TOKEN.test(token)) throw new UsageError("--token takes the token its dry run printed");
        break;
      case "--undo":
        undo = value();
        if (!RUN.test(undo)) throw new UsageError("--undo takes the run ID an apply printed");
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
      default:
        if (arg.startsWith("--")) {
          throw new UsageError(
            `tasks import planning has no option ${/^--[a-z-]{1,30}$/.test(flag) ? flag : "like that"}`,
          );
        }
        positional.push(arg);
    }
  }
  const previewing =
    positional.length > 0 ||
    me !== undefined ||
    actions !== undefined ||
    checkedAs !== undefined ||
    orphans ||
    roots.length > 0;
  const chosen = [dryRun, apply !== undefined, undo !== undefined].filter(Boolean).length;
  if (chosen !== 1) {
    throw new UsageError("tasks import planning takes one of --dry-run, --apply and --undo");
  }
  if (apply !== undefined) {
    if (token === undefined) throw new UsageError("--apply needs the dry run's --token");
    if (previewing) throw new UsageError("--apply takes its run and token only");
    return { action: "apply", run: apply, token };
  }
  if (token !== undefined) throw new UsageError("--token goes with --apply");
  if (undo !== undefined) {
    if (previewing) throw new UsageError("--undo takes its run only");
    return { action: "undo", run: undo };
  }
  const [folder] = positional;
  if (folder === undefined || positional.length > 1) {
    throw new UsageError("tasks import planning takes one folder: the prototype's");
  }
  return {
    action: "preview",
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
    add(`Apply it with: tasks import planning --apply ${r.run} --token ${r.token}`);
  }
  return `${lines.join("\n")}\n`;
}

/** An apply's answer for a person. */
function applied(r: ImportPlanningApplyResult): string {
  const c = r.counts;
  const lines: string[] = [];
  const add = (text = "") => lines.push(text);
  add(
    r.status === "unchanged"
      ? "The space holds the prototype as it is already: nothing was written."
      : `Applied run ${r.run}${r.replayed === true ? " (an earlier apply of this run)" : ""}.`,
  );
  if (r.backup !== undefined) add(`Backup before it: ${r.backup}`);
  add(
    `Tasks: ${String(c.created)} created, ${String(c.updated)} changed, ${String(c.unchanged)} ` +
      `unchanged, ${String(c.deleted)} deleted in the space (not brought back).`,
  );
  if (c.gone > 0)
    add(`Legacy IDs no longer in the prototype: ${String(c.gone)} (nothing deleted).`);
  const conflicts = r.tasks.filter((t) => t.conflicts !== undefined);
  if (conflicts.length > 0) {
    add();
    add("Changed in the prototype and in the space, kept as the space has them:");
    for (const t of conflicts) {
      add(`  ${t.ref ?? t.legacy_id}  ${(t.conflicts ?? []).join(", ")}`);
    }
  }
  const unlisted = c.conflicts - conflicts.length;
  if (unlisted > 0) {
    add(`  and ${String(unlisted)} more tasks with conflicts, listed in the run's apply.json`);
  }
  if (r.tasks_more > 0 && unlisted <= 0) {
    add(`${String(r.tasks_more)} more tasks are listed in the run's apply.json.`);
  }
  if (r.incomplete === true) {
    add();
    add("The full answer of this apply was not saved: the counts come from its change, and the");
    add("next import of the prototype lists its conflicts again.");
  }
  if (r.status === "applied") {
    add();
    add(`Undo it with: tasks import planning --undo ${r.run}`);
  }
  return `${lines.join("\n")}\n`;
}

/** An undo's answer for a person. */
function undone(r: ImportPlanningUndoResult): string {
  const lines = [
    `Undid run ${r.run}: removed ${String(r.removed)} tasks, set back ${String(r.restored)}.`,
  ];
  if (r.kept.length > 0) {
    lines.push("Changed since the import, kept as they are:");
    for (const k of r.kept) lines.push(`  ${k.task}  ${k.fields.join(", ")}`);
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
    const parsed = parse(io, rest);
    session = await connectService(io, connect);
    if (parsed.action === "preview") {
      const result = (await opCall(
        session,
        globals,
        "import.planning.preview",
        parsed.input,
      )) as ImportPlanningPreviewResult;
      io.stdout(globals.json ? `${JSON.stringify(result)}\n` : summary(result));
      return 0;
    }
    // An apply takes a verified backup first, and an undo of a large import is a large commit:
    // each waits longer than a call's default before the CLI gives up waiting (it is still
    // decided, and the same command again replays it).
    const long = { ...globals, timeoutS: Math.max(globals.timeoutS, LONG_CALL_S) };
    if (parsed.action === "apply") {
      // The request ID follows from the run and the token, so a repeated command applies once.
      const result = (await opCall(session, long, "import.planning.apply", {
        run: parsed.run,
        token: parsed.token,
        request_id: `ip_${parsed.run.slice(3)}_${parsed.token.slice(4, 24)}`,
      })) as ImportPlanningApplyResult;
      io.stdout(globals.json ? `${JSON.stringify(result)}\n` : applied(result));
      return 0;
    }
    const result = (await opCall(session, long, "import.planning.undo", {
      run: parsed.run,
      request_id: `iu_${parsed.run.slice(3)}`,
    })) as ImportPlanningUndoResult;
    io.stdout(globals.json ? `${JSON.stringify(result)}\n` : undone(result));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
