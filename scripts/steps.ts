// Steps that `pnpm verify` and `pnpm check` both run, so the two cannot drift apart.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkGenerated, generators } from "./generated.ts";
import { repoRoot } from "./run.ts";

/** Whether this Node is the one the repository pins, and the pin is stated the same way twice. */
export function runtime(): boolean {
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

/** Whether every generated file matches its generator. */
export async function generated(): Promise<boolean> {
  if (generators.length === 0) {
    console.log("no generators registered yet");
    return true;
  }
  const problems = await checkGenerated(repoRoot, generators);
  for (const p of problems) console.error(p);
  if (problems.length > 0) console.error("Run pnpm gen and commit the result.");
  return problems.length === 0;
}

/**
 * The TypeScript projects: Node code, the browser page (DOM, JSX) and the end-to-end tests (Node,
 * with the DOM for code that runs in the page).
 */
export const TS_PROJECTS = [
  "tsconfig.json",
  "packages/web/tsconfig.json",
  "tests/e2e/tsconfig.json",
] as const;

/** The folders dependency-cruiser checks. */
export const CRUISE_ROOTS = ["packages", "scripts", "tests", "spikes"].filter((d) =>
  existsSync(join(repoRoot, d)),
);
