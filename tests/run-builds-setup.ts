// The product tests' global setup: makes the folder that holds what this run builds once for all
// its files (tests/run-builds.ts), and removes it by its full name when the run ends. Nothing is
// built here, so a run that needs no build pays nothing for it. The folder's name carries this
// process's ID: a run that was killed before its end left its folder, and a later run removes
// it once that process is gone.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

const PREFIX = "ttasks-run-";

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export default function setup(project: TestProject): () => void {
  for (const name of readdirSync(tmpdir())) {
    const owner = new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1];
    if (owner !== undefined && Number(owner) !== process.pid && !alive(Number(owner))) {
      rmSync(join(tmpdir(), name), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  }
  const folder = realpathSync.native(
    mkdtempSync(join(tmpdir(), `${PREFIX}${String(process.pid)}-`)),
  );
  project.provide("runBuilds", folder);
  return () => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}
