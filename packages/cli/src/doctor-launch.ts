// `ttasks doctor`'s launch rows and sessions row (A3 3.14; A4 3.4.1, 3.7, 3.8; M4.05b), from what
// the running service answers. Doctor starts no program for them: the service probes as a launch
// would, through its own launch service.
//
//   launch.scopes   Linux: terminals start without a systemd scope, so a restart or update of the
//                   service may end the sessions in them (warn)
//   launch.terminal the terminal a launch opens first and why: warn when it was not
//                   found, when the default the person set is one TTasks cannot open, or when
//                   the operating system's setting could not be read
//   launch.env     the person's environment as a launch reads it: on Linux and macOS the last
//                   login-shell snapshot the service attempted did not succeed, with the age of the
//                   one in use or none (warn); `--live` takes one now first, so plain doctor never
//                   runs the person's profile. On Windows a registry read that failed (warn)
//   launch.t3       the pairing with T3 Code: "Reconnect T3", or a token that cannot renew itself
//                   and runs out within 5 days or ran out (warn)
//   sessions        the agent connections open now, and how many are the session of an agent
//                   TTasks opened or of a background run
//
// Rows hold words, counts, dates and instance IDs only: never a path, a variable's name or value,
// a token or a task. None of them fails the report: each names what launches lose, and the fix.
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";

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
      detail: `Terminals start without a systemd scope (systemd-run --user did not work), so a restart or update of the service may end the agent sessions in them. Check that your user manager runs (systemctl --user status), then restart the service: ${CLI_NAME} service restart`,
    };
  }
  return {
    id,
    status: "skip",
    detail: "Only Linux puts terminals in scopes; elsewhere they start outside the service.",
  };
}

/** A terminal adapter's name for people. */
export const TERMINAL_NAMES: Readonly<Record<string, string>> = {
  wt: "Windows Terminal",
  console: "a console window",
  ghostty: "Ghostty",
  "gnome-terminal": "GNOME Terminal",
  kitty: "kitty",
  wezterm: "WezTerm",
  konsole: "Konsole",
  "x-terminal-emulator": "x-terminal-emulator",
  custom: "your custom terminal command",
};

/** Why a terminal was chosen, in a few words. */
export const TERMINAL_SOURCE_WORDS: Readonly<Record<string, string>> = {
  configured: "your choice in Settings",
  fallback: "a fallback",
  terminal_var: "$TERMINAL",
  desktop: "the desktop's default",
  distribution: "the distribution's default",
  windows: "Windows' default terminal",
  installed: "the first installed",
};

/** A name the service gave for a default TTasks cannot open: plain characters only. */
const SHOWN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

