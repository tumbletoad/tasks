// `tasks setup t3` (A4 3.4.1 "Pairing", A2 3.10; M2.11): the service's side, as rpc methods
// registered in the handler table (endpoint.ts), like `roots/*`.
//
//   t3/status      whether T3 can be used: paired, running, "Reconnect T3"   (every CLI class)
//   t3/pair        starts a pairing attempt and returns T3's approval page   (the user only)
//   t3/pair_wait   waits for the approval and keeps the grant                (the user only)
//
// The service runs the pairing, so the one holder of service.lock is the one writer of T3's
// machine state, and a new grant is seen by every launch at once. The person approves in the
// browser; the CLI opens T3's page there (cli/src/setup.ts). The token, the client registration
// and the grant ID live in `<state>/t3/pairing.json`: mode 0600, in a 0700 folder, written through
// atomicWrite (files.ts), never in machine.toml, a space, the log or an answer. A folder others can
// change is refused before a token is written into it.
//
// T3's home is T3's own: `T3CODE_HOME` when the service's environment names an absolute one, else
// `~/.t3` (A4 3.4.1). Tasks reads only `userdata/server-runtime.json` there, for T3's origin.
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import {
  chooseT3Route,
  PairingError,
  T3_FILE_MAX_BYTES,
  T3_FILES,
  T3_TEXT,
  T3CliRoute,
  T3Error,
  T3Route,
  type Instance,
  type PairingAttempt,
  type T3FileName,
  type T3Files,
} from "@tasks/launch";
import type { ConnectionClass } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import { atomicWrite, ensurePrivateDir, type Judged } from "./files.ts";
import type { Logger, T3PairFailure as PairFailure } from "./log.ts";
import { homeFolder, type HostFacts } from "./paths.ts";
import { unsafeMessage } from "./permissions.ts";

/** The folder of T3's machine state in `<state>`. */
export const T3_STATE_DIR = "t3";

/** T3's own variable for its home folder (assumed from the `.cmd` shim, A4 3.4.1). */
export const T3_HOME_VARIABLE = "T3CODE_HOME";

/** The files of T3's state, by name. */
export const t3FileNames = (): string[] => T3_FILES.map((name) => `${name}.json`);

/** T3's home folder: an absolute T3CODE_HOME, else `<home>/.t3`; undefined without a home. */
export function t3HomeOf(
  env: Readonly<Record<string, string | undefined>>,
  facts: HostFacts,
): string | undefined {
  const P = facts.platform === "win32" ? win32 : posix;
  const named = env[T3_HOME_VARIABLE];
  if (named !== undefined && named !== "" && P.isAbsolute(named)) return named;
  try {
    return P.join(homeFolder(facts), ".t3");
  } catch {
    return undefined;
  }
}

/** A T3 state folder that others can change: no token is written into it. */
export class T3StateUnsafe extends Error {
  override readonly name = "T3StateUnsafe";
  /** What a person reads: which folder, what is wrong, and the one command (permissions.ts). */
  readonly line: string;
  constructor(judged: Judged) {
    super("The T3 state folder can be changed by other users");
    this.line = unsafeMessage(
      [{ name: `${PRODUCT_NAME}'s T3 folder`, ...judged }],
      `Whoever can change it could put their own pairing with T3 Code in its place, so no token was kept`,
    );
  }
}

