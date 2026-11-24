// The request path's errors (A3 3.5): every failure becomes the contract's error body. A1's codes
// map through contracts' table (A3 3.5). Bodies never quote a value the caller sent: issues
// name a path and a fixed sentence, and storage's messages are fixed sentences.
import { CLI_NAME } from "@ttasks/brand";
import {
  a1ErrorBody,
  AppError,
  cliFaces,
  findEntry,
  laterIn,
  newerWorkJson,
  type ErrorBody,
} from "@ttasks/contracts";
import { StorageError, type WriteResult } from "@ttasks/storage";
import { USER_ONLY } from "./caller.ts";

/**
 * Refuses a call that uses what a later step builds (contracts' later.ts), naming the step, on
 * every face. The same list keeps it out of the MCP tool list and docs/agents/tools.md; the
 * command line's help still offers it. What the person has already and agents do not yet is
 * refused to an agent as anything else only the user may do.
 */
export function refuseLater(
  entry: string,
  input: Readonly<Record<string, unknown>>,
  audience: "user" | "agent",
): void {
  const row = laterIn(entry, input, audience);
  if (row === undefined) return;
  if (row.audience === "agent") throw USER_ONLY();
  throw new AppError({
    code: "invalid_input",
    message: "This service does not support that field yet.",
    hint: `It arrives with ${row.step}.`,
    data: { issues: [{ path: row.field, message: "Not supported by this service yet" }] },
  });
}

/** One field the handler refuses: a fixed sentence at a path. */
export function invalid(path: string, message: string, hint?: string): AppError {
  return new AppError({
    code: "invalid_input",
    message: `${message}.`,
    ...(hint === undefined ? {} : { hint }),
    data: { issues: [{ path, message }] },
  });
}

/** Zod's issue codes as fixed sentences: a message never quotes the input, nor a key it holds. */
const ISSUE: Readonly<Record<string, string>> = {
  invalid_type: "Wrong type",
  too_big: "Over its limit",
  too_small: "Too short or too few",
  invalid_value: "Not an allowed value",
  invalid_format: "Wrong format",
  invalid_union: "Not one of the allowed forms",
  unrecognized_keys: "Unknown field",
  not_multiple_of: "Not an allowed number",
};

/** The value at a schema issue's path in the input, or undefined where nothing is. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let node = input;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/** Fields an earlier build took, and the field a caller gives instead now. */
const RENAMED: Readonly<Record<string, string>> = { place: "folder" };

/**
 * Fields an earlier build took that no operation takes now: get_task's `bind`, since a launch's
 * session is decided by the connection. A fixed table, so a refusal names only keys the product
 * knows, never one a caller made up.
 */
const RETIRED: ReadonlySet<string> = new Set(["bind"]);

/** status's guides became skills: what an app that kept the old tool list sends instead. */
const GUIDE_NOW =
  'guide is now skills: skills ["working-a-task"] for work, ["organizing"] for triage or organize.';

/** The form of a field whose pattern the caller cannot see in its name, by the field's name. */
const FORMATS: Readonly<Record<string, string>> = {
  request_id: "16 to 64 characters from A-Z, a-z, 0-9, _ and -",
};

/**
 * A limit as the caller fixes it: what the field takes at most and how much it was given. Only
 * lengths and counts, never the value.
 */
function overLimit(maximum: unknown, origin: unknown, value: unknown): string {
  const most = typeof maximum === "number" || typeof maximum === "bigint" ? String(maximum) : "";
  if (most === "") return ISSUE["too_big"] ?? "Over its limit";
  if (origin === "string") {
    const given = typeof value === "string" ? `, not ${String(value.length)}` : "";
    return `At most ${most} characters${given}`;
  }
  if (origin === "array") {
    const given = Array.isArray(value) ? `, not ${String(value.length)}` : "";
    return `At most ${most} items${given}`;
  }
  return `At most ${most}`;
}

/**
 * A schema failure: `too_large` when every issue is a limit (A3 3.5: over a field, item or
 * request limit), else `invalid_input`, with each issue's path and a fixed sentence: a limit says
 * how much the field takes and how much it got, a format what it looks like. A field the input
 * leaves out is `Missing`, never a wrong type: the caller gave nothing to be wrong. A field an
 * earlier build took is named with the field that replaced it, or told to leave it out when none
 * did, so the caller fixes its call.
 * `face` and `entry` say where the caller reads its help: a command names its own.
 */
