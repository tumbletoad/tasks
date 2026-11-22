// Places on the real file system (A1 3.15, A4 3.3, R11; M2.07's Verify line): symbolic link and
// junction escapes, `..`, Windows case, a missing root, a nested folder and a sibling clone each
// give their reason, and no case returns another folder. Every tree is built in a temporary folder
// of its own, with real links: junctions on Windows (no special right needed), symbolic links
// elsewhere. A Windows directory symbolic link needs a right a normal user may lack: that case is
// skipped, with the reason, when the right is missing.
import { execFileSync } from "node:child_process";
import {
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
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { portableRemote, readGitRemote, remoteFromConfig } from "../src/git-remote.ts";
import {
  absoluteFolder,
  identityOf,
  isPlacePath,
  placeOf,
  resolveFolder,
  resolvePlace,
  rootNaming,
  sameIdentity,
  type RootFolder,
} from "../src/places.ts";

const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";

/** What resolvePlace returns for `folder` under `root`: its real path and its identity. */
function resolved(folder: string, root = "work"): unknown {
  const s = statSync(folder, { bigint: true });
  return expect.objectContaining({
    status: "ok",
    folder,
    root,
    identity: { dev: s.dev, ino: s.ino },
  });
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** A temporary folder of this test's own, as its real path. */
function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-places-")));
  temps.push(dir);
  return dir;
}

function folder(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A link to a folder that any user can make: a junction on Windows, a symbolic link elsewhere. */
function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, WINDOWS ? "junction" : "dir");
}

