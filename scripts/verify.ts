// pnpm verify (A7 3.3): every check a pull request must pass, in order, stopping at the first
// failure with the name of the step that failed.
//
// The product tests always run. The M0 lab self-tests (spikes/) run serially, and only when lab
// code or a file they depend on changed, or when asked: pnpm verify --lab, or TTASKS_VERIFY_LAB=1.
// The rule is in lab-tests.ts (A7 3.3).
//
// `--part checks|product|lab` runs one slice and `--shard i/n` one Vitest shard of a test part,
// so CI can spread verify over several machines. With no part it runs every step.
//
// safe-exit comes first: this script loads the product's generators and ends through
// `process.exit` (A2 3.12.1).
import "../packages/bridge/src/safe-exit.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkGenerated, generators } from "./generated.ts";
import {
  decideLab,
  findBase,
  parseVerifyArgs,
  type LabDecision,
  type VerifyOptions,
  type VerifyPart,
} from "./lab-tests.ts";
import { verifyManifest } from "./manifest.ts";
import { binPath, repoRoot, runNode } from "./run.ts";

type Step = () => boolean | Promise<boolean>;

/** Runs a dependency's command with the current Node and reports whether it exited with 0. */
const tool =
  (pkg: string, bin: string, args: readonly string[]): Step =>
  () =>
    runNode(binPath(pkg, bin), args).status === 0;

function runtime(): boolean {
  const pinned = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    devEngines?: { runtime?: { version?: string } };
  };
  const declared = pkg.devEngines?.runtime?.version;
  if (declared !== pinned) {
    console.error(
      `package.json devEngines.runtime.version is ${String(declared)}, .node-version is ${pinned}`,
    );
    return false;
  }
  if (process.version !== `v${pinned}`) {
    console.error(
      `running on Node ${process.version}, but the repository pins v${pinned}. Run it through pnpm.`,
    );
    return false;
  }
  console.log(`Node ${process.version}`);
  return true;
}

async function generated(): Promise<boolean> {
  if (generators.length === 0) {
    console.log("no generators registered yet");
    return true;
  }
  const problems = await checkGenerated(repoRoot, generators);
  for (const p of problems) console.error(p);
  if (problems.length > 0) console.error("Run pnpm gen and commit the result.");
  return problems.length === 0;
}

async function manifest(): Promise<boolean> {
  const { errors, tests } = await verifyManifest(repoRoot);
  for (const e of errors) console.error(e);
  console.log(`${String(tests)} tests checked against tests/manifest.json`);
  return errors.length === 0;
}

const cruiseRoots = ["packages", "scripts", "tests", "spikes"].filter((d) =>
  existsSync(join(repoRoot, d)),
);

/**
 * The TypeScript projects: Node code, the browser page (DOM, JSX) and the end-to-end tests (Node,
 * with the DOM for code that runs in the page).
 */
const TS_PROJECTS = ["tsconfig.json", "packages/web/tsconfig.json", "tests/e2e/tsconfig.json"];

function typecheck(): boolean {
  let ok = true;
  for (const project of TS_PROJECTS) {
    if (runNode(binPath("typescript", "tsc"), ["-p", project]).status !== 0) ok = false;
  }
  return ok;
}

let options: VerifyOptions;
try {
  options = parseVerifyArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
const shard = options.shard === null ? [] : ["--shard", options.shard];

/** Every step with the part it belongs to. The runtime check comes first in every part. */
const allSteps: [name: string, part: VerifyPart | "all", step: Step][] = [
  ["runtime", "all", runtime],
  ["generated files", "checks", generated],
  ["typecheck", "checks", typecheck],
  ["lint", "checks", tool("eslint", "eslint", ["--max-warnings", "0", "."])],
  ["format", "checks", tool("prettier", "prettier", ["--check", "--log-level", "warn", "."])],
  [
    "dependency rules",
    "checks",
    tool("dependency-cruiser", "depcruise", [
      "--config",
      ".dependency-cruiser.cjs",
      "--output-type",
      "err",
      ...cruiseRoots,
    ]),
  ],
  ["test manifest", "checks", manifest],
  ["product tests", "product", tool("vitest", "vitest", ["run", "--project", "product", ...shard])],
  ["lab tests", "lab", labTests],
];
const steps = allSteps.filter(
  ([, part]) => options.part === null || part === "all" || part === options.part,
);

// Decided before any step runs, so the rule that applied is the first thing the output says.
const lab: LabDecision | null = steps.some(([, part]) => part === "lab")
  ? decideLab(options, process.env, () => findBase(process.env))
  : null;
if (lab !== null) console.log(lab.reason);

function labTests(): boolean {
  if (lab === null || !lab.run) {
    if (lab !== null) console.log(lab.reason);
    return true;
  }
  return runNode(binPath("vitest", "vitest"), ["run", "--project", "lab", ...shard]).status === 0;
}

const started = performance.now();
for (const [index, [name, , step]] of steps.entries()) {
  const label = `[${String(index + 1)}/${String(steps.length)}] ${name}`;
  console.log(`\n${label}`);
  const t0 = performance.now();
  let ok: boolean;
  try {
    ok = await step();
  } catch (error) {
    console.error(error);
    ok = false;
  }
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);
  if (!ok) {
    console.error(`\nverify FAILED at step "${name}" (${seconds} s)`);
    process.exit(1);
  }
  console.log(`${label}: ok (${seconds} s)`);
}
const total = `${((performance.now() - started) / 1000).toFixed(1)} s`;
// A pass of one part, or without the lab tests, must not read as a pass of everything.
const slice =
  options.part === null
    ? ""
    : ` of part ${options.part}${options.shard === null ? "" : `, shard ${options.shard}`}`;
const skipped = lab === null || lab.run ? "" : `. ${lab.reason}`;
console.log(`\nverify passed${slice} (${total})${skipped}`);