export function schemaFailure(
  error: {
    readonly issues: readonly {
      readonly code: string;
      readonly path: readonly PropertyKey[];
      readonly keys?: readonly string[];
      readonly maximum?: unknown;
      readonly origin?: unknown;
    }[];
  },
  input?: unknown,
  face: Face = "mcp",
  entry?: string,
): AppError {
  const renamed: string[] = [];
  const retired: string[] = [];
  const first = error.issues.slice(0, 20);
  // Only status took guide, and only status takes the skills that replaced it.
  const oldGuide = (issue: (typeof first)[number]) =>
    entry === "space.status" &&
    issue.code === "unrecognized_keys" &&
    issue.path.length === 0 &&
    issue.keys?.includes("guide") === true;
  const guide = first.some(oldGuide);
  const issues = first.flatMap((issue) => {
    const path = issue.path.map(String).join(".");
    // An old field, or its name in a list of fields such as update_task's clear.
    const value = valueAt(input, issue.path);
    if (
      issue.code === "invalid_value" &&
      typeof value === "string" &&
      Object.hasOwn(RENAMED, value)
    ) {
      const now = RENAMED[value] ?? "";
      renamed.push(`${value} is now ${now}`);
      return [{ path, message: `Now ${now}` }];
    }
    if (oldGuide(issue)) return [{ path: "guide", message: "Now skills" }];
    const keys = issue.keys ?? [];
    const known = keys.filter((key) => Object.hasOwn(RENAMED, key) || RETIRED.has(key));
    if (issue.code === "unrecognized_keys" && known.length > 0) {
      const at = (key: string) => (path === "" ? key : `${path}.${key}`);
      return [
        ...known.map((key) => {
          if (RETIRED.has(key)) {
            retired.push(key);
            return { path: at(key), message: "No longer taken" };
          }
          const now = RENAMED[key] ?? "";
          renamed.push(`${key} is now ${now}`);
          return { path: at(key), message: `Now ${now}` };
        }),
        ...(known.length < keys.length
          ? [{ path, message: ISSUE["unrecognized_keys"] ?? "" }]
          : []),
      ];
    }
    const format = FORMATS[String(issue.path[issue.path.length - 1])];
    return [
      {
        path,
        message:
          issue.code === "invalid_type" && value === undefined
            ? "Missing"
            : issue.code === "too_big"
              ? overLimit(issue.maximum, issue.origin, value)
              : issue.code === "invalid_format" && format !== undefined
                ? format
                : (ISSUE[issue.code] ?? "Invalid"),
      },
    ];
  });
  const tooLarge = error.issues.every((issue) => issue.code === "too_big");
  const found = face === "cli" && entry !== undefined ? findEntry(entry) : undefined;
  const verb = found === undefined ? undefined : cliFaces(found)[0]?.verb;
  const help = verb === undefined ? undefined : `Run ${CLI_NAME} help ${verb} for the arguments.`;
  const fixes = [
    ...(renamed.length > 0
      ? [`${[...new Set(renamed)].join(", ")}: "cwd", an absolute folder or one under ~.`]
      : []),
    ...(retired.length > 0
      ? [`${[...new Set(retired)].join(", ")} is no longer taken: leave it out.`]
      : []),
  ];
  const hint = guide ? GUIDE_NOW : fixes.length > 0 ? fixes.join(" ") : help;
  return new AppError({
    code: tooLarge ? "too_large" : "invalid_input",
    message: tooLarge ? "The input is over a limit." : "The input does not match the operation.",
    ...(hint === undefined ? {} : { hint }),
    data: { issues },
  });
}

/** A failure of the storage layer (StorageError) as its body, through A1's table. */
export function storageFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof StorageError) {
    const body = a1ErrorBody(error.code, error.message);
    return new AppError(body);
  }
  return new AppError({ code: "internal", message: "Something went wrong in the service." });
}

/**
 * A request ID whose receipt in the caller's writer scope is another request's, decided at `at`,
 * as the writer refuses one (REQUEST_ID_REUSED).
 */
export function requestIdReused(at: number): AppError {
  return new AppError(
    a1ErrorBody(
      "REQUEST_ID_REUSED",
      "This request ID was used for another change: review it, then use a new ID",
      { field: "request_id", at },
    ),
  );
}

