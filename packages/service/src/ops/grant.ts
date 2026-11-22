// The grant gate: an agent's call may use only a space its registration grants, checked on the
// space the call would use before anything is read from it, and again before the writer gets a
// write. Setup keeps one live agent-home row per home in the grants table, naming the home's
// instance and the space its entry names.
//
// Whose grant a call needs is decided by who the connection is, never by a tool argument:
// - a session of a terminal launch: the live row of the home its click recorded, which must name
//   the space and, for a bridge, the instance it bound with; a home that never had a row may use
//   the machine's default only. So removing a registration stops the agent's bridge and shell
//   alike, and restoring it lets them go on with no reconnect;
// - a session of a background run: the run alone, while it runs;
// - a bridge that is no session: the live row of the instance its entry names (`manual` for an
//   entry without one, which may use the machine's default only).
// The person's classes, a script and an agent's shell that is no session are not an agent home's
// calls and are not gated.
//
// What the gate promises: an agent that uses the entry its app was given reaches only the spaces
// its home's live rows name, and its next call fails once setup revokes the row. The bridge sends
// no home folder, so whoever can edit the agent app's configuration, or start `ttasks mcp` from a
// shell, can name another instance: the gate is policy against mistakes and against a misled
// agent that stays inside its app, not a defence against local code that rewrites the app's
// configuration.
import { CLI_NAME } from "@ttasks/brand";
import { AppError } from "@ttasks/contracts";
import { MANUAL_INSTANCE } from "@ttasks/launch";
import type { SessionPort, Standing } from "./binding.ts";
import type { Caller } from "./caller.ts";

/**
 * The instance of an entry without a usable `--instance` (actor `agent:manual`). It has no row; it
 * may use the machine's default space only. machine.toml and setup refuse it as an instance ID.
 */
export { MANUAL_INSTANCE };

/** What the request path asks of the agent homes' rows (hub/home-gate.ts answers it). */
export interface HomeGate {
  /** Whether a call of the agent home `instance` may use the space `space` (an `sp_` ID). */
  may(instance: string, space: string): boolean;
  /**
   * The space the agent home `instance` may use now: its live row's, or for `manual` the
   * machine's default. None when there is no one such space.
   */
  spaceOf(instance: string): string | undefined;
}

/**
 * The refusal: `forbidden` with rule `grant`. One body for every case (a space the home's row does
 * not name, a row revoked, a home with no row), on every face, and the command that fixes it. It
 * names no space, home, folder, task or reference.
 */
export const grantRefused = (): AppError =>
  new AppError({
    code: "forbidden",
    message: "This agent is not registered for this space.",
    hint: `Ask the user to run: ${CLI_NAME} setup agents`,
    data: { rule: "grant" },
  });

/** The agent registrations could not be read: never read as a refusal or as a grant. */
export const grantsUnread = (): AppError =>
  new AppError({
    code: "service_unavailable",
    message: "The service could not read its agent registrations now.",
    hint: "Try again in a moment.",
    data: { reason: "not_ready", retryable: true },
  });

/** A session's standing now, or the retryable refusal when its home's rows could not be read. */
export function standingOf(
  sessions: SessionPort | undefined,
  caller: Caller,
): Extract<Standing, { kind: "read" }> | undefined {
  const binding = caller.binding;
  if (binding?.kind !== "session") return undefined;
  const standing = sessions?.standing(binding.session.home);
  if (standing === undefined || standing.kind === "failed") throw grantsUnread();
  return standing;
}

/**
 * Refuses the call unless its connection may use `space`. A host without the gate refuses every
 * agent home's call: the gate is never open by omission.
 */
export function checkGrant(
  host: { readonly homes?: HomeGate; readonly sessions?: SessionPort },
  caller: Caller,
  space: string | undefined,
): void {
  const standing = standingOf(host.sessions, caller);
  if (standing !== undefined) {
    if (space === undefined || !standing.may(space)) throw grantRefused();
    return;
  }
  if (caller.class !== "bridge") return;
  if (space === undefined || host.homes?.may(caller.home ?? "", space) !== true) {
    throw grantRefused();
  }
}
