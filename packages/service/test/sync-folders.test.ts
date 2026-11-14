// The synced-folder and network check (A1 3.2, A1 5 "Sync detection: fixture trees for every row of
// the table in 3.2, plus statfs types"). Every fact comes through a fixture host: its file looks
// see only the fixture tree (anything outside it is "not there", so this machine's own folders,
// sync clients and mounts are never read), and the machine's facts (environment, registry, drives,
// statfs, mount table) are fixture values or samples captured on real machines.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkFolder,
  cloudFilesProvider,
  driveFsPaths,
  folderMessage,
  linuxVolume,
  macVolume,
  windowsVolume,
  type FolderCheck,
  type SyncHost,
  type Volume,
} from "../src/hub/sync-folders.ts";
import { parseWindowsFacts } from "../src/hub/sync-host.ts";
import { fixtureHost, NO_WINDOWS, type SyncFacts } from "./sync-fixtures.ts";

/** A volume as the samples write it: `local`, the network file system's word, or `unchecked`. */
const word = (volume: Volume): string =>
  volume.kind === "network" ? volume.fs : volume.kind === "local" ? "local" : "unchecked";

const SAMPLES = fileURLToPath(
  new URL("../../../fixtures/sync/statfs-samples.json", import.meta.url),
);
const WINDOWS = process.platform === "win32";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh fixture tree under the OS temporary folder, by its real path. */
function tree(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sync-")));
  roots.push(root);
  return root;
}

/** Creates the folders of `path` and returns it. */
function dir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** The first synced signal's provider and rule, for brevity. */
const synced = (check: FolderCheck) => ({
  verdict: check.verdict,
  provider: check.provider,
  rule: check.signals.find((s) => s.kind === "synced")?.rule,
});

/** Drive for desktop's SyncTargets value as the Windows reference machine showed its layout: protobuf-like fields. */
function syncTargets(paths: readonly string[], utf16 = false): string {
  const parts: Buffer[] = [];
  for (const path of paths) {
    const account = Buffer.from("100000000000000000001", "utf8");
    const drive = Buffer.from("G:", "utf8");
    const root = utf16 ? Buffer.from(path, "utf16le") : Buffer.from(path, "utf8");
    const inner = Buffer.concat([field(1, field(1, account)), field(2, drive), field(3, root)]);
    parts.push(field(1, inner));
  }
  return Buffer.concat(parts).toString("base64");
}

/** A protobuf length-delimited field: its key, its length as a varint, its bytes. */
function field(number: number, bytes: Buffer): Buffer {
  const length: number[] = [];
  for (let n = bytes.length; ; n >>>= 7) {
    if (n < 0x80) {
      length.push(n);
      break;
    }
    length.push((n & 0x7f) | 0x80);
  }
  return Buffer.concat([Buffer.from([(number << 3) | 2, ...length]), bytes]);
}

const SYNCED_WORDS =
  "A live database there can be corrupted. Move it, or confirm that this folder is excluded from sync.";

