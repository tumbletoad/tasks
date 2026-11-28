// What the CLI prints (A2 3.10.2, 3.10.3; A3 3.5). With --json, stdout holds exactly one JSON
// document: the operation's result, or `{"error": {code, class, message, hint, data}}`. Without
// it, stdout holds plain text for a person and every write names its space. Diagnostics go to
// stderr. The exit code follows the error's class.
import { CLI_NAME } from "@ttasks/brand";
import { RpcError } from "@ttasks/bridge/protocol";
import { shellLine } from "@ttasks/launch";
import {
  errorClass,
  EXIT_CODES,
  isErrorCode,
  messageWithHint,
  AppError,
  effortLevels,
  effortTimeText,
  type EffortLevel,
  type ErrorBody,
  type ErrorClass,
} from "@ttasks/contracts";
import { newerText, type NewerWorkEntry } from "@ttasks/contracts/newer-work";
import type { Io } from "./io.ts";

/** A scalar as text; anything else as nothing. */
export const str = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

export const RESTART_HINT = `Restart the service: ${CLI_NAME} service restart.`;

/** The effort levels of a preference's value, when it is a list of them. */
function levelsIn(value: unknown): EffortLevel[] | undefined {
  return Array.isArray(value) && value.some((item) => typeof item === "object")
    ? effortLevels(value)
    : undefined;
}

/** A set's change of one key: its value from and to, a list of levels by their names. */
export const prefChangeText = (change: { key?: unknown; from?: unknown; to?: unknown }): string =>
  `${str(change.key)}: ${prefShown(change.from)} → ${prefShown(change.to)}`;

/** A preference's value on one line: JSON, and a list of levels by their names. */
function prefShown(value: unknown): string {
  return JSON.stringify(levelsIn(value)?.map((level) => level.key) ?? value);
}

/** One line per level that says more than its name: its time and what belongs on it. */
function levelLines(value: unknown): string[] {
  return (levelsIn(value) ?? []).flatMap((level) => {
    const said = [
      level.time === undefined ? undefined : `about ${effortTimeText(level.time)}`,
      level.about,
    ].filter((part) => part !== undefined);
    return said.length === 0 ? [] : [`  ${level.key}: ${said.join(". ")}`];
  });
}

const tasksText = (n: number): string => `${String(n)} task${n === 1 ? "" : "s"}`;

/** A move of a change of levels: "3 tasks from M to L (1 finished)". */
export function movedText(m: {
  from: string;
  to: string | null;
  active: number;
  finished: number;
  trash: number;
}): string {
  const out = [
    m.finished > 0 ? `${String(m.finished)} finished` : "",
    m.trash > 0 ? `${String(m.trash)} in the Trash` : "",
  ].filter((part) => part !== "");
  const where = `from ${m.from} to ${m.to ?? "no size"}`;
  return `${tasksText(m.active + m.finished + m.trash)} ${where}${out.length === 0 ? "" : ` (${out.join(", ")})`}`;
}

/** What a change of the effort levels moved, and the tasks it left on a size that is no level. */
function levelsReport(result: Result): string[] {
  const moved = (result["moved"] ?? []) as Parameters<typeof movedText>[0][];
  const off = (result["off_list"] ?? []) as { effort: string; tasks: string[]; count: number }[];
  return [
    ...moved.map((m) => movedText(m).replace(/^(\d+ tasks?) /u, "$1 moved ") + "."),
    ...off.map(({ effort, tasks, count }) => {
      const more = count > tasks.length ? ` and ${String(count - tasks.length)} more` : "";
      const are = count === 1 ? "is" : "are";
      return `${tasksText(count)} ${are} on ${effort}, which is not a level now: ${tasks.join(", ")}${more}.`;
    }),
  ];
}

/** Any failure as A3's error body. A JSON-RPC protocol error is the service's `internal`. */
export function bodyOf(error: unknown): ErrorBody {
  if (error instanceof AppError) return error.toBody();
  if (error instanceof RpcError) {
    const data = error.data as Partial<ErrorBody> | undefined;
    if (data !== undefined && isErrorCode(data.code) && typeof data.message === "string") {
      return data as ErrorBody;
    }
    if (error.code === -32601) {
      return {
        code: "op_unknown",
        message: "The running service does not know this command.",
        hint: RESTART_HINT,
      };
    }
  }
  return { code: "internal", message: "Something went wrong.", hint: "Run: ttasks doctor" };
}

/** A2 3.10.3's class of an error body: `service_unavailable` for a version is class `version`. */
export function classOf(body: ErrorBody): ErrorClass {
  const reason = body.data?.["reason"];
  return isErrorCode(body.code)
    ? errorClass(body.code, typeof reason === "string" ? reason : undefined)
    : "internal";
}

export const exitCodeOf = (body: ErrorBody): number => EXIT_CODES[classOf(body)];

