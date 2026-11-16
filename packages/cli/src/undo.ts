// `tasks undo`: the generic verb, with one check of its own. A change made by a script (a command
// with no terminal, such as one over ssh without -t) is on no undo stack. When one is newer than
// the person's own newest change, an undo would take back that older change, often of another task,
// which is rarely what someone who just ran `tasks undo` means. So the CLI asks the service to undo
// nothing then (`check_script`), says which change it would take back and which change by a script
// is newer, and asks on the terminal. `--yes` undoes without asking; a command with no one to ask
// gets the conflict and its words.
import type { ErrorBody } from "@tasks/contracts";
import type { Globals, VerbSpec } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
import { exitCodeOf, str } from "./output.ts";
import { runVerb } from "./verbs.ts";

/** The conflict's reason when a script's change is newer (the service's SCRIPT_CHANGE_AFTER). */
const SCRIPT_CHANGE_AFTER = "script_change_after";

/** A change's first operation as a verb a person reads: "completed M-25". */
const VERBS: Readonly<Record<string, string>> = {
  "task.create": "added",
  "task.complete": "completed",
  "task.archive": "dropped",
  "task.wrap_up": "wrapped up",
  "task.reopen": "reopened",
  "task.move": "moved",
  "task.patch": "changed",
  "log.add": "logged on",
  "note.add": "added a note to",
};

export interface UndoOptions extends ConnectOptions {
  /** Asks the person a yes-or-no question. Default: the terminal's (Io.ask). Tests answer it. */
  readonly ask?: (question: string) => Promise<boolean>;
}

/** The question: the person's change an undo takes back, and the script's newer one. */
export function undoQuestion(data: Readonly<Record<string, unknown>>): string {
  const tasks = (Array.isArray(data["tasks"]) ? data["tasks"] : []).map(str);
  const count = typeof data["task_count"] === "number" ? data["task_count"] : tasks.length;
  const more = count > tasks.length ? ` and ${String(count - tasks.length)} more` : "";
  const what = VERBS[str(data["change"])];
  const yours =
    tasks.length === 0
      ? "your own newest change"
      : `your change to ${tasks.join(", ")}${more}${what === undefined ? "" : ` (${what})`}`;
  const script = (data["script_change"] ?? {}) as Record<string, unknown>;
  const theirs = `${VERBS[str(script["change"])] ?? "changed"} ${str(script["task"])}`;
  return `A script ${theirs} after your newest change, and undo never takes back a script's change. Undo ${yours} instead? [y/N] `;
}

export async function undoCommand(
  io: Io,
  globals: Globals,
  verb: VerbSpec,
  args: readonly string[],
  options: UndoOptions,
): Promise<number> {
  const yes = args.includes("--yes") || args.includes("-y");
  const rest = args.filter((arg) => arg !== "--yes" && arg !== "-y");
  const ask = options.ask ?? io.ask;
  return runVerb(io, globals, verb, rest, options, undefined, {
    input: (input) => {
      // A named commit is the change the person means: nothing to ask.
      if (!yes && input["commit"] === undefined) input["check_script"] = true;
    },
    failed: async (body: ErrorBody, again) => {
      const data = body.data ?? {};
      if (data["reason"] !== SCRIPT_CHANGE_AFTER || ask === undefined || globals.json) {
        return undefined;
      }
      if (!(await ask(undoQuestion(data)))) {
        io.stderr("Nothing was undone.\n");
        return exitCodeOf(body);
      }
      // The change the question named, and no other: a newer change of the person's made
      // meanwhile stands before it, and the service refuses it then. JSON leaves out the
      // undefined check.
      return again({ commit: data["commit"], check_script: undefined });
    },
  });
}