/** T3's machine state as files: `<state>/t3/<name>.json`, 0600 in a 0700 folder. */
export function t3Files(stateDir: string, platform: NodeJS.Platform): T3Files {
  const P = platform === "win32" ? win32 : posix;
  const dir = P.join(stateDir, T3_STATE_DIR);
  const path = (name: T3FileName) => P.join(dir, `${name}.json`);
  return {
    read(name) {
      let fd: number | undefined;
      try {
        fd = openSync(path(name), "r");
        const info = fstatSync(fd);
        // The route keeps its files within this size (t3-state.ts), so nothing it wrote is refused.
        if (!info.isFile() || info.size > T3_FILE_MAX_BYTES) return undefined;
        const buffer = Buffer.alloc(info.size);
        let read = 0;
        while (read < buffer.length) {
          const n = readSync(fd, buffer, read, buffer.length - read, read);
          if (n === 0) break;
          read += n;
        }
        return buffer.subarray(0, read).toString("utf8");
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    write(name, text) {
      const judged = ensurePrivateDir(dir, platform);
      if (judged !== undefined) throw new T3StateUnsafe(judged);
      atomicWrite(path(name), text, 0o600);
    },
  };
}

/** What the T3 verbs need from the hub. */
export interface T3Host {
  readonly log: Logger;
  /** The T3 route of this service, over `<state>/t3`. */
  readonly route: T3Route;
  /** The CLI fallback route (M6.10), over the same state and T3 home. */
  readonly cli: T3CliRoute;
  /** The T3 instances machine.toml names, as this start read them. */
  readonly instances: readonly Instance[];
}

/**
 * The hub's T3 host: the paired route and the CLI fallback over one T3 home and one state folder.
 * The CLI's environment starts from the service's own through the allow-list here (only `t3/status`
 * uses the host so far, which starts no CLI); the step that launches through it passes the launch
 * service's person's environment (A4 3.8), as a terminal's claim gets it.
 */
export function t3Host(input: {
  readonly log: Logger;
  readonly home: string | undefined;
  readonly files: T3Files;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly instances: readonly Instance[];
}): T3Host {
  const { home, files, platform } = input;
  return {
    log: input.log,
    route: new T3Route({ home, files, platform }),
    cli: new T3CliRoute({
      home,
      files,
      platform,
      environment: { base: () => Promise.resolve({ kind: "service", env: input.env }) },
    }),
    instances: input.instances.filter((i) => i.target === "t3" && i.enabled),
  };
}

/** What `t3/status` says of an instance whose route is ready. */
const ROUTE_TEXT = {
  "t3-mcp": "Opens in T3 Code.",
  "t3-cli": `Not paired: opens through T3's command line, which sends the brief. Pair for an unsent draft: ${CLI_NAME} setup t3`,
} as const;

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can pair with T3 Code.",
      hint: `Ask the user to run: ${CLI_NAME} setup t3`,
      data: { rule: "user_only" },
    });
  }
}

/** Why a pairing failed, for the log and the answer. */
function failureOf(error: unknown): PairFailure {
  if (error instanceof PairingError) return error.reason;
  if (error instanceof T3StateUnsafe) return "unsafe_state";
  if (error instanceof T3Error) {
    return error.failure === "unreachable" ? "t3_not_running" : "t3_error";
  }
  return "t3_error";
}

const PAIR_TEXT: Record<PairFailure, { message: string; hint?: string }> = {
  t3_not_running: {
    message: "T3 Code is not running on this machine.",
    hint: `Start T3 Code, then run ${CLI_NAME} setup t3 again.`,
  },
  denied: { message: "T3 Code refused the pairing." },
  timed_out: {
    message: "No approval came from T3 Code in time.",
    hint: `Run ${CLI_NAME} setup t3 again.`,
  },
  cancelled: { message: "A newer pairing replaced this one." },
  unsupported: {
    message: `T3 Code's server does not offer pairing the way ${PRODUCT_NAME} needs it.`,
  },
  t3_error: { message: "T3 Code did not complete the pairing.", hint: "Try again." },
  unsafe_state: {
    message: `${PRODUCT_NAME}'s T3 state folder can be changed by other users, so no token was kept.`,
    hint: `Run ${CLI_NAME} doctor.`,
  },
};

/**
 * The answer for a failed pairing. `line`, when there is one, replaces the fixed words: a T3 state
 * folder others can change is named with its path and the one command that fixes it, as the service
 * names its own folders (permissions.ts). The log keeps the reason only.
 */
function pairError(reason: PairFailure, line?: string): AppError {
  const text = PAIR_TEXT[reason];
  return new AppError({
    code: reason === "denied" ? "forbidden" : reason === "cancelled" ? "conflict" : "invalid_input",
    message: line ?? text.message,
    ...(line !== undefined || text.hint === undefined ? {} : { hint: text.hint }),
    data: { reason },
  });
}

/** The person's line of a failure that has one (T3StateUnsafe). */
const lineOf = (error: unknown): string | undefined =>
  error instanceof T3StateUnsafe ? error.line : undefined;

const ATTEMPT_ID = /^[0-9a-f]{32}$/u;

/** How a pairing attempt ended: kept, or why not. */
type Outcome =
  | { readonly ok: true; readonly replaced: boolean; readonly expiresAt?: number }
  | { readonly ok: false; readonly reason: PairFailure; readonly line?: string };

