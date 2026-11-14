// Makes the signed lab releases of M0.07 from version folders the packaging spike built.
//
//   pnpm exec node spikes/m0/lifecycle/make-release.ts --stage <version folder> [--stage <...>]
//     --versions 0.0.7-lab.a,0.0.7-lab.b --work <folder> --dist <folder> --key <empty folder>
//
// For each stage (win-x64 or linux-x64, from `packaging/scripts/build.ts --work <w>`, found at
// `<w>/stage/<version>/`) and each version, it assembles a lab folder (build.ts), packs it like the
// packaging spike (zip or tar.gz) into `--dist`, then signs everything in `--dist` with a
// throwaway Ed25519 key (`packaging/src/release.ts`): SHA256SUMS, SHA256SUMS.sshsig and one
// install script per version and platform. The key folder must be outside the repository and
// empty, and the private key is deleted afterwards. All folders are scratch folders.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deleteKey, generateThrowawayKey, signRelease } from "../packaging/src/release.ts";
import { archiveName, packVersionFolder, type Manifest } from "../packaging/src/version-folder.ts";
import { assembleLabFolder, buildLab } from "./build.ts";

const { values } = parseArgs({
  options: {
    stage: { type: "string", multiple: true },
    versions: { type: "string", default: "0.0.7-lab.a,0.0.7-lab.b" },
    work: { type: "string" },
    dist: { type: "string" },
    key: { type: "string" },
  },
  strict: true,
});
const stages = values.stage ?? [];
if (stages.length === 0 || values.work === undefined || values.dist === undefined) {
  throw new Error("pass --stage <folder> (one or more), --work <folder> and --dist <folder>");
}
if (values.key === undefined) throw new Error("pass --key <empty folder outside the repository>");
mkdirSync(values.key, { recursive: true });
if (readdirSync(values.key).length > 0) throw new Error(`${values.key} is not empty`);

const lab = buildLab(join(values.work, "lab-js"));
for (const stage of stages) {
  const platform = (JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as Manifest)
    .platform;
  for (const version of values.versions.split(",")) {
    const folder = assembleLabFolder(stage, join(values.work, platform), version, lab);
    const archive = packVersionFolder(
      folder,
      platform,
      join(values.dist, archiveName(version, platform)),
    );
    console.log(`lab release: ${archive}`);
  }
}
const key = generateThrowawayKey(values.key);
try {
  const signed = signRelease(values.dist, key);
  console.log(`signed: ${signed.sums}`);
  for (const f of signed.installers) console.log(`install script: ${f}`);
} finally {
  deleteKey(key);
  console.log("throwaway private key deleted");
}
