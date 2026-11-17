// The recorded stream fixtures of lab run N (fixtures/streams/, M0.11) for tests and fake agents:
// each stream with its index entry, which states how the recorded process ended.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { StreamKind } from "../src/streams/events.ts";

export const STREAMS_DIR = resolve(import.meta.dirname, "..", "..", "..", "fixtures", "streams");

/** One entry of `index-<os>.json` (fixtures/streams/README.md). */
export interface FixtureEntry {
  file: string;
  cli: StreamKind;
  os: "windows" | "linux";
  exit: number | null;
  signal: string | null;
  cancel: string | null;
  escalated_to_force: boolean | null;
  stderr_class: string;
  lines: number;
  ends_with_newline: boolean;
  final_line: "complete" | "empty" | "cut-by-sanitiser" | "partial-from-run";
}

let cached: FixtureEntry[] | undefined;

/** Every index entry, from Windows and Linux. */
export function fixtureIndex(): FixtureEntry[] {
  cached ??= ["windows", "linux"].flatMap(
    (os) =>
      JSON.parse(readFileSync(join(STREAMS_DIR, `index-${os}.json`), "utf8")) as FixtureEntry[],
  );
  return cached;
}

/** The stream files on disk, as `<cli>/<name>.jsonl`. */
export function fixtureFiles(): string[] {
  return ["claude-print"].flatMap((cli) =>
    readdirSync(join(STREAMS_DIR, cli))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => `${cli}/${f}`),
  );
}

/** The index entry of one fixture file. Throws for a file the index does not name. */
export function fixtureEntry(file: string): FixtureEntry {
  const entry = fixtureIndex().find((e) => e.file === file);
  if (entry === undefined) throw new Error(`no index entry for fixture ${file}`);
  return entry;
}

/** The absolute path of a fixture, refusing anything outside fixtures/streams. */
export function fixturePath(file: string): string {
  const path = resolve(STREAMS_DIR, file);
  if (!path.startsWith(STREAMS_DIR + sep)) throw new Error("fixture path outside fixtures/streams");
  return path;
}

/** A fixture's bytes exactly as recorded. */
export function fixtureBytes(file: string): Uint8Array {
  return readFileSync(fixturePath(file));
}
