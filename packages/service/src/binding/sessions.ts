// Session records and binding handles in machine state (A3 3.7.4, 3.7.7; A4 3.10; M2.04, M4.06).
//
// Where they live, for now. A1 3.4 and A4 3.16 put session records in the space, in a `sessions`
// table written through the execution store's `upsertSession`. Schema 0.1 has no such table, 0.1 is
// frozen (real spaces exist), and M3.01's schema 0.2 does not add it. So until a later schema step
// adds the table with its `session.*` operations, the records live here, in `<state>/sessions.json`,
// beside the binding handles that A2 keeps in machine state anyway. What a session did in a space
// reaches the space through the write path today: its actor joins with `actor.register`
// (`agent:<instance>:<session>`), every commit and log entry carries its `session_id` from the
// credential, and the launch it bound through records `bound_at` (A4 3.9.1). What moves with
// the table: these records, behind the `SessionStore` interface below, and the user's `session.*`
// operations (bindings.ts `unbind`, `rebind`, `end`), which then go through the writer.
//
// The file holds IDs, instants, fixed words and hashes only: never a task text, a ticket, a handle
// or a path. It is replaced atomically (0600) after every change that must outlive a restart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isId } from "@tasks/storage";
import { INSTANCE_ID, isRoute, type Route } from "@tasks/launch";
import { atomicWrite } from "../hub/files.ts";
import { NATIVE_ID, NATIVE_SOURCES, type NativeSource } from "../ops/index.ts";

export const SESSIONS_FILE = "sessions.json";

/**
 * How a session was bound first (A3 3.7.3): the ticket, the launch reference, a task choice, a
 * native ID alone (rule 3), or the user's rebind of an earlier session (A3 3.7.3 "Rebinding").
 */
export const VIA = ["ticket", "launch_ref", "task", "native_id", "rebind"] as const;
export type Via = (typeof VIA)[number];

/**
 * Where a native ID on a session came from (A4 3.10's `native_id_source`), which decides what it
 * may do. `preset`, `returned` and `reference-match` are IDs the launch itself set or received (A4
 * preset Claude's UUID, T3 returned its thread ID, the reference match found Codex's thread):
 * each binds alone (A3 3.7.3 rule 3) and offers Resume. `bridge` is one a connection presented when
 * it bound through the launch's ticket, reference or native ID: it offers Resume, binds nothing
 * alone. `presented` is one a connection showed otherwise (an ad-hoc bind by task): it only lets the
 * same session's ticket be presented again (rule 2) and marks a connection shared.
 */
export const TRUST = ["preset", "returned", "reference-match", "bridge", "presented"] as const;
export type Trust = (typeof TRUST)[number];

/** The IDs that bind alone (A3 3.7.3 rule 3): the launch's own. */
export const BINDS_ALONE: ReadonlySet<Trust> = new Set<Trust>([
  "preset",
  "returned",
  "reference-match",
]);

/** A native ID a session holds, with where it came from. */
export interface NativeRecord {
  readonly source: NativeSource;
  readonly id: string;
  readonly trust: Trust;
}

/**
 * Why a session ended: a day without a connection, an agent or a call (`idle`); made with its
 * launch and never bound for 7 days (`stale`); the user ended, unbound or rebound it.
 */
