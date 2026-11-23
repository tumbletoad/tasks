// Whether an open space's backups are working, as the service last saw them: its daily upkeep
// failed, its backups folder is not there, or the newest backup does not pass a trial restore or
// could not be trial restored. A person sees it where they look at
// their spaces (`ttasks space list`, `ttasks doctor`, the page's space switcher), with what to do,
// until a backup succeeds again. Nothing is stored: each start's first upkeep finds it again.
import { CLI_NAME } from "@ttasks/brand";
import type { MaintenanceReport } from "./maintenance.ts";

/**
 * - `disk_full`: the daily backup was refused because the disk has too little free space.
 * - `failed`: it failed otherwise (a full or failing disk while writing, a backups folder that
 *   cannot be written, a database that fails its check).
 * - `unverified`: the newest backup was made but does not pass a trial restore.
 * - `unchecked`: the newest backup's trial restore could not run, for want of free space beside it
 *   (BUNDLE_LIMIT_EXCEEDED) or for another reason that is not the backup's. Nothing is known of it.
 * - `away`: the backups folder this machine set for the space is not there.
 */
export type BackupTroubleWhy = "disk_full" | "failed" | "unverified" | "unchecked" | "away";

export interface BackupHealth {
  /** What is wrong, or undefined while backups work. */
  readonly trouble?: { readonly why: BackupTroubleWhy; readonly code?: string };
  /** When the newest backup that passed a trial restore was made, as far as the service knows. */
  readonly lastGood?: number;
}

/** What `ttasks space list`, doctor and the page get for a space whose backups are not working. */
export interface BackupTroubleView {
  readonly why: BackupTroubleWhy;
  readonly code?: string;
  /** What happened and what to do, for people. Names `<folder>`, never a path. */
  readonly message: string;
  /** The newest backup known to restore: an ISO instant. */
  readonly last_good?: string;
}

/**
 * The code a backup refused with before writing, for want of free disk space. The upkeep's reply
 * carries only a code, so a write that failed on a full disk (DURABILITY_FAILED) cannot be told
 * from one on a failing disk, and is `failed`.
 */
const NO_ROOM = "BUNDLE_LIMIT_EXCEEDED";

/** After an upkeep run that ended with `report`. */
export function afterRun(health: BackupHealth, report: MaintenanceReport): BackupHealth {
  // The run's verified backup is the newest by the work it holds, so it replaces the one known
  // before even when its date is earlier: a clock set back dates later work earlier.
  const lastGood = report.verifiedAt ?? health.lastGood;
  const base = lastGood === undefined ? {} : { lastGood };
  if (report.backup === "away") return { ...base, trouble: { why: "away" } };
  // Retention verified the newest backups in this run: its verdict replaces what was known.
  if (report.checked === true) {
    if (report.unverified > 0) return { ...base, trouble: { why: "unverified" } };
    const code = report.unchecked?.code;
    if (report.unchecked !== undefined) {
      return { ...base, trouble: { why: "unchecked", ...(code === undefined ? {} : { code }) } };
    }
    return base;
  }
  // A run without a verdict found no daily backup due: a complete one is there since the last
  // daily hour, so a failure before is over. A backup that does not restore, or that could not be
  // checked, is still there.
  const still = health.trouble?.why === "unverified" || health.trouble?.why === "unchecked";
  return still && health.trouble !== undefined ? { ...base, trouble: health.trouble } : base;
}

/** After an upkeep run that failed with `code`, the service's drain aside. */
export function afterFailure(health: BackupHealth, code: string | undefined): BackupHealth {
  const why: BackupTroubleWhy = code === NO_ROOM ? "disk_full" : "failed";
  return {
    ...(health.lastGood === undefined ? {} : { lastGood: health.lastGood }),
    trouble: { why, ...(code === undefined ? {} : { code }) },
  };
}

/** After a backup a person made that passed its trial restore, made at `at`. */
export const afterProvenBackup = (at: number): BackupHealth => ({ lastGood: at });

/**
 * One space's backup health across its upkeep runs and the person's own backups. A run reports
 * what it saw when it began: a proven backup or a reopen since then is newer, and the run's outcome
 * leaves the health alone.
 */
export class BackupWatch {
  #health: BackupHealth = {};
  #news = 0;

  /** An upkeep run begins: pass the returned mark to ran() or failed(). */
  begin(): number {
    return this.#news;
  }

  ran(begun: number, report: MaintenanceReport): void {
    if (begun === this.#news) this.#health = afterRun(this.#health, report);
  }

  failed(begun: number, code: string | undefined): void {
    if (begun === this.#news) this.#health = afterFailure(this.#health, code);
  }

  /** A backup the person made passed its trial restore. */
  proven(at: number): void {
    this.#health = afterProvenBackup(at);
    this.#news += 1;
  }

  /** The space closed: what is known belongs to the database that was open. */
  reset(): void {
    this.#health = {};
    this.#news += 1;
  }

  view(): BackupTroubleView | undefined {
    return troubleView(this.#health);
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** A local date and time to the minute, as the CLI shows a migration's. */
function local(at: number): string {
  const d = new Date(at);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const NOW = `${CLI_NAME} space backup <folder>`;

/** The view of a space's backup trouble, or undefined while its backups work. */
export function troubleView(health: BackupHealth): BackupTroubleView | undefined {
  const { trouble, lastGood } = health;
  if (trouble === undefined) return undefined;
  const code = trouble.code === undefined ? "" : ` (${trouble.code})`;
  const what = {
    disk_full: `The daily backup failed: the disk has too little free space${code}. Free some space, then make one now: ${NOW}.`,
    failed: `The daily backup failed${code}. Check that the disk has free space and that the backups folder can be written, then make one now: ${NOW}.`,
    unverified: `The newest backup does not pass a trial restore. Make a new one now: ${NOW}.`,
    unchecked:
      trouble.code === NO_ROOM
        ? `The newest backup could not be trial restored: the disk of its backups folder lacks the free space for the trial, with 1 GB to spare${code}. It is kept, and no backup was removed. Free some space: the next daily backup checks it again.`
        : `The newest backup could not be trial restored${code}. It is kept, and no backup was removed. Check the disk of its backups folder: the next daily backup checks it again.`,
    away: `The backups folder set for this space is not there, so no daily backup was made. If it is on a drive that is not connected, connect it; otherwise create the folder. ${CLI_NAME} space backups <folder> names it.`,
  }[trouble.why];
  const good =
    lastGood === undefined ? "" : ` The newest backup known to restore is from ${local(lastGood)}.`;
  return {
    why: trouble.why,
    ...(trouble.code === undefined ? {} : { code: trouble.code }),
    message: `${what}${good}`,
    ...(lastGood === undefined ? {} : { last_good: new Date(lastGood).toISOString() }),
  };
}