describe("[A1.5.sync.detect] synced folders and network file systems, a fixture tree for every row of A1 3.2", () => {
  test("Syncthing: .stfolder in an ancestor, with A1's words", async () => {
    const root = tree();
    dir(join(root, "Sync", ".stfolder"));
    const space = dir(join(root, "Sync", "spaces", "mira"));
    const check = await checkFolder(space, fixtureHost(root));
    expect(synced(check)).toEqual({ verdict: "synced", provider: "syncthing", rule: "marker" });
    expect(check.signals[0]?.depth).toBe(2);
    expect(folderMessage(check)).toBe(`This space is inside a Syncthing folder. ${SYNCED_WORDS}`);
  });

  test("Dropbox: .dropbox in an ancestor, or a root listed in ~/.dropbox/info.json", async () => {
    const root = tree();
    writeFileSync(join(dir(join(root, "Dropbox")), ".dropbox"), "");
    const marked = await checkFolder(dir(join(root, "Dropbox", "mira")), fixtureHost(root));
    expect(synced(marked)).toEqual({ verdict: "synced", provider: "dropbox", rule: "marker" });

    const home = dir(join(root, "home"));
    const listed = dir(join(root, "Dropbox (Fixture)"));
    writeFileSync(
      join(dir(join(home, ".dropbox")), "info.json"),
      JSON.stringify({ personal: { path: listed, host: 1 } }),
    );
    const check = await checkFolder(dir(join(listed, "a", "mira")), fixtureHost(root, { home }));
    expect(synced(check)).toEqual({
      verdict: "synced",
      provider: "dropbox",
      rule: "provider_root",
    });
    // ~/.dropbox is Dropbox's own settings folder, not its marker: a space elsewhere under the
    // home folder is local.
    const local = await checkFolder(dir(join(home, "Tasks", "mira")), fixtureHost(root, { home }));
    expect(local.verdict).toBe("local");
  });

  test("OneDrive: under %OneDrive% (a stale one too), or a UserFolder of an account", async () => {
    const root = tree();
    const stale = dir(join(root, "OneDrive"));
    const viaEnv = await checkFolder(
      dir(join(stale, "Documents", "mira")),
      fixtureHost(root, { env: { OneDrive: stale } }),
    );
    expect(synced(viaEnv)).toEqual({
      verdict: "synced",
      provider: "onedrive",
      rule: "provider_root",
    });
    for (const name of ["OneDriveConsumer", "OneDriveCommercial"]) {
      const check = await checkFolder(
        join(stale, "mira"),
        fixtureHost(root, { env: { [name]: stale } }),
      );
      expect(check.provider, name).toBe("onedrive");
    }
    const account = dir(join(root, "OneDrive - Fixture Org"));
    const viaAccount = await checkFolder(
      dir(join(account, "mira")),
      fixtureHost(root, { windows: { ...NO_WINDOWS, oneDriveAccounts: [account] } }),
    );
    expect(synced(viaAccount)).toEqual({
      verdict: "synced",
      provider: "onedrive",
      rule: "provider_root",
    });
    expect(folderMessage(viaAccount)).toBe(
      `This space is inside a OneDrive folder. ${SYNCED_WORDS}`,
    );
  });

  test("Google Drive: a volume labelled Google Drive", async () => {
    const root = tree();
    const volume = dir(join(root, "G"));
    const check = await checkFolder(
      dir(join(volume, "My Drive", "mira")),
      fixtureHost(root, {
        windows: {
          ...NO_WINDOWS,
          drives: [{ root: volume, type: "Fixed", label: "Google Drive", format: "FAT32" }],
        },
      }),
    );
    expect(synced(check)).toEqual({
      verdict: "synced",
      provider: "google_drive",
      rule: "volume_label",
    });
  });

  test.runIf(WINDOWS)(
    "Google Drive: a mirror root in DriveFS's SyncTargets, UTF-8 or UTF-16",
    async () => {
      const root = tree();
      const mirror = dir(join(root, "Google Drive"));
      for (const utf16 of [false, true]) {
        const check = await checkFolder(
          dir(join(mirror, "mira")),
          fixtureHost(root, {
            windows: { ...NO_WINDOWS, driveFsTargets: syncTargets([mirror], utf16) },
          }),
        );
        expect(synced(check), String(utf16)).toEqual({
          verdict: "synced",
          provider: "google_drive",
          rule: "provider_root",
        });
      }
    },
  );

  test("Google Drive's SyncTargets value: its paths in UTF-8, UTF-16 and at an odd offset", () => {
    const paths = ["D:\\Google Drive", "E:\\Mirror\\Drive"];
    expect(driveFsPaths(syncTargets(paths)).sort()).toEqual([...paths].sort());
    expect(driveFsPaths(syncTargets(paths, true)).sort()).toEqual([...paths].sort());
    // A UTF-16 field that starts at an odd offset of the value.
    const field = Buffer.from("D:\\Odd Mirror", "utf16le");
    const odd = Buffer.concat([Buffer.from([0x08, 0x01, 0x1a, field.length]), field]);
    expect(driveFsPaths(odd.toString("base64"))).toEqual(["D:\\Odd Mirror"]);
    // A value of another shape: its UTF-8 text is searched.
    expect(
      driveFsPaths(Buffer.from("\u0000\u0007D:\\Plain Root\u0000").toString("base64")),
    ).toEqual(["D:\\Plain Root"]);
    expect(driveFsPaths("")).toEqual([]);
  });

  test("Cloud Files: a sync root registered for this user (iCloud, others)", async () => {
    const root = tree();
    const icloud = dir(join(root, "iCloudDrive"));
    const other = dir(join(root, "Contoso Sync"));
    const host = fixtureHost(root, {
      windows: {
        ...NO_WINDOWS,
        syncRoots: [
          { id: "iCloudDrive!S-1-5-21-1-2-3-1001!Fixture", path: icloud },
          { id: "ContosoSync!S-1-5-21-1-2-3-1001!Fixture", path: other },
        ],
      },
    });
    expect(synced(await checkFolder(dir(join(icloud, "mira")), host))).toEqual({
      verdict: "synced",
      provider: "icloud",
      rule: "provider_root",
    });
    const unknown = await checkFolder(dir(join(other, "mira")), host);
    expect(unknown.provider).toBe("cloud_files");
    expect(folderMessage(unknown)).toBe(
      `This space is inside a cloud sync folder. ${SYNCED_WORDS}`,
    );
    expect(cloudFilesProvider("OneDrive!S-1-5-21!Personal|1")).toBe("onedrive");
    expect(cloudFilesProvider("GoogleDriveFS!S-1-5-21!x")).toBe("google_drive");
    expect(cloudFilesProvider("Nextcloud-1!S-1-5-21!x")).toBe("nextcloud");
  });

  test.skipIf(WINDOWS)(
    "iCloud and macOS cloud folders: ~/Library/Mobile Documents and ~/Library/CloudStorage",
    async () => {
      const root = tree();
      const home = dir(join(root, "home"));
      const host = fixtureHost(root, { platform: "darwin", home });
      const icloud = await checkFolder(
        dir(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "mira")),
        host,
      );
      expect(synced(icloud)).toEqual({
        verdict: "synced",
        provider: "icloud",
        rule: "cloud_folder",
      });
      const storage = await checkFolder(
        dir(join(home, "Library", "CloudStorage", "GoogleDrive-fixture", "mira")),
        host,
      );
      expect(storage.provider).toBe("google_drive");
      const plain = await checkFolder(dir(join(home, "Tasks", "mira")), host);
      expect(plain.verdict).toBe("local");
    },
  );

  test("Nextcloud, ownCloud: .owncloudsync.log or .sync_*.db in an ancestor", async () => {
    const root = tree();
    writeFileSync(join(dir(join(root, "Nextcloud")), ".owncloudsync.log"), "");
    const log = await checkFolder(dir(join(root, "Nextcloud", "mira")), fixtureHost(root));
    expect(synced(log)).toEqual({ verdict: "synced", provider: "nextcloud", rule: "marker" });
    writeFileSync(join(dir(join(root, "ownCloud")), ".sync_4f2a9c.db"), "");
    const journal = await checkFolder(dir(join(root, "ownCloud", "x", "mira")), fixtureHost(root));
    expect(synced(journal)).toEqual({ verdict: "synced", provider: "nextcloud", rule: "marker" });
  });

  test("Git: .git in an ancestor, a folder or a worktree's file", async () => {
    const root = tree();
    dir(join(root, "repo", ".git"));
    const check = await checkFolder(dir(join(root, "repo", "spaces", "mira")), fixtureHost(root));
    expect(synced(check)).toEqual({ verdict: "synced", provider: "git", rule: "marker" });
    expect(folderMessage(check)).toBe(`This space is inside a Git working tree. ${SYNCED_WORDS}`);
    writeFileSync(join(dir(join(root, "worktree")), ".git"), "gitdir: elsewhere\n");
    expect(
      (await checkFolder(dir(join(root, "worktree", "mira")), fixtureHost(root))).provider,
    ).toBe("git");
  });

  test("Network: a statfs type of a network file system, a UNC path, a network drive", async () => {
    const root = tree();
    const space = dir(join(root, "mnt", "mira"));
    const nfs = await checkFolder(space, fixtureHost(root, { platform: "linux", statfs: 0x6969 }));
    expect(nfs).toMatchObject({ verdict: "network", fs: "nfs" });
    expect(folderMessage(nfs)).toBe(
      "This space is on a network file system. A live database there can be corrupted. It is never written there. Move it to a local folder.",
    );
    const ext4 = await checkFolder(space, fixtureHost(root, { platform: "linux", statfs: 0xef53 }));
    expect(ext4.verdict).toBe("local");

    // A mapped drive's real path is its UNC path (captured: fixtures/sync/statfs-samples.json).
    const unc = "\\\\fileserver\\share\\spaces\\mira";
    const mapped = await checkFolder(
      space,
      fixtureHost(root, {
        platform: "win32",
        realpath: (p) => (resolve(p) === space ? unc : undefined),
      }),
    );
    expect(mapped).toMatchObject({ verdict: "network", fs: "unc" });
    if (WINDOWS) {
      // A drive Windows reports as a network drive (the fixture claims this tree's drive is one).
      const drive = space.slice(0, 3);
      const remote = await checkFolder(
        space,
        fixtureHost(root, {
          windows: {
            ...NO_WINDOWS,
            drives: [{ root: drive, type: "Network", label: "", format: "NTFS" }],
          },
        }),
      );
      expect(remote).toMatchObject({ verdict: "network", fs: "remote_drive" });
    }
    // Network wins over a sync signal: only Move is offered.
    dir(join(root, "mnt", ".stfolder"));
    const both = await checkFolder(
      space,
      fixtureHost(root, { platform: "linux", statfs: 0xff534d42 }),
    );
    expect(both.verdict).toBe("network");
  });

  test("Conflict copies beside space.db: synced, and the words name the file", async () => {
    const root = tree();
    const space = dir(join(root, "plain", "mira"));
    writeFileSync(join(space, "space.sync-conflict-20261101-101010-ABCDEF7.db"), "");
    const one = await checkFolder(space, fixtureHost(root));
    expect(one.verdict).toBe("synced");
    expect(one.conflicts).toEqual(["space.sync-conflict-20261101-101010-ABCDEF7.db"]);
    expect(folderMessage(one)).toContain("space.sync-conflict-20261101-101010-ABCDEF7.db");
    expect(folderMessage(one)).toContain(SYNCED_WORDS);
    writeFileSync(join(space, "space (Fixture's conflicted copy 2026-11-01).db"), "");
    dir(join(root, "plain", ".stfolder"));
    const two = await checkFolder(space, fixtureHost(root));
    expect(two.provider).toBe("syncthing");
    expect(two.conflicts).toHaveLength(2);
    expect(folderMessage(two)).toContain("space (Fixture's conflicted copy 2026-11-01).db");
  });

  test("a local folder, a missing one judged from its nearest ancestor, and a link into a synced folder", async () => {
    const root = tree();
    const plain = await checkFolder(dir(join(root, "Tasks", "mira")), fixtureHost(root));
    expect(plain).toMatchObject({ verdict: "local", signals: [], conflicts: [], exists: true });
    expect(folderMessage(plain)).toBeUndefined();

    dir(join(root, "Sync", ".stfolder"));
    const missing = await checkFolder(join(root, "Sync", "not", "yet", "mira"), fixtureHost(root));
    expect(missing).toMatchObject({ verdict: "synced", provider: "syncthing", exists: false });

    const target = dir(join(root, "Sync", "inner"));
    symlinkSync(target, join(dir(join(root, "elsewhere")), "link"), "junction");
    const linked = await checkFolder(
      dir(join(root, "elsewhere", "link", "mira")),
      fixtureHost(root),
    );
    expect(synced(linked)).toEqual({ verdict: "synced", provider: "syncthing", rule: "marker" });
  });

  test("a fact that cannot be read leaves the folder unchecked, served as synced, never local", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    const unchecked = (check: FolderCheck) => ({
      verdict: check.verdict,
      provider: check.provider,
      unchecked: check.signals.some((s) => s.rule === "unchecked"),
    });
    const expected = { verdict: "synced", provider: undefined, unchecked: true };
    // Windows: the registry's and the drives' facts could not be read.
    const windows = await checkFolder(
      space,
      fixtureHost(root, { platform: "win32", windows: null }),
    );
    expect(unchecked(windows)).toEqual(expected);
    expect(folderMessage(windows)).toBe(
      "This space's folder could not be checked for sync clients and network drives. A live database in a synced folder or on a network drive can be corrupted. Move it, or confirm that this folder is local and excluded from sync.",
    );
    // Linux: neither statfs nor the mount table; FUSE without the mount table that names it.
    const linux = { platform: "linux" } as const;
    expect(
      unchecked(
        await checkFolder(space, fixtureHost(root, { ...linux, statfs: null, mounts: null })),
      ),
    ).toEqual(expected);
    const fuse = 0x65735546;
    expect(
      unchecked(
        await checkFolder(space, fixtureHost(root, { ...linux, statfs: fuse, mounts: null })),
      ),
    ).toEqual(expected);
    // A FUSE mount is local only when the table names a local block device (`fuseblk`); any other
    // FUSE file system may serve files from anywhere (a mount table holds POSIX paths).
    if (!WINDOWS) {
      const mounted = (type: string) =>
        checkFolder(
          space,
          fixtureHost(root, {
            ...linux,
            statfs: fuse,
            mounts: `1 2 0:1 / ${root} rw - ${type} x rw\n`,
          }),
        );
      expect((await mounted("fuseblk")).verdict).toBe("local");
      expect(unchecked(await mounted("fuse.portal"))).toEqual(expected);
    }
    // macOS: no mount table.
    expect(
      unchecked(await checkFolder(space, fixtureHost(root, { platform: "darwin", mounts: null }))),
    ).toEqual(expected);

    // A fault in the check, anywhere: unchecked, and a marker found still names its provider.
    dir(join(root, "Tasks", ".stfolder"));
    const throwing = { ...fixtureHost(root), list: () => Promise.reject(new Error("a fault")) };
    const marked = await checkFolder(space, throwing);
    expect(marked).toMatchObject({ verdict: "synced", provider: "syncthing" });
    expect(marked.signals.some((s) => s.rule === "unchecked")).toBe(true);
    const broken = {
      ...fixtureHost(root),
      kind: () => Promise.reject(new Error("a fault")),
    };
    expect(unchecked(await checkFolder(space, broken))).toEqual(expected);
  });

  test("a large SyncTargets value is read without failing, and a long mirror root whole", async () => {
    // One field holding many small fields: a recursive walk that spread them would exceed the
    // call stack.
    const many = field(
      1,
      Buffer.concat(Array.from({ length: 100_001 }, () => field(1, Buffer.from([0x0a, 0x00])))),
    );
    const long = `D:\\${"m".repeat(244)}`;
    const value = Buffer.concat([many, Buffer.from(syncTargets([long]), "base64")]);
    expect(value.length).toBeGreaterThan(300_000);
    expect(driveFsPaths(value.toString("base64"))).toContain(long);
    // A long root as Drive for desktop writes it, read whole.
    expect(driveFsPaths(syncTargets([long]))).toEqual([long]);
    expect(driveFsPaths(syncTargets([long], true))).toEqual([long]);
    // A root nested deeper than the walk goes is still found, beside a shallow one.
    let deep = field(3, Buffer.from("D:\\deep-mirror", "utf8"));
    for (let i = 0; i < 10; i += 1) deep = field(1, deep);
    const both = Buffer.concat([Buffer.from(syncTargets(["G:\\other-mirror"]), "base64"), deep]);
    expect(driveFsPaths(both.toString("base64")).sort()).toEqual([
      "D:\\deep-mirror",
      "G:\\other-mirror",
    ]);

    // The check goes on: a Syncthing marker beside that value still counts. The value was too
    // large to read whole, so the folder is unchecked too (the next test).
    const root = tree();
    dir(join(root, "Sync", ".stfolder"));
    const check = await checkFolder(
      dir(join(root, "Sync", "mira")),
      fixtureHost(root, {
        platform: "win32",
        windows: { ...NO_WINDOWS, driveFsTargets: value.toString("base64") },
      }),
    );
    expect(check).toMatchObject({ verdict: "synced", provider: "syncthing" });
    expect(check.signals.some((s) => s.rule === "marker" && s.provider === "syncthing")).toBe(true);
    expect(check.signals.some((s) => s.rule === "unchecked")).toBe(true);
  });

  test("a SyncTargets value the walk cuts short leaves the folder unchecked, never local", async () => {
    // A UTF-16 mirror root nested deeper than the walk's 8 levels: the text search reads UTF-8
    // only, so it is not found, and a folder under it would pass as local (review round 3,
    // finding 8).
    let deep = field(3, Buffer.from("D:\\deep-mirror", "utf16le"));
    for (let i = 0; i < 10; i += 1) deep = field(1, deep);
    expect(driveFsPaths(deep.toString("base64"))).not.toContain("D:\\deep-mirror");
    // Past the field budget: the same.
    const many = field(
      1,
      Buffer.concat(Array.from({ length: 100_001 }, () => field(1, Buffer.from([0x0a, 0x00])))),
    );
    const root = tree();
    for (const value of [deep, many]) {
      const check = await checkFolder(
        dir(join(root, "Tasks", "mira")),
        fixtureHost(root, {
          platform: "win32",
          windows: { ...NO_WINDOWS, driveFsTargets: value.toString("base64") },
        }),
      );
      expect(check.verdict).toBe("synced");
      expect(check.signals.some((s) => s.rule === "unchecked")).toBe(true);
      expect(folderMessage(check)).toContain("could not be checked");
    }
    // A value read whole is no reason: the folder outside its roots is local. (Off Windows the
    // tree's real path is no drive path, so the folder stands on a fixture drive Q:.)
    const space = dir(join(root, "Tasks", "mira"));
    const whole = await checkFolder(
      space,
      fixtureHost(root, {
        platform: "win32",
        ...(WINDOWS
          ? {}
          : { realpath: (p: string) => (resolve(p) === space ? "Q:\\Tasks\\mira" : undefined) }),
        windows: {
          ...NO_WINDOWS,
          drives: [{ root: "Q:\\", type: "Fixed", label: "", format: "NTFS" }],
          driveFsTargets: syncTargets(["D:\\mirror"], true),
        },
      }),
    );
    expect(whole.verdict).toBe("local");
  });

  test("a folder on a drive the Windows facts do not list gets one fresh run, then is unchecked if it is still not listed", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    // The folder's real path is on Q:, a drive the kept answer may not list yet.
    const onQ = (p: string): string | undefined =>
      resolve(p) === space ? "Q:\\Tasks\\mira" : undefined;
    const q = { root: "Q:\\", type: "Fixed", label: "", format: "NTFS" };
    const judge = async (answers: (typeof NO_WINDOWS)[]) => {
      const asked: boolean[] = [];
      const host = {
        ...fixtureHost(root, { platform: "win32", realpath: onQ }),
        windowsFacts: (fresh?: boolean) => {
          asked.push(fresh === true);
          return Promise.resolve(answers.shift());
        },
      };
      const check = await checkFolder(space, host);
      return {
        verdict: check.verdict,
        unchecked: check.signals.some((s) => s.rule === "unchecked"),
        asked,
      };
    };
    // Listed by the kept answer: judged at once.
    expect(await judge([{ ...NO_WINDOWS, drives: [q] }])).toEqual({
      verdict: "local",
      unchecked: false,
      asked: [false],
    });
    // Listed only by the fresh run: judged by it.
    expect(await judge([NO_WINDOWS, { ...NO_WINDOWS, drives: [q] }])).toEqual({
      verdict: "local",
      unchecked: false,
      asked: [false, true],
    });
    // Labelled Google Drive in the fresh run: synced.
    const labelled = { ...q, format: "FAT32", label: "Google Drive" };
    expect((await judge([NO_WINDOWS, { ...NO_WINDOWS, drives: [labelled] }])).verdict).toBe(
      "synced",
    );
    // Still not listed: its type and label were not seen, so unchecked, never local.
    expect(await judge([NO_WINDOWS, NO_WINDOWS])).toEqual({
      verdict: "synced",
      unchecked: true,
      asked: [false, true],
    });
  });

  test("the fixture host never looks outside its tree", async () => {
    const root = tree();
    const host = fixtureHost(root);
    expect(await host.exists(join(root, "..", "anything"))).toBe(false);
    expect(await host.kind(resolve(root, ".."))).toBe("absent");
    expect(await host.list(resolve(root, ".."))).toEqual([]);
    expect(await host.realpath(sep)).toBeUndefined();
  });
});