/** A repository's working folder: `.git/config` with an origin. Git itself never runs. */
function repo(path: string, url: string): string {
  folder(path, ".git");
  writeFileSync(
    join(path, ".git", "config"),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  return path;
}

/** A world: `<tmp>/work` is the root `work`, `<tmp>/outside` lies outside every root. */
function world(): { base: string; work: string; outside: string; roots: RootFolder[] } {
  const base = tempDir();
  const work = folder(base, "work");
  const outside = folder(base, "outside");
  return { base, work, outside, roots: [{ id: "work", path: work }] };
}

describe("[A1.3.15.places.resolve] resolve(): one folder or a reason, never another folder", () => {
  test("a place resolves to exactly its folder, the root itself included", async () => {
    const { work, roots } = world();
    const portal = folder(work, "lumen", "portal");
    folder(work, "lumen", "portal-2");
    expect(await resolvePlace({ root: "work", path: "lumen/portal" }, roots)).toEqual(
      resolved(portal, "work"),
    );
    expect(await resolvePlace({ root: "work", path: "" }, roots)).toEqual(resolved(work, "work"));
  });

  test("a link or junction inside the root that leads outside it is escapes_root", async () => {
    const { work, outside, roots } = world();
    folder(outside, "secret", "deeper");
    linkFolder(join(outside, "secret"), join(work, "escape"));
    for (const path of ["escape", "escape/deeper"]) {
      expect(await resolvePlace({ root: "work", path }, roots)).toEqual({
        status: "failed",
        reason: "escapes_root",
        root: "work",
      });
    }
    // The way back is refused too: the folder the link leads to is under no root.
    expect(await placeOf(join(work, "escape"), roots)).toEqual({
      status: "failed",
      reason: "outside_roots",
      roots: ["work"],
    });
  });

  test("a link to a file is not_a_directory on every platform, a dangling link path_missing", async () => {
    // Windows cannot follow a junction to a file (its stat says the path is missing); Linux
    // follows a link to a file. The reason is the same on both: a file is there, not a folder.
    const { base, work, roots } = world();
    folder(work, "c d");
    writeFileSync(join(work, "c d", "e.f"), "x");
    linkFolder(join(work, "c d", "e.f"), join(work, "to-file"));
    linkFolder(join(work, "to-file"), join(work, "to-link"));
    linkFolder(join(base, "nowhere", "e.f"), join(work, "dangling"));
    const refused = (reason: string) => ({ status: "failed", reason, root: "work" });
    for (const [path, reason] of [
      ["to-file", "not_a_directory"],
      ["to-link", "not_a_directory"],
      ["c d/e.f", "not_a_directory"],
      ["to-file/b", "path_missing"],
      ["dangling", "path_missing"],
    ] as const) {
      expect([path, await resolvePlace({ root: "work", path }, roots)]).toEqual([
        path,
        refused(reason),
      ]);
    }
    // The way back gives the same reason.
    expect(await placeOf(join(work, "to-file"), roots)).toEqual({
      status: "failed",
      reason: "not_a_directory",
    });
    expect(await placeOf(join(work, "dangling"), roots)).toEqual({
      status: "failed",
      reason: "path_missing",
    });
  });

  test.skipIf(!WINDOWS && !LINUX)(
    "a chain of 40 links to a file is not_a_directory, a chain of 41 path_missing, as Linux follows them",
    async () => {
      const { work, roots } = world();
      writeFileSync(join(work, "file"), "x");
      // link-1 leads to the file, link-n to link-(n-1).
      linkFolder(join(work, "file"), join(work, "link-1"));
      for (let n = 2; n <= 41; n += 1) {
        linkFolder(join(work, `link-${String(n - 1)}`), join(work, `link-${String(n)}`));
      }
      for (const [path, reason] of [
        ["link-40", "not_a_directory"],
        ["link-41", "path_missing"],
      ] as const) {
        expect([path, await resolvePlace({ root: "work", path }, roots)]).toEqual([
          path,
          { status: "failed", reason, root: "work" },
        ]);
      }
    },
  );

  test("a relative link reached through another link leads where the file system takes it", async (context) => {
    // `alias` leads to `real/sub`. From there `../gone` is `real/gone`, which is missing, while its
    // spelling through `alias` would be the file `gone`; `../there` is the file `real/there`.
    const { work, roots } = world();
    folder(work, "real", "sub");
    writeFileSync(join(work, "gone"), "x");
    writeFileSync(join(work, "real", "there"), "x");
    linkFolder(join(work, "real", "sub"), join(work, "alias"));
    try {
      symlinkSync(join("..", "gone"), join(work, "real", "sub", "to-gone"), "dir");
      symlinkSync(join("..", "there"), join(work, "real", "sub", "to-there"), "dir");
    } catch (error) {
      // A relative link on Windows is a symbolic link, which needs a right a normal user may lack.
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    for (const [path, reason] of [
      ["alias/to-gone", "path_missing"],
      ["alias/to-there", "not_a_directory"],
      ["real/sub/to-gone", "path_missing"],
      ["real/sub/to-there", "not_a_directory"],
    ] as const) {
      expect([path, await resolvePlace({ root: "work", path }, roots)]).toEqual([
        path,
        { status: "failed", reason, root: "work" },
      ]);
    }
  });

  test("a link inside the root that stays inside names the folder it leads to", async () => {
    const { work, roots } = world();
    const target = folder(work, "repos", "portal");
    linkFolder(target, join(work, "short"));
    const found = await resolvePlace({ root: "work", path: "short" }, roots);
    expect(found).toEqual(resolved(target, "work"));
  });

  test.skipIf(!WINDOWS)(
    "[A1.3.15.places.resolve] Windows: a directory symbolic link that leads outside is escapes_root",
    async (context) => {
      const { work, outside, roots } = world();
      folder(outside, "secret");
      try {
        symlinkSync(join(outside, "secret"), join(work, "symlinked"), "dir");
      } catch (error) {
        // Creating a symbolic link on Windows needs SeCreateSymbolicLinkPrivilege or Developer
        // Mode; a normal user may have neither. Junctions (above) need no right.
        if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
        throw error;
      }
      expect(await resolvePlace({ root: "work", path: "symlinked" }, roots)).toMatchObject({
        status: "failed",
        reason: "escapes_root",
      });
    },
  );

  test("`..` and `.` segments are invalid_path, in a place and in an absolute folder", async () => {
    const { work, roots } = world();
    folder(work, "a", "b");
    for (const path of ["a/../a", "../outside", "a/./b", ".", "..", "a/b/..", "/a", "a//b", "a/"]) {
      expect(await resolvePlace({ root: "work", path }, roots)).toMatchObject({
        status: "failed",
        reason: "invalid_path",
      });
    }
    // Joined by hand: path.join would read the `..` itself.
    for (const given of [`${work}${sep}a${sep}..${sep}a`, `${work}/a/./b`, `${work}/a/b/..`]) {
      expect(await placeOf(given, roots)).toMatchObject({
        status: "failed",
        reason: "invalid_path",
      });
    }
  });

  test.skipIf(!WINDOWS)(
    "[A1.3.15.places.resolve] Windows: another case names the same folder, never another one",
    async () => {
      const { base, work, roots } = world();
      const portal = folder(work, "lumen", "portal");
      // The place in another case resolves to the folder with its own spelling.
      expect(await resolvePlace({ root: "work", path: "LUMEN/Portal" }, roots)).toEqual(
        resolved(portal, "work"),
      );
      // An absolute folder in another case becomes the place with the folder's own spelling.
      const upper = await placeOf(portal.toUpperCase(), roots);
      expect(upper).toMatchObject({ status: "ok", root: "work", path: "lumen/portal" });
      // A root written in another case holds the same folders.
      const shouting: RootFolder[] = [{ id: "work", path: join(base.toUpperCase(), "WORK") }];
      expect(await placeOf(portal, shouting)).toMatchObject({ path: "lumen/portal" });
      expect(await resolvePlace({ root: "work", path: "lumen/portal" }, shouting)).toEqual(
        resolved(portal, "work"),
      );
      // Case as the volume folds it, letter by letter, not as JavaScript's context rule for a
      // final sigma has it: where the file system finds `ΟΣ` through another spelling, so does
      // resolve, and where it finds nothing, resolve says path_missing.
      const greek = folder(work, "ΟΣ");
      const greekId = statSync(greek, { bigint: true });
      for (const spelling of ["οσ", "Οσ", "ος"]) {
        let same = false;
        try {
          const s = statSync(join(work, spelling), { bigint: true });
          same = s.dev === greekId.dev && s.ino === greekId.ino;
        } catch {
          // Not there: another name on this volume.
        }
        expect([spelling, await resolvePlace({ root: "work", path: spelling }, roots)]).toEqual([
          spelling,
          same ? resolved(greek, "work") : expect.objectContaining({ reason: "path_missing" }),
        ]);
      }
      // Two spellings of one root folder are one folder: `ttasks roots add` finds it named, and
      // two such roots written by hand leave the folder no one place.
      const loud = join(base.toUpperCase(), "WORK");
      expect(await rootNaming(loud, roots)).toEqual({ status: "named", root: "work" });
      const twice: RootFolder[] = [...roots, { id: "loud", path: loud }];
      expect(await placeOf(portal, twice)).toEqual({
        status: "failed",
        reason: "ambiguous_root",
        roots: ["loud", "work"],
      });
      // A sibling whose name only starts like the root's is not inside it.
      const workshop = folder(base, "WorkShop");
      expect(await placeOf(workshop, roots)).toMatchObject({ reason: "outside_roots" });
      // The extended form names the same folder.
      expect(await placeOf(`\\\\?\\${portal}`, roots)).toMatchObject({ path: "lumen/portal" });
    },
  );

  test.skipIf(!LINUX)(
    "[A1.3.15.places.resolve] Linux: case is part of the name, so another case is path_missing",
    async () => {
      const { work, roots } = world();
      folder(work, "lumen", "portal");
      expect(await resolvePlace({ root: "work", path: "LUMEN/Portal" }, roots)).toMatchObject({
        status: "failed",
        reason: "path_missing",
      });
    },
  );

  test.skipIf(!WINDOWS)(
    "[A1.3.15.places.resolve] Windows: a short name (8.3) is invalid_path, the long name resolves",
    async (context) => {
      const { work, roots } = world();
      const long = folder(work, "Lumen Health Portal");
      // The short name, from the file system object: Node has no call for it.
      const short = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TTASKS_TEST_FOLDER).ShortName",
        ],
        { env: { ...process.env, TTASKS_TEST_FOLDER: long }, encoding: "utf8" },
      ).trim();
      // A volume with 8.3 names turned off gives the long name back: nothing to test there.
      if (short === "" || short === "Lumen Health Portal") context.skip();
      expect(await resolvePlace({ root: "work", path: short }, roots)).toMatchObject({
        status: "failed",
        reason: "invalid_path",
      });
      expect(await resolvePlace({ root: "work", path: "Lumen Health Portal" }, roots)).toEqual(
        resolved(long, "work"),
      );
      // An absolute folder given by its short name becomes the place with the long name.
      expect(await placeOf(join(work, short), roots)).toMatchObject({
        path: "Lumen Health Portal",
      });
    },
  );

  test("a root this machine lacks is root_missing; a root whose folder is gone is root_unavailable", async () => {
    const { base, work, roots } = world();
    folder(work, "lumen");
    expect(await resolvePlace({ root: "oss", path: "lumen" }, roots)).toEqual({
      status: "failed",
      reason: "root_missing",
      root: "oss",
    });
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    const broken: RootFolder[] = [
      { id: "gone", path: join(base, "gone") },
      { id: "file", path: file },
      { id: "relative", path: "work" },
    ];
    for (const root of ["gone", "file", "relative"]) {
      expect(await resolvePlace({ root, path: "lumen" }, broken)).toEqual({
        status: "failed",
        reason: "root_unavailable",
        root,
      });
    }
  });

  test("a nested folder that is missing is path_missing, never its parent", async () => {
    const { work, roots } = world();
    folder(work, "lumen");
    expect(await resolvePlace({ root: "work", path: "lumen/portal" }, roots)).toMatchObject({
      status: "failed",
      reason: "path_missing",
    });
    // A dangling link is missing too.
    linkFolder(join(work, "nowhere"), join(work, "dangling"));
    expect(await resolvePlace({ root: "work", path: "dangling" }, roots)).toMatchObject({
      reason: "path_missing",
    });
    expect(await placeOf(join(work, "lumen", "portal"), roots)).toMatchObject({
      status: "failed",
      reason: "path_missing",
    });
  });

  test("a sibling clone is not the place: path_missing or identity_mismatch, never the clone", async () => {
    const { work, roots } = world();
    const url = "https://example.com/lumen/portal.git";
    const portal = repo(join(work, "lumen", "portal"), url);
    const clone = repo(join(work, "lumen", "portal-2"), url);
    const place = { root: "work", path: "lumen/portal", gitRemote: url };
    expect(await resolvePlace(place, roots)).toEqual(resolved(portal, "work"));
    // The result carries the remote it read and, for the process in the folder, what to check.
    expect(await resolvePlace(place, roots)).toMatchObject({
      remote: { status: "remote", url },
      check: { depth: 2, gitRemote: url },
    });
    // A config this reader cannot read exactly is no match for a recorded remote.
    writeFileSync(
      join(portal, ".git", "config"),
      `[include]\n\tpath = x\n[remote "origin"]\n\turl = ${url}\n`,
    );
    expect(await resolvePlace(place, roots)).toMatchObject({ reason: "identity_mismatch" });
    expect(await resolvePlace({ root: "work", path: "lumen/portal" }, roots)).toMatchObject({
      status: "ok",
      remote: { status: "unreadable" },
    });
    repo(portal, url);
    // Another repository in the place's folder: identity_mismatch.
    renameSync(portal, join(work, "lumen", "portal-old"));
    repo(portal, "https://example.com/other/repo.git");
    expect(await resolvePlace(place, roots)).toMatchObject({ reason: "identity_mismatch" });
    // No repository there at all: identity_mismatch too.
    rmSync(join(portal, ".git"), { recursive: true });
    expect(await resolvePlace(place, roots)).toMatchObject({ reason: "identity_mismatch" });
    // The place's folder gone, the clone of the same repository beside it: path_missing.
    rmSync(portal, { recursive: true });
    expect(await resolvePlace(place, roots)).toMatchObject({ reason: "path_missing" });
    // The clone is a place of its own, under its own path.
    expect(
      await resolvePlace({ root: "work", path: "lumen/portal-2", gitRemote: url }, roots),
    ).toEqual(resolved(clone, "work"));
  });

  test("a file where a folder is expected is not_a_directory, and a folder where a file is expected is not_a_file", async () => {
    const { work, roots } = world();
    folder(work, "notes");
    writeFileSync(join(work, "notes", "todo.md"), "x");
    expect(await resolvePlace({ root: "work", path: "notes/todo.md" }, roots)).toMatchObject({
      reason: "not_a_directory",
    });
    expect(await resolvePlace({ root: "work", path: "notes", kind: "file" }, roots)).toMatchObject({
      reason: "not_a_file",
    });
    expect(
      await resolvePlace({ root: "work", path: "notes/todo.md", kind: "file" }, roots),
    ).toMatchObject({ status: "ok" });
    expect(await placeOf(join(work, "notes", "todo.md"), roots)).toMatchObject({
      reason: "not_a_directory",
    });
  });

  test("a root that is itself a link is followed: its places are below the folder it leads to", async () => {
    const { base } = world();
    const real = folder(base, "data", "work");
    const portal = folder(real, "portal");
    linkFolder(real, join(base, "work-link"));
    const roots: RootFolder[] = [{ id: "work", path: join(base, "work-link") }];
    expect(await resolvePlace({ root: "work", path: "portal" }, roots)).toEqual(
      resolved(portal, "work"),
    );
    expect(await placeOf(portal, roots)).toMatchObject({ root: "work", path: "portal" });
    expect(await placeOf(join(base, "work-link", "portal"), roots)).toMatchObject({
      root: "work",
      path: "portal",
    });
  });
});

