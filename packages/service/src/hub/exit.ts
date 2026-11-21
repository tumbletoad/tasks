// The exit codes of `ttasks serve` (A2 3.3.1). The service managers act on them: systemd's unit, the
// Windows supervisor in ttasksw.exe (A2 3.3.2) and the macOS wrapper map each one, so they are
// exactly these numbers and nothing else.

export const EXIT = {
  /** A clean stop. Nothing restarts it. */
  ok: 0,
  /** Refused: package identity, root or an elevated Administrator, unsafe permissions, invalid configuration. */
  refused: 64,
  /** A crash, or the service lost ownership of `service.lock`. The manager restarts it. */
  crashed: 70,
  /** Another service already holds `service.lock` for this state folder. Nothing restarts it. */
  locked: 73,
  /** A restart was requested (`service/shutdown {restart: true}`). The manager starts it again at once. */
  restart: 75,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Why the service refused to run (exit 64). Logged as the `reason` of `service.refused`. */
export const REFUSALS = [
  "root",
  "elevated",
  "elevation_unknown",
  "packaged",
  "unsafe_permissions",
  /** A umask that takes away the person's own access to new files (A2 3.2.2 rule 5). */
  "unsafe_umask",
  "invalid_config",
] as const;
export type Refusal = (typeof REFUSALS)[number];

/**
 * A start that ends before the service runs: a refusal (64), another service holding the lock
 * (73) or a failure while starting (70). The message is a fixed text for people, never data.
 */
export class ServiceExit extends Error {
  override readonly name = "ServiceExit";
  readonly code: ExitCode;
  readonly refusal: Refusal | undefined;

  constructor(code: ExitCode, message: string, refusal?: Refusal) {
    super(message);
    this.code = code;
    this.refusal = refusal;
  }
}