/** Prints an error and returns its exit code. */
export function printError(io: Io, json: boolean, body: ErrorBody): number {
  const cls = classOf(body);
  if (json) {
    io.stdout(
      `${JSON.stringify({ error: { code: body.code, class: cls, message: body.message, ...(body.hint === undefined ? {} : { hint: body.hint }), ...(body.data === undefined ? {} : { data: body.data }) } })}\n`,
    );
  } else {
    // A3 3.5's text form: error <code>: <one sentence>. <hint>
    io.stderr(`error ${body.code}: ${messageWithHint(body.message, body.hint, CLI_NAME)}\n`);
    const issues = body.data?.["issues"];
    if (Array.isArray(issues)) {
      for (const issue of issues.slice(0, 5) as { path?: unknown; message?: unknown }[]) {
        io.stderr(`  ${str(issue.path)}: ${str(issue.message)}\n`);
      }
    }
    // An undo's or a redo's refusal says who changed which tasks since. Another conflict names its
    // task and field, and who wrote it when (A3 3.5), never the value.
    const newer = newerOf(body.data);
    const conflicts = body.data?.["conflicts"];
    if (newer !== undefined) {
      io.stderr(`  ${capital(newer)}.\n`);
    } else if (Array.isArray(conflicts)) {
      for (const c of conflicts.slice(0, 5) as Record<string, unknown>[]) {
        const what = [str(c["task"]), str(c["field"])].filter((part) => part !== "").join(" ");
        const who = str(c["by"]) === "" ? "" : `: ${str(c["by"])} at ${str(c["at"])}`;
        io.stderr(`  ${what}${who}\n`);
      }
    }
  }
  return EXIT_CODES[cls];
}

/**
 * Who changed which tasks since, from an undo's or a redo's answer (newerText), or undefined when
 * it names none. With no one else's work, the person's own earlier change holds it back.
 */
