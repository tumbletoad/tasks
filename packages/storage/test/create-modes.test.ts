// What storage's creation helpers set a mode on (A2 3.2.2 rule 5): only
// what this call created. A folder that was there, or that another process made in between, keeps
// its mode; a lock file is never created by SQLite, whose mode would follow the umask; a copy into
// a file that cannot be created leaves no stream behind.
//
// The moments between two calls are reached by wrapping node:fs's own functions (module's
// syncBuiltinESMExports carries the change to every importer) or the driver the lock is given, so
// the product code runs as it is. Each test also checks that its moment was reached, and what the
// product asked for at it (the flags of an open, SQLite's create), so that it fails on code that
// gets there differently. A mode that SQLite's default 0644 cannot become under any umask (0620)
// shows who created a file.
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compressFile } from "../src/backup/policy.ts";
import type { SqliteDriver } from "../src/driver.ts";
import { makeDirExact } from "../src/files.ts";
import { nodeSqliteDriver } from "../src/node-sqlite.ts";
import { takeFileLock } from "../src/writer-lock.ts";
import { tempFolders } from "./space-helpers.ts";

const posix = process.platform !== "win32";
const folders = tempFolders("modes");
const modeOf = (path: string) => statSync(path).mode & 0o777;

/** The errno code `fn` throws, or undefined. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  folders.cleanup();
});

/** Runs `around` in place of node:fs's `name` for every importer, until the test ends. */
function wrap<A extends unknown[], R>(
  name: "mkdirSync" | "statSync",
  around: (real: (...args: A) => R, ...args: A) => R,
): void {
  const table = fs as unknown as Record<string, unknown>;
  const real = table[name] as (...args: A) => R;
  table[name] = (...args: A) => around(real, ...args);
  syncBuiltinESMExports();
  restores.push(() => {
    table[name] = real;
    syncBuiltinESMExports();
  });
}

