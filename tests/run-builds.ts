// What a test run builds once for all the files that need it: the version folders and their
// releases, the Windows launchers. The first file that asks for a build makes it in the run's
// folder (tests/run-builds-setup.ts) while the others wait, and every file gets the same result.
// Nothing is kept from one run to the next, so no build is older than the code it was built from.
//
// A build is read-only. A test that changes a built thing copies it into a folder of its own first.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The folder of this run's builds (tests/run-builds-setup.ts). */
    runBuilds: string;
  }
}

/** A build that takes longer than this under any load has hung. */
const WAIT_MS = 900_000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * What `build` made, built once per test run under `name`. `build` gets an empty folder of its
 * own and returns a description of what it made, which must survive JSON. Callers in other
 * workers wait for the first one. A build that fails is tried again by the next caller, so each
 * sees the failure itself; a worker that dies while it builds fails the ones that wait.
 */
export async function builtOnce<T>(
  name: string,
  build: (dir: string) => Promise<T> | T,
): Promise<T> {
  const run = inject("runBuilds") as string | undefined;
  if (run === undefined) throw new Error("no run folder: run the tests through vitest.config.ts");
  const dir = join(run, name);
  const result = join(dir, "built.json");
  const lock = `${dir}.lock`;
  const end = Date.now() + WAIT_MS;
  for (;;) {
    if (existsSync(result)) return JSON.parse(readFileSync(result, "utf8")) as T;
    if (take(lock, name)) {
      try {
        // What a failed build left.
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        mkdirSync(dir);
        const text = JSON.stringify(await build(dir));
        writeFileSync(`${result}.part`, text);
        renameSync(`${result}.part`, result);
        return JSON.parse(text) as T;
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    if (Date.now() > end) throw new Error(`${name} was not built within ${String(WAIT_MS)} ms`);
    await pause(200);
  }
}

/** Takes the build's lock, or returns false while another worker holds it. */
function take(lock: string, name: string): boolean {
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: number;
    try {
      owner = Number(readFileSync(join(lock, "pid"), "utf8"));
    } catch {
      // Taken a moment ago: its owner writes its PID next.
      return false;
    }
    if (!alive(owner)) {
      throw new Error(`the worker that built ${name} ended before it finished`, { cause: error });
    }
    return false;
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  return true;
}