/** The platforms the check has a volume step for. */
const PLATFORMS = ["win32", "linux", "darwin"] as const;
type Platform = (typeof PLATFORMS)[number];

/** A local fixed drive Q:, where the Windows runs of these tests put the folder's real path. */
const Q = { root: "Q:\\", type: "Fixed", label: "", format: "NTFS" };

/**
 * Facts under which the fixture folder `space` is local on `platform`, on any OS: its real path is
 * one that platform writes (on Q: for Windows, ext4 on Linux, APFS on macOS).
 */
function localOn(platform: Platform, space: string): SyncFacts {
  const real = {
    win32: "Q:\\Tasks\\mira",
    linux: "/srv/tasks/mira",
    darwin: "/Users/fixture/Tasks/mira",
  }[platform];
  return {
    platform,
    realpath: (p) => (resolve(p) === space ? real : undefined),
    ...(platform === "win32" ? { windows: { ...NO_WINDOWS, drives: [Q] } } : {}),
  };
}

/** The steps a check did not complete, in order. */
const unseenSteps = (check: FolderCheck): (string | undefined)[] =>
  check.signals.filter((s) => s.rule === "unchecked").map((s) => s.step);

/** The host's looks (every function it has), so a look added to SyncHost is covered too. */
const looksOf = (host: SyncHost): string[] =>
  Object.keys(host).filter((k) => typeof host[k as keyof SyncHost] === "function");

