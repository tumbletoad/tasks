// What the CLI prints (A2 3.10.2, 3.10.3; A3 3.5). With --json, stdout holds exactly one JSON
// document: the operation's result, or `{"error": {code, class, message, hint, data}}`. Without
// it, stdout holds plain text for a person and every write names its space. Diagnostics go to
// stderr. The exit code follows the error's class.
import { CLI_NAME } from "@tasks/brand";
import { RpcError } from "@tasks/bridge/protocol";
import {
  errorClass,
  EXIT_CODES,
  isErrorCode,
  messageWithHint,
  AppError,
  type ErrorBody,
  type ErrorClass,
} from "@tasks/contracts";
import type { Io } from "./io.ts";

/** A scalar as text; anything else as nothing. */
export const str = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

export const RESTART_HINT = `Restart the service: ${CLI_NAME} service restart.`;

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
  return { code: "internal", message: "Something went wrong.", hint: "Run: tasks doctor" };
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
    // A conflict names its task and field, and who wrote it when (A3 3.5), never the value.
    const conflicts = body.data?.["conflicts"];
    if (Array.isArray(conflicts)) {
      for (const c of conflicts.slice(0, 5) as Record<string, unknown>[]) {
        const what = [str(c["task"]), str(c["field"])].filter((part) => part !== "").join(" ");
        const who = str(c["by"]) === "" ? "" : `: ${str(c["by"])} at ${str(c["at"])}`;
        io.stderr(`  ${what}${who}\n`);
      }
    }
  }
  return EXIT_CODES[cls];
}

