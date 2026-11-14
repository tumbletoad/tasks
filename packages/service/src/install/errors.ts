// The ways a service command can fail, each with the CLI exit code of its class (A2 3.10.3).

/** A2 3.10.3's classes that a service command uses, with their exit codes. */
export const ERROR_CLASSES = {
  internal: 1,
  usage: 2,
  not_found: 3,
  conflict: 4,
  forbidden: 5,
  service: 6,
  version: 7,
} as const;

export type ErrorClass = keyof typeof ERROR_CLASSES;

/**
 * A service command that cannot go on. The message is for a person: fixed text with the paths
 * and names of the install's own entries, never task data. `hint` is the command that helps.
 */
export class ServiceCommandError extends Error {
  override readonly name = "ServiceCommandError";
  readonly errorClass: ErrorClass;
  /** A word for `--json` callers: `entry_conflict`, `not_installed`, `service_unavailable`… */
  readonly code: string;
  readonly hint: string | undefined;

  constructor(errorClass: ErrorClass, code: string, message: string, hint?: string) {
    super(message);
    this.errorClass = errorClass;
    this.code = code;
    this.hint = hint;
  }

  get exitCode(): number {
    return ERROR_CLASSES[this.errorClass];
  }
}
