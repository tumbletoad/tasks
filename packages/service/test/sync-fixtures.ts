// A fixture host for the synced-folder check (A1 3.2): its file looks see only one fixture tree
// (anything outside it is "not there"), so a test never reads this machine's own folders, sync
// clients or mounts; the machine's facts (environment, registry, drives, statfs, mount table) are
// fixture values or captured samples. Tests only.
import { join, resolve } from "node:path";
import { isInside, type SyncHost, type WindowsSyncFacts } from "../src/hub/sync-folders.ts";
import { realSyncHost } from "../src/hub/sync-host.ts";

/**
 * The machine's facts. Each one left out is read as found and holding nothing (no registry
 * values, ext4 everywhere, an empty mount table); `null` is a fact that cannot be read.
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
}

/** ext4's statfs type: a local file system. */
const EXT4 = 0xef53;

export const NO_WINDOWS: WindowsSyncFacts = {
  oneDriveAccounts: [],
  syncRoots: [],
  driveFsTargets: "",
  drives: [],
};

/** A host over the fixture tree `root`: real file looks inside it, nothing outside it. */
export function fixtureHost(root: string, facts: SyncFacts = {}): SyncHost {
  const platform = facts.platform ?? process.platform;
  const inside = (path: string): boolean => isInside(process.platform, resolve(path), root);
  const windows = facts.windows === null ? undefined : (facts.windows ?? NO_WINDOWS);
  const real = realSyncHost({
    platform,
    env: facts.env ?? {},
    home: facts.home ?? join(root, "home"),
    windowsFacts: () => Promise.resolve(windows),
  });
  const statfs = facts.statfs === null ? undefined : (facts.statfs ?? EXT4);
  const mounts = facts.mounts === null ? undefined : (facts.mounts ?? "");
  return {
    ...real,
    isDirectory: (path) => (inside(path) ? real.isDirectory(path) : Promise.resolve(false)),
    exists: (path) => (inside(path) ? real.exists(path) : Promise.resolve(false)),
    realpath: (path) => {
      const given = facts.realpath?.(path);
      if (given !== undefined) return Promise.resolve(given);
      return inside(path) ? real.realpath(path) : Promise.resolve(undefined);
    },
    list: (folder) => (inside(folder) ? real.list(folder) : Promise.resolve(undefined)),
    readText: (path, max) => (inside(path) ? real.readText(path, max) : Promise.resolve(undefined)),
    windowsFacts: () => Promise.resolve(windows),
    statfsType: (path) => Promise.resolve(typeof statfs === "function" ? statfs(path) : statfs),
    mountTable: () => Promise.resolve(mounts),
  };
}
