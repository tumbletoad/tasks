import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { NODE_IO, type FileIo } from "@ttasks/storage";
import { tempRoot } from "../../test/harness.ts";
import { readyBackupsFolder } from "./space-settings.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** File I/O that records each folder synced, and fails the sync when `fail` says so. */
function recording(fail = false): { io: FileIo; synced: string[] } {
  const synced: string[] = [];
  const open = new Map<number, string>();
  let next = -1000;
  const io: FileIo = {
    ...NODE_IO,
    openSync: (path, flags, mode) => {
      if (flags !== "r") return NODE_IO.openSync(path, flags, mode);
      next -= 1;
      open.set(next, path);
      return next;
    },
    fsyncSync: (fd) => {
      const path = open.get(fd);
      if (path === undefined) {
        NODE_IO.fsyncSync(fd);
        return;
      }
      if (fail) throw Object.assign(new Error("injected"), { code: "EIO" });
      synced.push(path);
    },
    closeSync: (fd) => {
      if (!open.delete(fd)) NODE_IO.closeSync(fd);
    },
  };
  return { io, synced };
}

describe("[A1.5.backup.outside-home] the default backups folder is made durably before a backup goes there", () => {
  // A folder's sync is POSIX's (storage's fsyncFolder); Windows has none to make.
  test.skipIf(process.platform === "win32")(
    "each folder it makes has its entry synced in its parent; one that cannot be synced is not used",
    () => {
      const { root, cleanup } = tempRoot("ready-backups");
      cleanups.push(cleanup);
      const home = join(root, "h-backups");
      const dir = join(home, "sp_fixture");
      const made = recording();
      expect(readyBackupsFolder({ dir, set: false }, made.io)).toBe(dir);
      expect(made.synced).toEqual([home, root]);
      const failing = recording(true);
      expect(readyBackupsFolder({ dir: join(home, "sp_other"), set: false }, failing.io)).toBe(
        undefined,
      );
    },
  );

  test("the default folder is made; a folder a person set never is, since it may be on a drive that is away", () => {
    const { root, cleanup } = tempRoot("ready-set");
    cleanups.push(cleanup);
    const dir = join(root, "h-backups", "sp_fixture");
    expect(readyBackupsFolder({ dir, set: false })).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    const away = join(root, "drive", "backups");
    expect(readyBackupsFolder({ dir: away, set: true })).toBe(away);
    expect(existsSync(away)).toBe(false);
  });
});