/** The input path of the caller's own operation `op`, with the field a refusal names there. */
export type PathOf = (op: number, field: string | undefined) => string | undefined;

/** Where the caller reads a hint: the commands a person types, an agent's tools, or the UI. */
export type Face = "cli" | "mcp" | "ui";

/** How the caller on `face` does `entry`: the command or the tool, or nothing in the UI. */
export function way(face: Face, entry: string, args: string): string | undefined {
  const found = findEntry(entry);
  if (face === "mcp") return found?.faces.mcp?.tool ?? entry;
  if (face === "ui") return undefined;
  const verb = (found === undefined ? undefined : cliFaces(found)[0])?.verb ?? entry;
  return `${CLI_NAME} ${verb}${args === "" ? "" : ` ${args}`}`;
}

const said = (words: string, how: string | undefined) =>
  how === undefined ? `${words}.` : `${words}: ${how}.`;

/** The hint of a refusal whose remedy is another call, in the words of the caller's face. */
function hintOf(code: string, face: Face): string | undefined {
  switch (code) {
    case "TASK_NOT_ACTIVE":
      return said("Reopen it first", way(face, "task.reopen", "<task> --reason <why>"));
    // The person chooses; nothing is overwritten unseen.
    case "UNDO_CONFLICT":
      return face === "mcp"
        ? "Pass partial to undo the rest, or set the value again."
        : face === "cli"
          ? `Undo the rest with ${CLI_NAME} undo --partial, or set the value again.`
          : "Undo the rest, or set the value again.";
    case "UNDO_BEFORE_FLOOR":
      return "Changes from before the space's last format change stay as they are.";
    default:
      return undefined;
  }
}

/** A conflict's `reason` when complete_task's wrap-up was held (A3 3.4.8). */
export const ALREADY_WRAPPED = "already_wrapped";
const WRAPPED =
  "The task is already wrapped up with another outcome or other learnings, so nothing was changed.";

/** What to do about a task wrapped up already: log on it, or reopen it and finish it again. */
function wrappedHint(face: Face, task: string | undefined): string {
  const ref = task ?? "<task>";
  return [
    said("To add to it, log an entry", way(face, "entry.add", `${ref} <text>`)),
    said("To finish it again, reopen it first", way(face, "task.reopen", `${ref} --reason <why>`)),
  ].join(" ");
}

/**
 * Who wrote a version, as people read it (A3 3.10): an import, the user, else the actor's label.
 * read.ts labels entries and history rows by the same rule.
 */
export const byOf = (by: { kind: string; label: string; origin?: string }): string =>
  by.origin === "import" ? "import" : by.kind === "human" ? "user" : by.label;

/**
 * Whether a conflict is complete_task's held wrap-up (A3 3.4.8): every conflict is on `wrap` of
 * the request's `once` wrap-up operation, on a task the writer found wrapped. A base conflict on
 * that operation finds the task not wrapped (else it is held), so the value tells them apart. A
 * replay's receipt holds no value, and is read as held, the case a person meets.
 */
function heldWrapUp(result: WriteResult, op: number | undefined): boolean {
  if (op === undefined || result.status !== "conflict" || result.conflicts.length === 0) {
    return false;
  }
  return result.conflicts.every((c) => {
    if (c.entity !== "tasks" || c.field !== "wrap" || c.op !== op) return false;
    if (c.value === undefined) return true;
    return (
      typeof c.value === "object" &&
      c.value !== null &&
      (c.value as Record<string, unknown>)["wrap_state"] === "wrapped"
    );
  });
}

/**
 * A conflict or a refusal the writer decided, as its body (A3 3.5). `hints` replaces a code's hint
 * where one entry's remedy differs: a redo's UNDO_CONFLICT has no partial form. `wrapUp` is the
 * index of complete_task's `once` wrap-up operation, the only one the writer holds whatever the
 * base. `face` is where the caller reads the hint: a command names commands, a tool tools. `own`
 * turns the request's operation index into the caller's own, undefined for one it did not ask for.
 * `pathOf` names where in the input that operation came from, so the caller fixes that draft.
 */
