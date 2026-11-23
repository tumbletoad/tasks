// What a migration did to a space, in the words a person reads after an update: from which schema
// to which, when, and the backup taken just before it. The service records the newest migration of
// each space (space-settings.ts `last_migration`); `ttasks space list` shows it, doctor shows the
// ones of the service's current run, and `ttasks update` the ones its restart ran.
import { CLI_NAME } from "@ttasks/brand";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";

export interface Migrated {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly backup?: string;
  /** Whether that backup is still in the space's backups folder. An older service leaves it out. */
  readonly backup_listed?: boolean;
}

interface Row {
  readonly name?: string;
  readonly id?: string;
  readonly registered?: string;
  readonly state?: string;
  readonly migrated?: Migrated;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local date and time of an ISO instant, to the minute. */
function local(at: string): string {
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
        : ` The backup from just before it: ${migrated.backup} (${CLI_NAME} space backups lists it).`;
  return `Updated from schema ${migrated.from} to ${migrated.to} on ${local(migrated.at)}.${backup}`;
}

/** Whether a row's migration happened at or after `sinceMs`. */
export const migratedSince = (migrated: Migrated | undefined, sinceMs: number): boolean =>
  migrated !== undefined && Date.parse(migrated.at) >= sinceMs;

/** How long `ttasks update` waits for the spaces its restart opens: a migration can take a while. */
export const SETTLE_MS = 120_000;
const POLL_MS = 500;

/**
 * After a restart: waits until no space is opening (at most `waitMs`), then gives a line for each
 * space a migration changed since `sinceMs`, and one for each space still opening. Nothing when the
 * service cannot be asked: the update itself is done either way.
 */
export async function migrationLines(
  io: Io,
  connect: ConnectOptions,
  sinceMs: number,
  waitMs: number = SETTLE_MS,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
): Promise<string[]> {
  let session: Session | undefined;
  try {
    session = await connectService(io, connect);
    const deadline = Date.now() + waitMs;
    let rows: Row[] = [];
    for (;;) {
      const listed = (await session.call("space/list", {}, { timeoutMs: 10_000 })) as {
        spaces?: Row[];
      };
      rows = listed.spaces ?? [];
      if (!rows.some((row) => row.state === "opening") || Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    const lines: string[] = [];
    for (const row of rows) {
      const name = row.name ?? row.id ?? row.registered ?? "A space";
      if (row.state === "opening") {
        lines.push(
          `${name} is still opening, perhaps behind a migration. ${CLI_NAME} space list shows what it did once it is open.`,
        );
      } else if (row.migrated !== undefined && migratedSince(row.migrated, sinceMs)) {
        lines.push(`${name}: ${migratedLine(row.migrated)}`);
      }
    }
    return lines;
  } catch {
    return [];
  } finally {
    session?.close();
  }
}
