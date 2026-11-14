// A fixture host for the synced-folder check (A1 3.2): its file looks see only one fixture tree
// (anything outside it is "not there"), so a test never reads this machine's own folders, sync
// clients or mounts; the machine's facts (environment, registry, drives, volumes, statfs, mount
// table) are fixture values or captured samples. Tests only.
import { join, resolve } from "node:path";
import { isInside, type SyncHost, type WindowsSyncFacts } from "../src/hub/sync-folders.ts";
import { realSyncHost } from "../src/hub/sync-host.ts";

/**
 * The machine's facts. Each one left out is read as found and holding nothing (no registry
 * values, ext4 everywhere, one volume, one ext4 file system at / on Linux and APFS at / on macOS);
 * `null` is a fact that cannot be read.
 */
export interface SyncFacts {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string>;
  windows?: WindowsSyncFacts | null;
  /** The statfs type of every path, or per path. */
  statfs?: number | null | ((path: string) => number | undefined);
  mounts?: string | null;
  /** A real path to report for a path, in place of the file system's. */
  realpath?: (path: string) => string | undefined;
  /**
   * The identity of the volume that holds a path (default: one volume for every path). A listed
   * local drive without its own `volume` gets this one's for its root, as the real host reads it
   * right after the facts; `null`: no identity can be read.
   */
  volume?: null | ((path: string) => string);
}

/** ext4's statfs type: a local file system. */
const EXT4 = 0xef53;

/** macOS's mount table on a machine whose every folder is on its APFS system volume. */
const MAC_MOUNTS = "/dev/disk3s1 on / (apfs, local, journaled)\n";

/** Linux's mount table on a machine whose every folder is on one ext4 file system. */
export const LINUX_MOUNTS = "1 0 8:1 / / rw,relatime shared:1 - ext4 /dev/fixture rw\n";

export const NO_WINDOWS: WindowsSyncFacts = {
  oneDriveAccounts: [],
  syncRoots: [],
  driveFsTargets: "",
  drives: [],
};

/**
 * The facts with the fixture tree's own drive among the drives, when the tree is on a drive letter
 * they do not list: a local fixed drive, as a temporary folder's is. A folder on a drive the facts
 * do not list is unchecked (A1 3.2), and the tree is on a real drive of this machine.
 */
function withTreeDrive(facts: WindowsSyncFacts, root: string): WindowsSyncFacts {
  const letter = /^([A-Za-z]):/.exec(root)?.[1]?.toUpperCase();
  const listed = (d: { root: string }): boolean =>
    /^[A-Za-z]:\\$/.test(d.root) && d.root[0]?.toUpperCase() === letter;
  if (letter === undefined || facts.drives.some(listed)) return facts;
  const drive = { root: `${letter}:\\`, type: "Fixed", format: "NTFS", label: "" };
  return { ...facts, drives: [...facts.drives, drive] };
}

const fails = (what: string): Promise<never> => Promise.reject(new Error(`${what} cannot be read`));

/** A host over the fixture tree `root`: real file looks inside it, nothing outside it. */
export function fixtureHost(root: string, facts: SyncFacts = {}): SyncHost {
  const platform = facts.platform ?? process.platform;
  const inside = (path: string): boolean => isInside(process.platform, resolve(path), root);
  const volume = facts.volume === undefined ? () => "fixture-volume" : facts.volume;
  const listed =
    facts.windows === null ? undefined : withTreeDrive(facts.windows ?? NO_WINDOWS, root);
  const windows =
    listed === undefined || volume === null
      ? listed
      : {
          ...listed,
          drives: listed.drives.map((d) =>
            d.type === "Network" || d.volume !== undefined ? d : { ...d, volume: volume(d.root) },
          ),
        };
  const real = realSyncHost({
    platform,
    env: facts.env ?? {},
    home: facts.home ?? join(root, "home"),
    windowsFacts: () => Promise.resolve(windows),
  });
  const statfs = facts.statfs === undefined ? EXT4 : facts.statfs;
  const tables: Partial<Record<NodeJS.Platform, string>> = {
    darwin: MAC_MOUNTS,
    linux: LINUX_MOUNTS,
  };
  const mounts = facts.mounts === undefined ? (tables[platform] ?? "") : facts.mounts;
  return {
    ...real,
    kind: (path) => (inside(path) ? real.kind(path) : Promise.resolve("absent")),
    exists: (path) => (inside(path) ? real.exists(path) : Promise.resolve(false)),
    realpath: (path) => {
      const given = facts.realpath?.(path);
      if (given !== undefined) return Promise.resolve(given);
      return inside(path) ? real.realpath(path) : Promise.resolve(undefined);
    },
    list: (folder) => (inside(folder) ? real.list(folder) : Promise.resolve([])),
    readText: (path, max) => (inside(path) ? real.readText(path, max) : Promise.resolve(undefined)),
    volumeOf: (path) => (volume === null ? fails("the volume") : Promise.resolve(volume(path))),
    windowsFacts: () => Promise.resolve(windows),
    statfsType: (path) => {
      const type = typeof statfs === "function" ? statfs(path) : statfs;
      return type === null || type === undefined ? fails("statfs") : Promise.resolve(type);
    },
    mountTable: () => (mounts === null ? fails("the mount table") : Promise.resolve(mounts)),
  };
}
