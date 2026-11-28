// A test install around a built version folder, laid out by hand in a
// temporary folder: the build's runtime gate and `pnpm accept --installed` run the build through
// its launchers in it, as real processes, with the install root as TTASKS_HOME (it holds
// home.marker, so the launchers set TTASKS_HOME to it). Install itself is the install scripts'; this is only the
// layout, never the user's install, PATH or registry.
//
//   <root>/versions/<v>/   the version folder, its files hard-linked (copied where a link fails)
//   <root>/current         a symlink to versions/<v> (Linux, macOS), a text file "<v>" (Windows)
//   <root>/bin/ttasks       a symlink to ../current/bin/ttasks (Linux, macOS)
//   <root>/bin/ttasks.exe, ttasksw.exe   copies of the version's launchers (Windows)
//   <root>/home.marker
//
// The version folder's files are hard links: nothing a test runs may write into versions/.
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface TestInstall {
  readonly root: string;
  readonly version: string;
  readonly versionFolder: string;
  /** The stable launcher: `<root>/bin/ttasks`, or `<root>\bin\ttasks.exe`. */
  readonly launcher: string;
  /** The version-local launcher: `<root>/versions/<v>/bin/ttasks(.exe)`. */
  readonly versionLauncher: string;
}

function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) linkTree(source, target);
    else if (entry.isFile()) {
      try {
        linkSync(source, target);
      } catch {
        copyFileSync(source, target);
        chmodSync(target, statSync(source).mode & 0o777);
      }
    } else throw new Error(`not a plain file in a version folder: ${source}`);
  }
}

/** Lays out a test install of `versionFolder` at `root`, which must be a new or empty folder. */
export function layoutTestInstall(
  versionFolder: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): TestInstall {
  const manifest = JSON.parse(readFileSync(join(versionFolder, "manifest.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  const name = String(manifest.name);
  const version = String(manifest.version);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version))
    throw new Error("no version in manifest.json");
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0) throw new Error(`${root} is not empty`);
  const target = join(root, "versions", version);
  linkTree(versionFolder, target);
  writeFileSync(join(root, "home.marker"), "");
  mkdirSync(join(root, "bin"));
  const windows = platform === "win32";
  if (windows) {
    writeFileSync(join(root, "current"), version);
    for (const exe of [`${name}.exe`, `${name}w.exe`]) {
      copyFileSync(join(target, "bin", exe), join(root, "bin", exe));
    }
  } else {
    symlinkSync(`versions/${version}`, join(root, "current"));
    symlinkSync(`../current/bin/${name}`, join(root, "bin", name));
  }
  const exe = windows ? `${name}.exe` : name;
  return {
    root,
    version,
    versionFolder: target,
    launcher: join(root, "bin", exe),
    versionLauncher: join(target, "bin", exe),
  };
}