/** `host` with the look `name` replaced by `fake`, and a record of whether the check called it. */
function withLook(
  host: SyncHost,
  name: string,
  fake: () => Promise<never>,
): { host: SyncHost; called: () => boolean } {
  let called = false;
  const look = (): Promise<never> => {
    called = true;
    return fake();
  };
  return { host: { ...host, [name]: look }, called: () => called };
}

describe("[A1.5.sync.fails-closed] local only from positive evidence of every step: a look that fails, answers a default, answers something unexpected or hangs leaves the folder unchecked", () => {
  test("every platform's check answers local on the fixture's facts, so the cases below are not local only for their own reason", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    for (const platform of PLATFORMS) {
      const check = await checkFolder(space, fixtureHost(root, localOn(platform, space)));
      expect(check.verdict, platform).toBe("local");
      expect(check.signals, platform).toEqual([]);
    }
  });

  test("a look of the host that fails, any look on any platform, leaves the folder unchecked, never local", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    const calledSomewhere = new Set<string>();
    for (const platform of PLATFORMS) {
      const host = fixtureHost(root, localOn(platform, space));
      for (const name of looksOf(host)) {
        const faulty = withLook(host, name, () => Promise.reject(new Error("a failed look")));
        const check = await checkFolder(space, faulty.host);
        if (!faulty.called()) continue;
        calledSomewhere.add(name);
        expect(check.verdict, `${platform} ${name}`).not.toBe("local");
        expect(unseenSteps(check).length, `${platform} ${name}`).toBeGreaterThan(0);
      }
    }
    // Every look is made on some platform: none is left out of this test.
    expect([...calledSomewhere].sort()).toEqual(looksOf(fixtureHost(root)).sort());
  });

  test("a look that never answers leaves the folder unchecked once the check's bound has passed", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    for (const platform of PLATFORMS) {
      const host = fixtureHost(root, localOn(platform, space));
      for (const name of looksOf(host)) {
        const hanging = withLook(host, name, () => new Promise<never>(() => undefined));
        // Any bound: a check that waits on a look that never answers cannot end before it.
        const check = await checkFolder(space, hanging.host, 50);
        if (!hanging.called()) continue;
        expect(check.verdict, `${platform} ${name}`).not.toBe("local");
        expect(unseenSteps(check), `${platform} ${name}`).toContain("check");
      }
    }
  });

  test("a real path that cannot be resolved is never replaced by the path as given (finding: a junction into a share judged by the local drive's facts)", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    for (const platform of PLATFORMS) {
      const facts = localOn(platform, space);
      // The folder exists, and its resolution fails or answers nothing.
      for (const realpath of [
        () => Promise.reject(new Error("GetFinalPathNameByHandle failed")),
        () => Promise.resolve(undefined),
      ]) {
        const check = await checkFolder(space, { ...fixtureHost(root, facts), realpath });
        expect(check.verdict, platform).toBe("synced");
        expect(unseenSteps(check), platform).toContain("real_path");
        expect(folderMessage(check), platform).toContain("could not be checked");
      }
    }
    if (WINDOWS) {
      // The path as given is on a network drive: a network signal still holds without the real path.
      const drive = space.slice(0, 3);
      const check = await checkFolder(space, {
        ...fixtureHost(root, {
          windows: {
            ...NO_WINDOWS,
            drives: [{ root: drive, type: "Network", label: "", format: "" }],
          },
        }),
        realpath: () => Promise.reject(new Error("GetFinalPathNameByHandle failed")),
      });
      expect(check).toMatchObject({ verdict: "network", fs: "remote_drive" });
    }
  });

  test("Windows: the volume that holds the folder must be its drive's own volume, and a real path must be a drive or UNC path", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    const facts = localOn("win32", space);
    // Another volume mounted in a folder of Q: holds the folder: its type and format were not seen.
    const mounted = await checkFolder(
      space,
      fixtureHost(root, {
        ...facts,
        volume: (p) => (p === "Q:\\" ? "q-volume" : "mounted-volume"),
      }),
    );
    expect(mounted.verdict).toBe("synced");
    expect(unseenSteps(mounted)).toEqual(["volume"]);
    // A real path that is neither a drive path nor a UNC path: a volume or device path.
    for (const real of ["\\\\?\\Volume{0-1}\\Tasks\\mira", "Volume{0-1}\\Tasks\\mira"]) {
      const check = await checkFolder(
        space,
        fixtureHost(root, { ...facts, realpath: (p) => (resolve(p) === space ? real : undefined) }),
      );
      expect(unseenSteps(check), real).toEqual(["volume"]);
    }
  });

  test("Windows: a drive whose type the system could not determine, or whose file system the check does not know, is not local", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    for (const [type, format] of [
      ["Unknown", "NTFS"],
      ["NoRootDirectory", ""],
      ["Fixed", "FUSE-rclone"],
    ] as const) {
      const check = await checkFolder(
        space,
        fixtureHost(root, {
          ...localOn("win32", space),
          windows: { ...NO_WINDOWS, drives: [{ ...Q, type, format }] },
        }),
      );
      expect(check.verdict, type).toBe("synced");
      expect(unseenSteps(check), type).toEqual(["volume"]);
    }
  });

  test("Linux and macOS: a file system the check does not know is not local; no other platform has a volume step", async () => {
    const root = tree();
    const space = dir(join(root, "Tasks", "mira"));
    // eCryptfs: stacked on a folder that may be anywhere.
    const ecryptfs = await checkFolder(
      space,
      fixtureHost(root, { ...localOn("linux", space), statfs: 0xf15f }),
    );
    expect(unseenSteps(ecryptfs)).toEqual(["volume"]);
    const autofs = await checkFolder(
      space,
      fixtureHost(root, {
        ...localOn("darwin", space),
        mounts: "map auto_home on / (autofs, automounted)\n",
      }),
    );
    expect(unseenSteps(autofs)).toEqual(["volume"]);
    const other = await checkFolder(space, fixtureHost(root, { platform: "freebsd" }));
    expect(unseenSteps(other)).toEqual(["volume"]);
  });

  test("the folder: a name on its way that is no folder, or no folder at all up to the root, leaves it unchecked", async () => {
    const root = tree();
    // A file where a folder above the space would be.
    writeFileSync(join(dir(join(root, "Tasks")), "file"), "");
    const below = await checkFolder(join(root, "Tasks", "file", "mira"), fixtureHost(root));
    expect(unseenSteps(below)).toEqual(expect.arrayContaining(["folder"]));
    expect(below.verdict).toBe("synced");
    // A link whose target is gone: it may have led anywhere.
    const target = dir(join(root, "gone"));
    symlinkSync(target, join(root, "Tasks", "link"), WINDOWS ? "junction" : "dir");
    rmSync(target, { recursive: true });
    const dangling = await checkFolder(join(root, "Tasks", "link", "mira"), fixtureHost(root));
    expect(unseenSteps(dangling)).toEqual(expect.arrayContaining(["folder"]));
    // Nothing exists at all, not even the root.
    const nothing = await checkFolder(join(root, "Tasks", "mira"), {
      ...fixtureHost(root),
      kind: () => Promise.resolve("absent"),
    });
    expect(unseenSteps(nothing)).toEqual(expect.arrayContaining(["folder"]));
    expect(nothing.verdict).toBe("synced");
  });

  test("Dropbox's info.json that is not what Dropbox writes, and a sync client's root whose real path fails, leave the folder unchecked", async () => {
    const root = tree();
    const home = dir(join(root, "home"));
    const space = dir(join(root, "Tasks", "mira"));
    const info = join(dir(join(home, ".dropbox")), "info.json");
    const facts = { ...localOn("linux", space), home };
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ personal: { host: 1 } }),
      JSON.stringify({ personal: "x" }),
      Buffer.from([0x7b, 0xff, 0x7d]),
      `{"personal": {"path": "${"x".repeat(70_000)}"}}`,
    ]) {
      writeFileSync(info, bad);
      const check = await checkFolder(space, fixtureHost(root, facts));
      expect(unseenSteps(check), String(bad).slice(0, 20)).toEqual(["sync_clients"]);
    }
    // What Dropbox writes: read, and the folder outside its root is local.
    writeFileSync(info, JSON.stringify({ personal: { path: join(root, "Dropbox"), host: 1 } }));
    expect((await checkFolder(space, fixtureHost(root, facts))).verdict).toBe("local");
    // A root whose real path cannot be read: the folder may be under it by another name.
    const host = fixtureHost(root, facts);
    const check = await checkFolder(space, {
      ...host,
      realpath: (p) =>
        resolve(p) === join(root, "Dropbox")
          ? Promise.reject(new Error("a failed look"))
          : host.realpath(p),
    });
    expect(unseenSteps(check)).toEqual(["sync_clients"]);
  });
});