describe("[A1.3.15.places.inverse] an absolute folder becomes a root and a relative path", () => {
  test("the closest root wins: a root nested in another holds its own folders", async () => {
    const { work, roots } = world();
    const lumen = folder(work, "lumen");
    const portal = folder(lumen, "portal", "src");
    const nested: RootFolder[] = [...roots, { id: "lumen", path: lumen }];
    expect(await placeOf(portal, nested)).toMatchObject({
      status: "ok",
      root: "lumen",
      path: "portal/src",
    });
    expect(await placeOf(lumen, nested)).toMatchObject({ root: "lumen", path: "" });
    expect(await placeOf(work, nested)).toMatchObject({ root: "work", path: "" });
    // The order of the roots does not matter.
    expect(await placeOf(portal, [...nested].reverse())).toMatchObject({ root: "lumen" });
  });

  test("two roots that name one folder through different spellings are ambiguous_root", async () => {
    const { base, work, roots } = world();
    linkFolder(work, join(base, "alias"));
    const both: RootFolder[] = [...roots, { id: "alias", path: join(base, "alias") }];
    const portal = folder(work, "portal");
    expect(await placeOf(portal, both)).toEqual({
      status: "failed",
      reason: "ambiguous_root",
      roots: ["alias", "work"],
    });
    expect(await rootNaming(join(base, "alias"), roots)).toEqual({ status: "named", root: "work" });
    expect(await rootNaming(join(base, "outside"), roots)).toEqual({ status: "free" });
    expect(await rootNaming(join(base, "gone"), roots)).toEqual({ status: "unavailable" });
  });

  test("a folder under no root is outside_roots with the root IDs, and a relative path is not_absolute", async () => {
    const { outside, roots } = world();
    expect(await placeOf(outside, roots)).toEqual({
      status: "failed",
      reason: "outside_roots",
      roots: ["work"],
    });
    expect(await placeOf("work/lumen", roots)).toMatchObject({ reason: "not_absolute" });
    expect(await placeOf("", roots)).toMatchObject({ reason: "not_absolute" });
  });

  test("turning a folder into a place and resolving it gives the same folder", async () => {
    const { work, roots } = world();
    const deep = folder(work, "clients", "Lumen Health", "portal ü");
    const bound = await placeOf(deep, roots);
    expect(bound).toMatchObject({
      status: "ok",
      root: "work",
      path: "clients/Lumen Health/portal ü",
    });
    if (bound.status !== "ok") return;
    const back = await resolvePlace({ root: bound.root, path: bound.path }, roots);
    expect(back).toEqual(resolved(deep, "work"));
  });

  test.skipIf(!LINUX)(
    "[A1.3.15.places.inverse] Linux: a folder whose name a place cannot hold exactly is invalid_path",
    async () => {
      const { work, roots } = world();
      // A backslash is a name character on Linux and a separator in a place; a name in NFD is
      // stored as NFC, which Linux reads as another name.
      for (const name of ["back\\slash", "cafe\u0301"]) {
        const odd = folder(work, name);
        expect(await placeOf(odd, roots)).toMatchObject({ reason: "invalid_path" });
      }
    },
  );
});

