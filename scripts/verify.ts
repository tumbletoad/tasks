// pnpm verify: every check a pull request must pass, stopping at the first failure with the name
// of the step that failed.
//
// The static checks each use one core, so they run side by side, and each prints its output when it
// ends. The tests run after them, so a typing or lint error is reported in about a minute.
//
// The product tests always run. The M0 lab self-tests (spikes/) run serially, and only when lab
// code or a file they depend on changed, or when asked: pnpm verify --lab, or TTASKS_VERIFY_LAB=1.
// The rule is in lab-tests.ts.
//
// `--part checks|product|lab` runs one slice and `--shard i/n` one Vitest shard of a test part,
// so CI can spread verify over several machines. With no part it runs every step.
//
// safe-exit comes first: this script loads the product's generators and ends through
// `process.exit`.
import "../packages/bridge/src/safe-exit.ts";
import { join } from "node:path";
import {
  decideLab,
  findBase,
  isProjectionPath,
  projectionFolders,
  parseVerifyArgs,
  type LabDecision,
  type VerifyOptions,
  type VerifyPart,
} from "./lab-tests.ts";
import { binPath, repoRoot, runNode, runNodeCaptured, type Captured } from "./run.ts";
import { CRUISE_ROOTS, generated, runtime, typecheck } from "./steps.ts";

/** Whether the step passed. A step that runs beside others returns its output, to print at its end. */
type Step = () => boolean | Promise<boolean | Captured>;

/** A dependency's command with the current Node, its output passed through as it comes. */
const tool =
  (pkg: string, bin: string, args: readonly string[]): Step =>
  () =>
    runNode(binPath(pkg, bin), args).status === 0;

/** A dependency's command with the current Node, its output kept until it ends. */
const quiet =
  (pkg: string, bin: string, args: readonly string[]): Step =>
  () =>
    runNodeCaptured(binPath(pkg, bin), args);

let options: VerifyOptions;
try {
  options = parseVerifyArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
const shard = options.shard === null ? [] : ["--shard", options.shard];

type Named = [name: string, part: VerifyPart | "all", step: Step];

/** Every step with the part it belongs to, in order. The steps of one stage run side by side. */
const allStages: Named[][] = [
  [["runtime", "all", runtime]],
  [["generated files", "checks", generated]],
  [
    ["typecheck", "checks", () => typecheck()],
    ["lint", "checks", () => runNodeCaptured(join(repoRoot, "scripts", "lint.ts"), [])],
    ["format", "checks", quiet("prettier", "prettier", ["--check", "--log-level", "warn", "."])],
    [
      "dependency rules",
      "checks",
      quiet("dependency-cruiser", "depcruise", [
        "--config",
        ".dependency-cruiser.cjs",
        "--output-type",
        "err",
        ...CRUISE_ROOTS,
      ]),
    ],
    [
      "test manifest",
      "checks",
      () => runNodeCaptured(join(repoRoot, "scripts", "manifest.ts"), []),
    ],
  ],
  [
    [
      "product tests",
      "product",
      tool("vitest", "vitest", ["run", "--project", "product", ...shard]),
    ],
  ],
  [["lab tests", "lab", labTests]],
];
const stages = allStages
  .map((stage) =>
    stage.filter(([, part]) => options.part === null || part === "all" || part === options.part),
  )
  .filter((stage) => stage.length > 0);

// Decided before any step runs, so the rule that applied is the first thing the output says.
const lab: LabDecision | null = stages.flat().some(([, part]) => part === "lab")
  ? decideLab(options, process.env, () => findBase(process.env))
  : null;
if (lab !== null) console.log(lab.reason);

// A change to the projection meets the model's random runs before it merges: they once found a
// defect that the fixed seeds never reach (packages/projection/test/model-replay.test.ts).
if (
  stages.flat().some(([, part]) => part === "product") &&
  process.env["PROJECTION_MODEL_RUNS"] === undefined
) {
  const base = findBase(process.env);
  const folders = projectionFolders();
  const changed = !base.found || base.changed.some((p) => isProjectionPath(p, folders));
  if (changed) {
    process.env["PROJECTION_MODEL_RUNS"] = "50";
    console.log(
      `projection model: 50 random runs, ${base.found ? `the projection or a package it uses changed since ${base.label}` : `the base could not be determined (${base.why})`}`,
    );
  }
}

function labTests(): boolean {
  if (lab === null || !lab.run) {
    if (lab !== null) console.log(lab.reason);
    return true;
  }
  return runNode(binPath("vitest", "vitest"), ["run", "--project", "lab", ...shard]).status === 0;
}

const count = String(stages.flat().length);
const started = performance.now();
let index = 0;
for (const stage of stages) {
  const labels = stage.map(([name]) => `[${String(++index)}/${count}] ${name}`);
  console.log(
    `\n${labels.length === 1 ? (labels[0] ?? "") : `${labels.join(", ")}: side by side`}`,
  );
  const results = await Promise.all(
    stage.map(async ([name, , step], i) => {
      const t0 = performance.now();
      let ok: boolean;
      let output = "";
      try {
        const result = await step();
        if (typeof result === "boolean") ok = result;
        else {
          ok = result.status === 0;
          output = result.output.trimEnd();
        }
      } catch (error) {
        ok = false;
        output = error instanceof Error ? (error.stack ?? error.message) : String(error);
      }
      const seconds = ((performance.now() - t0) / 1000).toFixed(1);
      const label = labels[i] ?? name;
      if (output !== "") console.log(`${stage.length === 1 ? "" : `\n${label}\n`}${output}`);
      console.log(`${label}: ${ok ? "ok" : "FAILED"} (${seconds} s)`);
      return { name, ok, seconds };
    }),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    const steps = failed.map((r) => `step "${r.name}" (${r.seconds} s)`).join(" and ");
    console.error(`\nverify FAILED at ${steps}`);
    process.exit(1);
  }
}
const total = `${((performance.now() - started) / 1000).toFixed(1)} s`;
// A pass of one part, or without the lab tests, must not read as a pass of everything.
const slice =
  options.part === null
    ? ""
    : ` of part ${options.part}${options.shard === null ? "" : `, shard ${options.shard}`}`;
const skipped = lab === null || lab.run ? "" : `. ${lab.reason}`;
console.log(`\nverify passed${slice} (${total})${skipped}`);
