// Launch intents and their states (A4 3.9). Pure: the states, the routes, the edges of the state
// machine, the fixed reason codes, and the evidence a record may hold. Every backend of the
// execution store and the state machine read these, so there is one table of legal transitions.
//
// A launch record holds IDs, states, instants and fixed codes only: never a brief, a prompt, a
// composer text, a title or a path (A4 3.9.1, R14, AGENTS.md). The absolute folder, the composer
// text and the tickets stay in machine state (A4 3.16), where M2.08 puts them.

/** A4 3.9.1's states, in the order a launch moves through them. */
export const INTENT_STATES = [
  "prepared",
  "dispatching",
  "dispatched",
  "confirmed",
  "failed",
  "unknown",
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

/** The states recovery works on (A4 3.9.3, 3.16.1 `openWork`): not final on this machine. */
export const OPEN_STATES = ["prepared", "dispatching", "dispatched"] as const;
export type OpenState = (typeof OPEN_STATES)[number];

/** A4 3.1's routes: one mechanism of a target. */
export const ROUTES = ["terminal", "link", "t3-mcp", "t3-cli", "clipboard"] as const;
export type Route = (typeof ROUTES)[number];

/**
 * Whether a launch is still opening: Prepared, Dispatching, or a terminal launch its shim has not
 * settled yet, which its claim window ends. A link or T3 launch that was Dispatched only asked its
 * app, and nothing settles it. A second click gets a launch that is opening, and the page holds
 * Open while one is. The writer's `focus` statement holds the same rule.
 */
export const isOpening = (launch: { readonly state: string; readonly route: string }): boolean =>
  launch.state === "prepared" ||
  launch.state === "dispatching" ||
  (launch.state === "dispatched" && launch.route === "terminal");

/**
 * How a Confirmed launch's record says its session stands: `ended` once its agent's end was
 * reported (an earlier build recorded the exit code alone), `restored` once a claim or a restore in
 * place ended it as a backup's, `lost` once its shim went without a word, else `open`, which the
 * shim host decides.
 */
export function sessionRecord(
  evidence: Readonly<Record<string, unknown>>,
): "ended" | "restored" | "lost" | "open" {
  if (evidence["ran_ms"] !== undefined || evidence["exit_code"] !== undefined) return "ended";
  if (evidence["restored_at"] !== undefined) return "restored";
  return evidence["lost_at"] === undefined ? "open" : "lost";
}

/**
 * Whether a launch's record holds something open: a launch still opening, or a terminal session
 * whose end it does not record. A backup holds such records as they were when it was made: a
 * restored copy shows them as recorded, and a claim or a restore in place ends them as restored.
 */
export const isOpenLaunch = (launch: {
  readonly state: string;
  readonly route: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}): boolean =>
  isOpening(launch) ||
  (launch.state === "confirmed" &&
    launch.route === "terminal" &&
    sessionRecord(launch.evidence) === "open");

/**
 * Whether the launch row `l` (an alias in the statement) holds an agent that started and whose end
 * is not recorded: Dispatched once its shim claimed it (an end before its session is confirmed
 * fails the launch), or Confirmed while `sessionRecord` is `open`.
 */
export const heldAgentSql = (l: string): string =>
  `((${l}.state = 'dispatched' AND json_extract(${l}.detail, '$.evidence.claim') IS NOT NULL) OR ` +
  `(${l}.state = 'confirmed' AND json_extract(${l}.detail, '$.evidence.ran_ms') IS NULL AND ` +
  `json_extract(${l}.detail, '$.evidence.exit_code') IS NULL AND ` +
  `json_extract(${l}.detail, '$.evidence.restored_at') IS NULL AND ` +
  `json_extract(${l}.detail, '$.evidence.lost_at') IS NULL))`;

/**
 * The legal transitions (A4 3.9.1). A self edge records evidence and changes no state: T3's repeat
 * on Dispatching, before it is sent; a terminal shim's claim and its agent's PID on Dispatched; the
 * bridge's binding on Confirmed. Dispatching → Confirmed is a confirmation that arrives before the
 * call's own answer was recorded, in one step. Unknown moves only on a definite observation, to
 * Confirmed or Failed, and never back towards a dispatch. Confirmed and Failed are final.
 */
export const EDGES: Readonly<Record<IntentState, readonly IntentState[]>> = {
  prepared: ["dispatching", "failed"],
  dispatching: ["dispatching", "dispatched", "confirmed", "failed", "unknown"],
  dispatched: ["dispatched", "confirmed", "failed", "unknown"],
  confirmed: ["confirmed"],
  failed: [],
  unknown: ["confirmed", "failed"],
};

/** Whether `from → to` is an edge of A4's state machine. */
export const isEdge = (from: IntentState, to: IntentState): boolean => EDGES[from].includes(to);

/** Why a place does not resolve to a folder, or a working folder fails its check. A closed list. */
export const RESOLVE_REASONS = [
  /** The relative path is not a place's path (A1 3.15). */
  "invalid_path",
  /** This machine has no root with the place's root ID. */
  "root_missing",
  /** The root's folder is not there, is not a folder or cannot be reached. */
  "root_unavailable",
  /** The place's folder is not there or cannot be reached (a dangling link included). */
  "path_missing",
  /** The place is a folder and a file is there (through a link to a file included). */
  "not_a_directory",
  /** The place is a file and something else is there. */
  "not_a_file",
  /** The path leads outside the root's folder, through a link or a junction. */
  "escapes_root",
  /** The folder holds another repository than the one the place recorded, or none it can read. */
  "identity_mismatch",
  /** The volume gives no file number (0), so the folder has no identity to check: never guessed. */
  "identity_unavailable",
  /**
   * The working folder is not the directory `resolvePlace` found, or no longer lies at the depth
   * it found below the root's directory: the tree changed in between.
   */
  "folder_changed",
  /**
   * A folder TTasks makes and owns (the space's work folder, A4 3.3) is not one it may work
   * in: a link, a junction or another reparse point, another user's, open to other users (POSIX),
   * or not inside its parent by identity.
   */
  "unsafe_folder",
  /** The folder's drive or share did not answer in time: nothing was started. */
  "not_answering",
] as const;
export type ResolveReason = (typeof RESOLVE_REASONS)[number];

/**
 * The fixed reason codes of Failed and Unknown (A4 3.9.1, 3.9.2, 3.9.3). A record holds a code,
 * never a message: the UI words it (A4 3.9.4, 3.18).
 */
export const FAIL_REASONS = [
  /** Left in Prepared for 10 minutes. Not shown as a failure. */
  "expired",
  /** The person closed a Prepared question, or a check failed, before anything external. */
  "cancelled",
  /** A definite error before activation: the terminal, the URL handler or T3 refused. */
  "refused",
  /** Terminal: no claim within the claim window. No agent can start without one. */
  "not_claimed",
  /** Terminal: the shim's check of folder, executable or protocol failed. */
  "verify_failed",
  /** Terminal: the agent exited within 3 s. */
  "agent_exited",
  /** T3: the thread's folder is not the resolved folder. */
  "folder_mismatch",
  /** T3 does not offer the instance's model, and made no thread. */
  "model_unavailable",
  /** T3 refused the instance's permission as broader than the pairing allows, and made no thread. */
  "mode_denied",
  /** Clipboard: the service stopped before the copy was reported. */
  "interrupted",
  /**
   * A backup brought the launch back while it was still opening, and a claim or a restore in
   * place made that copy the space: nothing of it goes on here, whatever became of it elsewhere.
   */
  "restored",
  /** The folder no longer resolved right before the launch: its own reason. */
  ...RESOLVE_REASONS,
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export const UNKNOWN_REASONS = [
  /** The external call gave no answer, timed out or failed in a way that does not tell. */
  "no_answer",
  /** The service lost track: a restart, or a claimed shim that is gone without a report. */
  "lost",
  /** T3: TTasks re-paired before the launch settled, so a repeat would make a second thread. */
  "regranted",
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export type Reason = FailReason | UnknownReason;

const isOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T);

export const isIntentState = (value: unknown): value is IntentState => isOf(INTENT_STATES, value);
export const isRoute = (value: unknown): value is Route => isOf(ROUTES, value);
export const isFailReason = (value: unknown): value is FailReason => isOf(FAIL_REASONS, value);
export const isUnknownReason = (value: unknown): value is UnknownReason =>
  isOf(UNKNOWN_REASONS, value);

/**
 * The kinds of an evidence value: an ID (a native session or thread ID, a T3 grant ID, a claim,
 * a file identity), an instant in milliseconds, a non-negative count (a PID, an exit code) or a
 * flag. None can hold free text.
 */
export type EvidenceKind = "id" | "instant" | "count" | "flag";

/**
 * The evidence a launch record may hold (A4 3.9.1, 3.16: "evidence (shim claim, agent PID and
 * start time, T3 thread ID, observed cwd, bridge binding time)"). Evidence only grows: a key, once
 * written, keeps its value, which makes a terminal's claim a once-only record.
 */
export const EVIDENCE_FIELDS = {
  /** The resolved folder's file identity: device and inode, or the Windows volume and file ID. */
  folder_id: "id",
  /** The native session ID TTasks preset (Claude Code's `--session-id`). */
  preset: "id",
  /** T3: the grant the launch was dispatched under (added at Dispatching, A4 3.9.1). */
  grant: "id",
  /**
   * T3: when the idle-thread create was repeated with the same key (A4 3.9.3), recorded before the
   * repeat is sent. Evidence only grows, so a launch is repeated once at most.
   */
  replayed_at: "instant",
  /** The native session or thread ID the target returned (T3's thread ID). */
  thread: "id",
  /**
   * Terminal: the shim's claim, and when it was recorded. A fresh random ID per claim: never the
   * ticket or the attachment credential, which are secrets kept hashed in machine state.
   */
  claim: "id",
  claimed_at: "instant",
  /** Terminal: the agent's PID and process start time (`launch.started`). */
  pid: "count",
  pid_started_at: "instant",
  /** The observed working folder equals the resolved folder (shim verify, T3's folder check). */
  folder_checked: "flag",
  /** The agent's exit code, for a launch that ended (`launch.exited`). */
  exit_code: "count",
  /** Terminal: the agent ended after running this long, as its shim measured it. */
  ran_ms: "count",
  /**
   * Terminal: when the service found the shim of a Confirmed launch gone without a report. Its
   * agent most likely ended with it, but nothing says when or whether it did.
   */
  lost_at: "instant",
  /**
   * Terminal: when a claim or a restore in place ended the session of a Confirmed launch that a
   * backup brought back. Its agent may still run where it started; nothing of it belongs to this
   * copy of the space.
   */
  restored_at: "instant",
  /** The bridge redeemed the ticket or the launch reference (A3). */
  bound_at: "instant",
  /**
   * Terminal: the adapter that was Dispatched (`[terminal] app`'s names), and why it was in the
   * chain (TERMINAL_SOURCES), for the receipt.
   */
  terminal: "id",
  terminal_source: "id",
  /**
   * The person's note on the task that holds what they asked the launch's agent to do: its entry
   * reference, such as `n2`. Known at Prepared: the note is saved before the launch is recorded.
   */
  request: "id",
  /**
   * Terminal: the agent home the click started the app in, as a digest (`homeDigest`): the link
   * to the monitor's agents compares it, and the path itself is never stored.
   */
  home: "id",
  /**
   * What of the instance's settings the click's route could not carry, as Open said it: their
   * codes (`read-only`, `home`) joined by `.`. Known at Prepared, so every later answer says it.
   */
  left_out: "id",
} as const satisfies Record<string, EvidenceKind>;

export type EvidenceKey = keyof typeof EVIDENCE_FIELDS;

type EvidenceValue<K extends EvidenceKind> = K extends "id"
  ? string
  : K extends "flag"
    ? boolean
    : number;

export type Evidence = {
  [K in EvidenceKey]?: EvidenceValue<(typeof EVIDENCE_FIELDS)[K]>;
};

/** A native or local ID: plain characters only (the stream parsers' rule, runs/streams). */
export const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The largest instant: 9999-12-31T23:59:59.999Z (A1 3.4's integer domain). */
export const MAX_INSTANT = 253_402_300_799_999;

/** The largest count: 2^31 − 1 (A1 3.4). */
export const MAX_COUNT = 2_147_483_647;

/** Whether `value` is a valid value of an evidence kind. */
export function isEvidenceValue(kind: EvidenceKind, value: unknown): boolean {
  switch (kind) {
    case "id":
      return typeof value === "string" && EVIDENCE_ID.test(value);
    case "instant":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value <= MAX_INSTANT
        : false;
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value <= MAX_COUNT
        : false;
    case "flag":
      return typeof value === "boolean";
  }
}

/** The problem with `evidence` as a path such as `evidence.pid`, or undefined when it is valid. */
export function evidenceProblem(evidence: unknown): string | undefined {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return "evidence";
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(EVIDENCE_FIELDS, key)) return "evidence";
    if (!isEvidenceValue(EVIDENCE_FIELDS[key as EvidenceKey], value)) return `evidence.${key}`;
  }
  return undefined;
}

/** The evidence keys `incoming` sets to another value than `held` has: evidence only grows. */
export function evidenceConflicts(held: Evidence, incoming: Evidence): EvidenceKey[] {
  return (Object.keys(incoming) as EvidenceKey[]).filter(
    (key) => incoming[key] !== undefined && held[key] !== undefined && held[key] !== incoming[key],
  );
}

/** Evidence without undefined values, in key order, so two spellings compare equal. */
export function cleanEvidence(evidence: Evidence): Evidence {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(evidence).sort()) {
    const value = evidence[key as EvidenceKey];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Launch references (A4 3.1): `L`, four random symbols from A1's ID alphabet in upper case, and a
// check character, for example `L7KQ2M`. The space's writer makes them (never one a launch of the
// space held); this module only reads them.

/** A1's ID alphabet in upper case: Crockford base32 without I, L, O and U. */
export const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The check character of four reference symbols: their values weighted 1, 3, 5 and 7, summed mod
 * 32. Odd weights are invertible mod 32, so every single changed symbol changes the check.
 */
export function launchRefCheck(symbols: string): string | undefined {
  if (symbols.length !== 4) return undefined;
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const value = REF_ALPHABET.indexOf(symbols.charAt(i));
    if (value < 0) return undefined;
    sum += value * (2 * i + 1);
  }
  return REF_ALPHABET.charAt(sum % 32);
}

/** Whether `text` is a launch reference with a valid check character. */
export function isLaunchRef(text: unknown): text is string {
  if (typeof text !== "string" || text.length !== 6 || !text.startsWith("L")) return false;
  return launchRefCheck(text.slice(1, 5)) === text.charAt(5);
}

// ---------------------------------------------------------------------------------------------
// Timing (A4 3.9.1, 3.9.2, 3.6.3)

/** A Prepared intent is closed as `expired` after 10 minutes. */
export const PREPARED_TTL_MS = 10 * 60_000;

/**
 * A terminal launch's claim window: no claim within it means no agent started (A4 3.9.2). It runs
 * from Dispatching, when the ticket first leaves the service.
 */
export const CLAIM_WINDOW_MS = 120_000;

/**
 * How far in this clock's future a click may be recorded and still be placed on the monotonic
 * clock: a wall clock that stepped back a little.
 */
export const CLICK_SLACK_MS = 5_000;

/**
 * How long the launch machine waits for one call to the execution store. A call still unanswered
 * then has an open outcome (A1 3.8): the machine's call on that intent ends without it.
 */
export const STORE_DEADLINE_MS = 15_000;

/**
 * How long the launch machine waits for one external step: a dispatch, T3's repeat, a claim's
 * reply, an observation or the grant. A step still unanswered then is a timeout, which A4 3.9.2
 * records as not knowing; its call on that intent then ends.
 */
export const STEP_DEADLINE_MS = 30_000;

/**
 * Whether two instants lie at least `limit` apart, in either direction: how a window is judged
 * from the wall clock alone, for a record this service has no monotonic mark of (machine.ts). A
 * wall clock that stepped back then ends a window instead of stretching it: the safe side,
 * because ending a window starts nothing, and no agent starts without a claim.
 */
export const apart = (now: number, since: number, limit: number): boolean =>
  Math.abs(now - since) >= limit;
