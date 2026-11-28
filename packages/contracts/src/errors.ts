// Error codes and the classes and exit codes they belong to. This module has
// no dependencies, so the browser client can use AppError without loading Zod.

/** The CLI's exit code for each class. */
export const EXIT_CODES = {
  success: 0,
  internal: 1,
  usage: 2,
  not_found: 3,
  conflict: 4,
  forbidden: 5,
  service: 6,
  version: 7,
  space: 8,
  unbound: 9,
  partial: 10,
  interrupted: 130,
} as const;

export type ExitClass = keyof typeof EXIT_CODES;
export type ErrorClass = Exclude<ExitClass, "success" | "partial" | "interrupted">;

export interface ErrorSpec {
  /** The A2 class, which sets the CLI's exit code. */
  readonly class: ErrorClass;
  /** The HTTP status of the UI's API. */
  readonly http: number;
  /** When the code is returned, in a few words. */
  readonly when: string;
}

/**
 * Every error code an entry may return, with its class and HTTP status.
 * A3 names the status of the common codes. The others take their class's status.
 */
export const ERROR_CODES = {
  invalid_input: { class: "usage", http: 400, when: "Schema or rule violation" },
  not_found: { class: "not_found", http: 404, when: "No task, group, entry or cursor there" },
  ambiguous: { class: "not_found", http: 404, when: "A reference matches several entities" },
  unbound: { class: "unbound", http: 404, when: "No task given and the call is no session's" },
  launch_unknown: { class: "not_found", http: 404, when: "Unknown launch reference" },
  conflict: { class: "conflict", http: 409, when: "base older than a touched field" },
  wrong_tool: { class: "usage", http: 400, when: "Completing or reopening with the wrong tool" },
  forbidden: { class: "forbidden", http: 403, when: "User-only, policy, grant or limit rule" },
  request_id_conflict: { class: "conflict", http: 409, when: "Same request_id, different intent" },
  applied_earlier: {
    class: "conflict",
    http: 409,
    when: "Another version applied this request_id: nothing written now",
  },
  too_large: { class: "usage", http: 413, when: "Over a field, item or request limit" },
  cursor_expired: { class: "not_found", http: 404, when: "Search cursor no longer valid" },
  space_unavailable: { class: "space", http: 503, when: "The space cannot answer now" },
  service_unavailable: { class: "service", http: 503, when: "The service could not be reached" },
  read_only: { class: "space", http: 503, when: "The space is read-only on this machine" },
  op_unknown: { class: "version", http: 404, when: "The service does not know the entry" },
  internal: { class: "internal", http: 500, when: "A bug" },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** `service_unavailable` reasons that the CLI reports with class `version`, exit 7. */
export const VERSION_REASONS = ["restart_session", "service_too_old"] as const;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/** The class of an error, taking the reason into account. */
export function errorClass(code: ErrorCode, reason?: string): ErrorClass {
  if (
    code === "service_unavailable" &&
    (VERSION_REASONS as readonly string[]).includes(reason ?? "")
  ) {
    return "version";
  }
  return ERROR_CODES[code].class;
}

/** The error body of every face: `{"error": {code, message, hint, data}}`. */
export interface ErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Thrown by the typed client and by handlers. `message` is one sentence, `hint` the next step. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly data: Readonly<Record<string, unknown>>;

  constructor(body: ErrorBody) {
    super(body.message);
    this.name = "AppError";
    this.code = body.code;
    this.hint = body.hint;
    this.data = body.data ?? {};
  }

  toBody(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      data: this.data,
    };
  }
}

/** A text as compared for "says the same": lower case, one space, no closing punctuation. */
const plain = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?:]+$/, "")
    .trim();

/** Whether `text` ends with `tail` as whole words: the message's last instruction is the hint. */
const endsWith = (text: string, tail: string): boolean =>
  text.endsWith(tail) &&
  (text.length === tail.length || /[^a-z0-9_-]/.test(text.charAt(text.length - tail.length - 1)));

/**
 * The text form of a message and its hint, `<message>. <hint>`, for every face that prints
 * one (the CLI, the MCP tools). The message ends with a full stop, added when it has none. A hint
 * that is a bare command (`<cli> …`) follows `Run: `. A hint the message already ends with (whole
 * words, compared plainly) is left out, so a message and its hint never say the same thing twice;
 * a message that names the command elsewhere, such as `<cli> doctor failed`, keeps it. A message that ends with a colon is
 * finished by its hint as it stands, or by a full stop when it has none; an empty message is its
 * hint alone.
 */
export function messageWithHint(message: string, hint: string | undefined, cli: string): string {
  const trimmed = message.trim();
  const tip = hint?.trim() ?? "";
  const open = trimmed.endsWith(":");
  const sentence =
    trimmed === "" || /[.!?]$/.test(trimmed)
      ? trimmed
      : `${open ? trimmed.slice(0, -1) : trimmed}.`;
  if (tip === "" || endsWith(plain(sentence), plain(tip))) return sentence;
  if (open) return `${trimmed} ${tip}`;
  const told = tip.startsWith(`${cli} `) ? `Run: ${tip}` : tip;
  return sentence === "" ? told : `${sentence} ${told}`;
}
