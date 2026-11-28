// The schema steps of the harness's build: the real 0.1 to 0.6, then the storage tests' stand-in 0.7
// (packages/storage/test/stand-in-steps.ts), which never ships. A space is created at 0.1 as a
// released 0.1 build created it, and its first writer migrates it to 0.7 in one migration of six
// steps, the real ones first, so a kill between the steps shows whether the migration is
// all or nothing, with the real steps in it. A restore of a barrier backup brings 0.1 back.
import { step0002 } from "../../packages/storage/migrations/0002-schema-0.2.ts";
import { TABLES_0_3_NEW } from "../../packages/storage/migrations/0003-schema-0.3.ts";
import { TABLES_0_4_NEW } from "../../packages/storage/migrations/0004-schema-0.4.ts";
import { TABLES_0_5_NEW } from "../../packages/storage/migrations/0005-schema-0.5.ts";
import { TABLES_0_6_NEW } from "../../packages/storage/migrations/0006-schema-0.6.ts";
import { encodeRevision } from "../../packages/storage/src/schema.ts";
import { STEPS_0_1 } from "../../packages/storage/test/revisions.ts";
import { STEPS_0_7 } from "../../packages/storage/test/stand-in-steps.ts";

export const HARNESS_STEPS = STEPS_0_7;

/** The chain a new space is created with: the released 0.1's. */
export const CREATE_STEPS = STEPS_0_1;

export const REVISION_0_1 = encodeRevision({ major: 0, minor: 1 });
export const REVISION_0_2 = encodeRevision({ major: 0, minor: 2 });
export const REVISION_0_3 = encodeRevision({ major: 0, minor: 3 });
export const REVISION_0_4 = encodeRevision({ major: 0, minor: 4 });
export const REVISION_0_5 = encodeRevision({ major: 0, minor: 5 });
export const REVISION_0_6 = encodeRevision({ major: 0, minor: 6 });
export const REVISION_0_7 = encodeRevision({ major: 0, minor: 7 });

/** The tables the real 0.2 adds: there exactly when the space is at 0.2 or later. */
export const TABLES_0_2 = step0002.tables.filter(
  (table) => !STEPS_0_1.some((step) => step.tables.includes(table)),
);

/** The tables the real 0.3 adds: there exactly when the space is at 0.3 or later. */
export const TABLES_0_3 = TABLES_0_3_NEW;

/** The search index's tables, which the real 0.4 adds: there exactly at 0.4 or later. */
export const TABLES_0_4 = TABLES_0_4_NEW;

/** The folders table, which the real 0.5 adds: there exactly at 0.5 or later. */
export const TABLES_0_5 = TABLES_0_5_NEW;

/** The pages and the texts of a node, which the real 0.6 adds: there exactly at 0.6 or later. */
export const TABLES_0_6 = TABLES_0_6_NEW;
