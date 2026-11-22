// Builds the spike's version folder and its archive for one platform (A2 3.12.2, 3.12.8 "build").
//
//   pnpm exec node spikes/m0/packaging/scripts/build.ts [--platform linux-x64|win-x64]
//     [--version 0.0.0-spike] [--build <id>] [--dist <folder>] [--work <folder>]
//     [--signature require|skip] [--level 0-9]
//
// 1. Downloads the official Node from nodejs.org and verifies it (src/node-runtime.ts).
// 2. Compiles ttasks.exe and ttasksw.exe with MSVC (win-x64, on Windows only).
// 3. Assembles <work>/stage/<version>/ with manifest.json.
// 4. Packs <dist>/ttasks-<version>-<platform>.tar.gz or .zip and reads it back as a check.
// This script needs the network. pnpm verify never runs it. The workflow m0-packaging does.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readTarGz, readZip } from "../src/archive.ts";
import { compileLaunchers } from "../src/msvc.ts";
import { fetchNodeRuntime } from "../src/node-runtime.ts";
import { defaultDist } from "../src/paths.ts";
import {
  archiveName,
  assembleVersionFolder,
  folderEntries,
  hostPlatform,
  isPlatform,
  packVersionFolder,
  sha256,
  verifyVersionFolder,
} from "../src/version-folder.ts";

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    version: { type: "string", default: "0.0.0-spike" },
    build: { type: "string", default: "local" },
    dist: { type: "string", default: defaultDist },
    work: { type: "string" },
    signature: { type: "string", default: "require" },
    level: { type: "string", default: "9" },
  },
  strict: true,
});

const platform = values.platform ?? hostPlatform();
if (platform === undefined || !isPlatform(platform)) {
  throw new Error("pass --platform linux-x64 or --platform win-x64");
}
if (values.signature !== "require" && values.signature !== "skip") {
  throw new Error("--signature is require or skip");
}
const level = Number.parseInt(values.level, 10);
const work = values.work ?? join(values.dist, ".work");
mkdirSync(work, { recursive: true });

const runtime = await fetchNodeRuntime({
  platform,
  cacheDir: join(work, "cache"),
  signature: values.signature,
});

let launchers: { ttasks: string; ttasksw: string } | undefined;
if (platform === "win-x64") {
  launchers = compileLaunchers(join(work, "launchers"));
  console.log(`launchers: compiled ${launchers.ttasks} and ${launchers.ttasksw}`);
}

const stage = join(work, "stage", values.version);
rmSync(stage, { recursive: true, force: true });
const manifest = assembleVersionFolder(stage, {
  version: values.version,
  build: values.build,
  platform,
  node: {
    version: runtime.version,
    sqlite: runtime.sqlite,
    binary: runtime.binary,
    license: runtime.license,
  },
  ...(launchers === undefined ? {} : { launchers }),
});
const problems = verifyVersionFolder(stage);
if (problems.length > 0)
  throw new Error(`the staged folder fails its manifest: ${problems.join("; ")}`);

const archive = packVersionFolder(
  stage,
  platform,
  join(values.dist, archiveName(values.version, platform)),
  level,
);
const data = readFileSync(archive);
const back = platform === "win-x64" ? readZip(data) : readTarGz(data);
const expected = folderEntries(stage);
for (const e of expected) {
  const found = back.find((b) => b.path === e.path && b.type === "file");
  if (found === undefined || !found.data.equals(e.data))
    throw new Error(`archive check failed at ${e.path}`);
}

console.log(`version folder: ${stage} (${String(Object.keys(manifest.files).length)} files)`);
console.log(`archive: ${archive}`);
console.log(`archive size: ${String(data.length)} bytes`);
console.log(`archive sha256: ${sha256(data)}`);
