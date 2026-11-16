// Builds a standalone .mjs copy of the kit: Node's own type stripping, then `./x.ts` imports
// rewritten to `./x.mjs`. The lab runs the forwarder, shims and probe from this copy, because
// running .ts costs Node about 20 ms of extra start time (measured on Windows 11), which would
// bias rows B01 and B07. The copy needs no node_modules, so it can be copied to a Linux machine.
// `build.json` records the source folder and a hash of every source file, so the bench can refuse
// a copy that is missing files or older than its sources (`checkBuiltKit`).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KitError, asObject, parseObject } from "./wire.ts";

export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const IS_BUILT = import.meta.url.endsWith(".mjs");
const RELATIVE_TS = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g;

/** Strips one file without Node's experimental-feature warning on stderr. */
function strip(code: string): string {
  const original = process.emitWarning.bind(process);
  process.emitWarning = () => undefined;
  try {
    return stripTypeScriptTypes(code);
  } finally {
    process.emitWarning = original;
  }
}

/** One source file as .mjs: types stripped, `./x.ts` and `../x.ts` imports pointed at `.mjs`. */
export function compileSource(code: string): string {
  return strip(code).replace(RELATIVE_TS, "$1$2$3.mjs$2");
}

const isSource = (name: string) =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");

/** The SHA-256 of every kit source file in `dir`, by file name. */
function sourceHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of readdirSync(dir).filter(isSource).sort()) {
    hashes[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return hashes;
}

/** Writes the .mjs kit into `out` and returns it. A built kit returns its own folder. */
export function buildKit(out: string): string {
  if (IS_BUILT) return KIT_DIR;
  mkdirSync(out, { recursive: true });
  const outputs: string[] = [];
  for (const name of readdirSync(KIT_DIR).filter(isSource)) {
    const code = compileSource(readFileSync(join(KIT_DIR, name), "utf8"));
    const target = name.replace(/\.ts$/, ".mjs");
    writeFileSync(join(out, target), code);
    outputs.push(target);
  }
  const record = { format: 1, source: KIT_DIR, sources: sourceHashes(KIT_DIR), outputs };
  writeFileSync(join(out, "build.json"), `${JSON.stringify(record, null, 2)}\n`);
  return out;
}

/**
 * Checks a prebuilt kit without reading its .mjs files, so a cold run finds them cold: build.json
 * must exist, every output must exist, and when the source folder it was built from is present,
 * every source must still have the recorded hash. Returns the folder; throws `kit_missing` or
 * `kit_stale`.
 */
export function checkBuiltKit(dir: string): string {
  const record = existsSync(join(dir, "build.json"))
    ? parseObject(readFileSync(join(dir, "build.json"), "utf8"))
    : undefined;
  const outputs = record?.["outputs"];
  if (record === undefined || !Array.isArray(outputs)) {
    throw new KitError("kit_missing", `No built kit in ${dir}. Run: kit build ${dir}`);
  }
  for (const name of outputs) {
    if (
      typeof name !== "string" ||
      !existsSync(join(dir, name)) ||
      !statSync(join(dir, name)).isFile()
    ) {
      throw new KitError(
        "kit_missing",
        `The built kit in ${dir} lacks ${JSON.stringify(name)}. Run kit build again.`,
      );
    }
  }
  const source = record["source"];
  const recorded = asObject(record["sources"]) ?? {};
  if (typeof source === "string" && existsSync(source)) {
    const current = sourceHashes(source);
    const names = new Set([...Object.keys(current), ...Object.keys(recorded)]);
    for (const name of names) {
      if (current[name] !== recorded[name]) {
        throw new KitError(
          "kit_stale",
          `The built kit in ${dir} is older than ${join(source, name)}. Run kit build again.`,
        );
      }
    }
  }
  return dir;
}
