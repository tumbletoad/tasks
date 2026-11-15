// Every schema step, in order (A1 3.17). Creating a space runs them all on an empty database. The
// last one's revision is the build's latest. M1.06's runner takes the steps after a space's own
// revision.
import type { SchemaStep } from "../src/schema.ts";
import { step0001 } from "./0001-schema-0.1.ts";
import { step0002 } from "./0002-schema-0.2.ts";
import { step0003 } from "./0003-schema-0.3.ts";

export const SCHEMA_STEPS: readonly SchemaStep[] = [step0001, step0002, step0003];
