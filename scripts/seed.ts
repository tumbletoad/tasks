// pnpm seed (A7 3.3): builds the Mira sample space, fixture data only.
//
//   pnpm seed --out <folder> [--seed <text>] [--tasks <n>]
//
// The space goes to <folder>/mira, which must not exist yet. The same seed and size give the same
// space on every machine: the script prints its content digest, which tests compare. The scale
// corpus (--scale) and the synthetic prototype folder (--planning) arrive with the steps that need
// them (M1.15, M7).
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkedDriver,
  DEFAULT_SEED,
  DEFAULT_TASKS,
  digestSpace,
  MAX_TASKS,
  seedMira,
} from "../packages/testkit/src/index.ts";

const USAGE = "Usage: pnpm seed --out <folder> [--seed <text>] [--tasks <n>]";

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--planning")) return (await import("./seed-planning.ts")).seedPlanning(argv);
  let values: { out?: string | undefined; seed?: string | undefined; tasks?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { out: { type: "string" }, seed: { type: "string" }, tasks: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (values.out === undefined || values.out === "") {
    console.error(USAGE);
    return 2;
  }
  const tasks = values.tasks === undefined ? DEFAULT_TASKS : Number(values.tasks);
  if (!/^[1-9][0-9]{0,3}$/.test(values.tasks ?? "1") || tasks > MAX_TASKS) {
    console.error(`--tasks is a whole number from 1 to ${String(MAX_TASKS)}`);
    return 2;
  }
  const out = isAbsolute(values.out) ? values.out : resolve(values.out);
  const seed = values.seed ?? DEFAULT_SEED;
  const space = await seedMira(out, { seed, tasks });
  const digest = digestSpace(await checkedDriver(), space.folder);
  console.log(`Mira sample space: ${space.folder}`);
  console.log(`seed: ${seed}, tasks: ${String(tasks)}`);
  console.log(`digest: ${digest}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const code = (error as { code?: unknown }).code;
    console.error(`pnpm seed failed${typeof code === "string" ? `: ${code}` : ""}`);
    process.exitCode = 1;
  },
);
