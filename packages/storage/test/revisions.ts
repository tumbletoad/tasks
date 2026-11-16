// Spaces at a released schema revision older than the build's (A1 5: "Fixture databases for every
// released schema revision from 0.1 on, migrated to current, then verified"). A fixture of an older
// revision is BUILT, never checked in as a database file: its chain of steps is the released one,
// and the steps of a released revision are frozen (migrations/0001-schema-0.1.ts), so the builder
// produces what that release produced. testkit's seedMira builds its sample with these, and the
// known 0.1 sample's digest pins the result. Exported as @tasks/storage/revisions for testkit and
// other packages' tests. Plain functions without vitest, so a worker thread can use them too.
import { step0001 } from "../migrations/0001-schema-0.1.ts";
import { step0002 } from "../migrations/0002-schema-0.2.ts";
import { step0003 } from "../migrations/0003-schema-0.3.ts";
import { step0004 } from "../migrations/0004-schema-0.4.ts";
import { step0005 } from "../migrations/0005-schema-0.5.ts";
import { SCHEMA_STEPS } from "../migrations/index.ts";
import type { SchemaStep } from "../src/schema.ts";
import {
  createSpaceWith,
  openSpaceWith,
  type CreatedSpace,
  type CreateSpaceOptions,
  type OpenedSpace,
  type OpenSpaceOptions,
} from "../src/space.ts";
import type { CheckedDriver } from "../src/startup-check.ts";

/** The chain of steps of the released 0.1 builds: the build of every real 0.1 space. */
export const STEPS_0_1: readonly SchemaStep[] = [step0001];

/** The chain of steps of the 0.2 builds (M3.01), released and frozen like 0.1's. */
export const STEPS_0_2: readonly SchemaStep[] = [step0001, step0002];

/** The chain of steps of the 0.3 builds (M6.01), released and frozen like the others. */
export const STEPS_0_3: readonly SchemaStep[] = [step0001, step0002, step0003];

/** The chain of steps of the 0.4 builds: the search index. Frozen once it is released. */
export const STEPS_0_4: readonly SchemaStep[] = [step0001, step0002, step0003, step0004];

/** The chain of steps of the 0.5 builds: folders. Frozen once it is released. */
export const STEPS_0_5: readonly SchemaStep[] = [
  step0001,
  step0002,
  step0003,
  step0004,
  step0005,
];

/** This build's chain, for symmetry with the released ones. */
export const STEPS_LATEST: readonly SchemaStep[] = SCHEMA_STEPS;

/**
 * Creates a space with the chain `steps`, as a build whose latest step is the chain's last would
 * create it: that revision, its format and its space.json.
 */
export function createSpaceAt(
  checked: CheckedDriver,
  folder: string,
  options: CreateSpaceOptions,
  steps: readonly SchemaStep[],
): CreatedSpace {
  return createSpaceWith(checked, folder, options, { steps });
}

/**
 * Opens a space as a build whose chain is `steps` opens it: a space at that chain's last revision
 * opens as its writer, a newer one is refused or read as that build refuses or reads it.
 */
export function openSpaceAt(
  checked: CheckedDriver,
  folder: string,
  options: OpenSpaceOptions,
  steps: readonly SchemaStep[],
): OpenedSpace {
  return openSpaceWith(checked, folder, options, { steps });
}
