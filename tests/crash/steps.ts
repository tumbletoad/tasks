// The schema steps of the harness's build: the real 0.1 and 0.2 (M3.01), then the storage tests'
// stand-in 0.3 (packages/storage/test/stand-in-steps.ts), which never ships. A space is created at
// 0.1 as a released 0.1 build created it, and its first writer migrates it to 0.3 in one migration
// of two steps, the real 0.2 first, so a kill between the steps shows whether the migration is all
// or nothing, with the real step in it. A restore of a barrier backup brings 0.1 back.
import { step0002 } from "../../packages/storage/migrations/0002-schema-0.2.ts";
import { encodeRevision } from "../../packages/storage/src/schema.ts";
import { STEPS_0_1 } from "../../packages/storage/test/revisions.ts";
import { STEPS_0_3 } from "../../packages/storage/test/stand-in-steps.ts";

export const HARNESS_STEPS = STEPS_0_3;

/** The chain a new space is created with: the released 0.1's. */
export const CREATE_STEPS = STEPS_0_1;

export const REVISION_0_1 = encodeRevision({ major: 0, minor: 1 });
export const REVISION_0_2 = encodeRevision({ major: 0, minor: 2 });
export const REVISION_0_3 = encodeRevision({ major: 0, minor: 3 });

/** The tables the real 0.2 adds: there exactly when the space is at 0.2 or later. */
export const TABLES_0_2 = step0002.tables.filter(
  (table) => !STEPS_0_1.some((step) => step.tables.includes(table)),
);
