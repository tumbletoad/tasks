// `tasks doctor`'s launch rows and sessions row (A3 3.14; A4 3.4.1, 3.7, 3.8; M4.05b), from what
// the running service answers. Doctor starts no program for them: the service probes as a launch
// would, through its own launch service.
//
//   launch.scopes   Linux: terminals start without a systemd scope, so a restart or update of the
//                   service may end the sessions in them (warn)
//   launch.env      the person's environment as a launch reads it: on Linux and macOS the last
//                   login-shell snapshot the service attempted did not succeed, with the age of the
//                   one in use or none (warn); `--live` takes one now first, so plain doctor never
//                   runs the person's profile. On Windows a registry read that failed (warn)
//   launch.t3       the pairing with T3 Code: "Reconnect T3", or a token that cannot renew itself
//                   and runs out within 5 days or ran out (warn)
//   sessions        session records the service could not read back at its start, or agent
//                   connections in shared mode (warn)
//
// Rows hold words, counts, dates and instance IDs only: never a path, a variable's name or value,
// a token or a task. None of them fails the report: each names what launches lose, and the fix.
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import { INSTANCE_ID } from "@tasks/launch";
import type { Session } from "./connect.ts";

export interface Check {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail" | "skip";
  readonly detail: string;
}

const DAY = 86_400_000;
/** A4 3.4.1: doctor warns this long before a token that cannot renew itself runs out. */
export const T3_WARN_MS = 5 * DAY;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An ISO time from the service, or undefined. */
function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** A date for people, as the calendar day in UTC. */
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A duration for people: minutes, hours or days. */
function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hours`;
  return `${String(Math.round(hours / 24))} days`;
}

/** `launch.scopes` (A4 3.7): `doctor/launch`'s `scopes`. */
export function scopesCheck(scopes: unknown): Check {
  const id = "launch.scopes";
  if (scopes === true) {
    return {
      id,
      status: "ok",
      detail:
        "Terminals start in a systemd scope of their own, so a restart or update of the service leaves them running.",
    };
  }
  if (scopes === false) {
    return {
      id,
      status: "warn",
      detail: `Terminals start without a systemd scope (systemd-run --user did not work), so a restart or update of the service may end the agent sessions in them. Check that your user manager runs (systemctl --user status), then run: ${CLI_NAME} service restart`,
    };
  }
  return {
    id,
    status: "skip",
    detail: "Only Linux puts terminals in scopes; elsewhere they start outside the service.",
  };
}

const SNAPSHOT_WHY: Readonly<Record<string, string>> = {
  timeout: "it did not finish within 10 seconds",
  failed: "it failed",
  no_markers: "its output could not be read (a profile that exits or replaces the shell?)",
  too_large: "it printed too much",
  no_shell: "no login shell was found",
};

/** `launch.env` (A4 3.8): `doctor/launch`'s `environment`, at `now`. */
export function environmentCheck(environment: unknown, now: number): Check {
  const id = "launch.env";
  if (!isObject(environment)) {
    return {
      id,
      status: "skip",
      detail: "This service gives its agents a fixed environment, so there is nothing to read.",
    };
  }
  if (environment["kind"] === "registry") {
    return environment["read"] === true
      ? {
          id,
          status: "ok",
          detail: "Launched agents get your environment, read from the registry.",
        }
      : {
          id,
          status: "warn",
          detail: `Windows PowerShell could not read your environment from the registry in time, so launched agents get the service's own environment. Run: ${CLI_NAME} doctor again; if it stays, check that Windows PowerShell starts.`,
        };
  }
  const outcome = environment["outcome"];
  const attempted = instant(environment["attempted_at"]);
  const taken = instant(environment["taken_at"]);
  const live = `${CLI_NAME} doctor --live`;
  if (typeof outcome !== "string") {
    // No attempt since the service started: a launch takes one when it needs it.
    return taken === undefined
      ? {
          id,
          status: "skip",
          detail: `No launch has read your login shell's environment yet. To read it now, run: ${live}`,
        }
      : {
          id,
          status: "ok",
          detail: `Launched agents get your login shell's environment, taken ${age(now - taken)} ago; a launch takes it again once it is a day old.`,
        };
  }
  const when = attempted === undefined ? "" : ` (${age(now - attempted)} ago)`;
  if (outcome === "ok") {
    return {
      id,
      status: "ok",
      detail: `Your login shell gave its environment when last asked${when}; launched agents get it.`,
    };
  }
  const why = SNAPSHOT_WHY[outcome] ?? "it failed";
  const used =
    taken === undefined
      ? "launched agents get the service's own environment, without what your profile sets (such as nvm's PATH)"
      : `launched agents get the one taken ${age(now - taken)} ago${now - taken >= DAY ? ", which is stale" : ""}`;
  return {
    id,
    status: "warn",
    detail: `Your login shell did not give its environment when last asked${when}: ${why}. So ${used}. Check your shell profile, then run: ${live}`,
  };
}

