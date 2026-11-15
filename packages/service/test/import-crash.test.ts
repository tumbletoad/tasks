// An import killed for real at each point of its apply (A7 3.15.5; the owner's rule: never half an
// import): during its barrier backup, after the backup and before the transaction, inside the
// transaction before COMMIT, and after COMMIT before the answer. A child process
// (import-crash-child.ts) runs the service's apply on a real space folder and blocks at the point;
// the test kills it, opens the space again and finds either nothing of the import or all of it, then
// runs the same apply again, which applies it once: the import's tasks exist exactly once. Fixture
// data only, in temporary folders removed by their full names.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { attachWorld, openWorld, type ImportWorld } from "./import-harness.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(REPO, "fixtures", "planning-prototype");
const CHILD = join(import.meta.dirname, "import-crash-child.ts");
const index = JSON.parse(
  readFileSync(join(REPO, "fixtures", "planning-prototype.index.json"), "utf8"),
) as { me: string; roots: Record<string, string> };
const ROOTS = Object.entries(index.roots).map(([id, path]) => ({ id, path }));

/** The points, in the order the apply reaches them, and whether the import is in after it. */
const POINTS = [
  { point: "copied", committed: false },
  { point: "sidecar-published", committed: false },
  { point: "before-commit", committed: false },
  { point: "after-commit", committed: true },
] as const;

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-05-crash-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** Runs the child until it reaches `point`, then kills it. Resolves once it has ended. */
function killAt(env: Record<string, string>, point: string): Promise<{ reached: boolean }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let reached = false;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line === `at ${point}`) {
        reached = true;
        child.kill("SIGKILL");
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("error", fail);
    child.on("close", () => {
      clearTimeout(timer);
      if (!reached) fail(new Error(`The child ended before ${point}: ${stderr.slice(-2000)}`));
      else done({ reached });
    });
  });
}

const count = (world: ImportWorld, sql: string): number => Number(world.rows(sql)[0]?.["n"] ?? 0);

describe("[A7.3.15.importer.apply-crash] an apply killed at each of its points", () => {
  for (const { point, committed } of POINTS) {
    test(`killed at ${point}: ${committed ? "all" : "nothing"} of it, and a retry applies it once`, async () => {
      const root = join(scratch, point);
      const prototype = join(root, "prototype");
      cpSync(FIXTURE, prototype, { recursive: true });
      const world = await openWorld(root, { roots: ROOTS });
      const preview = await world.preview({ folder: prototype, me: index.me });
      const tasks = count(world, "SELECT count(*) AS n FROM tasks");
      const { folder, machine } = world;
      world.close();

      await killAt(
        {
          TASKS_IMPORT_CRASH: JSON.stringify({
            folder,
            machine,
            roots: ROOTS,
            run: preview.run,
            token: preview.token,
            point,
          }),
        },
        point,
      );

      const again = await attachWorld(folder, machine, { roots: ROOTS });
      try {
        const imports = count(again, "SELECT count(*) AS n FROM commits WHERE origin = 'import'");
        expect(imports).toBe(committed ? 1 : 0);
        expect(count(again, "SELECT count(*) AS n FROM exchanges")).toBe(committed ? 1 : 0);
        expect(count(again, "SELECT count(*) AS n FROM tasks")).toBe(
          committed ? tasks + preview.counts.tasks : tasks,
        );
        // The same apply again: applied once, whether the first one committed or not.
        const result = await again.apply(preview.run, preview.token ?? "");
        expect(result.status).toBe("applied");
        if (committed) expect(result.replayed).toBe(true);
        expect(count(again, "SELECT count(*) AS n FROM commits WHERE origin = 'import'")).toBe(1);
        expect(count(again, "SELECT count(*) AS n FROM tasks")).toBe(tasks + preview.counts.tasks);
        expect(
          again.rows(
            "SELECT alias FROM aliases WHERE namespace = 'planning' GROUP BY alias HAVING count(*) > 1",
          ),
        ).toEqual([]);
        expect(count(again, "SELECT count(*) AS n FROM exchange_items")).toBe(preview.counts.tasks);
        expect(again.rows("PRAGMA integrity_check")[0]?.["integrity_check"]).toBe("ok");
      } finally {
        again.close();
      }
    }, 180_000);
  }
});
