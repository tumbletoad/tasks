// The product tests' global setup: makes the folder that holds what this run builds once for all
// its files (tests/run-builds.ts), and removes it by its full name when the run ends. Nothing is
// built here, so a run that needs no build pays nothing for it.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject): () => void {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-run-")));
  project.provide("runBuilds", folder);
  return () => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}
