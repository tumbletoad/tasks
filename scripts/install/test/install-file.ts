// The install scripts' tests' shared part (install-*.test.ts): each file's own folder of test
// installs, the run's release in it (runVersions: built once per test run, read-only, so what a
// test changes it copies into `work` first), the canary kit, and the checks of a good install and
// of a refused download.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { PRODUCT_ID, PRODUCT_NAME } from "../../../packages/brand/src/index.ts";
import { canonicalStatePath, installId } from "../../../packages/service/src/hub/paths.ts";
import {
  fired,
  installsFolder,
  linkTarget,
  listing,
  prepareCanary,
  present,
  runInstaller,
  runVersions,
  stableCommand,
  windows,
  type Canary,
  type Ran,
  type Release,
} from "./kit.ts";

export const SLOW = 900_000;

let folders: ReturnType<typeof installsFolder>;
/** This file's own folder, and the folder its test installs' roots go in. */
export let work: string;
export let homes: string;
/** The run's version folder and its release. */
export let base: string;
export let release: Release;
export let canary: Canary;

/** Makes this file's folder, with the run's release and a canary kit, and removes it at the end. */
export function useInstallFolder(label: string): void {
  beforeAll(async () => {
    folders = installsFolder(label);
    work = folders.root;
    homes = join(work, "h");
    // User-only, whatever the umask: the installer refuses a root below a folder others can change.
    mkdirSync(homes, { mode: 0o700 });
    ({ folder: base, release } = (await runVersions()).first);
    canary = prepareCanary(join(work, "canary-kit"));
  }, SLOW);

  afterAll(() => {
    folders.remove();
  });
}

export const install = (
  options: Omit<Parameters<typeof runInstaller>[1], "within">,
  from = release,
): Ran => runInstaller(from, { ...options, within: work });

export const output = (ran: Ran): string =>
  `exit ${String(ran.status)}\n${ran.stdout}\n${ran.stderr}`;

/** A path as install.sh writes it in a command to paste: single-quoted unless it is plain. */
export const pasted = (path: string): string =>
  /^[A-Za-z0-9_./+-]+$/u.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** A good install: current, the stable command, home.marker, install.json, no leftovers. */
export function expectInstalled(root: string, ran: Ran, version = release.version): void {
  expect(ran.status, output(ran)).toBe(0);
  expect(ran.stdout).toContain(`Installed ${PRODUCT_NAME} ${version}`);
  for (const row of [
    "integrity",
    "runtime",
    "candidate-space",
    "candidate-endpoint",
    "candidate-bridge",
  ]) {
    expect(ran.stdout, row).toMatch(new RegExp(`^ok {4}${row}: `, "m"));
  }
  const current = join(root, "current");
  if (windows) expect(readFileSync(current, "utf8")).toBe(version);
  else expect(linkTarget(current)).toBe(`versions/${version}`);
  expect(existsSync(stableCommand(root))).toBe(true);
  if (windows) expect(existsSync(join(root, "bin", `${PRODUCT_ID}w.exe`))).toBe(true);
  else expect(linkTarget(stableCommand(root))).toBe(`../current/bin/${PRODUCT_ID}`);
  expect(existsSync(join(root, "home.marker"))).toBe(true);
  const leftovers = listing(join(root, "versions")).filter((p) => p.startsWith("."));
  expect(leftovers, "download or staging folders were left").toEqual([]);
  expect(present(join(root, ".install.lock")), "the install lock was left").toBe(false);
  const record = JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as {
    install_id: string;
    root: string;
    versions: string[];
    method: string;
  };
  const state = realpathSync.native(join(root, "state"));
  expect(record.install_id).toBe(installId(canonicalStatePath(state, process.platform)));
  expect(record.versions).toContain(version);
  expect(record.method).toBe("script");
}

/** A refused download: the reason, nothing ran, and the root's parent exactly as it was. */
export function expectRefused(
  ran: Ran,
  reason: RegExp,
  parentBefore: string[],
  parent: string,
): void {
  expect(fired(canary), `a stand-in ran: ${output(ran)}`).toEqual([]);
  expect(ran.status, output(ran)).not.toBe(0);
  expect(ran.stderr).toMatch(reason);
  expect(listing(parent)).toEqual(parentBefore);
}