/** `launch.terminal`: `doctor/launch`'s `terminal`. */
export function terminalCheck(terminal: unknown): Check {
  const id = "launch.terminal";
  if (!isObject(terminal)) {
    return {
      id,
      status: "skip",
      detail: "This service opens no terminals on this operating system.",
    };
  }
  const app = typeof terminal["app"] === "string" ? TERMINAL_NAMES[terminal["app"]] : undefined;
  const source =
    typeof terminal["source"] === "string" ? TERMINAL_SOURCE_WORDS[terminal["source"]] : undefined;
  const set = "To choose one, open Settings and pick it under Terminal.";
  if (app === undefined || source === undefined || terminal["found"] !== true) {
    return {
      id,
      status: "warn",
      detail:
        app === undefined
          ? `No terminal ${PRODUCT_NAME} can open was found, so Open in a terminal app fails. Install one, or choose one in Settings under Terminal.`
          : `${app} (${source ?? "chosen"}) was not found, so Open tries the next terminal. Install it, or choose another in Settings under Terminal.`,
    };
  }
  const unread = terminal["unread"];
  if (unread === "windows" || unread === "desktop") {
    const what =
      unread === "windows"
        ? "your default terminal in Windows' settings"
        : "your desktop's default terminal in time";
    return {
      id,
      status: "warn",
      detail: `${PRODUCT_NAME} could not read ${what}, so terminals open in ${app}, its fallback. ${set}`,
    };
  }
  const unsupported = terminal["unsupported"];
  if (typeof unsupported === "string") {
    const which =
      unsupported === "other"
        ? "Your default terminal in Windows' settings"
        : SHOWN_NAME.test(unsupported) && unsupported !== "unnamed"
          ? `Your default terminal (${unsupported})`
          : "Your default terminal";
    return {
      id,
      status: "warn",
      detail: `${which} is one ${PRODUCT_NAME} cannot open yet, so terminals open in ${app} (${source}). ${set}`,
    };
  }
  return { id, status: "ok", detail: `Terminals open in ${app}: ${source}.` };
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
  if (typeof outcome !== "string" || outcome === "ok") {
    // No attempt since the service started, or one that succeeded: it passes only with a snapshot
    // under a day old to show. An older one is not judged: the next launch takes it again, and
    // only --live says now whether the shell still gives one.
    if (taken === undefined) {
      return {
        id,
        status: "skip",
        detail: `No launch has read your login shell's environment yet. To read it now, run: ${live}`,
      };
    }
    if (now - taken >= DAY) {
      return {
        id,
        status: "skip",
        detail: `The login shell's environment launched agents get was taken ${age(now - taken)} ago; the next launch takes it again. To check your login shell now, run: ${live}`,
      };
    }
    return {
      id,
      status: "ok",
      detail: `Launched agents get your login shell's environment, taken ${age(now - taken)} ago; a launch takes it again once it is a day old.`,
    };
  }
  const when = attempted === undefined ? "" : ` (${age(now - attempted)} ago)`;
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
  if (status["renews"] !== true && expires === undefined && status["expires_at"] !== undefined) {
    // An expiry the service gave that cannot be read: nothing to judge the pairing by.
    return {
      id,
      status: "skip",
      detail: "The service did not say when T3 Code's pairing runs out.",
    };
  }
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

/**
 * `sessions` (A3 3.14): `doctor/sessions`'s answer, the agent connections open now and how many
 * are a task's session, or null for a service without binding. Nothing in it is a fault.
 */
export function sessionsCheck(facts: unknown): Check {
  const id = "sessions";
  if (!isObject(facts)) {
    return { id, status: "skip", detail: "This service binds no agent sessions." };
  }
  const isCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const open = facts["open"];
  const sessions = isObject(facts["sessions"]) ? facts["sessions"] : {};
  const launch = sessions["launch"];
  const run = sessions["run"];
  // Facts missing or in another shape are not a pass: the row cannot say what it would judge.
  if (!isCount(open) || !isCount(launch) || !isCount(run) || launch + run > open) {
    return { id, status: "skip", detail: "The service did not say how its sessions stand." };
  }
  if (open === 0) return { id, status: "ok", detail: "No agent connection is open." };
  const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  return {
    id,
    status: "ok",
    detail: `${plural(open, "agent connection", "agent connections")} open: ${String(launch)} ${launch === 1 ? "is" : "are"} a task's session through an agent ${PRODUCT_NAME} opened, ${String(run)} through a background run. Any other connection names its task on each call.`,
  };
}

/** The rows when no service answers. */
export const LAUNCH_ROWS_WITHOUT_SERVICE: readonly Check[] = [
  { id: "launch.scopes", status: "skip", detail: "No service to ask." },
  { id: "launch.terminal", status: "skip", detail: "No service to ask." },
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
      ? { id: "launch.terminal", status: "skip", detail: "The service did not answer." }
      : terminalCheck(facts["terminal"]),
    facts === undefined
      ? { id: "launch.env", status: "skip", detail: "The service did not answer." }
      : environmentCheck(facts["environment"], now),
    t3PairingCheck(t3?.answer, now),
    sessions === undefined
      ? { id: "sessions", status: "skip", detail: "The service did not answer." }
      : sessionsCheck(sessions.answer),
  ];
}
