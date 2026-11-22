// pnpm accept m<N> [--part <name>] [--profile <p>] [--installed <folder>] (A7 3.3, 3.18.6): runs
// the `ci` entries of tests/manifest.json that milestones M1 to M<N> own in the profile, and lists
// the `manual` ones. A part is the subset one step owns, such as `pnpm accept m1 --part cli` for
// M1.10's Verify line; the parts are listed in PARTS below.
//
// Without `--installed` a run takes the `ci` and `installed` entries, from source. With
// `--installed <root or folder>` it takes the `installed` ones (A7 3.18.6: those that also run
// against an installed build), against:
//   - an install root that an install script made (M1.14; it holds home.marker and current): its
//     current version folder, and the root itself for the tests of the install as installed,
//   - a built version folder (M1.13's `pnpm build` writes one to dist/<platform>/<version>/), or a
//     folder holding exactly one.
// The tests that start a service and `ttasks` processes lay out a test install of the version
// folder in their own temporary TTASKS_HOME and run it through its launcher
// (packages/cli/test/cli-harness.ts), so no test changes the install it was given.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseManifest, PROFILES, type ManifestEntry } from "./manifest.ts";
import { binPath, repoRoot, runNode } from "./run.ts";

/** The parts of a milestone's acceptance: the manifest IDs each one runs. */
export const PARTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  m1: {
    // M1.10's Verify line: the CLI against a real service child in a temporary TTASKS_HOME.
    cli: ["A2.3.10.cli.accept"],
    // M1.13's check that the bundles behave like the source, with --installed: the CLI's
    // acceptance, with the folder's integrity and runtime rows and `ttasks mcp` as the build's own
    // bridge through the launcher, and the space verbs, whose writes, backups and restores run in
    // the built service's storage, space-admin and maintenance workers.
    build: ["A2.3.10.cli.accept", "A2.3.10.cli.space"],
  },
  m2: {
    // M1's build part, and M2.08's launch shim from the build: `ttasks shim` through the folder's
    // launcher against the folder's own bundled service (A4 3.6.3).
    build: ["A2.3.10.cli.accept", "A2.3.10.cli.space", "A4.5.shim.installed"],
  },
  m3: {
    // M3.01's installed-build drill (A1 5, MIL-02), which repeats M1.15's with the real 0.2: an
    // `installed` entry, run with --installed against an install root (the smoke job's) or the
    // version folder `pnpm build --sign test` makes. Real 0.1 spaces are upgraded
    // only after it passes.
    migration: ["A1.5.migration.drill"],
  },
};

/** The variable that tells the test harness which built version folder to run. */
export const INSTALLED_VAR = "TTASKS_ACCEPT_INSTALLED";
/** The variable that names the install root, when `--installed` names one (M1.14). */
export const INSTALL_ROOT_VAR = "TTASKS_ACCEPT_INSTALL_ROOT";

/**
 * The version folder an install root's `current` names (A2 3.12.2): a link to versions/<v>, or on
 * Windows a text file holding <v>. Undefined when `root` is no install root.
 */
export function currentFolderOf(path: string): string | undefined {
  const root = resolve(path);
  const current = join(root, "current");
  if (!existsSync(join(root, "home.marker")) || !existsSync(current)) return undefined;
  let folder: string;
  try {
    folder = lstatSync(current).isSymbolicLink()
      ? realpathSync.native(current)
      : join(root, "versions", readFileSync(current, "utf8").trim());
  } catch {
    return undefined;
  }
  return existsSync(join(folder, "manifest.json")) ? folder : undefined;
}

/**
 * The version folder `--installed` names: the folder itself when it has a manifest.json, else the
 * one version folder inside it. Undefined when there is no single one.
 */
export function versionFolderOf(path: string): string | undefined {
  const folder = resolve(path);
  if (existsSync(join(folder, "manifest.json"))) return folder;
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return undefined;
  const inside = readdirSync(folder)
    .map((name) => join(folder, name))
    .filter((child) => existsSync(join(child, "manifest.json")));
  return inside.length === 1 ? inside[0] : undefined;
}