interface Sample {
  readonly source: string;
  readonly fstype: string;
  readonly statfs_type: string;
  readonly expect: string;
}

interface Samples {
  readonly linux: readonly Sample[];
  readonly windows: readonly {
    readonly source: string;
    readonly realpath: string;
    readonly drive_type: string;
    readonly format: string;
    readonly expect: string;
  }[];
  readonly macos: readonly {
    readonly source: string;
    readonly mount: string;
    readonly path: string;
    readonly expect: string;
  }[];
}

describe("[A1.5.sync.statfs] network types from captured statfs samples", () => {
  const samples = JSON.parse(readFileSync(SAMPLES, "utf8")) as Samples;

  test("Linux: each sample's statfs type, and FUSE's mount table type", () => {
    expect(samples.linux.length).toBeGreaterThan(10);
    for (const sample of samples.linux) {
      const type = Number.parseInt(sample.statfs_type, 16);
      const mounts = `36 25 0:32 / /fixture rw,relatime shared:1 - ${sample.fstype} fixture rw\n`;
      const found = word(linuxVolume(type, mounts, "/fixture/spaces/mira"));
      expect(found, `${sample.fstype} (${sample.source})`).toBe(sample.expect);
    }
    // FUSE: a network subtype is network, fuseblk local, any other subtype unchecked, and so is a
    // FUSE path the table does not list or a table that is not there.
    const fuse = (type: string, path = "/m/mira") =>
      word(
        linuxVolume(
          0x65735546,
          `1 2 0:1 / / rw - ext4 x rw\n3 4 0:2 / /m rw - ${type} x rw\n`,
          path,
        ),
      );
    expect(fuse("fuse.sshfs")).toBe("fuse.sshfs");
    expect(fuse("fuse.rclone")).toBe("fuse.rclone");
    expect(fuse("fuseblk")).toBe("local");
    expect(fuse("fuse.portal")).toBe("unchecked");
    expect(fuse("fuse")).toBe("unchecked");
    expect(fuse("fuse.sshfs", "/elsewhere/mira")).toBe("unchecked");
    expect(word(linuxVolume(0x65735546, undefined, "/m/mira"))).toBe("unchecked");
    // The longest mount point holds the path, and a mount point with a space is read as the
    // kernel escapes it.
    const nested = "1 2 0:1 / / rw - ext4 x rw\n3 4 0:2 / /my\\040net rw - fuse.sshfs h:/x rw\n";
    expect(word(linuxVolume(0x65735546, nested, "/my net/spaces/mira"))).toBe("fuse.sshfs");
    expect(word(linuxVolume(0x65735546, nested, "/home/mira"))).toBe("unchecked");
  });

  test("Windows: a mapped network drive's real path, and the drive's type and format", () => {
    expect(samples.windows.length).toBeGreaterThan(0);
    const facts = (root: string, type: string, format: string) => ({
      ...NO_WINDOWS,
      drives: [{ root, type, label: "", format }],
    });
    for (const sample of samples.windows) {
      const letter = /^([A-Z]):/.exec(sample.realpath)?.[1] ?? "W";
      const drive = facts(`${letter}:\\`, sample.drive_type, sample.format);
      expect(word(windowsVolume(sample.realpath, drive)), sample.source).toBe(sample.expect);
      expect(
        word(windowsVolume("Z:\\spaces\\mira", facts("Z:\\", sample.drive_type, sample.format))),
        sample.source,
      ).toBe(sample.drive_type === "Network" ? "remote_drive" : "local");
    }
    // A drive the facts do not list, a type the system could not determine, a file system the
    // check does not know: unchecked, whatever the drive's readiness said.
    const at = "C:\\Users\\fixture\\Tasks\\mira";
    expect(word(windowsVolume(at, NO_WINDOWS))).toBe("unchecked");
    for (const [type, format] of [
      ["Unknown", "NTFS"],
      ["NoRootDirectory", "NTFS"],
      ["Fixed", "FUSE-rclone"],
      ["Fixed", ""],
    ] as const) {
      expect(word(windowsVolume(at, facts("C:\\", type, format))), `${type} ${format}`).toBe(
        "unchecked",
      );
    }
    for (const type of ["Fixed", "Removable", "CDRom", "Ram"]) {
      expect(word(windowsVolume(at, facts("C:\\", type, "NTFS"))), type).toBe("local");
    }
    // Device, extended and volume paths are no shares, and no drive path either.
    const c = facts("C:\\", "Fixed", "NTFS");
    for (const path of ["\\\\?\\C:\\x", "\\\\.\\pipe\\x", "Volume{0-1}\\x", "C:x", "x"]) {
      expect(word(windowsVolume(path, c)), path).toBe("unchecked");
    }
  });

  test("macOS: the mount table's type", () => {
    for (const sample of samples.macos) {
      expect(word(macVolume(sample.mount, sample.path)), sample.source).toBe(sample.expect);
    }
    // A type the check does not know, and a path the table does not hold: unchecked.
    expect(word(macVolume("map auto_home on /home (autofs, automounted)\n", "/home/x"))).toBe(
      "unchecked",
    );
    expect(word(macVolume("/dev/disk4 on /Volumes/x (apfs, local)\n", "/Users/x"))).toBe(
      "unchecked",
    );
  });

  test("the Windows facts the PowerShell run writes, read back field by field", () => {
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
    const output = (...lines: string[]): string => [...lines, "end"].join("\n");
    const out = output(
      `drive ${b64("C:\\")} ${b64("Fixed")} ${b64("NTFS")} ${b64("Fixture")}`,
      `drive ${b64("G:\\")} ${b64("Fixed")} ${b64("FAT32")} ${b64("Google Drive")}`,
      `drive ${b64("Z:\\")} ${b64("Network")} ${b64("")} ${b64("")}`,
      `onedrive ${b64("C:\\Users\\fixture\\OneDrive – Lumen")}`,
      `root ${b64("OneDrive!S-1-5-21-1!Personal")} ${b64("C:\\Users\\fixture\\OneDrive")}`,
      `drivefs ${syncTargets(["D:\\Google Drive"])}`,
    );
    const facts = parseWindowsFacts(`${out}\r\n`);
    expect(facts?.oneDriveAccounts).toEqual(["C:\\Users\\fixture\\OneDrive – Lumen"]);
    expect(facts?.syncRoots).toEqual([
      { id: "OneDrive!S-1-5-21-1!Personal", path: "C:\\Users\\fixture\\OneDrive" },
    ]);
    expect(facts?.drives[1]).toEqual({
      root: "G:\\",
      type: "Fixed",
      format: "FAT32",
      label: "Google Drive",
    });
    expect(facts?.drives[2]).toEqual({ root: "Z:\\", type: "Network", format: "", label: "" });
    expect(driveFsPaths(facts?.driveFsTargets ?? "")).toEqual(["D:\\Google Drive"]);
    // A machine with none of them: only the drives, and the end.
    expect(
      parseWindowsFacts(output(`drive ${b64("C:\\")} ${b64("Fixed")} ${b64("NTFS")} ${b64("")}`)),
    ).toEqual({
      oneDriveAccounts: [],
      syncRoots: [],
      driveFsTargets: "",
      drives: [{ root: "C:\\", type: "Fixed", format: "NTFS", label: "" }],
    });
    // Each field is its exact text: a leading U+FEFF is part of it, not a byte order mark.
    expect(parseWindowsFacts(output(`onedrive ${b64("\uFEFFC:\\x")}`))?.oneDriveAccounts).toEqual([
      "\uFEFFC:\\x",
    ]);
    // Anything else is no facts, so the folder is unchecked, never local.
    for (const bad of [
      "not the run's output",
      // Cut off before its end.
      `drive ${b64("C:\\")} ${b64("Fixed")} ${b64("NTFS")} ${b64("")}`,
      output(`drive ${b64("C:\\")} ${b64("Fixed")} ${b64("NTFS")}`),
      output(`onedrive ${b64("C:\\x")} ${b64("C:\\y")}`),
      output(`mount ${b64("C:\\x")}`),
      output(`onedrive C:\\Users\\fixture\\OneDrive`),
      output(`drivefs not*base64`),
      // Base64, but not UTF-8.
      output(`onedrive ${Buffer.from([0xff, 0xfe, 0x00]).toString("base64")}`),
    ]) {
      expect(parseWindowsFacts(bad), bad).toBeUndefined();
    }
  });
});
