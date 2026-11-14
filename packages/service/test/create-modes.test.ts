// What the creation helpers set a mode on (A2 3.2.2 rule 5): only what this
// call created. A folder that was there, or that another process made in between, keeps its mode;
// a folder replaced before its mode is set is never followed; the log's append never creates a
// file without its mode. Linux and macOS: Windows keeps the inherited ACL and no mode is set.
//
// The moments between two calls are reached by wrapping node:fs's own functions (module's
// syncBuiltinESMExports carries the change to every importer), so the product code runs as it is.
// Each test also checks that its moment was reached, and what the product asked for at it (the
// flags of an open), so that it fails on code that gets there differently, whatever the umask.
import fs, {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendPrivate, makeDir } from "../src/hub/files.ts";
import { tempRoot } from "./harness.ts";

const posix = process.platform !== "win32";
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function temp(label: string): string {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  return root;
}

/**
 * Whether open flags may create a file that is not there without failing on one that is (O_CREAT
 * without O_EXCL): such an open gives a new file the mode masked by the umask.
 */
function createsNonExclusively(flags: unknown): boolean {
  if (typeof flags === "string") return /^[wa]/u.test(flags) && !flags.includes("x");
  if (typeof flags !== "number") return false;
  return (flags & constants.O_CREAT) !== 0 && (flags & constants.O_EXCL) === 0;
}

/** Runs `around` in place of node:fs's `name` for every importer, until the test ends. */
function wrap<A extends unknown[], R>(
  name: "mkdirSync" | "openSync",
  around: (real: (...args: A) => R, ...args: A) => R,
): void {
  const table = fs as unknown as Record<string, unknown>;
  const real = table[name] as (...args: A) => R;
  table[name] = (...args: A) => around(real, ...args);
  syncBuiltinESMExports();
  cleanups.push(() => {
    table[name] = real;
    syncBuiltinESMExports();
  });
}

describe.skipIf(!posix)(
  "[A2.3.2.2.permissions.create] a mode is set only on what this call created",
  () => {
    test("makeDir: folders that were there keep their mode, the ones it made get exactly the mode", () => {
      const root = temp("md");
      const top = join(root, "top");
      mkdirSync(top);
      chmodSync(top, 0o755);
      const made = makeDir(join(top, "a", "b"), 0o700);
      expect(made).toEqual([join(top, "a"), join(top, "a", "b")]);
      expect(modeOf(top)).toBe(0o755);
      expect(modeOf(join(top, "a"))).toBe(0o700);
      expect(modeOf(join(top, "a", "b"))).toBe(0o700);
      // Again: nothing is made, nothing is changed.
      chmodSync(join(top, "a"), 0o750);
      expect(makeDir(join(top, "a", "b"), 0o700)).toEqual([]);
      expect(modeOf(join(top, "a"))).toBe(0o750);
      // A file where the folder belongs throws EEXIST, as mkdir -p does.
      writeFileSync(join(top, "file"), "");
      expect(() => makeDir(join(top, "file"))).toThrow(expect.objectContaining({ code: "EEXIST" }));
    });

    test("makeDir: a folder another process makes between two of its steps keeps that process's mode", () => {
      const root = temp("mr");
      const middle = join(root, "a", "b");
      // Another process makes a/b with its own mode once a exists, before this call makes a/b.
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
          // test cannot step into. It is played here with the same steps: a, then the other
          // process's a/b, then the rest; it returns the first folder it made, as Node's does.
          real(join(root, "a"), options);
          race(real);
          real(...args);
          return join(root, "a");
        }
        // Folder by folder, as makeDir works: the other process's mkdir comes just before this one.
        if (!injected && path === middle && existsSync(join(root, "a"))) race(real);
        return real(...args);
      });
      const made = makeDir(join(middle, "c"), 0o700);
      expect(injected).toBe(true);
      expect(modeOf(middle)).toBe(0o751);
      expect(made).toEqual([join(root, "a"), join(middle, "c")]);
      expect(modeOf(join(root, "a"))).toBe(0o700);
      expect(modeOf(join(middle, "c"))).toBe(0o700);
    });

    test("makeDir: a new folder replaced by a link before its mode is set is not followed", () => {
      const root = temp("ml");
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
      expect(["ELOOP", "ENOTDIR"]).toContain(codeOf(() => makeDir(target, 0o700)));
      expect(injected).toBe(true);
      expect(modeOf(outside)).toBe(0o755);
    });

    test("appendPrivate: a file removed between its exclusive create and the append is created again with its mode", () => {
      const root = temp("ap");
      const log = join(root, "service.log");
      writeFileSync(log, "first\n", { mode: 0o600 });
      // The exclusive create sees the file (EEXIST); then a rotation moves it away before the
      // append opens it. Every open of the log is recorded: none may create the file without
      // failing on one that is there, since such an open gives a new file the umask's mode. The
      // mode asked for, 0700, is one Node's default 0666 cannot become under any umask (it has no
      // x bit), so the mode below shows who created the file too.
      let rotated = false;
      const opens: unknown[] = [];
      wrap<Parameters<typeof fs.openSync>, number>("openSync", (real, ...args) => {
        const [path, flags] = args;
        if (path !== log) return real(...args);
        opens.push(flags);
        if (!rotated && flags === "ax") {
          try {
            return real(...args);
          } finally {
            rotated = true;
            renameSync(log, `${log}.1`);
          }
        }
        return real(...args);
      });
      appendPrivate(log, "second\n", 0o700);
      expect(rotated).toBe(true);
      expect(opens.filter(createsNonExclusively)).toEqual([]);
      expect(opens.length).toBeGreaterThanOrEqual(3);
      expect(readFileSync(log, "utf8")).toBe("second\n");
      expect(modeOf(log)).toBe(0o700);
      expect(readFileSync(`${log}.1`, "utf8")).toBe("first\n");
    });

    test("appendPrivate: an existing log keeps its mode, and a link in its place is not followed", () => {
      const root = temp("al");
      const log = join(root, "service.log");
      writeFileSync(log, "first\n", { mode: 0o600 });
      chmodSync(log, 0o640);
      appendPrivate(log, "second\n");
      expect(readFileSync(log, "utf8")).toBe("first\nsecond\n");
      expect(modeOf(log)).toBe(0o640);
      const elsewhere = join(root, "elsewhere");
      writeFileSync(elsewhere, "");
      rmSync(log);
      symlinkSync(elsewhere, log);
      expect(() => {
        appendPrivate(log, "third\n");
      }).toThrow(expect.objectContaining({ code: "ELOOP" }));
      expect(readFileSync(elsewhere, "utf8")).toBe("");
    });
  },
);
