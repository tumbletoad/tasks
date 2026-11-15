// The request path's errors (A3 3.5): every failure becomes the contract's error body. A1's codes
// map through contracts' table (A3 3.5). Bodies never quote a value the caller sent: issues
// name a path and a fixed sentence, and storage's messages are fixed sentences.
import { a1ErrorBody, AppError, type ErrorBody } from "@tasks/contracts";
import { StorageError, type WriteResult } from "@tasks/storage";

/** A feature of an entry that a later step builds. Never a silent drop of what the caller sent. */
export function unsupported(path: string, owner: string): AppError {
  return new AppError({
    code: "invalid_input",
    message: "This service does not support that field yet.",
    hint: `It arrives with ${owner}.`,
    data: { issues: [{ path, message: "Not supported by this service yet" }] },
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

/**
 * A schema failure: `too_large` when every issue is a limit (A3 3.5: over a field, item or
 * request limit), else `invalid_input`, with each issue's path and a fixed sentence. A field the
 * input leaves out is `Missing`, never a wrong type: the caller gave nothing to be wrong.
 */
export function schemaFailure(
  error: {
    readonly issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[];
  },
  input?: unknown,
): AppError {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    message:
      issue.code === "invalid_type" && valueAt(input, issue.path) === undefined
        ? "Missing"
        : (ISSUE[issue.code] ?? "Invalid"),
  }));
  const tooLarge = error.issues.every((issue) => issue.code === "too_big");
  return new AppError({
    code: tooLarge ? "too_large" : "invalid_input",
    message: tooLarge ? "The input is over a limit." : "The input does not match the operation.",
    hint: "Run tasks help <verb> for the arguments.",
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

/** The hint of a refusal whose remedy is another call (A3 3.4.6, 3.5). */
const HINTS: Readonly<Record<string, string>> = {
  TASK_NOT_ACTIVE: "Reopen it first: reopen_task (tasks reopen).",
  // A1 3.10.1: the person chooses; nothing is overwritten unseen.
  UNDO_CONFLICT: "Pass partial to undo the rest (tasks undo --partial), or set the value again.",
  UNDO_BEFORE_FLOOR: "Changes from before the space's last format change stay as they are.",
};

/** A conflict's `reason` when complete_task's wrap-up was held (A3 3.4.8). */
export const ALREADY_WRAPPED = "already_wrapped";
const WRAPPED =
  "The task is already wrapped up with another outcome or other learnings, so nothing was changed.";
const WRAPPED_HINT =
  "To add to it, log an entry: add_entry (tasks log). To finish it again, reopen it first: reopen_task (tasks reopen).";

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
 * base.
 */
export function resultFailure(
  result: WriteResult,
  hints: Readonly<Record<string, string>> = {},
  wrapUp?: number,
): AppError {
  const problem = result.error;
  // complete_task on a task wrapped up already with another outcome or other learnings: the
  // writer holds the wrap-up whatever the base, so a fresh read changes nothing. The message says
  // what happened, `reason` names it for a script, and the hint says what the person can do.
  const wrapped = heldWrapUp(result, wrapUp);
  const hint = wrapped
    ? WRAPPED_HINT
    : problem === undefined
      ? undefined
      : (hints[problem.code] ?? HINTS[problem.code]);
  const base: ErrorBody =
    problem === undefined
      ? { code: "conflict", message: "A field changed after the base: read again." }
      : {
          ...a1ErrorBody(problem.code, wrapped ? WRAPPED : problem.message, {
            ...(problem.op === undefined ? {} : { op: problem.op }),
            ...(problem.field === undefined ? {} : { field: problem.field }),
            ...(problem.at === undefined ? {} : { at: problem.at }),
            ...(problem.reason === undefined ? {} : { reason: problem.reason }),
          }),
          ...(hint === undefined ? {} : { hint }),
        };
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
    // An undo's: what the change wrote, and what undoing it would set back ("Restore mine").
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
      conflicts,
      ...(result.replayed === true ? { replayed: true } : {}),
    },
  });
}

function withReplay(body: ErrorBody): ErrorBody {
  return { ...body, data: { ...body.data, replayed: true } };
}

/** A space the service does not serve, or not now (A3 3.5's transport table). */
export function spaceUnavailable(reason: string, retryable: boolean, state?: string): AppError {
  return new AppError({
    code: "space_unavailable",
    message:
      reason === "opening"
        ? "The space is still opening."
        : "The service does not serve that space now.",
    hint: reason === "opening" ? "Try again in a moment." : "Run tasks space list.",
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
