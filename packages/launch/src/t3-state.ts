// T3's machine state (A4 3.16 "T3 state"): the pairing (the client registration, its token and
// the current grant ID) and each T3 launch's plan. Machine state
// only: never machine.toml, never a space, never a log. The service keeps these as files in a
// user-only folder of `<state>`, written atomically with mode 0600 (hub/t3.ts); this module reads
// and writes them through that port and checks every field it reads back, so a damaged file is
// read as absent, never half-trusted.
//
// The grant ID (A4 3.1, 3.4.1 "Grant identity"): a local random ID per successful authorization.
// Every T3 intent records the grant it was dispatched under, and the one repeat A4 allows (L14) is
// sent only while the pairing still holds that grant.
import { randomBytes } from "node:crypto";
import { EVIDENCE_ID } from "./intents.ts";
import type { Grant } from "./t3-oauth.ts";

/** The files of T3's machine state, by name: `<name>.json` in the T3 state folder. */
export const T3_FILES = ["pairing", "plans"] as const;
export type T3FileName = (typeof T3_FILES)[number];

/**
 * How the route reaches its machine state. `write` replaces the file atomically, user-only; both
 * run synchronously, so a check and the send that follows it see one pairing.
 */
export interface T3Files {
  read(name: T3FileName): string | undefined;
  write(name: T3FileName, text: string): void;
}

/** An in-memory T3Files: for tests, and for a caller that keeps nothing. */
export class MemoryT3Files implements T3Files {
  readonly files = new Map<T3FileName, string>();
  read(name: T3FileName): string | undefined {
    return this.files.get(name);
  }
  write(name: T3FileName, text: string): void {
    this.files.set(name, text);
  }
}

/** A paired T3: the grant T3 issued and TTasks's grant ID for it. */
export interface T3Pairing extends Grant {
  /** TTasks's grant ID: new at every authorization (A4 3.1). */
  readonly grant: string;
  readonly pairedAt: number;
  /** Set when T3 refused the token (401): the instance shows "Reconnect T3" until paired again. */
  readonly reconnect: boolean;
  /** T3's environment ID, read once after pairing, for thread links. */
  readonly environment?: string;
}

/** A plan is kept this long after it was written, then dropped. */
export const PLAN_KEEP_MS = 7 * 24 * 60 * 60_000;

/** The largest T3 state file read back: the service's reader takes nothing larger (hub/t3.ts). */
export const T3_FILE_MAX_BYTES = 1024 * 1024;

/** A new grant ID: `t3g-` and 26 random base32 characters. */
export function newGrantId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `t3g-${[...randomBytes(26)].map((b) => alphabet.charAt(b % 32)).join("")}`;
}

const TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const CLIENT_ID = /^[\x21-\x7e]{1,512}$/u;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isObject(value) && value["format"] === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The pairing record as written, or undefined when there is none or it does not check. */
export function readPairing(files: T3Files): T3Pairing | undefined {
  const value = parse(files.read("pairing"));
  if (value === undefined) return undefined;
  const { grant, pairedAt, clientId, accessToken, expiresAt } = value;
  const { reconnect, environment } = value;
  if (typeof grant !== "string" || !EVIDENCE_ID.test(grant)) return undefined;
  if (!isInstant(pairedAt) || typeof reconnect !== "boolean") return undefined;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return undefined;
  if (typeof accessToken !== "string" || !TOKEN.test(accessToken)) return undefined;
  if (expiresAt !== undefined && !isInstant(expiresAt)) return undefined;
  if (
    environment !== undefined &&
    (typeof environment !== "string" || !EVIDENCE_ID.test(environment))
  ) {
    return undefined;
  }
  return {
    grant,
    pairedAt,
    reconnect,
    clientId,
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof environment === "string" ? { environment } : {}),
  };
}

export function writePairing(files: T3Files, pairing: T3Pairing): void {
  files.write("pairing", `${JSON.stringify({ format: 1, ...pairing })}\n`);
}

/** Where a thread runs in T3 (A4 3.4.1 steps 2 and 3). */
export type T3Strategy =
  { readonly type: "root" } | { readonly type: "existing_worktree"; readonly worktreePath: string };

/**
 * What a T3 launch sends, written before Dispatching (persistence before the step) so that a repeat
 * after a lost reply, or after a restart, sends the same call. Machine state: it holds the thread's
 * title and absolute folders, which never go into a space.
 */
export interface T3Plan {
  readonly projectId: string;
  readonly strategy: T3Strategy;
  /** `<task reference> <title>`, sanitised by the caller. */
  readonly title: string;
  readonly runtimeMode?: string;
  /** The resolved folder's identity, compared with the thread's folder (decimal text). */
  readonly folder: { readonly dev: string; readonly ino: string };
  readonly createdAt: number;
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function checkPlan(value: unknown): T3Plan | undefined {
  if (!isObject(value)) return undefined;
  const { projectId, strategy, title, runtimeMode, folder, createdAt } = value;
  if (!isText(projectId, 256) || !isText(title, 1024) || !isInstant(createdAt)) return undefined;
  if (!isObject(folder) || !isText(folder["dev"], 40) || !isText(folder["ino"], 40)) {
    return undefined;
  }
  let way: T3Strategy;
  if (isObject(strategy) && strategy["type"] === "root") way = { type: "root" };
  else if (
    isObject(strategy) &&
    strategy["type"] === "existing_worktree" &&
    isText(strategy["worktreePath"], 4096)
  ) {
    way = { type: "existing_worktree", worktreePath: strategy["worktreePath"] };
  } else return undefined;
  if (runtimeMode !== undefined && !isText(runtimeMode, 64)) return undefined;
  return {
    projectId,
    strategy: way,
    title,
    ...(runtimeMode === undefined ? {} : { runtimeMode }),
    folder: { dev: folder["dev"], ino: folder["ino"] },
    createdAt,
  };
}

/** The plan of launch `id`, or undefined. */
export function readPlan(files: T3Files, id: string): T3Plan | undefined {
  return checkPlan(parse(files.read("plans"))?.[id]);
}

/**
 * The plans file is kept at most this large, well within what its reader takes: a file the reader
 * refused would read as no plans, and the next write would drop them all.
 */
const PLANS_MAX_BYTES = T3_FILE_MAX_BYTES / 2;

/**
 * Writes the plan of launch `id`, and drops plans older than PLAN_KEEP_MS. When the file would grow
 * past PLANS_MAX_BYTES the oldest plans are dropped first, never the new one: a launch needs its
 * plan only for its repeat and its folder check, which come within minutes, or at the restart after.
 */
export function writePlan(files: T3Files, id: string, plan: T3Plan, now: number): void {
  const value = parse(files.read("plans")) ?? {};
  const older: [string, T3Plan][] = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === "format" || k === id) continue;
    const old = checkPlan(v);
    if (old !== undefined && now - old.createdAt < PLAN_KEEP_MS) older.push([k, old]);
  }
  older.sort((a, b) => b[1].createdAt - a[1].createdAt);
  const kept: Record<string, unknown> = { format: 1, [id]: plan };
  let size = Buffer.byteLength(JSON.stringify(kept)) + 1;
  for (const [k, old] of older) {
    // `,"<id>":<plan>` adds the length of `{"<id>":<plan>}` less one.
    const grows = Buffer.byteLength(JSON.stringify({ [k]: old })) - 1;
    if (size + grows > PLANS_MAX_BYTES) break;
    kept[k] = old;
    size += grows;
  }
  files.write("plans", `${JSON.stringify(kept)}\n`);
}
