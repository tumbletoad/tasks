// Every schema step, in order. Creating a space runs them all on an empty database. The last one's
// revision is the build's latest. The migration runner takes the steps after a space's own
// revision.
import type { SchemaStep } from "../src/schema.ts";
import { step0001 } from "./0001-schema-0.1.ts";
import { step0002 } from "./0002-schema-0.2.ts";
import { step0003 } from "./0003-schema-0.3.ts";
import { step0004 } from "./0004-schema-0.4.ts";

export const SCHEMA_STEPS: readonly SchemaStep[] = [step0001, step0002, step0003, step0004];
