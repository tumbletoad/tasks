// resolve() while the tree changes under it, and the in-folder check after it.
// Every file system call of resolvePlace is interposed, the reads of the Git remote
// and of an open file included, and a change is made just before call N, for every N; or after
// the last call; or a change before call N and its undoing before call M, for every N < M (A-B-A).
// The changes are real, with junctions (Windows) or symbolic links (elsewhere). Before each call
// the test records which directory the place names at that moment. The assertion is the honest
// one: whatever resolvePlace returns as a folder has the identity of a directory the place named
// at some moment during the call; and the in-folder check, run by a real child process that
// changes to the returned folder afterwards, accepts it exactly when the child is in that
// directory, that directory lies at the depth found below the root's directory and holds the
// recorded remote. Round three's four probes are scenes here, each with its outcome.
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
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { FolderCheck, WorkingFolderCheck } from "../src/places.ts";

const hook = vi.hoisted(() => ({
  /** Called before every file system call places.ts makes. */
  before: undefined as ((name: string, path?: string) => void) | undefined,
  /** May replace a stat's result (to give a file number of 0). */
  stat: undefined as ((path: string, result: unknown) => unknown) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const counted =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      hook.before?.(name);
      return fn(...args);
    };
  // An open file's own calls are interposed too: its stat, its read and its close.
  const handle = (opened: FileHandle): FileHandle =>
    new Proxy(opened, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        return prop === "stat" || prop === "read" || prop === "close"
          ? (...args: unknown[]) => {
              hook.before?.(`handle.${prop}`);
              return bound(...args);
            }
          : bound;
      },
    });
  return {
    ...real,
    realpath: counted("realpath", real.realpath),
    lstat: counted("lstat", real.lstat),
    stat: async (...args: Parameters<typeof real.stat>) => {
      hook.before?.("stat");
      const result = await real.stat(...args);
      return (hook.stat?.(String(args[0]), result) ?? result) as Awaited<
        ReturnType<typeof real.stat>
      >;
    },
    open: async (...args: Parameters<typeof real.open>) => {
      hook.before?.("open", String(args[0]));
      return handle(await real.open(...args));
    },
  };
});

const { checkWorkingFolder, placeOf, resolvePlace, rootNaming } = await import("../src/places.ts");
const { readGitRemote } = await import("../src/git-remote.ts");

