// Loads a driver by name inside the thread that will use it. The import is dynamic, so a module
// that only names drivers, such as the main thread's worker client, never loads a SQLite binding.
import type { DriverName, SqliteDriver } from "./driver.ts";
import { StorageError } from "./errors.ts";

export const DEFAULT_DRIVER: DriverName = "node:sqlite";

export async function loadDriver(name: DriverName): Promise<SqliteDriver> {
  switch (name) {
    case "node:sqlite":
      return (await import("./node-sqlite.ts")).nodeSqliteDriver;
    case "better-sqlite3":
      // The fallback arrives behind the same contract suite in M3.13 (A7 3.10).
      throw new StorageError(
        "STORAGE_UNSUPPORTED",
        "The better-sqlite3 driver is not part of this build",
      );
    default:
      throw new StorageError("STORAGE_UNSUPPORTED", "Unknown SQLite driver");
  }
}
