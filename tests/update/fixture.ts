// Fixture installs and releases for the updater's tests (A7 3.13 M6.12): small version folders with
// a manifest (nothing in them runs), installed by the install switch itself into a temporary
// root, and releases of them signed with throwaway keys made here. A stand-in service and a
// stand-in self-test record what the updater asked. The platform is a parameter, so the Windows
// switch (a `current` text file, copies of the launchers in bin) runs on Linux too. Tests only.
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import type { HostFacts } from "../../packages/service/src/hub/paths.ts";
import { writeVersionManifest } from "../../packages/service/src/version/folder.ts";
import { finishInstall } from "../../packages/service/src/version/install.ts";
import { archiveName, type Platform } from "../../packages/service/src/version/release.ts";
import { currentVersion } from "../../packages/service/src/version/switch.ts";
import type { HeldRun, RunsHold } from "../../packages/service/src/install/context.ts";
import type {
  RunningService,
  SelfTest,
  ServiceControl,
} from "../../packages/service/src/version/update.ts";
import { writeTarGz, writeZip, type FileEntry } from "../../scripts/build/archive.ts";
import { opensshPublicKey, signSums, writeSums } from "../../scripts/build/signing.ts";

export const windows = process.platform === "win32";

/** A folder of the test's own, removed by its full name. */
export function scratch(label: string): { dir: string; remove: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `tasks-upd-${label}-`)));
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export const throwawayKey = (): KeyObject => generateKeyPairSync("ed25519").privateKey;
export const keyLine = (key: KeyObject): string => opensshPublicKey(createPublicKey(key));

/** The platform name of a fixture's OS. */
export const platformName = (os: NodeJS.Platform): Platform =>
  os === "win32" ? "win-x64" : "linux-x64";

/** A fixture version folder's files: launchers that only say which version they are. */
export function fixtureFiles(
  version: string,
  os: NodeJS.Platform,
  launcher = version,
): FileEntry[] {
  const text = (s: string) => Buffer.from(s);
  const bins: FileEntry[] =
    os === "win32"
      ? [
          {
            path: `bin/${PRODUCT_ID}.exe`,
            data: text(`console launcher ${launcher}`),
            mode: 0o755,
          },
          { path: `bin/${PRODUCT_ID}w.exe`, data: text(`gui launcher ${launcher}`), mode: 0o755 },
        ]
      : [{ path: `bin/${PRODUCT_ID}`, data: text(`#!/bin/sh\n# ${launcher}\n`), mode: 0o755 }];
  return [
    ...bins,
    { path: `lib/${PRODUCT_ID}.mjs`, data: text(`// fixture entry ${version}\n`), mode: 0o644 },
    { path: "lib/chunks/cli.mjs", data: text(`// fixture chunk ${version}\n`), mode: 0o644 },
  ];
}

/** Writes a version folder of `files` and its manifest.json. Returns the manifest's bytes. */
export function writeFolder(
  folder: string,
  version: string,
  os: NodeJS.Platform,
  files: readonly FileEntry[],
): Buffer {
  for (const file of files) {
    const path = join(folder, ...file.path.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.data, { mode: file.mode });
  }
  writeVersionManifest(folder, {
    version,
    build: `fixture0${version.replaceAll(".", "")}`,
    platform: platformName(os),
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? "",
    protocol: { min: 1, max: 1 },
  });
  return readFileSync(join(folder, "manifest.json"));
}

export const factsFor = (root: string, os: NodeJS.Platform, home: string): HostFacts => ({
  platform: os,
  env: { TASKS_HOME: root },
  accountHome: home,
  uid: process.getuid?.(),
});

/** A separate install at `<dir>/root` with `version` current, made by the install switch. */
export async function fixtureInstall(
  dir: string,
  os: NodeJS.Platform,
  version = "0.1.0",
): Promise<{ root: string; facts: HostFacts }> {
  const root = join(dir, "root");
  mkdirSync(join(root, "versions"), { recursive: true });
  writeFileSync(join(root, "home.marker"), "");
  const folder = join(root, "versions", version);
  writeFolder(folder, version, os, fixtureFiles(version, os));
  const facts = factsFor(root, os, dir);
  await finishInstall({
    versionFolder: folder,
    facts,
    created: [".", "versions", `versions/${version}`, "home.marker"],
  });
  return { root, facts };
}

export interface FixtureRelease {
  readonly dist: string;
  /** The archive's path. */
  readonly archive: string;
  readonly version: string;
}

/** The archive of `files` as a build writes it for `os`. */
export function packFiles(files: readonly FileEntry[], os: NodeJS.Platform, manifest: Buffer) {
  const entries = [...files, { path: "manifest.json", data: manifest, mode: 0o644 }];
  return os === "win32" ? writeZip(entries, { level: 0 }) : writeTarGz(entries, { level: 0 });
}

/**
 * A signed release of a fixture version in the new folder `dist`: the archive, SHA256SUMS and its
 * signatures by `key`. `files` replaces the version's files (a look-alike, a hostile entry).
 */
