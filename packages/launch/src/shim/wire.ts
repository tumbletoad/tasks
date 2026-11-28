// The shim's part of ttasks-local/1: the methods a shim connection calls, the
// shapes of their params and replies, the patterns of the ticket and the attachment credential, and
// the shim's timings. Both sides read this file: the shim (`ttasks shim`, packages/cli/src/shim) and
// the service (host.ts). It imports types only, so the shim loads it without anything else of
// launch.
//
// What crosses the wire:
// - `launch.claim {ticket, role, pid, start_time}` presents the one-use ticket, once, from the
//   process the claim names. Its reply is the only message that carries what starts an agent:
//   argv, the environment, the attachment credential, and the check of the folder the shim was
//   started in (places.ts FolderCheck), never in argv or in the agent's environment.
// - `launch.attach {credential, pid, start_time}` presents the credential after a reconnect. Its
//   reply carries no argv, environment or brief, so an attachment can report and never start.
// - The reports (`launch.started`, `settled`, `exited`, `failed`) go on a connection that claimed
//   or attached, and only there: the connection holds the attachment, not the message.
import type { FolderCheck, ResolveReason } from "../places.ts";

/** The shim protocol's version, which the claim reply names and the shim checks. */
export const SHIM_PROTOCOL = 1;

/** The methods for interactive launches. */
export const SHIM_METHODS = {
  claim: "launch.claim",
  attach: "launch.attach",
  started: "launch.started",
  settled: "launch.settled",
  exited: "launch.exited",
  failed: "launch.failed",
} as const;

export type ShimMethod = (typeof SHIM_METHODS)[keyof typeof SHIM_METHODS];
export type ReportMethod = Exclude<ShimMethod, "launch.claim" | "launch.attach">;

/** The ID alphabet in upper case: the ticket's symbols. */
export const TICKET_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 120 random bits in base32, the ID alphabet in upper case, 24 symbols. */
export const TICKET = /^[0-9A-HJKMNP-TV-Z]{24}$/;

/**
 * 128 random bits as unpadded base64url, 22 characters. The last character carries two
 * bits, so it is one of four. No ticket fits this pattern, and no credential fits a ticket's.
 */
export const CREDENTIAL = /^[A-Za-z0-9_-]{21}[AQgw]$/;

/**
 * A process's start time exactly as its OS records it (`process.ts`): Linux's start time in clock
 * ticks since boot with the boot's ID, Windows's creation time as a FILETIME (100 ns since 1601).
 * Opaque: only compared for equality.
 */
export const START_TIME =
  /^(linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,20}|windows:\d{1,20})$/;

/** A PID a claim or a report may name: a positive count. */
export const isPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

/** A remote as places record it (git-remote.ts): one printable ASCII word, 2,048 at most. */
export const REMOTE = /^[\x21-\x7e]{1,2048}$/;

/** A launch ID (store.ts LAUNCH_ID: a test compares them), for the shim, which loads no store. */
export const LAUNCH_ID_FORM = /^la_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** A launch reference's form (intents.ts isLaunchRef also checks its check character). */
export const LAUNCH_REF_FORM = /^L[0-9A-HJKMNP-TV-Z]{5}$/;

/**
 * A name the agent's environment may hold: the plan's (records.ts), the service's computed
 * environment (environment.ts) and the shim's reading of the reply all keep to it, so the service
 * never sends a name the shim refuses.
 */
export const AGENT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/;

/**
 * The bounds of what the claim's reply carries, kept by the plan at the click (records.ts
 * checkPlan), by the environment the service computes, and checked again by the shim.
 */
export const REPLY_BOUNDS = {
  /** Entries of argv. */
  argv: 4096,
  /** Characters of one argument. */
  arg: 131_072,
  /** Names in the agent's environment (the instance's own: half of it). */
  env: 8192,
  /** Characters of one environment value (Windows' limit is 32,767). */
  value: 32_768,
  /** Characters of the title. */
  title: 1024,
  /** Characters of the exit file's path. */
  path: 4096,
} as const;

/** Text without a NUL, at most `max` characters. */
export const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");

/** Whether `value` is a plain object, as JSON gives one. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether `value` is a plain object holding exactly the `required` keys and maybe `optional` ones. */
export function hasExactly(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

const DECIMAL = /^(0|[1-9][0-9]{0,39})$/;

const CHECK_FIELDS = ["dev", "ino", "rootDev", "rootIno", "depth"] as const;

/**
 * A folder check as it travels in the claim's reply and in machine state (places.ts FolderCheck),
 * checked field by field and exactly (no other field): identities as decimal text, a depth, and
 * the remote when there is one. Undefined when it is not one: the shim then starts nothing.
 */
export function checkFolderCheck(value: unknown): FolderCheck | undefined {
  if (!hasExactly(value, CHECK_FIELDS, ["gitRemote"])) return undefined;
  const { dev, ino, rootDev, rootIno, depth, gitRemote } = value;
  const numbers = [dev, ino, rootDev, rootIno];
  if (!numbers.every((n): n is string => typeof n === "string" && DECIMAL.test(n))) {
    return undefined;
  }
  if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0 || depth > 1024) {
    return undefined;
  }
  if (gitRemote !== undefined && (typeof gitRemote !== "string" || !REMOTE.test(gitRemote))) {
    return undefined;
  }
  const [d, i, rd, ri] = numbers as [string, string, string, string];
  return {
    dev: d,
    ino: i,
    rootDev: rd,
    rootIno: ri,
    depth,
    ...(gitRemote === undefined ? {} : { gitRemote }),
  };
}

