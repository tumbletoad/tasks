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

/**
 * A schema failure: `too_large` when every issue is a limit (A3 3.5: over a field, item or
 * request limit), else `invalid_input`, with each issue's path and a fixed sentence.
 */
export function schemaFailure(error: {
  readonly issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[];
}): AppError {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: ISSUE[issue.code] ?? "Invalid",
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
};

/** A conflict or a refusal the writer decided, as its body (A3 3.5). */
export function resultFailure(result: WriteResult): AppError {
  const problem = result.error;
  const hint = problem === undefined ? undefined : HINTS[problem.code];
  const base: ErrorBody =
    problem === undefined
      ? { code: "conflict", message: "A field changed after the base: read again." }
      : {
          ...a1ErrorBody(problem.code, problem.message, {
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
    field: c.field,
    ...(c.value === undefined ? {} : { value: c.value }),
    version: c.version,
    // As read.ts labels entries and history (A3 3.10): an import, the user, else the actor.
    by: c.by.origin === "import" ? "import" : c.by.kind === "human" ? "user" : c.by.label,
    at: new Date(c.at).toISOString(),
  }));
  return new AppError({
    ...base,
    hint: "Read the task again, then send the change with a new request ID.",
    data: {
      ...base.data,
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
