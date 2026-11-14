// Offline fixtures for the packaging tests. The packaged runtime is the Node that runs the tests:
// the official 26.13.1 binary that pnpm downloaded and checked against pnpm-lock.yaml. Nothing
// here touches the network, and everything lives in a temporary folder.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Launchers, compileLaunchers } from "../src/msvc.ts";
import { loadPin } from "../src/node-runtime.ts";
import {
  deleteKey,
  generateThrowawayKey,
  type SignedRelease,
  signRelease,
} from "../src/release.ts";
import {
  archiveName,
  assembleVersionFolder,
  hostPlatform,
  packVersionFolder,
  type Platform,
} from "../src/version-folder.ts";

export const VERSION = "0.0.0-spike";

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `tasks-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function requireHostPlatform(): Platform {
  const platform = hostPlatform();
  if (platform === undefined) {
    throw new Error(`the packaging spike builds for linux-x64 and win-x64, not this host`);
  }
  return platform;
}

let launchers: Launchers | undefined;

/** The Windows launchers, compiled once per test file into `work`. */
export function testLaunchers(work: string): Launchers {
  launchers ??= compileLaunchers(join(work, "launchers"));
  return launchers;
}

/** Assembles a version folder for the host platform with the running Node as its runtime. */
export function assembleWithDevRuntime(work: string, out: string): Platform {
  const platform = requireHostPlatform();
  const pin = loadPin();
  const license = join(work, "node-license.txt");
  writeFileSync(license, "Stand-in for Node's licence in the offline tests.\n");
  assembleVersionFolder(out, {
    version: VERSION,
    build: "test",
    platform,
    node: { version: pin.version, sqlite: pin.sqlite, binary: process.execPath, license },
    ...(platform === "win-x64" ? { launchers: testLaunchers(work) } : {}),
  });
  return platform;
}

export interface FixtureRelease {
  platform: Platform;
  dist: string;
  archive: string;
  signed: SignedRelease;
  installer: string;
}

/**
 * A signed release in `<work>/dist`: the archive (stored, not compressed, to keep tests quick),
 * SHA256SUMS, SHA256SUMS.sshsig from a throwaway key and the rendered install script.
 */
export function buildFixtureRelease(work: string): FixtureRelease {
  const stage = join(work, "stage", VERSION);
  const platform = assembleWithDevRuntime(work, stage);
  const dist = join(work, "dist");
  const archive = packVersionFolder(stage, platform, join(dist, archiveName(VERSION, platform)), 0);
  const key = generateThrowawayKey(tempDirIn(work, "key"));
  try {
    const signed = signRelease(dist, key);
    const installer = signed.installers[0];
    if (installer === undefined) throw new Error("no install script rendered");
    return { platform, dist, archive, signed, installer };
  } finally {
    deleteKey(key);
  }
}

function tempDirIn(parent: string, label: string): string {
  return mkdtempSync(join(parent, `${label}-`));
}
