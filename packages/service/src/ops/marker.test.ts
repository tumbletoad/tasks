// The marker in a project's or a task's folder (marker.ts): what it holds, what a launch's look at
// it finds (the right marker, another's, a marker gone, a folder that takes none, an old folder
// without one, a marker written after its bound or never), how a clear and a move change it, and
// that a checkout's `git status` stays clean with it. Temporary folders of this test, fixture IDs. git runs only where it is installed, as
// the oracle of what a checkout shows.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { FOLDER_MARKER } from "@ttasks/brand";
import {
  FolderMarkers,
  identityFrom,
  MARKER_OWNERS,
  readMarker,
  type MarkerOwner,
} from "./marker.ts";
import { holdNextWrite, type HeldWrite } from "../../test/slow-marker.ts";

let base = "";
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-marker-")));
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

vi.mock("@ttasks/files", async () => (await import("../../test/slow-marker.ts")).slowFiles());

// The clock moves only when a test moves it: a disk slowed by load never passes a marker's bound.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Marks while the owners file's write is held past the bound (slow-marker.ts): the mark answers
 * false, and `land` lets the write go on.
 */
async function markSlowly(
  markers: FolderMarkers,
  owner: MarkerOwner,
  folder: string,
): Promise<{ answered: boolean; land: HeldWrite["land"] }> {
  const held = holdNextWrite();
  const marking = markers.mark(owner, folder);
  await held.reached;
  await vi.advanceTimersByTimeAsync(60_000);
  return { answered: await marking, land: held.land };
}

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
    if (process.platform !== "win32") {
      // Exactly these modes, whatever the umask.
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(statSync(join(dir, ".gitignore")).mode & 0o777).toBe(0o644);
      expect(statSync(join(dir, MARKER_OWNERS)).mode & 0o777).toBe(0o644);
    }
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

  test("a launch's look: its own marker opens, a marker gone is missing, another's names them", async () => {
    const { folder, markers } = fresh();
    await markers.mark(project, folder);
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
    // The checkout is moved aside and an unrelated one made at the same path.
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    expect(await markers.check(project, folder)).toEqual({ kind: "missing" });
    // The unrelated one became another space's project's folder.
    await new FolderMarkers({ file: join(base, "marks-elsewhere.json") }).mark(elsewhere, folder);
    expect(await markers.check(project, folder)).toEqual({ kind: "other", owners: [elsewhere] });
    // A marker that is not one TTasks writes is not this owner's either.
    writeFileSync(join(folder, FOLDER_MARKER, MARKER_OWNERS), "not json");
    expect(await markers.check(project, folder)).toEqual({ kind: "other", owners: [] });
    // The person chose to use it: marked over the broken one, it opens from then on.
    expect(await markers.mark(project, folder)).toBe(true);
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project] });
  });

  test("an owner this machine never marked in a folder opens there, and joins its marker", async () => {
    // Set before markers, or before the folder was there, next to another owner of the folder.
    const { folder, markers } = fresh();
    await markers.mark(project, folder);
    expect(await markers.check(task, folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project, task] });
    // A clear takes the task off, and an undo of the clear gives it the folder back.
    await markers.unmark(task, folder);
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project] });
    expect(await markers.check(task, folder)).toMatchObject({ kind: "ok" });
    // Another space's folder that this machine never marked for the project.
    const shared = fresh();
    await shared.markers.mark(elsewhere, shared.folder);
    expect(await markers.check(project, shared.folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(shared.folder)).toEqual({
      state: "owners",
      owners: [elsewhere, project],
    });
    // A broken owners file in a folder never marked for this owner is written over quietly.
    const broken = fresh();
    mkdirSync(join(broken.folder, FOLDER_MARKER));
    writeFileSync(join(broken.folder, FOLDER_MARKER, MARKER_OWNERS), "not json");
    expect(await broken.markers.check(task, broken.folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(broken.folder)).toEqual({ state: "owners", owners: [task] });
  });

  test("an old folder without a marker is marked at its next launch without a question", async () => {
    const { folder, markers } = fresh();
    expect(await markers.check(task, folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [task] });
    // From then on, another folder made at its path is noticed.
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    expect(await markers.check(task, folder)).toEqual({ kind: "missing" });
  });

  test("a marker gone from the very folder that was marked, as git clean -x leaves it, is put back without a question", async () => {
    const { folder, markers } = fresh();
    await markers.mark(project, folder);
    rmSync(join(folder, FOLDER_MARKER), { recursive: true });
    writeFileSync(join(folder, "build.log"), "made after the clean");
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project] });
    // Moved aside with its marker gone, and an unrelated folder made at the path: that one asks.
    rmSync(join(folder, FOLDER_MARKER), { recursive: true });
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    expect(await markers.check(project, folder)).toEqual({ kind: "missing" });
  });

  test("a marker written too slowly still keeps the folder: a folder made again at the path asks", async () => {
    // The write was given up at its bound and puts nothing in place after it; the very folder
    // takes its marker at the next look, and a checkout made at its path after that asks.
    const late = fresh();
    const slowly = await markSlowly(late.markers, project, late.folder);
    expect(slowly.answered).toBe(false);
    expect(await slowly.land()).toBeInstanceOf(Error);
    expect(await readMarker(late.folder)).toEqual({ state: "none" });
    expect(await late.markers.check(project, late.folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(late.folder)).toEqual({ state: "owners", owners: [project] });
    renameSync(late.folder, `${late.folder}-aside`);
    mkdirSync(late.folder);
    expect(await late.markers.check(project, late.folder)).toEqual({ kind: "missing" });

    // The checkout is replaced before any look: the new one asks.
    const never = fresh();
    const held = await markSlowly(never.markers, project, never.folder);
    renameSync(never.folder, `${never.folder}-aside`);
    mkdirSync(never.folder);
    expect(await held.land()).toBeInstanceOf(Error);
    expect(await never.markers.check(project, never.folder)).toEqual({ kind: "missing" });

    // The very folder whose write never landed takes its marker at the next look.
    const same = fresh();
    await (await markSlowly(same.markers, task, same.folder)).land(new Error("held by a scanner"));
    expect(await readMarker(same.folder)).toEqual({ state: "none" });
    expect(await same.markers.check(task, same.folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(same.folder)).toEqual({ state: "owners", owners: [task] });
  });

  test("a folder shared with another owner, where this owner's slow write never landed, opens and names both", async () => {
    const { folder, markers } = fresh();
    await markers.mark(project, folder);
    await (await markSlowly(markers, task, folder)).land(new Error("held by a scanner"));
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project] });
    expect(await markers.check(task, folder)).toMatchObject({ kind: "ok" });
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [project, task] });
  });

  test("a write given up at its bound changes nothing after: not another checkout moved to the path, not a cleared folder", async () => {
    // Another marked checkout takes the path while the write is held.
    const { folder, markers } = fresh();
    const held = await markSlowly(markers, project, folder);
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    await new FolderMarkers({ file: join(base, "marks-other.json") }).mark(elsewhere, folder);
    expect(await held.land()).toBeInstanceOf(Error);
    expect(await readMarker(folder)).toEqual({ state: "owners", owners: [elsewhere] });
    expect(await markers.check(project, folder)).toEqual({ kind: "other", owners: [elsewhere] });

    // The folder is cleared while the write is held.
    const cleared = fresh();
    const late = await markSlowly(cleared.markers, project, cleared.folder);
    await cleared.markers.unmark(project, cleared.folder);
    expect(await late.land()).toBeInstanceOf(Error);
    expect(await readMarker(cleared.folder)).toEqual({ state: "none" });
  });

  test("Use this folder is remembered for a folder that takes no marker", async () => {
    const { folder, markers, file } = fresh();
    await markers.mark(project, folder);
    // Another folder at the path, one TTasks cannot mark (a read-only share that came back as
    // another device): it asks, and the person says to use it.
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    writeFileSync(join(folder, FOLDER_MARKER), "a file of the person's");
    expect(await markers.check(project, folder)).toEqual({ kind: "missing" });
    expect(await markers.use(project, folder)).toMatchObject({ kind: "ok" });
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
    expect(await new FolderMarkers({ file, home: base }).check(project, folder)).toMatchObject({
      kind: "ok",
    });
    // Another folder made there after that still asks.
    renameSync(folder, `${folder}-again`);
    mkdirSync(folder);
    expect(await markers.check(project, folder)).toEqual({ kind: "missing" });
  });

  test("a file system that keeps no creation time or no usable file number gives no identity, so a gone marker still asks", () => {
    const known = { dev: 7n, ino: 42n, birthtimeNs: 1_700_000_000_000_000_000n };
    expect(identityFrom(known)).toBe("7:42:1700000000000000000");
    expect(identityFrom({ ...known, birthtimeNs: 0n })).toBeUndefined();
    expect(identityFrom({ ...known, ino: 0n })).toBeUndefined();
    expect(identityFrom({ ...known, ino: -1n })).toBeUndefined();
    expect(identityFrom({ ...known, ino: 2n ** 64n - 1n })).toBeUndefined();
  });

  test("what this machine marked outlives the service: a new start still knows the marker should be there", async () => {
    const { folder, markers, file } = fresh();
    await markers.mark(task, folder);
    rmSync(join(folder, FOLDER_MARKER), { recursive: true });
    // The same folder, after a new start: its marker is put back.
    expect(await new FolderMarkers({ file, home: base }).check(task, folder)).toMatchObject({
      kind: "ok",
    });
    renameSync(folder, `${folder}-aside`);
    mkdirSync(folder);
    expect(await new FolderMarkers({ file, home: base }).check(task, folder)).toEqual({
      kind: "missing",
    });
  });

  test("a folder that takes no marker opens as before, without the protection", async () => {
    const { folder, markers } = fresh();
    // Something that is not TTasks's marker has its name: nothing is written over it.
    writeFileSync(join(folder, FOLDER_MARKER), "a file of the person's");
    expect(await markers.mark(project, folder)).toBe(false);
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
    expect(readFileSync(join(folder, FOLDER_MARKER), "utf8")).toBe("a file of the person's");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // A folder this account cannot write to.
      const locked = join(base, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      expect(await markers.mark(project, locked)).toBe(false);
      expect(await markers.check(project, locked)).toMatchObject({ kind: "ok" });
      expect(existsSync(join(locked, FOLDER_MARKER))).toBe(false);
    }
  });

  test("a link where the marker belongs is never followed", async () => {
    const { folder, markers } = fresh();
    const outside = join(base, `outside-${String(n)}`);
    mkdirSync(outside);
    writeFileSync(join(outside, ".gitignore"), "the person's own\n");
    // A junction on Windows, which needs no privilege; a symbolic link elsewhere.
    symlinkSync(outside, join(folder, FOLDER_MARKER), "junction");
    expect(await markers.mark(project, folder)).toBe(false);
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
    await markers.unmark(project, folder);
    expect(readdirSync(outside)).toEqual([".gitignore"]);
    expect(readFileSync(join(outside, ".gitignore"), "utf8")).toBe("the person's own\n");
  });

  test("a folder of the person's with the marker's name keeps what the person put in it", async () => {
    const { folder, markers } = fresh();
    const dir = join(folder, FOLDER_MARKER);
    mkdirSync(dir);
    writeFileSync(join(dir, ".gitignore"), "notes\n");
    writeFileSync(join(dir, "notes"), "the person's notes");
    expect(await markers.mark(project, folder)).toBe(true);
    await markers.unmark(project, folder);
    expect(readdirSync(dir).sort()).toEqual([".gitignore", "notes"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("notes\n");
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
    expect(await markers.check(project, folder)).toMatchObject({ kind: "ok" });
  });

  test("a folder that moved with another keeps its marker, and an unrelated folder at its old place is missed", async () => {
    const { folder, markers } = fresh();
    const inner = join(folder, "inner");
    mkdirSync(inner);
    await markers.mark(task, inner);
    const moved = `${folder}-moved`;
    renameSync(folder, moved);
    await markers.moved(task, inner, join(moved, "inner"));
    expect(await readMarker(join(moved, "inner"))).toEqual({ state: "owners", owners: [task] });
    // Gone before any launch looked at the new place: only the move told this machine, and the
    // folder there is the one that was marked, so its marker is put back.
    rmSync(join(moved, "inner", FOLDER_MARKER), { recursive: true });
    expect(await markers.check(task, join(moved, "inner"))).toMatchObject({ kind: "ok" });
    expect(await readMarker(join(moved, "inner"))).toEqual({ state: "owners", owners: [task] });
    // An undo gives the task its old place back, where an unrelated folder was made since.
    mkdirSync(inner, { recursive: true });
    expect(await markers.check(task, inner)).toEqual({ kind: "missing" });
  });

  test("a folder that moved along as a copy is remembered as the folder it is at its new place", async () => {
    const { folder, markers } = fresh();
    const inner = join(folder, "inner");
    mkdirSync(inner);
    await markers.mark(task, inner);
    // Copied to another place, as a move to another drive is: the copy is another folder by its
    // identity, and it is the one the task has from now on.
    const moved = `${folder}-copied`;
    cpSync(folder, moved, { recursive: true });
    rmSync(folder, { recursive: true });
    await markers.moved(task, inner, join(moved, "inner"));
    // Its marker gone, the folder there is still the one this machine has for the task.
    rmSync(join(moved, "inner", FOLDER_MARKER), { recursive: true });
    expect(await markers.check(task, join(moved, "inner"))).toMatchObject({ kind: "ok" });
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
