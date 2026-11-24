// What a migration did to a space, in the words a person reads after an update: from which schema
// to which, when, and the backup taken just before it. The service records the newest migration of
// each space (space-settings.ts `last_migration`); `ttasks space list` shows it, and doctor shows
// the ones of the service's current run.
import { CLI_NAME } from "@ttasks/brand";

export interface Migrated {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly backup?: string;
  /** The folder that backup is in. An older service leaves it out. */
  readonly backup_folder?: string;
  /** Whether that backup is still in the space's backups folder. An older service leaves it out. */
  readonly backup_listed?: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local date and time of an ISO instant, to the minute. */
export function local(at: string): string {
  const d = new Date(at);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One sentence: what the migration did, and the backup taken just before it. The person is sent to
 * the list only while the backup is there.
 */
export function migratedLine(migrated: Migrated): string {
  const backup =
    migrated.backup === undefined
      ? ""
      : migrated.backup_listed === false
        ? ` The backup taken just before it was ${migrated.backup}.`
        : migrated.backup_folder !== undefined
          ? ` The backup from just before it: ${migrated.backup}, in ${migrated.backup_folder}.`
          : ` The backup from just before it: ${migrated.backup} (${CLI_NAME} space backups lists it).`;
  return `Updated from schema ${migrated.from} to ${migrated.to} on ${local(migrated.at)}.${backup}`;
}

/** Whether a row's migration happened at or after `sinceMs`. */
export const migratedSince = (migrated: Migrated | undefined, sinceMs: number): boolean =>
  migrated !== undefined && Date.parse(migrated.at) >= sinceMs;
