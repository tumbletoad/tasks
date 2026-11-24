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
//
// An install over another version (install.ts) keeps the same journal in a file of its own,
// `<state>/install-update.json`: a service of a version from before it reads update.json in any
// form and restarts after repairing it, and it must never do that unasked for an install.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../hub/files.ts";
import { isVersionName } from "./folder.ts";

export const UPDATE_JOURNAL = "update.json";
export const INSTALL_JOURNAL = "install-update.json";
export const JOURNAL_FORMAT = 1;

const KINDS = ["update", "rollback", "install"] as const;
export type JournalKind = (typeof KINDS)[number];

/** The file of a journal of `kind`. */
const fileOf = (kind: JournalKind): string =>
  kind === "install" ? INSTALL_JOURNAL : UPDATE_JOURNAL;
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
  /** An update from an archive, `ttasks update --rollback`, or an install over another version. */
  readonly kind: JournalKind;
  /** The version current named when it began. */
  readonly from: string;
  readonly to: string;
  readonly phase: Phase;
  /** The process that wrote it, for a person and doctor: never proof of anything. */
  readonly pid: number;
  readonly started_at: string;
  /** `versions/<staging>` while the archive is unpacked; null once it is gone or never made. */
  readonly staging: string | null;
  /**
   * Whether the update restarts this install's service, and a repair brings it back: it ran when
   * the update began, or at the switch with the person's agreement. Always false for an install.
   */
  readonly service: boolean;
  /**
   * Whether `to` passed its self-test: true from phase `staged` on (a `--rollback` tests its target
   * before it writes the journal), and kept through `rolling_back`. A repair keeps a new version
   * whose old one is broken only when this is true (repair.ts).
   */
  readonly tested: boolean;
  readonly launchers: readonly LauncherChange[];
}

/** The journal of `ttasks update` itself: an update or a rollback, in update.json. */
export type UpdateJournal = Journal & { readonly kind: "update" | "rollback" };

const STAGING = /^\.staging-[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A staging folder's name: `.staging-` and 16 hex digits. */
export const isStagingName = (name: string): boolean => STAGING.test(name);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parses a journal strictly. Undefined when it is not one this build wrote in that file: an
 * install's in its own, an update's or a rollback's in update.json.
 */
function parseJournal(text: string, file: string): Journal | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const { format, kind, from, to, phase, pid, started_at, staging, service, tested } = json;
  if (format !== JOURNAL_FORMAT) return undefined;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return undefined;
  if (fileOf(kind as JournalKind) !== file) return undefined;
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
    kind: kind as JournalKind,
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

/**
 * What the journals hold: none, a journal, or a file no updater of this build wrote (`of` names
 * whose file it is). update.json first: an older version's update after an install was cut off is
 * the later of the two.
 */
export type JournalRead =
  | { readonly kind: "none" }
  | { readonly kind: "journal"; readonly journal: Journal }
  | { readonly kind: "invalid"; readonly of: JournalKind };

export function readJournal(state: string): JournalRead {
  for (const kind of ["update", "install"] as const) {
    const file = fileOf(kind);
    let text: string;
    try {
      text = readFileSync(join(state, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { kind: "invalid", of: kind };
    }
    const journal = parseJournal(text, file);
    return journal === undefined ? { kind: "invalid", of: kind } : { kind: "journal", journal };
  }
  return { kind: "none" };
}

/** Whether a journal of either kind is there: an update or an install runs, or was cut off. */
export const journalPresent = (state: string): boolean =>
  existsSync(join(state, UPDATE_JOURNAL)) || existsSync(join(state, INSTALL_JOURNAL));

/** Writes a journal into its kind's file: a new file, flushed, renamed over the old (0600). */
export function writeJournal(state: string, journal: Journal): void {
  atomicWrite(join(state, fileOf(journal.kind)), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

/** Removes the journal of `kind` (an update's by default): the install is complete again. */
export function removeJournal(state: string, kind: JournalKind = "update"): void {
  rmSync(join(state, fileOf(kind)), { force: true });
}