/** `launch.t3` (A4 3.4.1): `t3/status`'s answer, at `now`; undefined when it did not answer. */
export function t3PairingCheck(status: unknown, now: number): Check {
  const id = "launch.t3";
  const pair = `${CLI_NAME} setup t3`;
  if (!isObject(status)) {
    return { id, status: "skip", detail: "The service did not say how T3 Code is paired." };
  }
  const state = status["state"];
  if (state === "not_paired") {
    return {
      id,
      status: "skip",
      detail: `${PRODUCT_NAME} is not paired with T3 Code. To open tasks in T3 Code, run: ${pair}`,
    };
  }
  if (state === "reconnect") {
    return {
      id,
      status: "warn",
      detail: `T3 Code no longer accepts ${PRODUCT_NAME}'s pairing, so Open in T3 Code cannot use it. Run: ${pair}`,
    };
  }
  if (state !== "ready" && state !== "not_running") {
    return { id, status: "skip", detail: "The service did not say how T3 Code is paired." };
  }
  const running = state === "ready" ? "" : " T3 Code is not running now.";
  const expires = instant(status["expires_at"]);
  if (status["renews"] === true || expires === undefined) {
    return {
      id,
      status: "ok",
      detail: `Paired with T3 Code${status["renews"] === true ? "; the pairing renews its token itself" : ""}.${running}`,
    };
  }
  if (expires <= now) {
    return {
      id,
      status: "warn",
      detail: `The pairing with T3 Code ran out on ${day(expires)} and cannot renew itself. Run: ${pair}`,
    };
  }
  if (expires - now <= T3_WARN_MS) {
    const days = Math.max(1, Math.ceil((expires - now) / DAY));
    return {
      id,
      status: "warn",
      detail: `The pairing with T3 Code runs out on ${day(expires)}, in ${String(days)} day${days === 1 ? "" : "s"}, and cannot renew itself. Pair again before then: ${pair}`,
    };
  }
  return {
    id,
    status: "ok",
    detail: `Paired with T3 Code until ${day(expires)}.${running}`,
  };
}

/** `sessions` (A3 3.14): `doctor/sessions`'s answer, or null for a service without binding. */
export function sessionsCheck(facts: unknown): Check {
  const id = "sessions";
  if (!isObject(facts)) {
    return { id, status: "skip", detail: "This service binds no agent sessions." };
  }
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const open = count(facts["open"]);
  const dropped = count(facts["dropped"]);
  // Instance IDs only, as the service names them: anything else never reaches a row.
  const shared = (Array.isArray(facts["shared"]) ? facts["shared"] : [])
    .filter(isObject)
    .map((s) => ({ instance: s["instance"], count: count(s["count"]) }))
    .filter(
      (s): s is { instance: string; count: number } =>
        typeof s.instance === "string" && INSTANCE_ID.test(s.instance) && s.count > 0,
    );
  const parts: string[] = [];
  if (dropped > 0) {
    parts.push(
      `${String(dropped)} session record${dropped === 1 ? " was" : "s were"} damaged and dropped when the service started: those agents go on unbound and name their task on each call, and a new launch from ${PRODUCT_NAME} binds again.`,
    );
  }
  if (shared.length > 0) {
    const n = shared.reduce((sum, s) => sum + s.count, 0);
    parts.push(
      `${String(n)} agent connection${n === 1 ? "" : "s"} of ${shared.map((s) => s.instance).join(", ")} carr${n === 1 ? "ies" : "y"} more than one conversation (shared mode): a call there binds to no task unless it names one, so ask the agent to name its task on each call.`,
    );
  }
  if (parts.length > 0) return { id, status: "warn", detail: parts.join(" ") };
  return {
    id,
    status: "ok",
    detail: `${String(open)} agent connection${open === 1 ? "" : "s"} open, none in shared mode; every session record was read back.`,
  };
}

/** The rows when no service answers. */
export const LAUNCH_ROWS_WITHOUT_SERVICE: readonly Check[] = [
  { id: "launch.scopes", status: "skip", detail: "No service to ask." },
  { id: "launch.env", status: "skip", detail: "No service to ask." },
  { id: "launch.t3", status: "skip", detail: "No service to ask." },
  { id: "sessions", status: "skip", detail: "No service to ask." },
];

/**
 * The rows, asked of a running service. A question it cannot answer (an older service) skips its
 * rows. With `live` (`doctor --live`) the service takes the login shell's snapshot now, so that
 * question gets the snapshot's deadline and more.
 */
export async function launchChecks(
  session: Session,
  live: boolean,
  now: number = Date.now(),
): Promise<Check[]> {
  const ask = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
    session.call(method, params, { timeoutMs }).then(
      (answer) => ({ answer }),
      () => undefined,
    );
  const launch = await ask("doctor/launch", { take: live }, 60_000);
  const t3 = await ask("t3/status", {}, 30_000);
  const sessions = await ask("doctor/sessions", {}, 30_000);
  const facts = isObject(launch?.answer) ? launch.answer : undefined;
  return [
    facts === undefined
      ? { id: "launch.scopes", status: "skip", detail: "The service did not answer." }
      : scopesCheck(facts["scopes"]),
    facts === undefined
      ? { id: "launch.env", status: "skip", detail: "The service did not answer." }
      : environmentCheck(facts["environment"], now),
    t3PairingCheck(t3?.answer, now),
    sessions === undefined
      ? { id: "sessions", status: "skip", detail: "The service did not answer." }
      : sessionsCheck(sessions.answer),
  ];
}