export const END_REASONS = ["idle", "stale", "user", "unbound", "rebound"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** A session record (A4 3.10's logical fields, as far as the binding service uses them). */
export interface SessionRecord {
  /** `se_` ID. */
  readonly id: string;
  /** The space it is pinned to for its whole life. */
  readonly space: string;
  /** Its task; null for a routine's (M6). */
  readonly task: string | null;
  /**
   * The agent home it belongs to (A3 3.7.8): the instance of the connection that bound it first,
   * or `manual`. A session made with its launch intent holds the launch's instance until then.
   */
  readonly instance: string;
  /** How it was bound first; null while no agent has bound it (made with its launch, A3 3.7.7). */
  readonly via: Via | null;
  /** The launches it was bound through, first open first. */
  readonly launches: readonly string[];
  /** Native IDs it holds (A3 3.7.3), each with where it came from. */
  readonly native: readonly NativeRecord[];
  /** The A4 instance its launch opened, for Resume (A4 3.10). */
  readonly opened_with?: string;
  /** How its first launch opened (A4 3.1's route). */
  readonly route?: Route;
  /** Its launch reference was resolved on a shared connection: opened, not tracked (A3 3.7.5). */
  readonly untracked?: true;
  /**
   * The session whose writer scope it writes under (A3 3.7.9): the first of a chain of rebinds, so
   * a retry after a rebind finds the receipt of a write made before it. Absent: its own.
   */
  readonly scope?: string;
  readonly created_at: number;
  /** The last bind or call (A3 3.7.7 `session.call`), kept at most a minute behind. */
  readonly seen_at: number;
  /** When it ended, and why. */
  readonly ended_at?: number;
  readonly end_reason?: EndReason;
}

/** A binding handle (A2 3.6.4, A3 3.7.4): the hash of a secret only the bridge's memory holds. */
export interface HandleRecord {
  /** SHA-256 of the handle, lower-case hex. */
  readonly hash: string;
  /** The instance of the connection it was issued to: only that instance resumes it. */
  readonly instance: string;
  /** The space the connection pinned. */
  readonly space: string | null;
  /** The session it is bound to. */
  readonly session: string | null;
  /**
   * The connection was unbound at some time, so it may have written unbound (A3 3.7.9): that
   * scope stays a receipt lookup. Set in the handle's first write when its bind left it unbound.
   */
  readonly wrote_unbound: boolean;
  /** The connection carried two conversations (A3 3.7.5): it stays shared when resumed. */
  readonly shared?: boolean;
  readonly created_at: number;
  /** The last bind or call through it: a handle is valid 24 hours after it, sliding. */
  readonly used_at: number;
}

export interface SessionState {
  readonly sessions: readonly SessionRecord[];
  readonly handles: readonly HandleRecord[];
}

/** Where the records are kept. `save` is durable when it returns, and throws when it is not. */
export interface SessionStore {
  /** The records, and how many invalid ones were left out. */
  load(): { readonly state: SessionState; readonly dropped: number };
  save(state: SessionState): void;
}

/**
 * At most this many of each are kept: ended sessions and handles no open connection holds go
 * first, oldest first; a live session is never removed to make room.
 */
export const MAX_SESSIONS = 4096;
export const MAX_HANDLES = 4096;
/** A session's launches and native IDs, each at most. */
export const MAX_LAUNCHES = 16;
export const MAX_NATIVE = 8;
/** The largest file read back, and so the largest written. */
const MAX_FILE = 8 * 1024 * 1024;

const INSTANT_MAX = 253_402_300_799_999;
const HASH = /^[0-9a-f]{64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= INSTANT_MAX;
/** An instance a record may name: an A4 instance ID, or `manual` for an entry without one. */
export const isInstance = (value: unknown): value is string =>
  typeof value === "string" && (value === "manual" || INSTANCE_ID.test(value));

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value);

function sessionOf(value: unknown): SessionRecord | undefined {
  if (!isObject(value)) return undefined;
  const { id, space, task, instance, via, launches, native, created_at, seen_at } = value;
  const { opened_with, route, untracked, scope, ended_at, end_reason } = value;
  if (!isId(id, "se") || !isId(space, "sp") || !isInstance(instance)) return undefined;
  if (task !== null && !isId(task, "t")) return undefined;
  if (via !== null && !isOneOf(VIA, via)) return undefined;
  if (!Array.isArray(launches) || launches.length > MAX_LAUNCHES) return undefined;
  if (!launches.every((l) => isId(l, "la"))) return undefined;
  if (!Array.isArray(native) || native.length > MAX_NATIVE) return undefined;
  const ids: NativeRecord[] = [];
  for (const entry of native) {
    if (!isObject(entry)) return undefined;
    const { source, id: nativeId, trust } = entry;
    if (!isOneOf(NATIVE_SOURCES, source)) return undefined;
    if (typeof nativeId !== "string" || !NATIVE_ID.test(nativeId)) return undefined;
    // A record of an earlier build holds no trust: what it held was only presented.
    if (trust !== undefined && !isOneOf(TRUST, trust)) return undefined;
    ids.push({ source, id: nativeId, trust: trust ?? "presented" });
  }
  if (opened_with !== undefined && !isInstance(opened_with)) return undefined;
  if (route !== undefined && !isRoute(route)) return undefined;
  if (untracked !== undefined && untracked !== true) return undefined;
  if (scope !== undefined && !isId(scope, "se")) return undefined;
  if (!isInstant(created_at) || !isInstant(seen_at)) return undefined;
  if (ended_at !== undefined && !isInstant(ended_at)) return undefined;
  if (end_reason !== undefined && (ended_at === undefined || !isOneOf(END_REASONS, end_reason))) {
    return undefined;
  }
  return {
    id,
    space,
    task,
    instance,
    via,
    launches: launches,
    native: ids,
    ...(opened_with === undefined ? {} : { opened_with }),
    ...(route === undefined ? {} : { route }),
    ...(untracked === true ? { untracked } : {}),
    ...(scope === undefined ? {} : { scope }),
    created_at,
    seen_at,
    ...(ended_at === undefined ? {} : { ended_at }),
    ...(end_reason === undefined ? {} : { end_reason }),
  };
}

function handleOf(value: unknown): HandleRecord | undefined {
  if (!isObject(value)) return undefined;
  const { hash, instance, space, session, wrote_unbound, shared, created_at, used_at } = value;
  if (typeof hash !== "string" || !HASH.test(hash) || !isInstance(instance)) return undefined;
  if (space !== null && !isId(space, "sp")) return undefined;
  if (session !== null && !isId(session, "se")) return undefined;
  if (typeof wrote_unbound !== "boolean") return undefined;
  if (shared !== undefined && typeof shared !== "boolean") return undefined;
  if (!isInstant(created_at) || !isInstant(used_at)) return undefined;
  return {
    hash,
    instance,
    space,
    session,
    wrote_unbound,
    ...(shared === true ? { shared } : {}),
    created_at,
    used_at,
  };
}

/** The records of a file's text, each checked; an invalid one is left out and counted. */
export function parseSessions(textValue: string): { state: SessionState; dropped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return { state: { sessions: [], handles: [] }, dropped: 1 };
  }
  if (!isObject(parsed) || parsed["format"] !== 1) {
    return { state: { sessions: [], handles: [] }, dropped: 1 };
  }
  // Every record is read (the file's size bounds them): the binding service keeps the counts
  // within MAX_SESSIONS and MAX_HANDLES when it admits one, never by dropping what it wrote.
  const rawSessions = Array.isArray(parsed["sessions"]) ? parsed["sessions"] : [];
  const rawHandles = Array.isArray(parsed["handles"]) ? parsed["handles"] : [];
  const sessions = rawSessions.flatMap((s) => sessionOf(s) ?? []);
  const handles = rawHandles.flatMap((h) => handleOf(h) ?? []);
  return {
    state: { sessions, handles },
    dropped: rawSessions.length - sessions.length + (rawHandles.length - handles.length),
  };
}

/** The file's text for the records. */
export function formatSessions(state: SessionState): string {
  return `${JSON.stringify({ format: 1, sessions: state.sessions, handles: state.handles })}\n`;
}

/** `<state>/sessions.json`. */
export class FileSessionStore implements SessionStore {
  readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, SESSIONS_FILE);
  }

  load(): { state: SessionState; dropped: number } {
    let textValue: string;
    try {
      const bytes = readFileSync(this.path);
      if (bytes.byteLength > MAX_FILE) return { state: { sessions: [], handles: [] }, dropped: 1 };
      textValue = bytes.toString("utf8");
    } catch {
      return { state: { sessions: [], handles: [] }, dropped: 0 };
    }
    return parseSessions(textValue);
  }

  save(state: SessionState): void {
    const textValue = formatSessions(state);
    if (Buffer.byteLength(textValue, "utf8") > MAX_FILE) {
      throw new Error("The session records are larger than the file may be");
    }
    atomicWrite(this.path, textValue, 0o600);
  }
}

/** In memory, through the same text: for tests. */
export class MemorySessionStore implements SessionStore {
  text: string | undefined;
  saves = 0;

  load(): { state: SessionState; dropped: number } {
    return this.text === undefined
      ? { state: { sessions: [], handles: [] }, dropped: 0 }
      : parseSessions(this.text);
  }

  save(state: SessionState): void {
    this.text = formatSessions(state);
    this.saves += 1;
  }
}
