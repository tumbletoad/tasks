// Setup's two record files as they are on disk, for tests that check where a record is kept and
// what an earlier build finds there. Product code reads them only through setupRecords (state.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupDir, type HomeRecord } from "../src/setup/index.ts";

/** The record file an earlier build reads. */
export const SETUP_FILE = "agents.json";
/** The further settings files' records. */
export const FURTHER_FILE = "agents-further.json";

/** The records in one record file, as written there; none when it is not there. */
export function readRecords(stateDir: string, file: string = SETUP_FILE): HomeRecord[] {
  const path = join(setupDir(stateDir), file);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { homes: HomeRecord[] }).homes;
}

/** Writes one record file as setup writes it. */
export function writeRecords(
  stateDir: string,
  records: readonly HomeRecord[],
  file: string = SETUP_FILE,
): void {
  mkdirSync(setupDir(stateDir), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(setupDir(stateDir), file),
    `${JSON.stringify({ format: 2, homes: records }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
