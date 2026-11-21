// `ttasks install --finish`, spike level (A2 3.12.4 step 4 on Linux, step 5 on Windows). The
// bootstrap script runs it through this version's own launcher, and only after it has verified
// the signature, the archive hash and every file. So this is a functional hand-over, never an
// authenticity check. It
//   1. runs the runtime gate as the self-test,
//   2. points `current` at this version (a symlink swapped by rename on POSIX, a text file replaced
//      by rename on Windows),
//   3. installs the stable command: <root>/bin/ttasks -> ../current/bin/ttasks on POSIX, copies of
//      ttasks.exe and ttasksw.exe in <root>\bin\ on Windows,
//   4. writes install.json.
// Not in the spike: update.lock, the update journal, PATH changes and autostart (3.12.6, M1).
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runGate } from "./gate.mjs";

const tmpName = (/** @type {string} */ base) => `${base}.tmp-${randomBytes(4).toString("hex")}`;

/** @param {string} target @param {string} link */
function swapSymlink(target, link) {
  try {
    if (readlinkSync(link) === target) return;
  } catch {
    // Missing or not a link: replace it below.
  }
  const tmp = tmpName(link);
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/** @param {string} file @param {string | Buffer} data */
function replaceFile(file, data) {
  const tmp = tmpName(file);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** @param {string[]} args @returns {Promise<number>} */
export async function main(args) {
  if (args.length !== 1 || args[0] !== "--finish") {
    process.stderr.write("usage: ttasks install --finish\n");
    return 64;
  }
  const versionDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const versionsDir = dirname(versionDir);
  if (basename(versionsDir) !== "versions") {
    process.stderr.write(`install: ${versionDir} is not inside a versions folder\n`);
    return 70;
  }
  const root = dirname(versionsDir);
  const manifest = JSON.parse(readFileSync(join(versionDir, "manifest.json"), "utf8"));
  const version = String(manifest.version);
  if (basename(versionDir) !== version) {
    process.stderr.write(`install: folder ${basename(versionDir)} holds version ${version}\n`);
    return 70;
  }

  const scratch = join(root, "state", "tmp");
  mkdirSync(scratch, { recursive: true });
  const gate = await runGate({ scratch, expect: { node: manifest.node, sqlite: manifest.sqlite } });
  const failed = gate.filter((r) => !r.ok);
  if (failed.length > 0) {
    for (const r of failed) process.stderr.write(`self-test failed: ${r.check}: ${r.detail}\n`);
    return 1;
  }

  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    replaceFile(join(root, "current"), version);
    for (const name of ["ttasks.exe", "ttasksw.exe"]) {
      const staged = join(bin, `${name}.new`);
      copyFileSync(join(versionDir, "bin", name), staged);
      renameSync(staged, join(bin, name));
    }
  } else {
    swapSymlink(`versions/${version}`, join(root, "current"));
    swapSymlink("../current/bin/ttasks", join(bin, "tasks"));
  }
  replaceFile(
    join(root, "install.json"),
    `${JSON.stringify(
      {
        version,
        platform: manifest.platform,
        channel: "spike",
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Installed TTasks ${version} (spike) into ${root}\n`);
  return 0;
}
