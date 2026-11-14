// The space's Tasks work folder (A4 3.3): `<state>/workdirs/space-<id>/`, where a
// task without a place works. Before anything is made or entered, `workdirs` and the space's folder
// must each be a real folder (no link, junction or other reparse point), this user's, user-only on
// POSIX, and inside its parent by identity; only then is the work folder resolved like a place.
// Real links (POSIX) and junctions (Windows) on the real file system, and a link that appears
// between the check and the creation (every mkdir is interposed). Temporary folders only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const hook = vi.hoisted(() => ({
  /** Called before every mkdirSync, with its path. */
  beforeMkdir: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const mkdir = (...args: Parameters<typeof real.mkdirSync>): string | undefined => {
    hook.beforeMkdir?.(String(args[0]));
    return real.mkdirSync(...args);
  };
  return { ...real, mkdirSync: mkdir };
});

const { resolveLaunchFolder } = await import("../src/shim/folder.ts");

const WINDOWS = process.platform === "win32";
const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const SPACE_FOLDER = `space-${SPACE}`;

const temps: string[] = [];
afterEach(() => {
  hook.beforeMkdir = undefined;
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** A state folder (0700) and a folder outside it, in a temporary folder of the test's own. */
function world(): { state: string; outside: string; workdirs: string; space: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-work-folder-")));
  temps.push(base);
  const state = join(base, "state");
  const outside = join(base, "outside");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  if (!WINDOWS) chmodSync(state, 0o700);
  const workdirs = join(state, "workdirs");
  return { state, outside, workdirs, space: join(workdirs, SPACE_FOLDER) };
}

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function link(target: string, path: string): void {
  symlinkSync(target, path, WINDOWS ? "junction" : "dir");
}

const resolve = (state: string) => resolveLaunchFolder(null, SPACE, { roots: [], stateDir: state });

describe("[A4.5.shim.work-folder] the work folder is checked before anything is made or entered", () => {
  test("made on first use, each folder user-only, and resolved below the state folder; found again as it is", async () => {
    const w = world();
    const first = await resolve(w.state);
    expect(first).toMatchObject({ status: "ok", folder: realpathSync.native(w.space) });
    if (first.status === "ok") expect(first.check.depth).toBe(2);
    if (!WINDOWS) {
      expect(statSync(w.workdirs).mode & 0o777).toBe(0o700);
      expect(statSync(w.space).mode & 0o777).toBe(0o700);
    }
    const again = await resolve(w.state);
    expect(again).toMatchObject({ status: "ok", folder: realpathSync.native(w.space) });
  });

  test("a link or junction where the space's folder belongs is refused, to the state folder itself or outside", async () => {
    for (const target of ["state", "outside"] as const) {
      const w = world();
      mkdirSync(w.workdirs, { mode: 0o700 });
      if (!WINDOWS) chmodSync(w.workdirs, 0o700);
      link(w[target], w.space);
      expect(await resolve(w.state), target).toMatchObject({
        status: "failed",
        reason: "unsafe_folder",
      });
      expect(readdirSync(w.outside), target).toEqual([]);
    }
  });

  test("a link or junction where workdirs belongs is refused before anything is made through it", async () => {
    for (const where of ["outside", "inside"] as const) {
      const w = world();
      const target = where === "outside" ? w.outside : join(w.state, "elsewhere");
      if (where === "inside") mkdirSync(target, { mode: 0o700 });
      link(target, w.workdirs);
      expect(await resolve(w.state), where).toMatchObject({
        status: "failed",
        reason: "unsafe_folder",
      });
      // Nothing was made in the folder the link leads to.
      expect(readdirSync(target), where).toEqual([]);
    }
  });

  test("a file where a folder belongs is not a folder", async () => {
    const w = world();
    writeFileSync(w.workdirs, "");
    expect(await resolve(w.state)).toMatchObject({ status: "failed", reason: "not_a_directory" });
    const v = world();
    mkdirSync(v.workdirs, { mode: 0o700 });
    if (!WINDOWS) chmodSync(v.workdirs, 0o700);
    writeFileSync(v.space, "");
    expect(await resolve(v.state)).toMatchObject({ status: "failed", reason: "not_a_directory" });
  });

  test("a state folder that is not there is the root's absence, and nothing is made", async () => {
    const w = world();
    rmSync(w.state, { recursive: true });
    expect(await resolve(w.state)).toMatchObject({
      status: "failed",
      reason: "root_unavailable",
    });
    expect(existsSync(w.state)).toBe(false);
  });

  test.skipIf(WINDOWS)(
    "POSIX: a folder that lets others in, or is another user's, is refused and left as it is",
    async () => {
      const w = world();
      mkdirSync(w.workdirs, { mode: 0o700 });
      chmodSync(w.workdirs, 0o755);
      expect(await resolve(w.state)).toMatchObject({ status: "failed", reason: "unsafe_folder" });
      expect(statSync(w.workdirs).mode & 0o777).toBe(0o755);
      expect(existsSync(w.space)).toBe(false);

      chmodSync(w.workdirs, 0o700);
      mkdirSync(w.space, { mode: 0o700 });
      chmodSync(w.space, 0o750);
      expect(await resolve(w.state)).toMatchObject({ status: "failed", reason: "unsafe_folder" });
      expect(statSync(w.space).mode & 0o777).toBe(0o750);

      chmodSync(w.space, 0o700);
      expect(await resolve(w.state)).toMatchObject({ status: "ok" });
      // Owned by another user: this process reads as someone else.
      const own = process.getuid?.() ?? 0;
      vi.spyOn(process, "getuid").mockReturnValue(own + 1);
      expect(await resolve(w.state)).toMatchObject({ status: "failed", reason: "unsafe_folder" });
    },
  );

  test("a link that appears between the check and the creation: the launch is refused; what remains is one empty folder made through it", async () => {
    // workdirs is checked, then swapped for a link to a folder outside before the space's folder
    // is made. The mkdir follows the link (Node has no mkdirat): that is the window that remains,
    // and only this user can use it, since the state folder is theirs and user-only. The check
    // after the creation finds the space's folder outside its checked parent and refuses it.
    const w = world();
    hook.beforeMkdir = (path) => {
      if (path !== w.space) return;
      hook.beforeMkdir = undefined;
      renameSync(w.workdirs, `${w.workdirs}-checked`);
      link(w.outside, w.workdirs);
    };
    expect(await resolve(w.state)).toMatchObject({ status: "failed", reason: "unsafe_folder" });
    expect(readdirSync(w.outside)).toEqual([SPACE_FOLDER]);
    expect(readdirSync(join(w.outside, SPACE_FOLDER))).toEqual([]);

    // The same before workdirs is made: the link is found instead of a folder, nothing goes
    // through it.
    const v = world();
    hook.beforeMkdir = (path) => {
      if (path !== v.workdirs) return;
      hook.beforeMkdir = undefined;
      link(v.outside, v.workdirs);
    };
    expect(await resolve(v.state)).toMatchObject({ status: "failed", reason: "unsafe_folder" });
    expect(readdirSync(v.outside)).toEqual([]);
  });
});
