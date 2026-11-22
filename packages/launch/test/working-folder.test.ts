// The in-folder check with real child processes (A1 3.15). A child is started in the
// folder resolvePlace returned, as the shim (M2.08) will be, and runs checkWorkingFolder there.
// The tree is changed before the start, between the start and the check, and before the start
// and back before the check (A-B-A). The child either is in the directory with the resolved
// identity or refuses. What "is in" means is read independently: on Linux from /proc/self/cwd, the
// directory the kernel says the process holds. On Windows a process's working directory, and every
// folder above it, cannot be renamed or removed while it is there (asserted below); Node reads `.`
// through the working-folder path, and the one case where that path and the directory the process
// holds differ at the check (a link put into the path before the start and taken out again) is
// asserted as the residual A1 3.15 names.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolvePlace,
  type FolderCheck,
  type RootFolder,
  type WorkingFolderCheck,
} from "../src/places.ts";

const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";
const CHILD = fileURLToPath(new URL("./working-folder-child.ts", import.meta.url));

const temps: string[] = [];
const children: Child[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await child.stop();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

interface Report {
  readonly result: WorkingFolderCheck;
  /** The identity of `.` as the child reads it. */
  readonly dot?: string;
  /** Linux: the identity of the directory the child holds (/proc/self/cwd). */
  readonly held?: string;
  /** The identity of `.` in a process the child started without a working-folder option. */
  readonly agent?: string;
}

interface Child {
  ready(): Promise<void>;
  check(check: FolderCheck): Promise<Report>;
  stop(): Promise<void>;
}

/** Starts the child in `folder`, by its path, as a terminal or the service will start the shim. */
function start(folder: string, agent = false): Child {
  const proc = spawn(process.execPath, [CHILD, agent ? "agent" : "check"], {
    cwd: folder,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<void>((done) =>
    proc.once("exit", () => {
      done();
    }),
  );
  const lines = createInterface({ input: proc.stdout });
  const waiting: ((line: string) => void)[] = [];
  const queued: string[] = [];
  lines.on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) queued.push(line);
    else next(line);
  });
  const line = (): Promise<string> =>
    new Promise((done) => {
      const first = queued.shift();
      if (first === undefined) waiting.push(done);
      else done(first);
    });
  const child: Child = {
    ready: async () => {
      expect(await line()).toBe("ready");
    },
    check: async (check) => {
      proc.stdin.write(`${JSON.stringify(check)}\n`);
      return JSON.parse(await line()) as Report;
    },
    stop: async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
    },
  };
  children.push(child);
  return child;
}

const idOf = (path: string): string => {
  const s = statSync(path, { bigint: true });
  return `${String(s.dev)}:${String(s.ino)}`;
};

/** Whether a rename is refused (the directory, or one inside it, is some process's working folder). */
function renameRefused(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    renameSync(to, from);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
    throw error;
  }
}

const link = (target: string, path: string): void => {
  symlinkSync(target, path, WINDOWS ? "junction" : "dir");
};
/** Removes a link: a junction is a folder to Windows, a symbolic link a file elsewhere. */
const unlink = (path: string): void => {
  if (WINDOWS) rmdirSync(path);
  else unlinkSync(path);
};

const REMOTE = "https://example.com/lumen/portal.git";

