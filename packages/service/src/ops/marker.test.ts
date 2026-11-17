// The marker in a project's or a task's folder (marker.ts): what it holds, what a launch's look at
// it finds (the right marker, another's, a marker gone, a folder that takes none, an old folder
// without one), how a clear and a move change it, and that a checkout's `git status` stays clean
// with it. Temporary folders of this test, fixture IDs. git runs only where it is installed, as
// the oracle of what a checkout shows.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FOLDER_MARKER } from "@tasks/brand";
import { FolderMarkers, MARKER_OWNERS, readMarker, type MarkerOwner } from "./marker.ts";

let base = "";
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-marker-")));
});
afterAll(() => {
  if (base !== "") {
    for (const left of [join(base, "locked")]) {
      if (existsSync(left)) chmodSync(left, 0o700);
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

let n = 0;
/** A new folder of this test, and a markers object whose home is the test's folder. */
function fresh(): { folder: string; markers: FolderMarkers; file: string } {
  n += 1;
  const folder = join(base, `f${String(n)}`);
  mkdirSync(folder, { recursive: true });
  const file = join(base, `marks-${String(n)}.json`);
  return { folder, markers: new FolderMarkers({ file, home: base }), file };
}

const SPACE = "s_0000000000000000000000000a";
const project: MarkerOwner = { space: SPACE, kind: "project", id: "p_0000000000000000000000000a" };
const task: MarkerOwner = { space: SPACE, kind: "task", id: "t_0000000000000000000000000a" };
const elsewhere: MarkerOwner = {
  space: "s_0000000000000000000000000b",
  kind: "project",
  id: "p_0000000000000000000000000b",
};

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

describe("[A1.3.15.folders.marker] the marker in a project's or a task's folder", () => {
  test("a marked folder holds the owners' IDs and an ignore file, and no task text", async () => {
    const { folder, markers } = fresh();
    expect(await markers.mark(project, folder)).toBe(true);
    expect(await markers.mark(task, folder)).toBe(true);
    // Marked twice for one owner, the marker names it once.
    expect(await markers.mark(task, folder)).toBe(true);
    const dir = join(folder, FOLDER_MARKER);
    expect(readdirSync(dir).sort()).toEqual([".gitignore", MARKER_OWNERS]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    const held = JSON.parse(readFileSync(join(dir, MARKER_OWNERS), "utf8")) as {
      about: string;
      owners: unknown[];
    };
    expect(held.owners).toEqual([
      { space: SPACE, project: project.id },
      { space: SPACE, task: task.id },
    ]);
    expect(Object.keys(held).sort()).toEqual(["about", "owners"]);
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project, task] });
  });

  test("a launch's look: its own marker opens, another's names them, a marker gone is missing", async () => {
    const { folder, markers } = fresh();
    await markers.mark(project, folder);
    expect(await markers.check(project, folder)).toEqual({ kind: "ok" });
    expect(await markers.check(task, folder)).toEqual({ kind: "other", owners: [project] });
    // Another space's project in the same folder: still not this task's.
    const shared = fresh();
    await shared.markers.mark(elsewhere, shared.folder);
    expect(await shared.markers.check(project, shared.folder)).toEqual({
      kind: "other",
      owners: [elsewhere],
    });
    // The checkout is moved aside and an unrelated one made at the same path.
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    expect(await markers.check(project, folder)).toEqual({ kind: "missing" });
    // A marker that cannot be read is not this owner's either.
    mkdirSync(join(folder, FOLDER_MARKER));
    writeFileSync(join(folder, FOLDER_MARKER, MARKER_OWNERS), "not json");
    expect(await markers.check(project, folder)).toEqual({ kind: "other", owners: [] });
    // The person chose to use it: marked, it opens.
    rmSync(join(folder, FOLDER_MARKER), { recursive: true });
    expect(await markers.mark(project, folder)).toBe(true);
    expect(await markers.check(project, folder)).toEqual({ kind: "ok" });
  });

  test("an old folder without a marker is marked at its next launch without a question", async () => {
    const { folder, markers } = fresh();
    expect(await markers.check(task, folder)).toEqual({ kind: "ok" });
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [task] });
    // From then on, its marker going is noticed.
    rmSync(join(folder, FOLDER_MARKER), { recursive: true });
    expect(await markers.check(task, folder)).toEqual({ kind: "missing" });
  });

  test("what this machine marked outlives the service: a new start still knows the marker should be there", async () => {
    const { folder, markers, file } = fresh();
    await markers.mark(task, folder);
    rmSync(join(folder, FOLDER_MARKER), { recursive: true });
    const again = new FolderMarkers({ file, home: base });
    expect(await again.check(task, folder)).toEqual({ kind: "missing" });
  });

  test("a folder that takes no marker opens as before, without the protection", async () => {
    const { folder, markers } = fresh();
    // Something that is not Tasks' marker has its name: nothing is written over it.
    writeFileSync(join(folder, FOLDER_MARKER), "a file of the person's");
    expect(await markers.mark(project, folder)).toBe(false);
    expect(await markers.check(project, folder)).toEqual({ kind: "ok" });
    expect(readFileSync(join(folder, FOLDER_MARKER), "utf8")).toBe("a file of the person's");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // A folder this account cannot write to.
      const locked = join(base, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      expect(await markers.mark(project, locked)).toBe(false);
      expect(await markers.check(project, locked)).toEqual({ kind: "ok" });
      expect(existsSync(join(locked, FOLDER_MARKER))).toBe(false);
    }
  });

  test("a clear takes the owner off the marker, and the marker goes with the last one", async () => {
    const { folder, markers } = fresh();
    await markers.mark(project, folder);
    await markers.mark(task, folder);
    await markers.unmark(task, folder);
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project] });
    await markers.unmark(project, folder);
    expect(existsSync(join(folder, FOLDER_MARKER))).toBe(false);
    // Cleared, the folder's marker is not missed: it is not this owner's folder any more.
    expect(await markers.check(project, folder)).toEqual({ kind: "ok" });
  });

  test("a folder that moved with another keeps its marker, and its marker is still missed when gone", async () => {
    const { folder, markers } = fresh();
    const inner = join(folder, "inner");
    mkdirSync(inner);
    await markers.mark(task, inner);
    const moved = `${folder}-moved`;
    renameSync(folder, moved);
    markers.moved(task, inner, join(moved, "inner"));
    expect(await markers.check(task, join(moved, "inner"))).toEqual({ kind: "ok" });
    rmSync(join(moved, "inner", FOLDER_MARKER), { recursive: true });
    expect(await markers.check(task, join(moved, "inner"))).toEqual({ kind: "missing" });
  });

  test.skipIf(!gitAvailable)(
    "a checkout's git status stays clean with the marker in it",
    async () => {
      const { folder, markers } = fresh();
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(base, "empty.gitconfig"),
      };
      writeFileSync(join(base, "empty.gitconfig"), "");
      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: folder, encoding: "utf8", env });
      expect(git("init", "-q").status).toBe(0);
      expect(git("status", "--porcelain", "--untracked-files=all").stdout).toBe("");
      expect(await markers.mark(project, folder)).toBe(true);
      expect(git("status", "--porcelain", "--untracked-files=all").stdout).toBe("");
      // The repository's own ignore files are left alone.
      expect(existsSync(join(folder, ".gitignore"))).toBe(false);
    },
  );
});
