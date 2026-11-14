// Shared set-up for the space tests: a checked node:sqlite driver, fresh temporary folders and a
// space with fixture values. Every folder lives under the OS temporary folder and is removed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Id } from "../src/ids.ts";
import { nodeSqliteDriver } from "../src/node-sqlite.ts";
import type { SchemaStep } from "../src/schema.ts";
import { createSpace, type CreatedSpace, type CreateSpaceOptions } from "../src/space.ts";
import { CheckedDriver } from "../src/startup-check.ts";
import { createSpaceAt } from "./revisions.ts";

/** A fixed machine ID for fixture spaces. */
export const TEST_MACHINE: Id<"m"> = "m_3q7k9d2xw8f4r6t1c5v0b2n8aa";

let checked: Promise<CheckedDriver> | undefined;

export const checkedDriver = (): Promise<CheckedDriver> =>
  (checked ??= CheckedDriver.check(nodeSqliteDriver));

/** Fresh temporary folders, removed by cleanup(). */
export function tempFolders(prefix: string): { make: () => string; cleanup: () => void } {
  const made: string[] = [];
  return {
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
      made.push(dir);
      return dir;
    },
    cleanup: () => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Creates the fixture space "Mira" at `<parent>/<slug>`, at this build's revision, or with the
 * chain `steps` (revisions.ts: STEPS_0_1 builds a space as a released 0.1 build did).
 */
export async function createFixtureSpace(
  parent: string,
  slug = "mira",
  options: Partial<CreateSpaceOptions> = {},
  steps?: readonly SchemaStep[],
): Promise<CreatedSpace> {
  const all = { name: "Mira", ownerLabel: "Mira Okafor", machineId: TEST_MACHINE, ...options };
  const checked = await checkedDriver();
  return steps === undefined
    ? createSpace(checked, join(parent, slug), all)
    : createSpaceAt(checked, join(parent, slug), all, steps);
}
