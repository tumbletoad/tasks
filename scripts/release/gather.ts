// The archives of one release, gathered from the build jobs' artifacts into one folder to sign.
// Each build job uploads its platform's archive with the SHA256SUMS it wrote over it; an archive
// is taken only when its bytes match that line, so the bytes signed are the bytes the build
// checked. Nothing is built or changed here.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_NAME, archiveName, type Platform } from "../build/platforms.ts";
import { SUMS_FILE } from "../build/signing.ts";
import { sumsDigest } from "../../packages/service/src/version/release.ts";
import { Refusal } from "./release.ts";

/** The platforms a release ships. macOS is built by build.yml but not released yet. */
export const RELEASE_PLATFORMS: readonly Platform[] = ["linux-x64", "linux-arm64", "win-x64"];

/**
 * Copies the archives of `version` from the artifact folders in `from` whose names start with
 * `prefix` into the new folder `out`: one per platform of `platforms`, each matching the SHA256SUMS
 * of its own artifact. Returns the archive names.
 */
export function gatherArchives(options: {
  readonly from: string;
  readonly prefix: string;
  readonly out: string;
  readonly version: string;
  readonly platforms?: readonly Platform[];
}): string[] {
  const platforms = options.platforms ?? RELEASE_PLATFORMS;
  if (existsSync(options.out)) throw new Refusal(`${options.out} exists: gather makes it itself.`);
  const folders = readdirSync(options.from)
    .filter((name) => name.startsWith(options.prefix))
    .map((name) => join(options.from, name))
    .filter((path) => statSync(path).isDirectory());
  const found = new Map<string, string>();
  for (const folder of folders) {
    const sums = readFileSync(join(folder, SUMS_FILE));
    for (const name of readdirSync(folder).filter((n) => ARCHIVE_NAME.test(n))) {
      const digest = createHash("sha256")
        .update(readFileSync(join(folder, name)))
        .digest("hex");
      if (sumsDigest(sums, name) !== digest) {
        throw new Refusal(
          `${name} does not match the SHA256SUMS its build wrote. Nothing was gathered.`,
        );
      }
      if (found.has(name)) throw new Refusal(`${name} came from two builds. Nothing was gathered.`);
      found.set(name, join(folder, name));
    }
  }
  const want = platforms.map((platform) => archiveName(options.version, platform)).sort();
  const have = [...found.keys()].sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    throw new Refusal(
      `The builds gave ${have.join(", ") || "no archive"}, not ${want.join(", ")}. Nothing was gathered.`,
    );
  }
  mkdirSync(options.out, { recursive: true });
  for (const name of want) copyFileSync(found.get(name) ?? "", join(options.out, name));
  return want;
}
