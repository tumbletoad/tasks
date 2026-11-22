// The update journal, `<state>/update.json` (A2 3.2.3, 3.12.6): present only while an update or a
// rollback runs, written with an atomic replace (a new file flushed, then renamed over the old)
// before each step that needs it to be undone or finished, and removed once the install is the
// complete new version or, after a rollback, the complete old one. A journal found by a process
// that holds update.lock is an interrupted update: the lock is held by the updater for the whole
// update, so its owner is gone (repair.ts reconciles it).
//
// What a journal must say before the step that needs it:
//   - `staging`, before the staging folder is made, so a repair can remove it;
//   - `launchers` with each stable launcher's old and new SHA-256, before current or a launcher
//     changes, so a repair can bring each one to either side;
//   - phase `rolling_back`, before a rollback changes anything, so a repair never rolls forward an
//     update that had already decided to go back.
// The other phases (`prepare`, `staged`, `switched`, `launchers_done`, `restarted`) say how far it
// came, for doctor and for people; a repair decides from what is on disk.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../hub/files.ts";
import { isVersionName } from "./folder.ts";

export const UPDATE_JOURNAL = "update.json";
export const JOURNAL_FORMAT = 1;

export const PHASES = [
  "prepare",
  "staged",
  "switched",
  "launchers_done",
  "restarted",
  "rolling_back",
] as const;
export type Phase = (typeof PHASES)[number];

/** A stable launcher the switch changes (Windows): its old SHA-256 (null: none) and its new one. */
export interface LauncherChange {
  readonly name: string;
  readonly old: string | null;
  readonly new: string;
}

export interface Journal {
  readonly format: typeof JOURNAL_FORMAT;
  /** An update from an archive, or `ttasks update --rollback`. */
  readonly kind: "update" | "rollback";
  /** The version current named when it began. */
  readonly from: string;
  readonly to: string;
  readonly phase: Phase;
  /** The process that wrote it, for a person and doctor: never proof of anything. */
  readonly pid: number;
  readonly started_at: string;
  /** `versions/<staging>` while the archive is unpacked; null once it is gone or never made. */
  readonly staging: string | null;
  /** Whether this install's service answered when it began: the update brings it back. */
  readonly service: boolean;
  /**
   * Whether `to` passed its self-test: true from phase `staged` on (a `--rollback` tests its target
   * before it writes the journal), and kept through `rolling_back`. A repair keeps a new version
   * whose old one is broken only when this is true (repair.ts).
   */
  readonly tested: boolean;
  readonly launchers: readonly LauncherChange[];
}

const STAGING = /^\.staging-[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A staging folder's name: `.staging-` and 16 hex digits. */
export const isStagingName = (name: string): boolean => STAGING.test(name);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses a journal strictly. Undefined when it is not one this build wrote. */
export function parseJournal(text: string): Journal | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const { format, kind, from, to, phase, pid, started_at, staging, service, tested } = json;
  if (format !== JOURNAL_FORMAT) return undefined;
  if (kind !== "update" && kind !== "rollback") return undefined;
  if (typeof from !== "string" || !isVersionName(from)) return undefined;
  if (typeof to !== "string" || !isVersionName(to) || to === from) return undefined;
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) return undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return undefined;
  if (typeof started_at !== "string") return undefined;
  if (staging !== null && (typeof staging !== "string" || !STAGING.test(staging))) return undefined;
  if (typeof service !== "boolean") return undefined;
  if (typeof tested !== "boolean") return undefined;
  if (!Array.isArray(json["launchers"])) return undefined;
  const launchers: LauncherChange[] = [];
  for (const item of json["launchers"] as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { name, old, new: next } = item;
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.exe$/.test(name)) return undefined;
    if (old !== null && (typeof old !== "string" || !HEX64.test(old))) return undefined;
    if (typeof next !== "string" || !HEX64.test(next)) return undefined;
    launchers.push({ name, old, new: next });
  }
  return {
    format: JOURNAL_FORMAT,
    kind,
    from,
    to,
    phase: phase as Phase,
    pid,
    started_at,
    staging,
    service,
    tested,
    launchers,
  };
}

/** What `<state>/update.json` holds: none, a journal, or a file no updater of this build wrote. */
export type JournalRead =
  | { readonly kind: "none" }
  | { readonly kind: "journal"; readonly journal: Journal }
  | { readonly kind: "invalid" };

export function readJournal(state: string): JournalRead {
  let text: string;
  try {
    text = readFileSync(join(state, UPDATE_JOURNAL), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "invalid" };
  }
  const journal = parseJournal(text);
  return journal === undefined ? { kind: "invalid" } : { kind: "journal", journal };
}

/** Writes the journal: a new file, flushed, renamed over the old (0600). */
export function writeJournal(state: string, journal: Journal): void {
  atomicWrite(join(state, UPDATE_JOURNAL), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

/** Removes the journal: the install is a complete version again. */
export function removeJournal(state: string): void {
  rmSync(join(state, UPDATE_JOURNAL), { force: true });
}