const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";
const CHILD = fileURLToPath(new URL("./working-folder-child.ts", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  hook.before = undefined;
  hook.stat = undefined;
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------------------------
// A child process that changes to a folder, runs the check there and changes back.

interface Report {
  readonly entered: boolean;
  readonly result?: WorkingFolderCheck;
  readonly dot?: string;
  readonly held?: string;
}

let server: {
  ask(folder: string, check: FolderCheck): Promise<Report>;
  stop(): Promise<void>;
};

beforeAll(() => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-race-home-")));
  const proc = spawn(process.execPath, [CHILD, "serve"], {
    cwd: home,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<void>((done) =>
    proc.once("exit", () => {
      done();
    }),
  );
  const lines = createInterface({ input: proc.stdout });
  const waiting: ((line: string) => void)[] = [];
  lines.on("line", (line) => waiting.shift()?.(line));
  server = {
    ask: (folder, check) =>
      new Promise((done) => {
        waiting.push((line) => {
          done(JSON.parse(line) as Report);
        });
        proc.stdin.write(`${JSON.stringify({ folder, check })}\n`);
      }),
    stop: async () => {
      proc.stdin.end();
      proc.kill();
      await exited;
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
});
afterAll(async () => {
  await server.stop();
});

// ---------------------------------------------------------------------------------------------
// Scenes and schedules

const link = (target: string, path: string): void => {
  symlinkSync(target, path, WINDOWS ? "junction" : "dir");
};
/** Removes a link: a junction is a folder to Windows, a symbolic link a file elsewhere. */
const unlink = (path: string): void => {
  if (WINDOWS) rmdirSync(path);
  else unlinkSync(path);
};
const retarget = (path: string, target: string): void => {
  unlink(path);
  link(target, path);
};

function idOf(path: string): string | undefined {
  try {
    const s = statSync(path, { bigint: true });
    return `${String(s.dev)}:${String(s.ino)}`;
  } catch {
    return undefined;
  }
}

function repo(path: string, url: string): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
}

const RIGHT = "https://example.com/right.git";
const WRONG = "https://example.com/wrong.git";

interface Scene {
  /** The root as configured. */
  readonly root: string;
  /** The place's path below it. */
  readonly path: string;
  /** The remote the place recorded. */
  readonly gitRemote?: string;
  /** The change, and how to undo it. */
  readonly change: () => void;
  readonly undo: () => void;
  /** The remote each repository holds, by its folder at build time. */
  readonly remotes?: Readonly<Record<string, string>>;
}

/** Outcomes seen over a scene's schedules, so a scene is known to reach what it is about. */
type Seen = Map<string, number>;

/**
 * One run: build the scene, make `at` changes before the calls they name (a step past the last
 * call is made after resolvePlace returns), then check what it returned.
 */
async function run(
  build: (base: string) => Scene,
  at: readonly number[],
  seen: Seen,
): Promise<number> {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-race-")));
  temps.push(base);
  const scene = build(base);
  const steps = [scene.change, scene.undo];
  const placePath = join(scene.root, ...scene.path.split("/"));
  const remoteOf = new Map<string, string>();
  for (const [folder, url] of Object.entries(scene.remotes ?? {})) {
    const id = idOf(folder);
    if (id !== undefined) remoteOf.set(id, url);
  }
  const named = new Set<string>();
  let calls = 0;
  let made = 0;
  // A step Windows refuses (a folder that holds an open file cannot be renamed) is a tree that
  // did not change, or changed in part: either way the test reads the tree as it is.
  const step = (): void => {
    try {
      steps[made]?.();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!WINDOWS || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      seen.set("change refused", (seen.get("change refused") ?? 0) + 1);
    }
    made += 1;
  };
  hook.before = () => {
    calls += 1;
    while (made < at.length && at[made] === calls) step();
    named.add(idOf(placePath) ?? "missing");
  };
  const found = await resolvePlace(
    {
      root: "work",
      path: scene.path,
      ...(scene.gitRemote === undefined ? {} : { gitRemote: scene.gitRemote }),
    },
    [{ id: "work", path: scene.root }],
  );
  hook.before = undefined;
  // Steps past the last call: after resolvePlace returned, before the process starts.
  while (made < at.length) step();
  const key = found.status === "ok" ? "ok" : found.reason;
  if (found.status !== "ok") {
    seen.set(key, (seen.get(key) ?? 0) + 1);
    return calls;
  }
  const label = { at, calls };
  // What resolvePlace returned is a directory the place named at some moment during the call.
  const returned = `${String(found.identity.dev)}:${String(found.identity.ino)}`;
  expect([label, named.has(returned)]).toEqual([label, true]);

  // A process changes to the folder, as the shim will be started there, and checks.
  const enters = idOf(found.folder);
  const report = await server.ask(found.folder, found.check);
  if (!report.entered) {
    seen.set("ok, folder gone", (seen.get("ok, folder gone") ?? 0) + 1);
    return calls;
  }
  // The directory the child is in, read independently of the check.
  const inside = LINUX ? report.held : enters;
  if (LINUX) expect([label, report.held]).toEqual([label, enters]);
  // Where that directory lies now, and the remote it holds, by the test's own reckoning.
  let atDepth = realpathSync.native(found.folder);
  for (let k = 0; k < found.check.depth; k += 1) atDepth = dirname(atDepth);
  const placed = idOf(atDepth) === `${found.check.rootDev}:${found.check.rootIno}`;
  const holds =
    scene.gitRemote === undefined ||
    (inside !== undefined && remoteOf.get(inside) === scene.gitRemote);
  const accepted = report.result?.status === "ok";
  // The check accepts exactly a child in the returned directory, where it was found, with the
  // recorded remote.
  expect([label, accepted]).toEqual([label, inside === returned && placed && holds]);
  const outcome = accepted
    ? "ok, accepted"
    : `ok, refused ${report.result?.status === "failed" ? report.result.reason : ""}`;
  seen.set(outcome, (seen.get(outcome) ?? 0) + 1);
  return calls;
}

/** Every single change (before each call, and after the last) and every A-B-A pair of a scene. */
async function everySchedule(build: (base: string) => Scene): Promise<Seen> {
  const seen: Seen = new Map();
  // How many calls resolvePlace makes on the scene as built.
  const calls = await run(build, [], seen);
  for (let n = 1; n <= calls + 1; n += 1) await run(build, [n], seen);
  for (let n = 1; n <= calls; n += 1) {
    for (let m = n + 1; m <= calls + 1; m += 1) await run(build, [n, m], seen);
  }
  return seen;
}

const reached = (seen: Seen, outcome: string): boolean => (seen.get(outcome) ?? 0) > 0;

// ---------------------------------------------------------------------------------------------

describe("[A1.3.15.places.race] the tree changes while resolve() reads it, and the check after it", () => {
  test("a folder swapped for a link that leads outside the root", async () => {
    const seen = await everySchedule((base) => {
      const work = join(base, "work");
      const target = join(work, "lumen", "portal");
      const outside = join(base, "outside");
      mkdirSync(target, { recursive: true });
      mkdirSync(outside);
      return {
        root: work,
        path: "lumen/portal",
        change: () => {
          renameSync(target, join(work, "lumen", "moved"));
          link(outside, target);
        },
        undo: () => {
          unlink(target);
          renameSync(join(work, "lumen", "moved"), target);
        },
      };
    });
    expect(reached(seen, "ok, accepted")).toBe(true);
    expect(reached(seen, "escapes_root")).toBe(true);
  }, 300_000);

  test("a root that is a link, retargeted to another folder", async () => {
    const seen = await everySchedule((base) => {
      mkdirSync(join(base, "first", "child"), { recursive: true });
      mkdirSync(join(base, "second", "child"), { recursive: true });
      const root = join(base, "work");
      link(join(base, "first"), root);
      return {
        root,
        path: "child",
        change: () => {
          retarget(root, join(base, "second"));
        },
        undo: () => {
          retarget(root, join(base, "first"));
        },
      };
    });
    expect(reached(seen, "ok, accepted")).toBe(true);
  }, 300_000);

  test("a link inside the root, retargeted to another folder inside it", async () => {
    const seen = await everySchedule((base) => {
      const work = join(base, "work");
      mkdirSync(join(work, "a", "child"), { recursive: true });
      mkdirSync(join(work, "b", "child"), { recursive: true });
      const lumen = join(work, "lumen");
      link(join(work, "a"), lumen);
      return {
        root: work,
        path: "lumen/child",
        change: () => {
          retarget(lumen, join(work, "b"));
        },
        undo: () => {
          retarget(lumen, join(work, "a"));
        },
      };
    });
    expect(reached(seen, "ok, accepted")).toBe(true);
  }, 300_000);

  test("probe 1: the folder replaced by a file (round three: ok just before the final realpath)", async () => {
    // Now: resolvePlace returns a directory the place named; a child cannot enter a file, and one
    // that enters the folder after the undo is in that directory and is accepted.
    const seen = await everySchedule((base) => {
      const work = join(base, "work");
      const target = join(work, "portal");
      mkdirSync(target, { recursive: true });
      return {
        root: work,
        path: "portal",
        change: () => {
          renameSync(target, join(work, "moved"));
          writeFileSync(target, "x");
        },
        undo: () => {
          rmSync(target);
          renameSync(join(work, "moved"), target);
        },
      };
    });
    expect(reached(seen, "not_a_directory")).toBe(true);
    expect(reached(seen, "ok, accepted")).toBe(true);
  }, 300_000);

  test("probe 2: the root retargeted to B, whose child links back to A's (round three: ok outside the root)", async () => {
    // Now: whatever is returned is a directory the place named; a child in it is accepted only
    // while it lies below the root's directory resolvePlace read.
    const seen = await everySchedule((base) => {
      mkdirSync(join(base, "A", "child"), { recursive: true });
      mkdirSync(join(base, "B"), { recursive: true });
      link(join(base, "A", "child"), join(base, "B", "child"));
      const root = join(base, "work");
      link(join(base, "A"), root);
      return {
        root,
        path: "child",
        change: () => {
          retarget(root, join(base, "B"));
        },
        undo: () => {
          retarget(root, join(base, "A"));
        },
      };
    });
    expect(reached(seen, "ok, accepted")).toBe(true);
    expect(reached(seen, "escapes_root")).toBe(true);
  }, 300_000);

  test("probe 2, outside: the root retargeted to B, whose child leads outside every root", async () => {
    const seen = await everySchedule((base) => {
      mkdirSync(join(base, "A", "child"), { recursive: true });
      mkdirSync(join(base, "B"), { recursive: true });
      mkdirSync(join(base, "secret"), { recursive: true });
      link(join(base, "secret"), join(base, "B", "child"));
      const root = join(base, "work");
      link(join(base, "A"), root);
      return {
        root,
        path: "child",
        change: () => {
          retarget(root, join(base, "B"));
        },
        undo: () => {
          retarget(root, join(base, "A"));
        },
      };
    });
    // An A-B-A can make resolvePlace return the identity of `secret` with A's path; the check
    // then refuses: the child is not in `secret`, or `secret` is not below the root's directory.
    expect(reached(seen, "ok, accepted")).toBe(true);
    expect(reached(seen, "escapes_root")).toBe(true);
  }, 300_000);

  test("probe 3: A swapped for B while the remote is read, and back (round three: ok with A's wrong remote)", async () => {
    // Now: resolvePlace may read B's remote at its own moment; the check, which reads the remote
    // through the directory the child is in, refuses A.
    const seen = await everySchedule((base) => {
      const work = join(base, "work");
      const a = join(work, "portal");
      const b = join(work, "other");
      repo(a, WRONG);
      repo(b, RIGHT);
      return {
        root: work,
        path: "portal",
        gitRemote: RIGHT,
        remotes: { [a]: WRONG, [b]: RIGHT },
        change: () => {
          renameSync(a, join(work, "parked"));
          renameSync(b, a);
        },
        undo: () => {
          renameSync(a, b);
          renameSync(join(work, "parked"), a);
        },
      };
    });
    expect(reached(seen, "identity_mismatch")).toBe(true);
    expect(reached(seen, "ok, refused identity_mismatch")).toBe(true);
    expect(reached(seen, "ok, accepted")).toBe(true);
  }, 300_000);

  test("round four: the root link retargeted while the folder it led to is replaced by a decoy", async () => {
    // A resolver that took the identity from the real path read earlier (stat of realpath)
    // would return the decoy, which the place never named; this scene catches that.
    const seen = await everySchedule((base) => {
      const a = join(base, "a");
      mkdirSync(join(a, "portal"), { recursive: true });
      mkdirSync(join(a, "decoy"), { recursive: true });
      mkdirSync(join(base, "b", "portal"), { recursive: true });
      const root = join(base, "work");
      link(a, root);
      return {
        root,
        path: "portal",
        change: () => {
          retarget(root, join(base, "b"));
          renameSync(join(a, "portal"), join(a, "saved"));
          renameSync(join(a, "decoy"), join(a, "portal"));
        },
        undo: () => {
          renameSync(join(a, "portal"), join(a, "decoy"));
          renameSync(join(a, "saved"), join(a, "portal"));
          retarget(root, a);
        },
      };
    });
    expect(reached(seen, "ok, accepted")).toBe(true);
  }, 300_000);

  test("probe 4: a retarget after resolve's last call (round three: returns A while the place names B)", async () => {
    // Now: by design, resolvePlace says what the place named during the call (A), and a child
    // that enters the returned folder is in A and is accepted: the guarantee is the directory,
    // not the path.
    const seen: Seen = new Map();
    const build = (base: string): Scene => {
      const work = join(base, "work");
      mkdirSync(join(work, "a", "child"), { recursive: true });
      mkdirSync(join(work, "b", "child"), { recursive: true });
      const lumen = join(work, "lumen");
      link(join(work, "a"), lumen);
      return {
        root: work,
        path: "lumen/child",
        change: () => {
          retarget(lumen, join(work, "b"));
        },
        undo: () => {
          retarget(lumen, join(work, "a"));
        },
      };
    };
    const calls = await run(build, [], seen);
    await run(build, [calls + 1], seen);
    expect(seen.get("ok, accepted")).toBe(2);
  });
});

describe("[A1.3.15.places.race] the remote is read step by step", () => {
  test("round four's finding 1, the documented limit: a repository changed while it is read can pass", async () => {
    // The folder's `.git` is a file naming git folder A; A and B both name WRONG. Between the read
    // of `.git` and the reads in A, `.git` is pointed at B and A is given RIGHT. The reader
    // follows `.git` as it was and reads A as it is: RIGHT, although the folder never held a
    // repository naming RIGHT. The remote check is this observation, not
    // an identity; the directory's identity is the guarantee.
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-race-")));
    temps.push(base);
    const folder = join(base, "work", "portal");
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(folder, { recursive: true });
    for (const gitDir of [a, b]) {
      mkdirSync(gitDir);
      writeFileSync(join(gitDir, "config"), `[remote "origin"]\n\turl = ${WRONG}\n`);
    }
    writeFileSync(join(folder, ".git"), `gitdir: ${a}\n`);
    expect(await readGitRemote(folder)).toEqual({ status: "remote", url: WRONG });
    let changed = false;
    hook.before = (name, path) => {
      if (changed || name !== "open" || path !== join(a, "commondir")) return;
      writeFileSync(join(folder, ".git"), `gitdir: ${b}\n`);
      writeFileSync(join(a, "config"), `[remote "origin"]\n\turl = ${RIGHT}\n`);
      changed = true;
    };
    expect(await readGitRemote(folder)).toEqual({ status: "remote", url: RIGHT });
    expect(changed).toBe(true);
    hook.before = undefined;
    expect(await readGitRemote(folder)).toEqual({ status: "remote", url: WRONG });
  });
});

describe("[A1.3.15.places.race] a volume without file numbers fails closed", () => {
  test("round three's finding 3: two folders A and a whose file number is 0 are never one folder", async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-race-")));
    temps.push(base);
    const work = join(base, "work");
    const cased = join(work, "cased");
    mkdirSync(cased, { recursive: true });
    if (WINDOWS) {
      // A case-sensitive folder on Windows needs the per-folder flag (WSL's driver). Without it
      // (fsutil may say "Access is denied" and still exit 0), `a` is `A`: the zero-number checks
      // below hold either way.
      const { spawnSync } = await import("node:child_process");
      spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", cased, "enable"], {
        stdio: "ignore",
      });
    }
    mkdirSync(join(cased, "A"));
    try {
      mkdirSync(join(cased, "a"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const roots = [{ id: "work", path: work }];
    // Every stat of something inside `cased` gives a file number of 0, as some shares do.
    hook.stat = (path, result) =>
      path.startsWith(cased) || path === "." || path.startsWith("..")
        ? new Proxy(result as object, {
            get: (target, prop) =>
              prop === "ino" ? 0n : (Reflect.get(target, prop, target) as unknown),
          })
        : result;
    for (const path of ["cased/A", "cased/a"]) {
      expect(await resolvePlace({ root: "work", path }, roots)).toMatchObject({
        status: "failed",
        reason: "identity_unavailable",
      });
    }
    expect(await placeOf(join(cased, "A"), roots)).toEqual({
      status: "failed",
      reason: "identity_unavailable",
    });
    expect(await rootNaming(join(cased, "A"), [{ id: "lower", path: join(cased, "a") }])).toEqual({
      status: "identity_unavailable",
    });
    // The check in the folder, here on this process's own working directory.
    expect(
      await checkWorkingFolder({ dev: "1", ino: "0", rootDev: "1", rootIno: "0", depth: 0 }),
    ).toEqual({ status: "failed", reason: "identity_unavailable" });
  });
});