describe("[A2.3.2.2.permissions.create] storage sets a mode only on what it created", () => {
  test.skipIf(!posix)(
    "makeDirExact: what was there keeps its mode, what another process made in between too",
    () => {
      const root = folders.make();
      const top = join(root, "top");
      mkdirSync(top);
      chmodSync(top, 0o755);
      makeDirExact(join(top, "a", "b"), 0o700, { recursive: true });
      expect(modeOf(top)).toBe(0o755);
      expect(modeOf(join(top, "a"))).toBe(0o700);
      expect(modeOf(join(top, "a", "b"))).toBe(0o700);
      // Without `recursive` an existing folder is EEXIST, and is not touched.
      chmodSync(join(top, "a"), 0o750);
      expect(() => {
        makeDirExact(join(top, "a"), 0o700);
      }).toThrow(expect.objectContaining({ code: "EEXIST" }));
      expect(modeOf(join(top, "a"))).toBe(0o750);
      // Another process makes x/y with its own mode once x exists, before this call makes x/y.
      const middle = join(root, "x", "y");
      let injected = false;
      const race = (real: (path: string) => unknown) => {
        real(middle);
        chmodSync(middle, 0o751);
        injected = true;
      };
      wrap<Parameters<typeof fs.mkdirSync>, string | undefined>("mkdirSync", (real, ...args) => {
        const [path, options] = args;
        const recursive =
          typeof options === "object" && options !== null && options.recursive === true;
        if (!injected && recursive && String(path).startsWith(`${middle}/`)) {
          // A recursive mkdir is one native call that makes each missing folder in turn, which a
          // test cannot step into. It is played here with the same steps: x, then the other
          // process's x/y, then the rest; it returns the first folder it made, as Node's does.
          real(join(root, "x"), options);
          race(real);
          real(...args);
          return join(root, "x");
        }
        // Folder by folder, as makeDirExact works: the other process's mkdir comes just before.
        if (!injected && path === middle && existsSync(join(root, "x"))) race(real);
        return real(...args);
      });
      makeDirExact(join(middle, "z"), 0o700, { recursive: true });
      expect(injected).toBe(true);
      expect(modeOf(middle)).toBe(0o751);
      expect(modeOf(join(root, "x"))).toBe(0o700);
      expect(modeOf(join(middle, "z"))).toBe(0o700);
    },
  );

  test.skipIf(!posix)("makeDirExact: a new folder replaced by a link is not followed", () => {
    const root = folders.make();
    const outside = join(root, "outside");
    mkdirSync(outside);
    chmodSync(outside, 0o755);
    const target = join(root, "new");
    let injected = false;
    wrap<Parameters<typeof fs.mkdirSync>, string | undefined>("mkdirSync", (real, ...args) => {
      const result = real(...args);
      if (args[0] === target) {
        rmSync(target, { recursive: true });
        symlinkSync(outside, target);
        injected = true;
      }
      return result;
    });
    // O_DIRECTORY refuses the link first on Linux (ENOTDIR), O_NOFOLLOW elsewhere (ELOOP).
    expect(["ELOOP", "ENOTDIR"]).toContain(
      codeOf(() => {
        makeDirExact(target, 0o700);
      }),
    );
    expect(injected).toBe(true);
    expect(modeOf(outside)).toBe(0o755);
  });

  test.skipIf(!posix)(
    "a lock file removed before SQLite opens it is created again with its exact mode, never by SQLite",
    async () => {
      const root = folders.make();
      // Every open SQLite is asked for is recorded: none may create the file, since SQLite would
      // give a new one its own 0644 masked by the umask. The mode asked for, 0620, is one 0644
      // cannot become under any umask (it has no group write), so the mode shows who created it.
      const creates: boolean[] = [];
      const recording = (before?: (path: string) => void): SqliteDriver => ({
        ...nodeSqliteDriver,
        open: (path, opts) => {
          creates.push(opts.create !== false);
          before?.(path);
          return nodeSqliteDriver.open(path, opts);
        },
      });
      const lock = join(root, "writer.lock");
      // Removed between the stat that takes its identity and SQLite's open.
      let removed = false;
      const held = await takeFileLock(
        recording((path) => {
          if (path === lock && !removed) {
            removed = true;
            rmSync(lock);
          }
        }),
        lock,
        250,
        0o620,
      );
      expect(removed).toBe(true);
      expect(held).toBeDefined();
      expect(creates).not.toContain(true);
      expect(modeOf(lock)).toBe(0o620);
      held?.release();
      // Removed between its exclusive creation and the stat before the open.
      const second = join(root, "service.lock");
      let gone = false;
      wrap<Parameters<typeof fs.statSync>, ReturnType<typeof fs.statSync>>(
        "statSync",
        (real, ...args) => {
          if (args[0] === second && !gone && existsSync(second)) {
            gone = true;
            rmSync(second);
          }
          return real(...args);
        },
      );
      creates.length = 0;
      const again = await takeFileLock(recording(), second, 250, 0o620);
      expect(gone).toBe(true);
      expect(again).toBeDefined();
      expect(creates.length).toBeGreaterThan(0);
      expect(creates).not.toContain(true);
      expect(modeOf(second)).toBe(0o620);
      again?.release();
    },
  );

  test("a copy into a file that exists fails with that error alone: no source stream is left to fail later", async () => {
    const root = folders.make();
    const dest = join(root, "backup.db.gz");
    writeFileSync(dest, "kept");
    const uncaught: unknown[] = [];
    const record = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", record);
    try {
      await expect(compressFile(join(root, "missing.db"), dest)).rejects.toMatchObject({
        code: "SPACE_EXISTS",
      });
      // A source stream made before the failed creation would fail on its own a moment later.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off("uncaughtException", record);
    }
    expect(uncaught).toEqual([]);
    expect(readFileSync(dest, "utf8")).toBe("kept");
    // A missing source with a new destination: the source's error, and the destination closed.
    const fresh = join(root, "fresh.db.gz");
    await expect(compressFile(join(root, "missing.db"), fresh)).rejects.toMatchObject({
      code: "SPACE_NOT_FOUND",
    });
    rmSync(fresh);
    expect(existsSync(fresh)).toBe(false);
  });
});