function newerOf(data: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const work = data?.["newer_work"];
  if (!Array.isArray(work)) return undefined;
  const entries = (work as Record<string, unknown>[]).flatMap((w): NewerWorkEntry[] =>
    typeof w["by"] === "string" && typeof w["at"] === "string"
      ? [
          {
            ...(typeof w["task"] === "string" ? { task: w["task"] } : {}),
            by: w["by"],
            at: w["at"],
          },
        ]
      : [],
  );
  return newerText(entries) ?? "it needs another change of yours first";
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A usage error (exit 2): the message names options and verbs, never a value. */
export function printUsage(io: Io, json: boolean, message: string): number {
  return printError(io, json, {
    code: "invalid_input",
    message,
    hint: "Run ttasks help for the commands.",
  });
}

// ---------------------------------------------------------------------------------------------
// Results for people

type Result = Record<string, unknown>;

const replay = (r: Result) => (r["replayed"] === true ? " (replayed)" : "");

/**
 * A finished task's state as a person says it: completed, or dropped for an archived one.
 * Undefined while the task is active, whose state is its status.
 */
function finished(lifecycle: unknown): string | undefined {
  if (lifecycle === "completed") return "completed";
  if (lifecycle === "archived") return "dropped";
  return undefined;
}

/** A line break as the tools' text answers split a request on (mcp/render.ts). */
const LINE_BREAK = /\r\n|[\n\r\p{Zl}\p{Zp}]/u;

/** An entry's text: a line after its first stays indented under the entry, never at the margin. */
const entryText = (text: unknown): string => String(text).split(LINE_BREAK).join("\n    ");

/** One task: its one state (the status while it is active), its priority, due date and inbox. */
function taskLine(task: Result): string {
  const parts = [finished(task["lifecycle"]) ?? str(task["status"]), `p${str(task["priority"])}`];
  const due = task["due"];
  if (typeof due === "string") parts.push(`due ${due}`);
  if (task["inbox"] === true) parts.push("inbox");
  return `${String(task["ref"])}  ${String(task["title"])}  (${parts.join(", ")})`;
}

/** An Open's `left_out` in words; a permission is said by its name ("your read-only setting"). */
const LEFT_OUT_WORDS: Readonly<Record<string, string>> = {
  arguments: "your extra arguments",
  environment: "your environment variables",
  home: "the account you chose for it",
};

/** What a launch receipt says its Open could not carry, as a sentence; undefined for nothing. */
export function leftOutLine(launch: unknown): string | undefined {
  const left = (launch as { left_out?: unknown } | undefined)?.left_out;
  if (!Array.isArray(left) || left.length === 0) return undefined;
  const what = left.map((code) => LEFT_OUT_WORDS[String(code)] ?? `your ${str(code)} setting`);
  return `Opened without ${listed(what)}, which this way of opening cannot carry. A terminal can, where one is set up: see ${CLI_NAME} doctor.`;
}

/** `refs` as a sentence lists them: "M-20", "M-20 and M-21", "M-20, M-21 and M-22". */
const listed = (refs: readonly string[]): string =>
  refs.length < 2 ? refs.join("") : `${refs.slice(0, -1).join(", ")} and ${refs.at(-1) ?? ""}`;

/** Who moved a task to the Trash, as a sentence's subject. */
const mover = (by: unknown): string => (by === "user" ? "You" : str(by));

/** The list a restored task is back in, and its area and project. */
function backIn(task: Result): string {
  const view =
    task["lifecycle"] === "completed"
      ? "Completed"
      : task["lifecycle"] === "archived"
        ? "Completed, dropped"
        : task["inbox"] === true
          ? "the Inbox"
          : str(task["status"]).charAt(0).toUpperCase() + str(task["status"]).slice(1);
  const group = [task["area"], task["project"]].filter((name) => typeof name === "string");
  const why =
    task["regrouped"] === "area"
      ? " (its project was deleted)"
      : task["regrouped"] === "inbox"
        ? " (its area was deleted)"
        : "";
  return `${view}${group.length === 0 ? "" : `, in ${group.join(" / ")}`}${why}`;
}

/**
 * What `ttasks delete` and `ttasks restore` did: the tasks moved, where each restored one is
 * back, a link that stayed with the task that took its key, and the tasks that were there already.
 */
function deleteLines(result: Result, space: string, restore: boolean): string[] {
  const moved = ((result["moved"] as unknown[] | undefined) ?? []).map(str);
  const already = ((result["already"] as unknown[] | undefined) ?? []).map(str);
  const lines: string[] = [];
  if (!restore && moved.length > 0) {
    lines.push(`Moved ${listed(moved)} to the Trash in ${space}${replay(result)}`);
  }
  for (const task of (result["restored"] as Result[] | undefined) ?? []) {
    lines.push(`${str(task["ref"])} is back in ${backIn(task)}${replay(result)}`);
    for (const held of (task["held"] as Result[] | undefined) ?? []) {
      lines.push(
        `  A source stays with ${str(held["by"])}, which took its key meanwhile: captures go there.`,
      );
    }
  }
  if (already.length > 0) {
    const was = already.length === 1 ? "was" : "were";
    lines.push(
      restore
        ? `${listed(already)} ${was} back already`
        : `${listed(already)} ${was} in the Trash already`,
    );
  }
  const later = ((result["later"] as unknown[] | undefined) ?? []).map(str);
  if (later.length > 0) {
    const is = later.length === 1 ? "is" : "are";
    lines.push(`${listed(later)} ${is} in the Trash from a later change: restore that one`);
  }
  if (lines.length === 0) lines.push(`Nothing moved in ${space}${replay(result)}`);
  return lines;
}

/**
 * A page of the Trash: one heading per change, who made it and when, with how many of its tasks
 * are there and its ID for `ttasks restore --change`, then each task and where it was.
 */
function trashLines(result: Result, space: string): string[] {
  const rows = (result["rows"] as Result[] | undefined) ?? [];
  if (rows.length === 0) return [`Nothing in the Trash in ${space}`];
  const lines: string[] = [];
  let change: string | undefined;
  for (const row of rows) {
    const removed = (row["removed"] ?? {}) as Result;
    if (removed["id"] !== change) {
      change = str(removed["id"]);
      const count = Number(removed["count"]);
      const why = typeof removed["reason"] === "string" ? ` · ${removed["reason"]}` : "";
      // How many of the change's tasks are here now: some may be back, or with a later change.
      const whose = removed["by"] === "user" ? "your change" : `${str(removed["by"])}'s change`;
      lines.push(
        `${String(count)} ${count === 1 ? "task" : "tasks"} here from ${whose}, ${str(removed["at"])}${why} · ${change}`,
      );
    }
    const group = [row["area"], row["project"]].filter((name) => typeof name === "string");
    lines.push(
      `  ${str(row["ref"])}  ${str(row["title"])}${group.length === 0 ? "" : `  (${group.join(" / ")})`}`,
    );
  }
  const cursor = result["cursor"];
  if (typeof cursor === "string") lines.push(`More: ttasks trash --cursor ${cursor}`);
  return lines;
}

/** A row's due commitment: a date, or a time with its zone (A1 3.4); empty without one. */
function dueText(due: unknown): string {
  if (typeof due === "string") return `due ${due}`;
  if (typeof due === "object" && due !== null) {
    const { at, tz } = due as Result;
    if (typeof at === "string") return `due ${at}${typeof tz === "string" ? ` (${tz})` : ""}`;
  }
  return "";
}

/**
 * A search page: a header with the positions, the scope and how the query was read, then one line
 * per row. A row changed since the search ran ends with `*`; one deleted or redacted since keeps its
 * place without its content. The page's `as_of` is for a script, in --json.
 */
function searchLines(result: Result): string[] {
  const rows = (result["rows"] as Result[] | undefined) ?? [];
  const first = Number(result["first"]);
  const span = rows.length === 0 ? "0" : `${String(first)}–${String(first + rows.length - 1)}`;
  const parsed = str(result["parsed"]);
  const lines = [
    `${span} of ${str(result["total"])} · scope ${str(result["scope"])}${parsed === "" ? "" : ` · parsed: ${parsed}`}`,
  ];
  for (const row of rows) {
    const mark = row["changed"] === true ? " *" : "";
    const group = str(row["project"]) || str(row["area"]);
    switch (row["kind"]) {
      case "deleted":
      case "redacted":
        lines.push(`${str(row["ref"])} · ${str(row["kind"])} since this search`);
        break;
      case "learning":
        lines.push(
          [str(row["task"]), str(row["date"]), group, `"${str(row["text"])}"`]
            .filter((part) => part !== "")
            .join(" · ") + mark,
        );
        break;
      default: {
        const ended = finished(row["lifecycle"]);
        const state =
          ended === undefined
            ? str(row["status"])
            : `${ended}${typeof row["completed"] === "string" ? ` ${row["completed"]}` : ""}`;
        const parts = [
          str(row["ref"]),
          state,
          row["priority"] === 4 ? "" : `P${str(row["priority"])}`,
          str(row["effort"]),
          dueText(row["due"]),
          group,
          str(row["title"]),
        ].filter((part) => part !== "");
        const from = str(row["snippet_from"]);
        // A finished task without a match in its text says how it ended in the summary's place.
        const line = row["snippet"] ?? row["ending"];
        // A line that only says the title again (a summary that is the title) adds nothing.
        const snippet =
          typeof line === "string" && line !== row["title"]
            ? ` — ${from === "" || from === "task" ? "" : `${from}: `}${line}`
            : "";
        lines.push(`${parts.join(" · ")}${snippet}${mark}`);
      }
    }
  }
  if (typeof result["cursor"] === "string") {
    lines.push(`More: ${CLI_NAME} find --cursor ${result["cursor"]}`);
  }
  return lines;
}

/**
 * A task draft's row (A3 3.4.5): added, or found by its source key (A1 3.6), with the lifecycle it
 * was found in, or the tasks that share its keys, and whether its log entry was added. `its` names
 * the draft: a follow-up's draft is not the task the line is about.
 */
function draftLine(task: Result, space: string, its = "its"): string {
  if (task["result"] !== "exists") {
    const project = typeof task["project"] === "string" ? `, in ${task["project"]}` : "";
    return `Added ${String(task["ref"])} to ${space}${project}`;
  }
  const ambiguous = task["ambiguous"];
  const several = Array.isArray(ambiguous);
  const logged =
    task["log_added"] === true
      ? ", log entry added"
      : task["log_left_out"] === true
        ? `; this command added ${its} log entry to no task: look at ${several ? "them" : "it"} first, as ${several ? "one" : "it"} may have it already, then add it with ${CLI_NAME} log`
        : "";
  if (several) {
    return `Several tasks in ${space} have ${its} source key: ${ambiguous.map(String).join(", ")}${logged}`;
  }
  const lifecycle =
    typeof task["lifecycle"] !== "string" || task["lifecycle"] === "active"
      ? ""
      : ` (${task["lifecycle"]})`;
  return `Found ${String(task["ref"])}${lifecycle} in ${space} by ${its} source key${logged}`;
}

/**
 * The sources of a new task that were linked without their key, because another active task holds
 * it: which task, so the person knows where captures of the item go.
 */
function heldLines(task: Result): string[] {
  return ((task["held"] as Result[] | undefined) ?? []).map(
    (held) =>
      `  Its source ${String(Number(held["source"]) + 1)} is linked without its key: ${str(held["held_by"])} holds the key, and captures of it go there.`,
  );
}

/** A change's operation kind as a verb on its task, for the undo's note on a script's change. */
const SCRIPT_VERBS: Readonly<Record<string, string>> = {
  "task.create": "added",
  "task.complete": "completed",
  "task.archive": "dropped",
  "task.wrap_up": "wrapped up",
  "task.reopen": "reopened",
  "task.move": "moved",
  "log.add": "logged on",
  "note.add": "added a note to",
};

/** Plain text for a person, per entry. `space` names the space a write went to (A2 3.10.2). */
/** What `ttasks area` says a write did, by its result. */
const GROUP_DONE: Readonly<Record<string, string>> = {
  created: "Created",
  exists: "Another project has this folder:",
  renamed: "Renamed",
  moved: "Moved",
  archived: "Archived",
  unarchived: "Unarchived",
  folder_set: "Folder set for",
  folder_cleared: "Folder cleared for",
  no_change: "No change to",
  proposed: "Proposed for",
};

/** Why folders inside the old one stayed, by the answer's `stayed_because`. */
const STAYED_WHY: Readonly<Record<string, string>> = {
  old_folder_there: "the old folder is still there",
  old_folder_unseen: "the old folder cannot be seen and nothing shows that the new one is it",
  unchecked: "a folder could not be checked",
  not_in_new_folder: "they are not in the new folder",
};

/** What a folder change did to the folders inside the old one, a line each. */
function insideLines(result: Result): string[] {
  const folders = (n: number) => `${String(n)} folder${n === 1 ? "" : "s"}`;
  const listed = (key: string, count: number): string[] => {
    const list = (result[key] as Result[] | undefined) ?? [];
    const lines = list.map((f) => {
      const who = f["kind"] === "task" ? str(f["ref"]) : `project ${str(f["name"])}`;
      return `  ${who}  ${str(f["folder"])}`;
    });
    return count > list.length ? [...lines, `  and ${String(count - list.length)} more`] : lines;
  };
  const lines: string[] = [];
  const moved = result["moved"];
  if (typeof moved === "number") {
    lines.push(`The old folder was moved: ${folders(moved)} inside it moved along.`);
    lines.push(...listed("followed", moved));
  }
  const stayed = result["stayed"];
  if (typeof stayed === "number") {
    const because = str(result["stayed_because"]);
    const why =
      because === "not_in_new_folder" && stayed === 1
        ? "it is not in the new folder"
        : (STAYED_WHY[because] ?? "");
    lines.push(
      `${folders(stayed)} inside the old one ${stayed === 1 ? "stays where it is" : "stay where they are"}${why === "" ? "" : `: ${why}`}.`,
    );
    lines.push(...listed("kept", stayed));
  }
  return lines;
}

/** Where captures of a source's item go: one task, or several a capture asks between. */
function capturesTo(source: Result): string | undefined {
  const value = source["captures_to"];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const refs = value.map(String);
  const more = typeof source["captures_more"] === "number" ? source["captures_more"] : 0;
  if (refs.length === 1 && more === 0) return `captures go to ${refs.join("")}`;
  return `captures ask which of ${refs.join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`;
}

/** What the command asked that a command it prints must ask again. */
export interface Asked {
  /** `--space` as given. */
  readonly space?: string | undefined;
  /** `--archived`. */
  readonly archived?: boolean;
  /** `ttasks restore`, not `ttasks delete`. */
  readonly restore?: boolean;
  /**
   * A person at a terminal (personAtTerminal), not an agent's shell or a script: a task in the Trash
   * tells a person how to restore it, and an agent to tell the person and not to.
   */
  readonly person?: boolean;
  readonly platform?: NodeJS.Platform;
}

/**
 * A command the output tells the person to run next, as they can paste it: in the space this one
 * was run for, since without `--space` it would act on the default space's task of the same
 * reference.
 */
function next(asked: Asked, words: readonly string[]): string {
  const argv = [CLI_NAME, ...words, ...(asked.space === undefined ? [] : ["--space", asked.space])];
  return shellLine(asked.platform ?? process.platform, argv) ?? argv.join(" ");
}

export function render(entry: string, result: Result, space: string, asked: Asked = {}): string {
  const lines: string[] = [];
  switch (entry) {
    case "task.add":
      for (const task of (result["tasks"] as Result[] | undefined) ?? []) {
        lines.push(`${draftLine(task, space)}${replay(result)}`, ...heldLines(task));
      }
      break;
    case "task.update": {
      const fields = (result["fields"] as string[] | undefined) ?? [];
      lines.push(
        result["result"] === "no_change"
          ? `No change to ${String(result["task"])} in ${space}${replay(result)}`
          : `Updated ${String(result["task"])} in ${space}: ${fields.join(", ")}${replay(result)}`,
      );
      lines.push(...insideLines(result));
      break;
    }
    case "entry.add":
      lines.push(
        `${result["kind"] === "note" ? "Noted" : "Logged"} ${String(result["entry"])} on ${String(result["task"])} in ${space}${replay(result)}`,
      );
      break;
    case "note.remove": {
      const note = str(result["note"]);
      const task = str(result["task"]);
      const number = note.replace(/^n/u, "");
      lines.push(
        result["result"] === "removed"
          ? `Removed note ${note} from ${task} in ${space}: put it back with ${next(asked, ["note", task, "--put-back", number])}${replay(result)}`
          : result["result"] === "put_back"
            ? `Put back note ${note} on ${task} in ${space}${replay(result)}`
            : `No change to note ${note} on ${task} in ${space}${replay(result)}`,
      );
      break;
    }
    case "task.finish": {
      const dropped = result["lifecycle"] === "archived";
      lines.push(
        result["result"] === "no_change"
          ? `${String(result["task"])} is already ${dropped ? "dropped" : "completed"} in ${space}${replay(result)}`
          : `${dropped ? "Dropped" : "Completed"} ${String(result["task"])} in ${space}${replay(result)}`,
      );
      for (const f of (result["follow_ups"] as Result[] | undefined) ?? []) {
        lines.push(draftLine(f, space, "a follow-up's"), ...heldLines(f));
      }
      break;
    }
    case "task.reopen":
      lines.push(`Reopened ${String(result["task"])} in ${space}${replay(result)}`);
      break;
    case "task.delete":
      lines.push(...deleteLines(result, space, asked.restore === true));
      break;
    case "task.trash":
      lines.push(...trashLines(result, space));
      break;
    case "history.undo":
    case "history.redo": {
      const tasks = ((result["tasks"] as unknown[] | undefined) ?? []).map(str);
      const count = typeof result["task_count"] === "number" ? result["task_count"] : tasks.length;
      const more = count > tasks.length ? ` and ${String(count - tasks.length)} more` : "";
      const which = tasks.length === 0 ? "" : ` to ${tasks.join(", ")}${more}`;
      const redo = entry === "history.redo";
      if (result["result"] === "kept") {
        // A change since kept it, or it cannot be applied now: nothing changed, and the next one
        // reaches the change before.
        const why = typeof result["why"] === "string" ? result["why"] : undefined;
        const reason =
          why === undefined
            ? (newerOf(result) ?? "it is as it was already")
            : why.charAt(0).toLowerCase() + why.slice(1);
        lines.push(
          `Not ${redo ? "redone" : "undone"}${which}: ${reason}, so it stays as it is. Run the command again for your change before it${replay(result)}`,
        );
        break;
      }
      lines.push(`${redo ? "Redid" : "Undid"} your change${which} in ${space}${replay(result)}`);
      // A3 3.7.4: a newer change by a script of the same person, which no undo reaches.
      const scripted = result["script_change"] as Result | undefined;
      if (scripted !== undefined) {
        lines.push(
          `Not undone: a script ${SCRIPT_VERBS[str(scripted["change"])] ?? "changed"} ${str(scripted["task"])} after that, and a script's changes are not on your undo stack.`,
        );
      }
      break;
    }
    case "task.get": {
      const task = (result["task"] ?? {}) as Result;
      lines.push(taskLine(task));
      const trashed = task["deleted"] as Result | undefined;
      if (trashed !== undefined) {
        const at = str(trashed["at"]);
        // A person is told how to bring it back; an agent's shell or a script, to tell the person.
        lines.push(
          asked.person === true
            ? `In the Trash: ${mover(trashed["by"])} moved it there at ${at}. Restore it with ${next(asked, ["restore", str(task["ref"])])}`
            : `In the Trash: ${trashed["by"] === "user" ? "the user" : str(trashed["by"])} moved it there at ${at}. Tell the user; do not add it again or restore it.`,
        );
      }
      // The user's request for the launch named: each line as typed after an indent.
      const request = result["request"] as Result | undefined;
      if (request?.["removed"] === true) {
        lines.push(
          `The user took back their request for this launch (note ${str(request["note"])}): do not act on it.`,
        );
      }
      if (typeof request?.["text"] === "string") {
        lines.push("Request from the user for this launch:");
        for (const line of request["text"].split(LINE_BREAK)) lines.push(`  ${line}`);
        if (typeof request["cut"] === "number") {
          lines.push(
            `  ... (+${String(request["cut"])} chars) The rest is note ${String(request["note"])}: --section notes.`,
          );
        }
      }
      if (typeof task["summary"] === "string" && task["summary"] !== "")
        lines.push(`  ${task["summary"]}`);
      const folder = task["folder"] as Result | undefined;
      if (typeof folder?.["path"] === "string") {
        const notes = [
          folder["of"] === "project" ? "its project's" : undefined,
          folder["missing"] === true ? "not found on this machine" : undefined,
        ].filter((note) => note !== undefined);
        lines.push(
          `  folder: ${folder["path"]}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`,
        );
      } else if (typeof folder?.["machine"] === "string") {
        lines.push(`  folder: on ${folder["machine"]}`);
      }
      const sections = (result["sections"] ?? task) as Result;
      for (const note of (sections["instructions"] as Result[] | undefined) ?? []) {
        lines.push(`  ${String(note["ref"])} user → agents: ${entryText(note["text"])}`);
      }
      if (typeof sections["context"] === "string" && sections["context"] !== "") {
        lines.push("", sections["context"]);
      }
      for (const source of (sections["sources"] as Result[] | undefined) ?? []) {
        const removed = source["removed"] as Result | undefined;
        const key = source["key"] ?? source["ref"];
        const facts = [
          typeof key === "string" ? key : undefined,
          typeof source["url"] === "string" ? source["url"] : undefined,
          capturesTo(source),
          String(source["id"]),
        ].filter((fact) => fact !== undefined);
        const label =
          removed === undefined
            ? "source"
            : `detached ${String(removed["at"]).slice(0, 10)} by ${String(removed["by"])}`;
        lines.push(`  ${label}: ${String(source["title"])} [${facts.join(" · ")}]`);
      }
      // A digest holds the first lessons and counts them all; the outcome section holds them all.
      const outcome = result["sections"] === undefined ? undefined : sections["outcome"];
      if (outcome === undefined) {
        const shown = (task["learnings"] as unknown[] | undefined) ?? [];
        const all = shown.length + Number((task["more"] as Result | undefined)?.["learnings"] ?? 0);
        if (all > 0) {
          const rest = shown.length < all ? ", all with --section outcome" : "";
          lines.push(`  learnings: ${String(shown.length)} of ${String(all)}${rest}`);
        }
        for (const learning of shown) lines.push(`  learning: ${entryText(learning)}`);
      } else {
        const section = outcome as Result;
        if (typeof section["outcome"] === "string") {
          const wrap =
            typeof section["wrap_state"] === "string" ? ` (${section["wrap_state"]})` : "";
          lines.push(`  outcome${wrap}: ${entryText(section["outcome"])}`);
        }
        for (const learning of (section["learnings"] as unknown[] | undefined) ?? []) {
          lines.push(`  learning: ${entryText(learning)}`);
        }
      }
      for (const note of (sections["notes"] as Result[] | undefined) ?? []) {
        const launches = (note["request_for"] as Result[] | undefined) ?? [];
        const asked =
          launches.length === 0
            ? ""
            : ` (request for ${launches.map((l) => `launch ${String(l["launch"])} [${String(l["instance"])}]`).join(", ")})`;
        lines.push(
          `  ${String(note["ref"])} ${String(note["author"])}${note["for_agents"] === true ? " → agents" : ""}${asked}: ${entryText(note["text"])}`,
        );
      }
      for (const entry of (sections["log"] as Result[] | undefined) ?? []) {
        lines.push(
          `  ${String(entry["ref"])} ${String(entry["kind"])} ${String(entry["author"])}: ${entryText(entry["text"])}`,
        );
      }
      for (const row of (sections["history"] as Result[] | undefined) ?? []) {
        lines.push(`  #${String(row["seq"])} ${String(row["actor"])}: ${String(row["what"])}`);
      }
      // Only the person's read lists the notes they took back, with the way to put one back.
      const removedNotes = (result["removed_notes"] as Result[] | undefined) ?? [];
      for (const note of removedNotes) {
        const removed = (note["removed"] ?? {}) as Result;
        lines.push(
          `  ${str(note["ref"])} removed ${str(removed["at"]).slice(0, 10)} by ${str(removed["by"])}: ${entryText(note["text"])}`,
        );
      }
      if (removedNotes.length > 0) {
        lines.push(
          `Put a note back with ${next(asked, ["note", str(task["ref"])])} --put-back <number>`,
        );
      }
      if (typeof result["before"] === "string") {
        lines.push(`More: the same command with --before ${result["before"]}`);
      }
      break;
    }
    case "space.status": {
      const sp = (result["space"] ?? {}) as Result;
      const counts = (result["counts"] ?? {}) as Result;
      const statuses = ((counts["statuses"] as Result[] | undefined) ?? [])
        .map((s) => `${String(s["status"])} ${String(s["count"])}`)
        .join(", ");
      lines.push(
        `${String(sp["name"])} (${String(sp["ref_prefix"])}) · ${String(result["date"])} · ${statuses} · inbox ${String(counts["inbox"])}`,
      );
      // Skills asked for: each as an agent gets it. Otherwise their names.
      for (const skill of (result["asked"] as Result[] | undefined) ?? []) {
        const when = typeof skill["when"] === "string" ? `: ${skill["when"]}` : "";
        lines.push("", `Skill ${String(skill["name"])}${when}`);
        if (typeof skill["problem"] === "string") lines.push(skill["problem"]);
        if (typeof skill["text"] === "string") lines.push("", skill["text"], "");
      }
      const missing = (result["missing"] as string[] | undefined) ?? [];
      if (missing.length > 0) lines.push(`no skill named ${missing.join(", ")}`);
      const listed = (result["skills"] as Result[] | undefined) ?? [];
      if (listed.length > 0) {
        lines.push(`skills: ${listed.map((s) => String(s["name"])).join(", ")}`);
      }
      // A skill that cannot be used says why.
      for (const skill of listed) {
        if (typeof skill["problem"] === "string") {
          lines.push(`  ${String(skill["name"])}: ${skill["problem"]}`);
        }
      }
      const here = result["here"] as Result[] | undefined;
      if (here !== undefined) {
        const total = result["here_total"];
        lines.push(`here: ${String(typeof total === "number" ? total : here.length)}`);
        for (const task of here) {
          const project = typeof task["project"] === "string" ? ` · ${task["project"]}` : "";
          lines.push(`  ${taskLine(task)} · ${String(task["match"])}${project}`);
        }
      }
      for (const section of (result["sections"] as Result[] | undefined) ?? []) {
        lines.push(`${String(section["name"])}:`);
        for (const task of (section["tasks"] as Result[] | undefined) ?? [])
          lines.push(`  ${taskLine(task)}`);
      }
      break;
    }
    case "receipt.get":
      lines.push(
        result["found"] === true
          ? `${String(result["status"])} at ${String(result["decided_at"])}, as of ${String(result["as_of"])}`
          : "No receipt for that request ID in this writer scope: nothing was written under it, and the request can be sent again.",
      );
      break;
    case "task.search":
      lines.push(...searchLines(result));
      break;
    case "group.manage": {
      // `ttasks area list` (A3 3.4.10): each area with its active tasks, its projects below it. A
      // write says what it did to which group first.
      const group = result["group"] as Result | undefined;
      if (typeof result["result"] === "string" && group !== undefined) {
        const done = GROUP_DONE[str(result["result"])] ?? str(result["result"]);
        const folder = typeof group["folder"] === "string" ? `: ${group["folder"]}` : "";
        lines.push(`${done} ${str(group["kind"])} ${str(group["name"] ?? group["id"])}${folder}`);
        const also = (result["also"] as Result[] | undefined) ?? [];
        if (also.length > 0)
          lines.push(`Also the folder of ${listed(also.map((p) => str(p["name"])))}.`);
        lines.push(...insideLines(result));
      }
      // A project a line, with the repository in its folder and the folder on this machine. A
      // group's ID shows where its name alone does not name it.
      const facts = (g: Result) =>
        `${g["archived"] === true ? ", archived" : ""}${typeof g["ref"] === "string" ? `, id ${g["ref"]}` : ""}`;
      const project = (g: Result) =>
        `  ${str(g["name"])}${typeof g["repo"] === "string" ? ` [${g["repo"]}]` : ""} (${str(g["active"])}${facts(g)})${typeof g["folder"] === "string" ? `  ${g["folder"]}` : ""}`;
      for (const area of (result["areas"] as Result[] | undefined) ?? []) {
        lines.push(`${str(area["name"])} (${str(area["active"])}${facts(area)})`);
        lines.push(...((area["projects"] as Result[] | undefined) ?? []).map(project));
      }
      const loose = (result["projects"] as Result[] | undefined) ?? [];
      if (loose.length > 0) lines.push("No area", ...loose.map(project));
      // A write takes no cursor: the rest of the list is read with list, in the same space and with
      // the same archived groups.
      if (typeof result["cursor"] === "string") {
        const argv = [
          CLI_NAME,
          "area",
          "list",
          ...(asked.space === undefined ? [] : ["--space", asked.space]),
          ...(asked.archived === true ? ["--archived"] : []),
          "--cursor",
          result["cursor"],
        ];
        lines.push(
          result["action"] === "list"
            ? `More: the same command with --cursor ${result["cursor"]}`
            : `More: ${shellLine(asked.platform ?? process.platform, argv) ?? argv.join(" ")}`,
        );
      }
      break;
    }
    case "prefs.manage":
      // `ttasks prefs` (A3 3.4.11): one key a line, its value or what it takes; a set says what
      // it changed from and to, or that the value was so already.
      if (result["action"] === "set" && Array.isArray(result["changed"])) {
        for (const change of result["changed"] as Result[]) {
          lines.push(prefChangeText(change), ...levelLines(change["to"]));
        }
        lines.push(...levelsReport(result));
        if (result["changed"].length > 0 || result["moved"] !== undefined) break;
        lines.push("Nothing changed: the value was so already.");
      }
      for (const pref of (result["prefs"] as Result[] | undefined) ?? []) {
        const shown =
          result["action"] === "describe"
            ? `${str(pref["summary"])} (${str(pref["shape"])})`
            : `${prefShown(pref["value"])}${pref["is_default"] === true ? " (default)" : ""}`;
        const inForce =
          "in_force" in pref
            ? ` · in force: ${JSON.stringify(pref["in_force"])}, as this build does not read it yet`
            : "";
        const fixed = pref["fixed"] === true ? " · fixed in this build" : "";
        lines.push(
          `${str(pref["key"])}: ${shown}${pref["policy"] === true ? " · policy" : ""}${fixed}${inForce}`,
          ...(result["action"] === "describe" ? [] : levelLines(pref["value"])),
        );
      }
      break;
    case "launch.open": {
      // `ttasks brief`: the pointer brief itself, ready to paste, or how the launch stands.
      const launch = (result["launch"] ?? {}) as Result;
      const copy = result["copy"];
      if (typeof copy === "string") lines.push(copy);
      else lines.push(`Launch ${String(launch["reference"])}: ${String(launch["state"])}`);
      const left = leftOutLine(launch);
      if (left !== undefined) lines.push(left);
      break;
    }
    default:
      return `${JSON.stringify(result, null, 2)}\n`;
  }
  // A warning is part of what happened: a person reads it here, as an agent does in its answer.
  for (const warning of (result["warnings"] as unknown[] | undefined) ?? []) {
    lines.push(`Warning: ${str(warning)}`);
  }
  return `${lines.join("\n")}\n`;
}