describe("[A1.3.15.places.syntax] the path rules per OS", () => {
  test("a place's path: the writer's rules everywhere, and Win32's names on Windows", () => {
    for (const path of ["", "a", "a/b", "Lumen Health/portal", "ü", "a.b", "a~1"]) {
      expect(isPlacePath(path, "linux")).toBe(true);
      expect(isPlacePath(path, "win32")).toBe(true);
    }
    const everywhere = [
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "a/../b",
      "./a",
      "a\\b",
      "C:/x",
      "C:x",
      "a\u0000b",
      "a\u202eb",
      "a\u200bb",
      "cafe\u0301",
      "\ud800",
      "x".repeat(1025),
    ];
    for (const path of everywhere) {
      expect([path, isPlacePath(path, "linux")]).toEqual([path, false]);
      expect([path, isPlacePath(path, "win32")]).toEqual([path, false]);
    }
    const windowsOnly = [
      "a.",
      "a ",
      "a/b.",
      "nul",
      "NUL.txt",
      "con",
      "com1",
      "lpt9.log",
      "ab:c",
      "a*",
      'a"b',
      "a|b",
      "a?b",
      "a<b",
    ];
    for (const path of windowsOnly) {
      expect([path, isPlacePath(path, "linux")]).toEqual([path, true]);
      expect([path, isPlacePath(path, "win32")]).toEqual([path, false]);
    }
    expect(isPlacePath("x".repeat(1024), "linux")).toBe(true);
  });

  test("an absolute folder: drive, UNC and extended forms on Windows; `/` elsewhere", () => {
    const ok = (given: string, platform: NodeJS.Platform) => absoluteFolder(given, platform);
    expect(ok("C:\\Users\\mira\\work", "win32")).toEqual({
      ok: true,
      path: "C:\\Users\\mira\\work",
    });
    expect(ok("C:/Users/mira", "win32")).toEqual({ ok: true, path: "C:/Users/mira" });
    expect(ok("\\\\srv\\share\\work", "win32")).toEqual({ ok: true, path: "\\\\srv\\share\\work" });
    expect(ok("\\\\?\\C:\\work", "win32")).toEqual({ ok: true, path: "C:\\work" });
    expect(ok("\\\\?\\UNC\\srv\\share\\x", "win32")).toEqual({
      ok: true,
      path: "\\\\srv\\share\\x",
    });
    expect(ok("/home/mira/work", "linux")).toEqual({ ok: true, path: "/home/mira/work" });
    const reason = (given: string, platform: NodeJS.Platform) => {
      const r = absoluteFolder(given, platform);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason("\\\\.\\pipe\\x", "win32")).toBe("invalid_path");
    expect(reason("\\\\?\\Volume{x}\\a", "win32")).toBe("invalid_path");
    expect(reason("C:x", "win32")).toBe("not_absolute");
    expect(reason("\\work", "win32")).toBe("not_absolute");
    expect(reason("/home/mira", "win32")).toBe("not_absolute");
    expect(reason("C:\\work", "linux")).toBe("not_absolute");
    expect(reason("work", "linux")).toBe("not_absolute");
    expect(reason("C:\\work\\a.", "win32")).toBe("invalid_path");
    expect(reason("C:\\work\\a \\b", "win32")).toBe("invalid_path");
    expect(reason("C:\\work\\nul", "win32")).toBe("invalid_path");
    expect(reason("C:\\work\\..\\x", "win32")).toBe("invalid_path");
    expect(reason("/home/./x", "linux")).toBe("invalid_path");
    expect(reason("/home/a\u0000", "linux")).toBe("not_absolute");
    expect(reason("/home/a\u202e", "linux")).toBe("invalid_path");
    // A lone surrogate, which Node would turn into U+FFFD: another name.
    expect(reason("/home/name-\ud800", "linux")).toBe("invalid_path");
    expect(reason("C:\\work\\name-\udc00", "win32")).toBe("invalid_path");
  });

  test("a person's folder opens whatever characters its name holds: a zero-width joiner, a non-joiner, a direction mark", async () => {
    const dir = tempDir();
    // An emoji sequence, Persian text and a mark: each a name a person gives a folder.
    for (const name of [
      "team-\u{1F469}\u200d\u{1F4BB}",
      "\u0646\u0627\u0645\u0647\u200c\u0647\u0627",
      "notes\u200e",
    ]) {
      const path = join(dir, name);
      mkdirSync(path);
      const s = statSync(path, { bigint: true });
      expect(await resolveFolder(path)).toMatchObject({
        status: "ok",
        folder: path,
        identity: { dev: s.dev, ino: s.ino },
      });
    }
    // Controls are still no name, and a missing folder is never another one.
    expect(await resolveFolder(join(dir, "a\u0007b"))).toEqual({
      status: "failed",
      reason: "invalid_path",
    });
    expect(await resolveFolder(join(dir, "gone"))).toMatchObject({ status: "failed" });
  });

  test("a folder named with U+FFFD is not reached through a lone surrogate", async () => {
    const { work, roots } = world();
    folder(work, "name-\ufffd");
    expect(await placeOf(join(work, "name-\ufffd"), roots)).toMatchObject({ status: "ok" });
    expect(await placeOf(join(work, "name-\ud800"), roots)).toEqual({
      status: "failed",
      reason: "invalid_path",
    });
  });
});

