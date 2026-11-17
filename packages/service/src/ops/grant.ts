// The grant gate (A3 3.7.4, 3.7.8): an agent home's call may use only a space its registration
// grants. Setup keeps one live agent-home row per home in the grants table, naming the home's
// instance and the space its entry names (`--space`, `--instance`, A3 3.7.4's "registration
// grant"); a call of that home into any other space is `forbidden` with rule `grant`, before
// anything is read from the space.
//
// Which home a call comes from is what its connection presents, never a tool argument:
// - an MCP connection: the instance its entry names (`--instance`, written by setup into the agent
//   app's own configuration and carried in the authenticated bind frame), or `manual` for an
//   entry without one (a word no configured instance and no row may take, so a hand-made entry
//   never shares a registered home's rows);
// - a call on a slot (an MCP connection's binding, or a CLI call whose ticket maps to a live
//   session): the slot's instance, and when it is bound, its session's instance too. A session is
//   made for the instance of the connection that bound it and binds no connection of another
//   instance (binding/bindings.ts), so the two are one home; the gate checks both all the same,
//   so a session's calls stop with its home's row whichever connection carries them.
// The user's classes, a script and an agent's CLI without a session are not an agent home's calls.
//
// What the gate promises: an agent that uses the entry its app was given reaches only the spaces
// its home's live rows name, whatever its calls carry (no tool takes a space; a space a CLI call
// names meets its binding's space first; a launch reference and a task are read in the call's
// space, which the gate checked before anything was read; a ticket binds only into a granted
// space), and its next call fails once setup revokes the row. The bridge sends no home folder, so
// the instance is the home as the service knows it: whoever can edit the agent app's
// configuration, or start `tasks mcp` from a shell, can name another instance. That is A3 3.7.4's
// honesty rule: the gate is policy against mistakes and against a prompt-injected agent that stays
// inside its app, not a defence against local code that rewrites the app's configuration. An
// agent's CLI without a session (`agent:unknown`) is no home's and is not gated (A3 3.7.9).
import { CLI_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import { MANUAL_INSTANCE } from "@tasks/launch";
import { runOf } from "./binding.ts";
import type { Caller } from "./caller.ts";

/**
 * The instance of an entry without a usable `--instance` (A3 3.7.4: "a hand-made entry", actor
 * `agent:manual`). It has no row; it may use the machine's default space only. machine.toml and
 * setup refuse it as an instance ID, and the gate counts no row of it.
 */
export { MANUAL_INSTANCE };

/** What the request path asks of the agent homes' rows (hub/home-gate.ts answers it). */
export interface HomeGate {
  /**
   * Whether a call of the agent home `instance` may use the space `space` (an `sp_` ID). `run` is
   * the background run (`ru_` ID) the call's session or ticket acts for: Tasks gave that run's
   * agent its tools, so the run's own calls may use the run's space without a row.
   */
  may(instance: string, space: string, run?: string): boolean;
}

/**
 * The refusal (A3 3.5, 3.7.8): `forbidden` with rule `grant`. One body for every case (a space the
 * home's row does not name, a row revoked, a home with no row), on every face, and the command
 * that fixes it. It names no space, home, folder, task or reference.
 */
export const grantRefused = (): AppError =>
  new AppError({
    code: "forbidden",
    message: "This agent is not registered for this space.",
    hint: `Ask the user to run: ${CLI_NAME} setup agents`,
    data: { rule: "grant" },
  });

/**
 * The agent homes a call comes from, each of which must be granted its space: a slot's instance
 * and its bound session's, an MCP connection's entry instance, or none for a call that is not an
 * agent home's. An MCP caller that names none is no home's (the empty instance), so it is refused
 * rather than taken as a hand-made entry.
 */
export function homesOf(caller: Caller): readonly string[] {
  const slot = caller.binding;
  if (slot !== undefined) {
    const session = slot.session?.instance;
    return session === undefined || session === slot.instance
      ? [slot.instance]
      : [slot.instance, session];
  }
  if (caller.class === "bridge") return [caller.home ?? ""];
  return [];
}

/**
 * Refuses the call unless every agent home it comes from may use `space` (A3 3.7.8), as the run its
 * session acts for if it acts for one. A host without the gate refuses every agent home's call: the
 * gate is never open by omission.
 */
export function checkGrant(
  gate: HomeGate | undefined,
  caller: Caller,
  space: string | undefined,
): void {
  const run = runOf(caller.binding?.session);
  for (const home of homesOf(caller)) {
    if (space === undefined || gate?.may(home, space, run) !== true) throw grantRefused();
  }
}
