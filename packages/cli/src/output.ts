// What the CLI prints (A2 3.10.2, 3.10.3; A3 3.5). With --json, stdout holds exactly one JSON
// document: the operation's result, or `{"error": {code, class, message, hint, data}}`. Without
// it, stdout holds plain text for a person and every write names its space. Diagnostics go to
// stderr. The exit code follows the error's class.
import { RpcError } from "@tasks/bridge/protocol";
import {
  errorClass,
  EXIT_CODES,
  isErrorCode,
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
        hint: "tasks service restart",
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
    const hint = body.hint === undefined ? "" : ` ${body.hint}`;
    io.stderr(`error ${body.code}: ${body.message}${hint}\n`);
    const issues = body.data?.["issues"];
    if (Array.isArray(issues)) {
      for (const issue of issues.slice(0, 5) as { path?: unknown; message?: unknown }[]) {
        io.stderr(`  ${str(issue.path)}: ${str(issue.message)}\n`);
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

function taskLine(task: Result): string {
  const parts = [str(task["status"]), `p${str(task["priority"])}`];
  const due = task["due"];
  if (typeof due === "string") parts.push(`due ${due}`);
  if (task["inbox"] === true) parts.push("inbox");
  if (task["lifecycle"] !== "active") parts.push(String(task["lifecycle"]));
  return `${String(task["ref"])}  ${String(task["title"])}  (${parts.join(", ")})`;
}

/** Plain text for a person, per entry. `space` names the space a write went to (A2 3.10.2). */
export function render(entry: string, result: Result, space: string): string {
  const lines: string[] = [];
  switch (entry) {
    case "task.add":
      for (const task of (result["tasks"] as Result[] | undefined) ?? []) {
        lines.push(`Added ${String(task["ref"])} to ${space}${replay(result)}`);
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
      lines.push(`Completed ${String(result["task"])} in ${space}${replay(result)}`);
      for (const f of (result["follow_ups"] as Result[] | undefined) ?? []) {
        lines.push(`Added ${String(f["ref"])} to ${space}`);
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
            : tasks.length > 0
              ? "Undid part of your change"
              : "Nothing of your change was left to undo";
      lines.push(`${done}${which} in ${space}${replay(result)}`);
      const kept = (result["unresolved"] as Result[] | undefined) ?? [];
      if (kept.length > 0) lines.push("Kept as others set them:");
      for (const field of kept) {
        const task = typeof field["task"] === "string" ? `${field["task"]} ` : "";
        lines.push(`  ${task}${str(field["field"])}: ${str(field["by"])} at ${str(field["at"])}`);
      }
      break;
    }
    case "task.get": {
      const task = (result["task"] ?? {}) as Result;
      lines.push(taskLine(task));
      if (typeof task["summary"] === "string" && task["summary"] !== "")
        lines.push(`  ${task["summary"]}`);
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
      lines.push(`as of ${String(result["as_of"])}`);
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
      lines.push(`as of ${String(result["as_of"])}`);
      break;
    }
    case "receipt.get":
      lines.push(
        result["found"] === true
          ? `${String(result["status"])} at ${String(result["decided_at"])}, as of ${String(result["as_of"])}`
          : "No receipt for that request ID in this writer scope.",
      );
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