describe("[A1.3.15.places.git-remote] the Git remote, read from the repository's config file", () => {
  test("origin first, else the first remote; a worktree's .git file and commondir are followed", async () => {
    const remote = (url: string) => ({ status: "remote", url });
    expect(
      remoteFromConfig(
        '[remote "upstream"]\n\turl = https://example.com/u.git\n[remote "origin"]\n\turl = "git@example.com:o/r.git" ; note\n',
      ),
    ).toEqual(remote("git@example.com:o/r.git"));
    expect(remoteFromConfig('[remote "fork"]\n  url = ssh://git@example.com/f.git\n')).toEqual(
      remote("ssh://git@example.com/f.git"),
    );
    expect(remoteFromConfig("[core]\n\tbare = false\n")).toEqual({ status: "none" });

    const base = tempDir();
    const main = repo(folder(base, "main"), "https://example.com/m.git");
    expect(await readGitRemote(main)).toEqual(remote("https://example.com/m.git"));
    // A worktree: `.git` is a file naming its gitdir, whose commondir is the main repository's.
    const gitdir = folder(main, ".git", "worktrees", "wt");
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    const wt = folder(base, "wt");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(await readGitRemote(wt)).toEqual(remote("https://example.com/m.git"));
    // The same with a relative gitdir, as a submodule writes it, joined to the folder.
    const sub = folder(main, "sub");
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/worktrees/wt\r\n");
    expect(await readGitRemote(sub)).toEqual(remote("https://example.com/m.git"));
    // A parent's repository is never the folder's own.
    expect(await readGitRemote(folder(main, "src"))).toEqual({ status: "none" });
    // A config over the bound, a .git file that is not git's, or one that names nothing: unreadable.
    const big = repo(folder(base, "big"), "https://example.com/b.git");
    writeFileSync(join(big, ".git", "config"), `# ${"x".repeat(300_000)}\n`, { flag: "a" });
    expect(await readGitRemote(big)).toEqual({ status: "unreadable" });
    const odd = folder(base, "odd");
    writeFileSync(join(odd, ".git"), "gitdir:no-space\n");
    expect(await readGitRemote(odd)).toEqual({ status: "unreadable" });
    writeFileSync(join(odd, ".git"), `gitdir: ${join(base, "nowhere")}\n`);
    expect(await readGitRemote(odd)).toEqual({ status: "unreadable" });
    // Text that is not UTF-8 is not read as anything.
    const latin = repo(folder(base, "latin"), "https://example.com/l.git");
    writeFileSync(
      join(latin, ".git", "config"),
      Buffer.concat([
        Buffer.from('[remote "origin"]\n\turl = https://example.com/'),
        Buffer.from([0xe9]),
        Buffer.from(".git\n"),
      ]),
    );
    expect(await readGitRemote(latin)).toEqual({ status: "unreadable" });
    expect(dirname(gitdir)).toContain("worktrees");
  });

  test("only network addresses are recorded, without credentials", () => {
    expect(portableRemote("https://user:token@example.com/o/r.git")).toBe(
      "https://example.com/o/r.git",
    );
    expect(portableRemote("https://ghp_secret@example.com/o/r.git")).toBe(
      "https://example.com/o/r.git",
    );
    expect(portableRemote("ssh://git:pw@example.com:22/o/r.git")).toBe(
      "ssh://git@example.com:22/o/r.git",
    );
    expect(portableRemote("git@example.com:o/r.git")).toBe("git@example.com:o/r.git");
    for (const local of [
      "/srv/git/r.git",
      "../r.git",
      "C:\\repos\\r.git",
      "C:/repos/r.git",
      "file:///srv/git/r.git",
      "\\\\srv\\share\\r.git",
      "",
      "https://exa mple.com/x",
    ]) {
      expect([local, portableRemote(local)]).toEqual([local, undefined]);
    }
  });

  test("only known network transports, whole and bounded: no helper, no other scheme, no long form", () => {
    for (const kept of [
      "git://example.com/o/r.git",
      "git+ssh://git@example.com/o/r.git",
      "ssh+git://git@example.com/o/r.git",
      "http://example.com/o/r.git",
      "ftps://example.com/o/r.git",
      "ssh://git@[2001:db8::1]:22/o/r.git",
      "git@gitlab.example.com:group/sub/r.git",
      "example.com:o/r.git",
    ]) {
      expect([kept, portableRemote(kept)]).toEqual([kept, kept]);
    }
    for (const dropped of [
      // Remote helpers name a program or a local file, not a network address.
      "ext::C:/fixture-private/git-bridge.exe",
      "ext::/usr/local/bin/fixture-bridge %S",
      "fd::3",
      "persistent-https::https://example.com/o/r.git",
      "codecommit::eu-west-1://fixture-repo",
      "fixture-helper::anything",
      "9fixture::C:/fixture-private/bridge.exe",
      "::fixture",
      // Schemes git does not reach over the network itself.
      "s3://fixture-bucket/r.git",
      "fixture://example.com/r.git",
      // scp-like forms whose host is not a host name.
      "ex!ample:o/r.git",
      "user@ex%61mple:o/r.git",
      // Over the bound once written out: URL encoding makes each é six characters.
      `https://example.com/${"\u00e9".repeat(400)}.git`,
      `git@example.com:${"x".repeat(2100)}`,
    ]) {
      expect([dropped, portableRemote(dropped)]).toEqual([dropped, undefined]);
    }
    // Whatever is kept is one printable ASCII word within the writer's bound.
    const long = `https://example.com/${"a".repeat(2000)}`;
    const kept = portableRemote(long);
    expect(kept === undefined || (kept.length <= 2048 && /^[\x21-\x7e]+$/u.test(kept))).toBe(true);
  });

  test("round four's finding 2: two addresses git keeps apart are never recorded as one", () => {
    // Git passes the path as written: a query or a fragment is part of the address (and may carry
    // a secret), so such a URL is not recorded rather than cut down to another address.
    for (const dropped of [
      "ssh://git@example.com/repo.git?A",
      "ssh://git@example.com/repo.git?B",
      "https://example.com/repo.git?token=fixture",
      "https://example.com/repo.git#main",
      // A user name holding an `@`: which part is the host is not certain.
      "https://me@example.org:fixture@example.com/r.git",
      // Git knows its schemes in lower case only.
      "SSH://git@example.com/r.git",
      "HTTPS://example.com/r.git",
    ]) {
      expect([dropped, portableRemote(dropped)]).toEqual([dropped, undefined]);
    }
    // Everything else is kept as git reads it: no dot segment folded, no escape decoded, no case
    // or default port changed.
    for (const asIs of [
      "ssh://git@example.com/a/../repo.git",
      "https://example.com/a/%2e%2e/repo.git",
      "https://Example.COM/r.git",
      "https://example.com:443/r.git",
      "https://example.com",
    ]) {
      expect([asIs, portableRemote(asIs)]).toEqual([asIs, asIs]);
    }
    expect(portableRemote("ssh://git@example.com/a/../repo.git")).not.toBe(
      portableRemote("ssh://git@example.com/repo.git"),
    );
  });
});