export function fixtureRelease(
  dist: string,
  version: string,
  os: NodeJS.Platform,
  key: KeyObject,
  options: { files?: readonly FileEntry[]; launcher?: string; manifest?: Buffer } = {},
): FixtureRelease {
  mkdirSync(dist, { recursive: true });
  const files = options.files ?? fixtureFiles(version, os, options.launcher);
  const manifest =
    options.manifest ??
    writeFolder(join(dist, ".folder"), version, os, fixtureFiles(version, os, options.launcher));
  rmSync(join(dist, ".folder"), { recursive: true, force: true });
  const archive = archiveName(version, platformName(os));
  writeFileSync(join(dist, archive), packFiles(files, os, manifest));
  writeSums(dist, [archive]);
  signSums(dist, key, join(dist, ".signing"));
  rmSync(join(dist, ".signing"), { recursive: true, force: true });
  return { dist, archive: join(dist, archive), version };
}

/** What `current` names in a fixture install. */
export const currentOf = (root: string, os: NodeJS.Platform): string | undefined =>
  currentVersion(root, os);

/** The raw content of `current` (a link's target, or the text file's). */
export const currentRaw = (root: string, os: NodeJS.Platform): string =>
  os === "win32"
    ? readFileSync(join(root, "current"), "utf8")
    : readlinkSync(join(root, "current"));

/** A stand-in for the service, which follows current when it is restarted. */
export class FakeControl implements ServiceControl {
  /** The version the service runs, or undefined when it is not running. */
  version: string | undefined;
  /** When true, a restart leaves the service down. */
  failRestarts = false;
  /** When set, a restart throws it (as a service command that fails does). */
  restartError: Error | undefined;
  readonly calls: string[] = [];
  readonly #root: string;
  readonly #os: NodeJS.Platform;

  constructor(root: string, os: NodeJS.Platform, running: boolean) {
    this.#root = root;
    this.#os = os;
    this.version = running ? currentVersion(root, os) : undefined;
  }

  running(): Promise<RunningService | undefined> {
    return Promise.resolve(
      this.version === undefined ? undefined : { version: this.version, manager: "manual" },
    );
  }

  restart(options: { readonly supervisorChanged: boolean }): Promise<void> {
    this.calls.push(`restart${options.supervisorChanged ? " supervisor" : ""}`);
    if (this.restartError !== undefined) {
      this.version = undefined;
      return Promise.reject(this.restartError);
    }
    this.version = this.failRestarts ? undefined : currentVersion(this.#root, this.#os);
    return Promise.resolve();
  }

  waitFor(version: string): Promise<boolean> {
    this.calls.push(`wait ${version}`);
    return Promise.resolve(this.version === version);
  }

  /** The service's background runs, when a test gives it some. */
  runs: FakeRuns | undefined;

  holdRuns(): Promise<RunsHold | undefined> {
    const runs = this.runs;
    if (runs === undefined || this.version === undefined) return Promise.resolve(undefined);
    this.calls.push("hold");
    return Promise.resolve(runs.hold(this.calls));
  }
}

/**
 * A stand-in service's runs: what blocks an update, which a test changes, and the runs that do not
 * stop in time when asked to.
 */
export class FakeRuns {
  blocking: HeldRun[];
  /** The runs left after a Stop of all. */
  stubborn: HeldRun[] = [];
  #waiters: (() => void)[] = [];

  constructor(blocking: HeldRun[]) {
    this.blocking = blocking;
  }

  /** What blocks becomes `next`, as the service would tell it. */
  set(next: HeldRun[]): void {
    this.blocking = next;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  hold(calls: string[]): RunsHold {
    const runs = this;
    return {
      blocking: () => runs.blocking,
      changed: () =>
        new Promise<void>((resolve) => {
          runs.#waiters.push(resolve);
        }),
      held: true,
      stopAll: () => {
        calls.push("stop runs");
        runs.blocking = runs.stubborn;
        return Promise.resolve(runs.stubborn);
      },
      release: () => {
        calls.push("release");
      },
    };
  }
}

/** A stand-in self-test that records the folders it was asked about. */
export function fakeSelfTest(result = true): SelfTest & { readonly folders: string[] } {
  const folders: string[] = [];
  const test = (folder: string) => {
    folders.push(folder);
    return Promise.resolve({ ok: result, failed: result ? [] : ["integrity: fixture failure"] });
  };
  return Object.assign(test, { folders });
}

/** Every entry below `dir` by path: a file's SHA-256 is replaced by its bytes' length and text. */
export function tree(dir: string, skip: (path: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (skip(path)) continue;
      if (entry.isDirectory()) {
        out.push(`${path}/`);
        walk(path);
      } else if (entry.isSymbolicLink()) {
        out.push(`${path} -> ${readlinkSync(join(dir, path))}`);
      } else {
        out.push(`${path} ${readFileSync(join(dir, path)).toString("base64")}`);
      }
    }
  };
  if (existsSync(dir)) walk("");
  return out.sort();
}