export function t3Verbs(host: T3Host): Readonly<Record<string, Verb>> {
  // The attempt in progress, at most one: a new one cancels the one before. Its outcome is kept as
  // soon as T3 answers, whether or not the CLI still waits for it (`t3/pair_wait` only reports).
  const attempts = new Map<string, { attempt: PairingAttempt; done: Promise<Outcome> }>();
  // Which `t3/pair` call is the newest, counted before its first await: a call whose attempt is
  // set up after a newer call started cancels its own attempt, so two overlapping calls never
  // leave two live attempts (whose older approval could replace the newer pairing).
  let generation = 0;
  const iso = (ms: number | undefined) =>
    ms === undefined ? {} : { expires_at: new Date(ms).toISOString() };

  return {
    "t3/status": async () => {
      const available = await host.route.availability();
      // Per instance, the route a click would take now, or why none ("Start T3 Code" when T3 is
      // not running): from what the routes already read, no request and no process (M6.10).
      const instances = await Promise.all(
        host.instances.map(async (instance) => {
          const choice = await chooseT3Route(host.route, host.cli, instance);
          return choice.kind === "route"
            ? { id: instance.id, route: choice.route, message: ROUTE_TEXT[choice.route] }
            : {
                id: instance.id,
                route: null,
                reason: choice.reason,
                message: T3_TEXT[choice.reason],
              };
        }),
      );
      const running = await host.route.running();
      // The token's expiry and whether the pairing renews it (a refresh token), for doctor's
      // warning before it runs out (A4 3.4.1), whether or not T3 runs now.
      const pairing = host.route.pairing();
      const token =
        pairing === undefined || pairing.reconnect
          ? {}
          : { ...iso(pairing.expiresAt), renews: pairing.refreshToken !== undefined };
      if (available.state !== "ready") {
        return {
          state: available.state,
          message: T3_TEXT[available.state],
          ...token,
          running,
          instances,
        };
      }
      return {
        state: "ready",
        message: "Paired with T3 Code.",
        paired_at: new Date(available.pairedAt).toISOString(),
        ...token,
        running,
        instances,
      };
    },

    "t3/pair": async (_params, cls) => {
      userOnly(cls);
      generation += 1;
      const mine = generation;
      for (const pending of attempts.values()) pending.attempt.cancel();
      attempts.clear();
      let attempt: PairingAttempt;
      try {
        attempt = await host.route.beginPairing();
      } catch (error) {
        const reason = failureOf(error);
        host.log.log("setup.pair_failed", { reason });
        throw pairError(reason, lineOf(error));
      }
      if (mine !== generation) {
        // A newer pairing started while this one was set up: it replaces this one.
        attempt.cancel();
        host.log.log("setup.pair_failed", { reason: "cancelled" });
        throw pairError("cancelled");
      }
      const done = host.route.finishPairing(attempt).then(
        (kept): Outcome => {
          host.log.log("setup.paired", { replaced: kept.replaced });
          return { ok: true, ...kept };
        },
        (error: unknown): Outcome => {
          const reason = failureOf(error);
          host.log.log("setup.pair_failed", { reason });
          const line = lineOf(error);
          return { ok: false, reason, ...(line === undefined ? {} : { line }) };
        },
      );
      const id = randomBytes(16).toString("hex");
      attempts.set(id, { attempt, done });
      return {
        attempt: id,
        url: attempt.url,
        expires_at: new Date(attempt.expiresAt).toISOString(),
      };
    },

    "t3/pair_wait": async (params, cls) => {
      userOnly(cls);
      const id = params["attempt"];
      const pending = typeof id === "string" && ATTEMPT_ID.test(id) ? attempts.get(id) : undefined;
      if (pending === undefined || typeof id !== "string") {
        throw new AppError({
          code: "invalid_input",
          message: "No pairing with T3 is in progress under this ID.",
          hint: `Run ${CLI_NAME} setup t3 again.`,
          data: { issues: [{ path: "attempt", message: "No pairing in progress" }] },
        });
      }
      const outcome = await pending.done;
      if (attempts.get(id) === pending) attempts.delete(id);
      if (!outcome.ok) throw pairError(outcome.reason, outcome.line);
      return { paired: true, replaced: outcome.replaced, ...iso(outcome.expiresAt) };
    },
  };
}