/** `<tmp>/work` is the root; `work/lumen/portal` the place, a repository; a decoy beside it. */
async function world(): Promise<{
  base: string;
  work: string;
  portal: string;
  other: string;
  outside: string;
  roots: RootFolder[];
  folder: string;
  id: string;
  check: FolderCheck;
}> {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-wf-")));
  temps.push(base);
  const work = join(base, "work");
  const portal = join(work, "lumen", "portal");
  const other = join(work, "lumen", "other");
  const outside = join(base, "outside");
  for (const dir of [join(portal, ".git"), other, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(portal, ".git", "config"), `[remote "origin"]\n\turl = ${REMOTE}\n`);
  const roots = [{ id: "work", path: work }];
  const found = await resolvePlace(
    { root: "work", path: "lumen/portal", gitRemote: REMOTE },
    roots,
  );
  if (found.status !== "ok") throw new Error(`the place does not resolve: ${found.reason}`);
  return {
    base,
    work,
    portal,
    other,
    outside,
    roots,
    folder: found.folder,
    id: `${String(found.identity.dev)}:${String(found.identity.ino)}`,
    check: found.check,
  };
}

describe("[A1.3.15.places.working-folder] the in-folder check in a real child process", () => {
  test("a child started in the folder passes, and an agent it starts is there too", async () => {
    const w = await world();
    expect(w.check).toEqual({
      dev: w.id.split(":")[0],
      ino: w.id.split(":")[1],
      rootDev: idOf(w.work).split(":")[0],
      rootIno: idOf(w.work).split(":")[1],
      depth: 2,
      gitRemote: REMOTE,
    });
    const child = start(w.folder, true);
    await child.ready();
    const got = await child.check(w.check);
    expect(got).toMatchObject({ result: { status: "ok" }, dot: w.id, agent: w.id });
    if (LINUX) expect(got.held).toBe(w.id);
  });

  test("swapped before the start: the child is in another directory and refuses", async () => {
    const w = await world();
    // A folder renamed into the place's name.
    renameSync(w.portal, `${w.portal}-old`);
    renameSync(w.other, w.portal);
    const first = start(w.folder);
    await first.ready();
    const got = await first.check(w.check);
    expect(got).toMatchObject({ result: { status: "failed", reason: "folder_changed" } });
    expect(got.dot).toBe(idOf(w.portal));
    if (LINUX) expect(got.held).toBe(idOf(w.portal));
    await first.stop();
    // A link to a folder outside the root in the place's name.
    renameSync(w.portal, w.other);
    link(w.outside, w.portal);
    const second = start(w.folder);
    await second.ready();
    expect(await second.check(w.check)).toMatchObject({
      result: { status: "failed", reason: "folder_changed" },
      dot: idOf(w.outside),
    });
  });

  test("swapped between the start and the check: the child stays in the resolved directory", async () => {
    const w = await world();
    const child = start(w.folder, true);
    await child.ready();
    if (WINDOWS) {
      // The directory a process is in, and every folder above it, cannot be renamed or removed.
      expect(renameRefused(w.portal, `${w.portal}-moved`)).toBe(true);
      expect(renameRefused(join(w.work, "lumen"), join(w.work, "lumen-moved"))).toBe(true);
      expect(renameRefused(w.work, `${w.work}-moved`)).toBe(true);
    } else {
      // The path names another directory now; the child still holds the resolved one.
      renameSync(w.portal, `${w.portal}-moved`);
      renameSync(w.other, w.portal);
      expect(idOf(w.portal)).not.toBe(w.id);
    }
    const got = await child.check(w.check);
    expect(got).toMatchObject({ result: { status: "ok" }, dot: w.id, agent: w.id });
    if (LINUX) expect(got.held).toBe(w.id);
  });

  test("moved out of the root between the start and the check: refused, or not possible", async () => {
    const w = await world();
    const child = start(w.folder);
    await child.ready();
    if (WINDOWS) {
      expect(renameRefused(w.portal, join(w.outside, "portal"))).toBe(true);
      expect(await child.check(w.check)).toMatchObject({ result: { status: "ok" } });
      return;
    }
    renameSync(w.portal, join(w.outside, "portal"));
    // Still the resolved directory, but no longer at its depth below the root's directory.
    expect(await child.check(w.check)).toMatchObject({
      result: { status: "failed", reason: "folder_changed" },
      dot: w.id,
    });
  });

  test("swapped before the start and back before the check by renames (A-B-A): refused", async () => {
    const w = await world();
    renameSync(w.portal, `${w.portal}-old`);
    renameSync(w.other, w.portal);
    const decoy = idOf(w.portal);
    const child = start(w.folder);
    await child.ready();
    if (WINDOWS) {
      // The way back is refused: the child holds the decoy under the place's name.
      expect(renameRefused(w.portal, w.other)).toBe(true);
    } else {
      renameSync(w.portal, w.other);
      renameSync(`${w.portal}-old`, w.portal);
      expect(idOf(w.portal)).toBe(w.id);
    }
    const got = await child.check(w.check);
    expect(got).toMatchObject({ result: { status: "failed", reason: "folder_changed" } });
    if (LINUX) expect(got.held).toBe(decoy);
  });

  test("swapped before the start through a link in the path and back before the check (A-B-A)", async () => {
    const w = await world();
    // The place's parent becomes a link to a decoy tree with a `portal` of its own.
    const lumen = join(w.work, "lumen");
    const decoy = join(w.base, "decoy");
    mkdirSync(join(decoy, "portal"), { recursive: true });
    renameSync(lumen, `${lumen}-old`);
    link(decoy, lumen);
    const child = start(w.folder, true);
    await child.ready();
    // The link is not the child's working directory, so it can be taken out again.
    unlink(lumen);
    renameSync(`${lumen}-old`, lumen);
    expect(idOf(w.portal)).toBe(w.id);
    const got = await child.check(w.check);
    if (!WINDOWS) {
      // `.` is the directory the child holds: the decoy. Refused.
      expect(got).toMatchObject({ result: { status: "failed", reason: "folder_changed" } });
      if (LINUX) expect(got.held).toBe(idOf(join(decoy, "portal")));
      return;
    }
    // Windows, the residual (A1 3.15): Node reads `.` through the working-folder path, which
    // names the resolved directory again, so the check passes and an agent started now starts
    // there. But the child holds the decoy: the decoy cannot be renamed, the resolved directory
    // can, so the path is not tied to it until the child enters it again.
    expect(got).toMatchObject({ result: { status: "ok" }, dot: w.id, agent: w.id });
    expect(renameRefused(join(decoy, "portal"), join(decoy, "portal-moved"))).toBe(true);
    expect(renameRefused(w.portal, `${w.portal}-moved`)).toBe(false);
  });

  test("a remote changed between the start and the check is identity_mismatch", async () => {
    const w = await world();
    const child = start(w.folder);
    await child.ready();
    writeFileSync(
      join(w.portal, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/other/repo.git\n',
    );
    expect(await child.check(w.check)).toMatchObject({
      result: { status: "failed", reason: "identity_mismatch" },
      dot: w.id,
    });
  });

  test("a folder removed while the child is in it is path_missing, or cannot be removed", async () => {
    const w = await world();
    const empty = join(w.work, "empty");
    mkdirSync(empty);
    const found = await resolvePlace({ root: "work", path: "empty" }, w.roots);
    if (found.status !== "ok") throw new Error(found.reason);
    const child = start(found.folder);
    await child.ready();
    if (WINDOWS) {
      expect(() => {
        rmdirSync(empty);
      }).toThrow();
      expect(await child.check(found.check)).toMatchObject({ result: { status: "ok" } });
      return;
    }
    rmdirSync(empty);
    expect(await child.check(found.check)).toMatchObject({
      result: { status: "failed", reason: "path_missing" },
    });
  });

  test("a check that does not fit the folder is refused: another identity, depth or root", async () => {
    const w = await world();
    // Each part of an identity counts: the volume as much as the file number (round four).
    const other = (n: string) => (n === "1" ? "2" : "1");
    for (const wrong of [
      { ...w.check, ino: other(w.check.ino) },
      { ...w.check, dev: other(w.check.dev) },
      { ...w.check, depth: 1 },
      { ...w.check, rootIno: other(w.check.rootIno) },
      { ...w.check, rootDev: other(w.check.rootDev) },
    ]) {
      const child = start(w.folder);
      await child.ready();
      expect([wrong, await child.check(wrong)]).toMatchObject([
        wrong,
        { result: { status: "failed", reason: "folder_changed" } },
      ]);
      await child.stop();
    }
  });
});