export function resultFailure(
  result: WriteResult,
  hints: Readonly<Record<string, string>> = {},
  wrapUp?: number,
  face: Face = "mcp",
  own: (i: number) => number | undefined = (i) => i,
  pathOf?: PathOf,
): AppError {
  const problem = result.error;
  const op = problem?.op === undefined ? undefined : own(problem.op);
  // complete_task on a task wrapped up already with another outcome or other learnings: the
  // writer holds the wrap-up whatever the base, so a fresh read changes nothing. The message says
  // what happened, `reason` names it for a script, and the hint says what the person can do.
  const wrapped = heldWrapUp(result, wrapUp);
  const hint = wrapped
    ? wrappedHint(face, result.conflicts[0]?.ref)
    : problem === undefined
      ? undefined
      : (hints[problem.code] ?? hintOf(problem.code, face));
  const path = op === undefined ? undefined : pathOf?.(op, problem?.field);
  let base: ErrorBody =
    problem === undefined
      ? { code: "conflict", message: "A field changed after the base: read again." }
      : {
          ...a1ErrorBody(problem.code, wrapped ? WRAPPED : problem.message, {
            ...(op === undefined ? {} : { op }),
            ...(problem.field === undefined ? {} : { field: problem.field }),
            ...(problem.at === undefined ? {} : { at: problem.at }),
            ...(problem.reason === undefined ? {} : { reason: problem.reason }),
          }),
          ...(hint === undefined ? {} : { hint }),
        };
  if (path !== undefined && problem !== undefined) {
    base = { ...base, data: { ...base.data, issues: [{ path, message: problem.message }] } };
  }
  if (result.status !== "conflict") {
    return new AppError(result.replayed === true ? withReplay(base) : base);
  }
  const conflicts = result.conflicts.map((c) => ({
    ...(c.ref === undefined ? {} : { task: c.ref }),
    // A row other than the task itself, by its table and ID: a link, a place, or a child row that
    // keeps a create from being undone or a redo from taking a key (A1 3.10). A source belongs to
    // no one task, so its ID is all that names it.
    ...(c.entity === "tasks" ? {} : { entity: c.entity, id: c.id }),
    field: c.field,
    ...(c.value === undefined ? {} : { value: c.value }),
    // An undo's: what the change wrote, and what undoing it would set back.
    ...(c.wrote === undefined ? {} : { wrote: c.wrote }),
    ...(c.restore === undefined ? {} : { restore: c.restore }),
    version: c.version,
    by: byOf(c.by),
    at: new Date(c.at).toISOString(),
  }));
  return new AppError({
    ...base,
    hint: hint ?? "Read the task again, then send the change with a new request ID.",
    data: {
      ...base.data,
      ...(wrapped ? { reason: ALREADY_WRAPPED } : {}),
      as_of: result.as_of,
      // An undo or redo's UNDO_CONFLICT names the commit it met: a caller that named none (Ctrl+Z)
      // passes it to Undo the rest, so it never reaches a newer change instead.
      ...(result.target === undefined ? {} : { commit: result.target }),
      // A refused redo's: every undone change it tried, which stay for the next redo.
      ...(result.passed === undefined ? {} : { passed_over: result.passed }),
      // An undo's or a redo's: who changed which task since.
      ...(result.newer === undefined ? {} : newerWorkJson(result.newer)),
      conflicts,
      ...(result.replayed === true ? { replayed: true } : {}),
    },
  });
}

function withReplay(body: ErrorBody): ErrorBody {
  return { ...body, data: { ...body.data, replayed: true } };
}

/**
 * A space the service does not serve, or not now. `wayOut`: what the space's state tells a person
 * to run, which `ttasks space list` shows with the space's folder.
 */
export function spaceUnavailable(
  reason: string,
  retryable: boolean,
  state?: string,
  wayOut?: string,
): AppError {
  return new AppError({
    code: "space_unavailable",
    message:
      reason === "opening"
        ? "The space is still opening."
        : "The service does not serve that space now.",
    hint: retryable
      ? "Try again in a moment."
      : wayOut === undefined
        ? "Run ttasks space list."
        : `${wayOut} Run ttasks space list for its folder.`,
    data: { reason, retryable, ...(state === undefined ? {} : { state }) },
  });
}

/**
 * A write to a space that takes no write on this machine (A3 3.5 `read_only`). `message`, when
 * given, says why in the words people read (A1 3.2: a synced folder, a network file system); it
 * never holds a path.
 */
export function readOnly(reason: string | undefined, message?: string): AppError {
  return new AppError({
    code: "read_only",
    message: message ?? "The space is read-only on this machine.",
    data: { reason: reason ?? "read_only", retryable: false },
  });
}
