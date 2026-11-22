// Builds the lab code of M0.07 as .mjs and assembles lab version folders.
//
// `buildLab(out)` writes the kit to `<out>/kit/` and the lifecycle sources to `<out>/lifecycle/`,
// so `node <out>/lifecycle/lab.mjs` runs the lab harness with no node_modules, on the packaged
// Node of either machine.
//
// `assembleLabFolder(stage, out, version)` copies a version folder that the packaging spike built
// (`scripts/build.ts`, A2 3.12.2) and turns it into a lab release of `version`: `lib/ttasks.mjs`
// becomes the lab entry (`entry.ts`), `lib/supervisor.mjs` and the built kit (`lib/kit/*.mjs`) are
// added, and `manifest.json` is written again for the new file set and version. The launchers, the
// Node runtime, `gate.mjs` and `install.mjs` stay byte for byte as built.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKit, compileSource } from "../kit/build.ts";
import {
  VERSION_PATTERN,
  listFiles,
  sha256File,
  verifyVersionFolder,
  type Manifest,
} from "../packaging/src/version-folder.ts";

export const LIFECYCLE_DIR = dirname(fileURLToPath(import.meta.url));

/** The lifecycle sources a machine runs. The build and release scripts run from the repository. */
export const LAB_SOURCES = ["entry.ts", "supervisor.ts", "lab.ts"];

/** Writes `<out>/kit/` and `<out>/lifecycle/`. Returns both folders. */
export function buildLab(out: string): { kit: string; lifecycle: string } {
  const kit = buildKit(join(out, "kit"));
  const lifecycle = join(out, "lifecycle");
  mkdirSync(lifecycle, { recursive: true });
  for (const name of LAB_SOURCES) {
    const code = compileSource(readFileSync(join(LIFECYCLE_DIR, name), "utf8"));
    writeFileSync(join(lifecycle, name.replace(/\.ts$/, ".mjs")), code);
  }
  return { kit, lifecycle };
}

/** The same path rule as the packaging spike's manifest (the POSIX installer reads it). */
const MANIFEST_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * Copies the built version folder `stage` to `<outRoot>/<version>/` as a lab release and returns
 * that folder. `lab` is a `buildLab` output.
 */
export function assembleLabFolder(
  stage: string,
  outRoot: string,
  version: string,
  lab: { kit: string; lifecycle: string },
): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid version ${version}`);
  const problems = verifyVersionFolder(stage);
  if (problems.length > 0) throw new Error(`the stage fails its manifest: ${problems.join("; ")}`);
  const base = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as Manifest;
  const out = join(outRoot, version);
  if (existsSync(out)) throw new Error(`${out} already exists`);
  cpSync(stage, out, { recursive: true });
  rmSync(join(out, "manifest.json"));
  writeFileSync(join(out, "lib", "ttasks.mjs"), readFileSync(join(lab.lifecycle, "entry.mjs")));
  writeFileSync(
    join(out, "lib", "supervisor.mjs"),
    readFileSync(join(lab.lifecycle, "supervisor.mjs")),
  );
  mkdirSync(join(out, "lib", "kit"));
  for (const name of readdirSync(lab.kit).filter((n) => n.endsWith(".mjs"))) {
    writeFileSync(join(out, "lib", "kit", name), readFileSync(join(lab.kit, name)));
  }
  const files: Record<string, string> = {};
  for (const rel of listFiles(out)) {
    if (!MANIFEST_PATH.test(rel)) throw new Error(`path not allowed in a version folder: ${rel}`);
    files[rel] = sha256File(join(out, ...rel.split("/")));
  }
  const manifest: Manifest = { ...base, version, build: "lab-m0.07", files };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const after = verifyVersionFolder(out);
  if (after.length > 0) throw new Error(`the lab folder fails its manifest: ${after.join("; ")}`);
  return out;
}