export interface AcceptArgs {
  readonly milestone: number;
  readonly part: string | undefined;
  readonly profile: string;
  readonly installed: string | undefined;
}

export function parseAcceptArgs(argv: readonly string[]): AcceptArgs | string {
  const [target, ...rest] = argv;
  const match = /^m([1-9][0-9]?)$/.exec(target ?? "");
  if (match === null)
    return "usage: pnpm accept m<N> [--part <name>] [--profile <p>] [--installed <folder>]";
  let part: string | undefined;
  let profile = "v1";
  let installed: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return `${String(flag)} needs a value`;
    if (flag === "--part") part = value;
    else if (flag === "--profile") profile = value;
    else if (flag === "--installed") installed = value;
    else return `unknown option ${String(flag)}`;
    i += 1;
  }
  if (!(PROFILES as readonly string[]).includes(profile)) return `unknown profile ${profile}`;
  const milestone = Number(match[1]);
  if (part !== undefined && PARTS[`m${String(milestone)}`]?.[part] === undefined) {
    return `m${String(milestone)} has no part ${part}`;
  }
  return { milestone, part, profile, installed };
}

/** The entries an acceptance run takes: owned by M1 to M<N>, in the profile, of the part. */
export function selectEntries(
  entries: readonly ManifestEntry[],
  args: AcceptArgs,
): ManifestEntry[] {
  const part =
    args.part === undefined ? undefined : PARTS[`m${String(args.milestone)}`]?.[args.part];
  return entries.filter((entry) => {
    const owner = Number(entry.owner.slice(1));
    return (
      owner >= 1 &&
      owner <= args.milestone &&
      entry.profiles.includes(args.profile) &&
      (part === undefined || part.includes(entry.id))
    );
  });
}

/**
 * The entries a run executes (A7 3.18.6): `ci` and `installed` from source, only `installed`
 * against an installed build. `manual` ones are listed, never run.
 */
export function runnable(chosen: readonly ManifestEntry[], args: AcceptArgs): ManifestEntry[] {
  return chosen.filter((e) =>
    args.installed === undefined
      ? e.kind === "ci" || e.kind === "installed"
      : e.kind === "installed",
  );
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function run(argv: readonly string[]): number {
  const args = parseAcceptArgs(argv);
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }
  if (args.installed !== undefined) {
    const current = currentFolderOf(args.installed);
    const folder = current ?? versionFolderOf(args.installed);
    if (folder === undefined) {
      console.error(
        "--installed names no install root (home.marker and current) and no version folder (manifest.json).",
      );
      return 2;
    }
    if (current !== undefined) {
      console.log(`against the install at ${resolve(args.installed)}, version folder ${folder}`);
      process.env[INSTALL_ROOT_VAR] = resolve(args.installed);
    } else {
      console.log(`against the built version folder ${folder}`);
    }
    process.env[INSTALLED_VAR] = folder;
  }
  const { entries, errors } = parseManifest(
    JSON.parse(readFileSync(join(repoRoot, "tests", "manifest.json"), "utf8")) as unknown,
  );
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    return 1;
  }
  const chosen = selectEntries(entries, args);
  const ci = runnable(chosen, args);
  const manual = chosen.filter((e) => e.kind === "manual");
  for (const entry of manual) console.log(`manual, open: ${entry.id} ${entry.title}`);
  if (ci.length === 0) {
    console.log("no ci entries to run");
    return 0;
  }
  console.log(`running ${String(ci.length)} entries: ${ci.map((e) => e.id).join(", ")}`);
  const pattern = `\\[(${ci.map((e) => escape(e.id)).join("|")})\\]`;
  const result = runNode(binPath("vitest", "vitest"), [
    "run",
    "--project",
    "product",
    "--testNamePattern",
    pattern,
  ]);
  return result.status ?? 1;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