describe("[A1.3.15.places.inverse] identity without a file number", () => {
  test("a file number of 0 or of all ones is no identity, and never matches, not even itself", () => {
    const at = (dev: bigint, ino: bigint) => ({ dev, ino });
    expect(identityOf(at(7n, 0n))).toBeUndefined();
    expect(identityOf(at(7n, 2n ** 64n - 1n))).toBeUndefined();
    expect(identityOf(at(7n, 5n))).toEqual({ dev: 7n, ino: 5n });
    // Two folders of a volume that gives no file numbers are never one folder, whatever their
    // names (round three's finding 3: `A` and `a` compared as one); nor is one folder itself.
    expect(sameIdentity(at(7n, 0n), at(7n, 0n))).toBe(false);
    // Identity decides, never a name; another volume is another folder.
    expect(sameIdentity(at(7n, 5n), at(7n, 5n))).toBe(true);
    expect(sameIdentity(at(7n, 5n), at(8n, 5n))).toBe(false);
    expect(sameIdentity(at(7n, 5n), at(7n, 6n))).toBe(false);
  });

  test.skipIf(!WINDOWS && !LINUX)(
    "[A1.3.15.places.inverse] folders whose names differ only in case are two places in a case-sensitive folder",
    async (context) => {
      const { work, roots } = world();
      const cased = folder(work, "cased");
      if (WINDOWS) {
        // A case-sensitive folder on Windows needs the per-folder flag (which needs WSL's driver).
        try {
          execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", cased, "enable"], {
            stdio: "ignore",
          });
        } catch {
          context.skip();
        }
      }
      const upper = folder(cased, "A");
      const lower = folder(cased, "a");
      // fsutil can refuse ("Access is denied") and still exit 0: then `a` is `A`, nothing to test.
      if (readdirSync(cased).length !== 2) context.skip();
      expect(await resolvePlace({ root: "work", path: "cased/A" }, roots)).toEqual(resolved(upper));
      expect(await resolvePlace({ root: "work", path: "cased/a" }, roots)).toEqual(resolved(lower));
      expect(await placeOf(upper, roots)).toMatchObject({ path: "cased/A" });
      expect(await placeOf(lower, roots)).toMatchObject({ path: "cased/a" });
    },
  );
});