/** A usage error (exit 2): the message names options and verbs, never a value. */
export function printUsage(io: Io, json: boolean, message: string): number {
  return printError(io, json, {
    code: "invalid_input",
    message,
    hint: "Run tasks help for the commands.",
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

/** One task: its one state (the status while it is active), its priority, due date and inbox. */
function taskLine(task: Result): string {
  const parts = [finished(task["lifecycle"]) ?? str(task["status"]), `p${str(task["priority"])}`];
  const due = task["due"];
  if (typeof due === "string") parts.push(`due ${due}`);
  if (task["inbox"] === true) parts.push("inbox");
  return `${String(task["ref"])}  ${String(task["title"])}  (${parts.join(", ")})`;
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
 * was found in and whether its log entry went there, or the tasks that share its keys.
 */
function draftLine(task: Result, space: string): string {
  if (task["result"] !== "exists") return `Added ${String(task["ref"])} to ${space}`;
  const ambiguous = task["ambiguous"];
  if (Array.isArray(ambiguous)) {
    return `Several tasks in ${space} have its source key: ${ambiguous.map(String).join(", ")}`;
  }
  const lifecycle = task["lifecycle"] === "active" ? "" : ` (${String(task["lifecycle"])})`;
  const logged = task["log_added"] === true ? ", log entry added" : "";
  return `Found ${String(task["ref"])}${lifecycle} in ${space} by its source key${logged}`;
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
/** What `tasks area` says a write did, by its result. */
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

export function render(entry: string, result: Result, space: string): string {
  const lines: string[] = [];
  switch (entry) {
    case "task.add":
      for (const task of (result["tasks"] as Result[] | undefined) ?? []) {
        lines.push(`${draftLine(task, space)}${replay(result)}`);
      }
      break;
    case "task.update": {
      const fields = (result["fields"] as string[] | undefined) ?? [];
      lines.push(
        result["result"] === "no_change"
          ? `No change to ${String(result["task"])} in ${space}${replay(result)}`
          : `Updated ${String(result["task"])} in ${space}: ${fields.join(", ")}${replay(result)}`,
      );
      break;
    }
    case "entry.add":
      lines.push(
        `${result["kind"] === "note" ? "Noted" : "Logged"} ${String(result["entry"])} on ${String(result["task"])} in ${space}${replay(result)}`,
      );
      break;
    case "task.finish": {
      const dropped = result["lifecycle"] === "archived";
      lines.push(
        result["result"] === "no_change"
          ? `${String(result["task"])} is already ${dropped ? "dropped" : "completed"} in ${space}${replay(result)}`
          : `${dropped ? "Dropped" : "Completed"} ${String(result["task"])} in ${space}${replay(result)}`,
      );
      for (const f of (result["follow_ups"] as Result[] | undefined) ?? []) {
        const ref = typeof f["ref"] === "string" ? f["ref"] : undefined;
        lines.push(
          f["result"] !== "exists"
            ? `Added ${String(ref)} to ${space}`
            : ref === undefined
              ? `Several tasks in ${space} have a follow-up's source key`
              : `Found ${ref} in ${space} by a follow-up's source key`,
        );
      }
      break;
    }
    case "task.reopen":
      lines.push(`Reopened ${String(result["task"])} in ${space}${replay(result)}`);
      break;
    case "history.undo":
    case "history.redo": {
      const tasks = ((result["tasks"] as unknown[] | undefined) ?? []).map(str);
      const count = typeof result["task_count"] === "number" ? result["task_count"] : tasks.length;
      const more = count > tasks.length ? ` and ${String(count - tasks.length)} more` : "";
      const which = tasks.length === 0 ? "" : ` to ${tasks.join(", ")}${more}`;
      const done =
        result["result"] === "redone"
          ? "Redid your change"
          : result["result"] !== "partial"
            ? "Undid your change"
            : tasks.length > 0 || result["tasks"] === undefined
              ? "Undid part of your change"
              : "Nothing of your change was left to undo";
      lines.push(`${done}${which} in ${space}${replay(result)}`);
      const kept = (result["unresolved"] as Result[] | undefined) ?? [];
      if (kept.length > 0) lines.push("Kept as others set them:");
      for (const field of kept) {
        const task = typeof field["task"] === "string" ? `${field["task"]} ` : "";
        lines.push(`  ${task}${str(field["field"])}: ${str(field["by"])} at ${str(field["at"])}`);
      }
      // A3 3.7.4: a newer change by a script of the same person, which no undo reaches. A partial
      // undo that kept a script's field has said so above.
      const scripted = result["script_change"] as Result | undefined;
      if (scripted !== undefined && !kept.some((field) => field["by"] === "script")) {
        lines.push(
          `Not undone: a script ${SCRIPT_VERBS[str(scripted["change"])] ?? "changed"} ${str(scripted["task"])} after that, and a script's changes are not on your undo stack.`,
        );
      }
      break;
    }
    case "task.get": {
      const task = (result["task"] ?? {}) as Result;
      lines.push(taskLine(task));
      if (typeof task["summary"] === "string" && task["summary"] !== "")
        lines.push(`  ${task["summary"]}`);
      const folder = task["folder"] as Result | undefined;
      if (typeof folder?.["path"] === "string") {
        lines.push(
          `  folder: ${folder["path"]}${folder["of"] === "project" ? " (its project's)" : ""}`,
        );
      } else if (typeof folder?.["machine"] === "string") {
        lines.push(`  folder: on ${folder["machine"]}`);
      }
      const sections = (result["sections"] ?? task) as Result;
      for (const note of (sections["instructions"] as Result[] | undefined) ?? []) {
        lines.push(`  ${String(note["ref"])} user → agents: ${String(note["text"])}`);
      }
      if (typeof sections["context"] === "string" && sections["context"] !== "") {
        lines.push("", sections["context"]);
      }
      for (const source of (sections["sources"] as Result[] | undefined) ?? []) {
        lines.push(
          `  source: ${String(source["title"])}${typeof source["key"] === "string" ? ` [${source["key"]}]` : ""}`,
        );
      }
      for (const note of (sections["notes"] as Result[] | undefined) ?? []) {
        lines.push(
          `  ${String(note["ref"])} ${String(note["author"])}${note["for_agents"] === true ? " → agents" : ""}: ${String(note["text"])}`,
        );
      }
      for (const entry of (sections["log"] as Result[] | undefined) ?? []) {
        lines.push(
          `  ${String(entry["ref"])} ${String(entry["kind"])} ${String(entry["author"])}: ${String(entry["text"])}`,
        );
      }
      for (const row of (sections["history"] as Result[] | undefined) ?? []) {
        lines.push(`  #${String(row["seq"])} ${String(row["actor"])}: ${String(row["what"])}`);
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
      if (typeof result["guide"] === "string") lines.push("", result["guide"], "");
      const here = result["here"] as Result[] | undefined;
      if (here !== undefined) {
        const total = result["here_total"];
        lines.push(`here: ${String(typeof total === "number" ? total : here.length)}`);
        for (const task of here) lines.push(`  ${taskLine(task)} · ${String(task["match"])}`);
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
          : "No receipt for that request ID in this writer scope.",
      );
      break;
    case "task.search":
      lines.push(...searchLines(result));
      break;
    case "group.manage": {
      // `tasks area list` (A3 3.4.10): each area with its active tasks, its projects below it. A
      // write says what it did to which group first.
      const group = result["group"] as Result | undefined;
      if (typeof result["result"] === "string" && group !== undefined) {
        const done = GROUP_DONE[str(result["result"])] ?? str(result["result"]);
        const folder = typeof group["folder"] === "string" ? `: ${group["folder"]}` : "";
        lines.push(`${done} ${str(group["kind"])} ${str(group["name"])}${folder}`);
        if (typeof result["moved"] === "number" && result["moved"] > 0) {
          lines.push(`${String(result["moved"])} task folders moved along.`);
        }
      }
      // A project a line, with its folder on this machine.
      const project = (g: Result) =>
        `  ${str(g["name"])} (${str(g["active"])})${typeof g["folder"] === "string" ? `  ${g["folder"]}` : ""}`;
      for (const area of (result["areas"] as Result[] | undefined) ?? []) {
        lines.push(`${str(area["name"])} (${str(area["active"])})`);
        lines.push(...((area["projects"] as Result[] | undefined) ?? []).map(project));
        if (typeof area["more_projects"] === "number") {
          lines.push(`  and ${String(area["more_projects"])} more projects`);
        }
      }
      const loose = (result["projects"] as Result[] | undefined) ?? [];
      if (loose.length > 0) lines.push("No area", ...loose.map(project));
      break;
    }
    case "prefs.manage":
      // `tasks prefs` (A3 3.4.11): one key a line, its value or what it takes.
      for (const pref of (result["prefs"] as Result[] | undefined) ?? []) {
        const shown =
          result["action"] === "describe"
            ? `${str(pref["summary"])} (${str(pref["shape"])})`
            : `${JSON.stringify(pref["value"])}${pref["is_default"] === true ? " (default)" : ""}`;
        lines.push(`${str(pref["key"])}: ${shown}${pref["policy"] === true ? " · policy" : ""}`);
      }
      break;
    case "launch.open": {
      // `tasks brief`: the pointer brief itself, ready to paste, or how the launch stands.
      const launch = (result["launch"] ?? {}) as Result;
      const copy = result["copy"];
      if (typeof copy === "string") lines.push(copy);
      else lines.push(`Launch ${String(launch["reference"])}: ${String(launch["state"])}`);
      break;
    }
    default:
      lines.push(JSON.stringify(result, null, 2));
  }
  return `${lines.join("\n")}\n`;
}