/** `after_exit` (sections.ts holds the same list; a test compares them). */
export const AFTER_EXIT_MODES = ["close", "close-on-success", "pause", "shell"] as const;
export type AfterExit = (typeof AFTER_EXIT_MODES)[number];

/** `launch.claim`'s params. */
export interface ClaimParams {
  readonly ticket: string;
  readonly role: "shim";
  readonly pid: number;
  readonly start_time: string;
}

/** The claim's reply: what the shim verifies and starts. */
export interface ClaimReply {
  readonly protocol: number;
  readonly launch: { readonly id: string; readonly reference: string };
  /** The absolute executable first. */
  readonly argv: readonly string[];
  /**
   * The folder the service resolved right before the launch, as its real path. The shim enters it
   * itself: no terminal's working-directory flag or start-folder setting decides where the
   * agent starts, and the folder never goes into a terminal's argv.
   */
  readonly folder: string;
  /**
   * What the shim checks about the folder once it is in it, before it does anything else
   * (`checkWorkingFolder`): the identity of the folder the service resolved, the
   * root's directory at its depth above it, and the remote the place recorded. The agent starts
   * there with no working-directory option of its own, so it inherits the checked folder.
   */
  readonly check: FolderCheck;
  /**
   * The agent's environment as the service computed it, final: the shim starts the agent
   * directly with it, never through a shell whose profile could change it or the folder.
   */
  readonly env: Readonly<Record<string, string>>;
  /** For the terminal title and the announce line. */
  readonly title: string;
  readonly after_exit: AfterExit;
  /** The attachment credential. The shim keeps it in memory only. */
  readonly credential: string;
  /** Where the shim writes `exit.json` when the service cannot be reached. */
  readonly exit_file: string;
  /** A fixed line to print under the announce line. */
  readonly notice?: Notice;
}

/**
 * Lines the shim prints under its announce line, by code: `brief_sent`, the app is too old to
 * hold the brief in its prompt box, so it was sent (catalogue.ts RouteDef `since`).
 */
export const NOTICES = ["brief_sent"] as const;
export type Notice = (typeof NOTICES)[number];

/** `launch.attach`'s params. */
export interface AttachParams {
  readonly credential: string;
  readonly pid: number;
  readonly start_time: string;
}

/** The attach reply: which launch, nothing that starts one. */
export interface AttachReply {
  readonly protocol: number;
  readonly launch: { readonly id: string; readonly reference: string };
}

/** `launch.started`: the agent's PID and when the shim started it (wall clock, milliseconds). */
export interface StartedParams {
  readonly pid: number;
  readonly started_at: number;
}

/** `launch.exited`. `settled`: the agent ran for 3 s or longer. */
export interface ExitedParams {
  readonly code: number | null;
  readonly signal: string | null;
  readonly ran_ms: number;
  readonly settled: boolean;
}

/** Why the shim started no agent after its claim: its check of the reply failed, or the spawn did. */
export const FAILED_REASONS = ["verify", "spawn"] as const;
export type FailedReason = (typeof FAILED_REASONS)[number];

export interface FailedParams {
  readonly reason: FailedReason;
  /** For a folder that failed the shim's check: `checkWorkingFolder`'s reason (places.ts). */
  readonly folder?: ResolveReason;
}

/**
 * `exit.json`: what the shim could not report because the service was down,
 * written atomically into its launch folder. The service collects it at start-up and in its check.
 */
export interface ExitFile {
  readonly format: 1;
  readonly launch: string;
  /** Whether the agent was started at all. */
  readonly spawned: boolean;
  readonly settled: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly ran_ms: number;
  readonly failed?: FailedReason;
  /** As `FailedParams.folder`. */
  readonly folder?: ResolveReason;
}

/** The reason word of every refused claim, attach or report. One word: no oracle for a guesser. */
export const REFUSED = "launch_refused";

/**
 * Terminal variables the shim adds from its own environment when the service's environment does
 * not name them (the agent's environment has no terminal layer: the terminal sets these for the shim, and an
 * interactive agent needs them). Names only from this list, never a pass-through.
 */
export const TERMINAL_ENV = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "VTE_VERSION",
] as const;

/** The agent counts as settled once it has run this long. */
export const SETTLE_MS = 3_000;

/** How long the shim tries to reach a service that is not reachable. */
export const CONNECT_RETRY_MS = 30_000;

/** How often a shim whose connection dropped tries again. */
export const REATTACH_MS = 5_000;
