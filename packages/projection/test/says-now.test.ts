// A task's readable file and the index say what the task is now, through the real writer and
// projector: an earlier outcome stays after a reopen and is said as earlier, a wait names what it
// waits on, the folder is the one Open uses, a timed deadline's day is the local one, and a file
// taken from the folder comes back while the projection runs. Fixture text only.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { catalogOf, checkWatermark, frontMatter, inTree, settle, world, type World } from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-now-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
let w: World;
beforeEach(async () => {
  n += 1;
  const folder = join(root, String(n));
  mkdirSync(folder);
  w = await world(folder, 6);
});
afterEach(() => {
  w.close();
});

/** An active task of the sample, by the catalogue's order. */
function activeTask(): string {
  const row = w.reader
    .prepare(
      "SELECT id FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL ORDER BY ref LIMIT 1",
    )
    .get<{ id: string }>();
  if (row === undefined) throw new Error("the sample has an active task");
  return row.id;
}

/** The text of `task`'s file, as the catalogue names it. */
function fileOf(task: string): string {
  const line = catalogOf(w.dir).find((l) => l.id === task);
  if (line === undefined) throw new Error(`${task} is in the catalogue`);
  return readFileSync(join(w.dir, ...line.path.split("/")), "utf8");
}

async function project(timeZone = "UTC"): Promise<void> {
  const p = w.projector({ timeZone });
  await p.start();
  await settle(p);
}

describe("[A1.5.projection.render] a task's file says what the task is now", () => {
  test("a reopened task keeps its earlier outcome and learnings, said as earlier", async () => {
    const task = activeTask();
    w.submit([{ kind: "task.complete", task, outcome: "Shipped the fixture fix." }]);
    w.submit([{ kind: "task.wrap_up", task, learnings: { add: ["Check the fixture first."] } }]);
    await project();
    const done = fileOf(task);
    expect(done).toContain("## Outcome\n\nShipped the fixture fix.");
    expect(done).toContain("## Learnings\n\n- Check the fixture first.");

    w.submit([{ kind: "task.reopen", task }]);
    await project();
    const open = fileOf(task);
    expect(open).toContain("## Earlier outcome\n\nShipped the fixture fix.");
    expect(open).toContain("## Earlier learnings\n\n- Check the fixture first.");
    expect(open).not.toContain("## Outcome");

    // Checked off again without a new outcome: the one there is still the earlier one.
    w.submit([{ kind: "task.complete", task }]);
    await project();
    const pending = fileOf(task);
    expect(pending).toContain("## Earlier outcome\n\nShipped the fixture fix.");
    expect(pending).not.toContain("## Outcome");
  });

  test("a dropped task says why it was dropped", async () => {
    const task = activeTask();
    w.submit([{ kind: "task.archive", task, reason: "The clinic changed vendors." }]);
    await project();
    expect(fileOf(task)).toContain("## Why it was dropped\n\nThe clinic changed vendors.");
  });

  test("a waiting task names what it waits on, and the file names the folder Open uses on each machine", async () => {
    const task = activeTask();
    w.submit([{ kind: "task.patch", task, set: { status: "waiting", waiting_on: "Tomas's review" } }]);
    w.submit([{ kind: "task.folder_set", task, path: "/srv/fixture/portal" }]);
    await project();
    const front = frontMatter(fileOf(task));
    expect(front["status"]).toBe("waiting");
    expect(front["waiting_on"]).toBe(`"Tomas's review"`);
    expect(front["folder"]).toBe("mira-desktop:/srv/fixture/portal");
  });

  test("a task without a folder of its own names its project's, and follows it when the project's changes", async () => {
    const row = w.reader
      .prepare(
        "SELECT t.id AS task, p.id AS project FROM tasks t JOIN projects p ON p.id = t.project_id " +
          "WHERE t.lifecycle = 'active' AND t.deleted_at IS NULL ORDER BY t.ref LIMIT 1",
      )
      .get<{ task: string; project: string }>();
    if (row === undefined) throw new Error("the sample has a task in a project");
    const p = w.projector();
    await p.start();
    await settle(p);
    w.submit([{ kind: "project.folder_set", project: row.project, path: "/srv/fixture/project" }]);
    await settle(p);
    expect(frontMatter(fileOf(row.task))["folder"]).toBe("mira-desktop:/srv/fixture/project");
    w.submit([{ kind: "task.folder_set", task: row.task, path: "/srv/fixture/own" }]);
    await settle(p);
    expect(frontMatter(fileOf(row.task))["folder"]).toBe("mira-desktop:/srv/fixture/own");
  });
});

describe("[A1.5.projection.render] index.md gives a timed deadline the local day", () => {
  test("a task due at 00:30 on the 18th in Amsterdam is listed as due on the 18th", async () => {
    const task = activeTask();
    const at = Date.UTC(2026, 10, 17, 23, 30);
    w.submit([{ kind: "task.patch", task, set: { due: { at, tz: "Europe/Amsterdam" } } }]);
    await project("Europe/Amsterdam");
    const ref = catalogOf(w.dir).find((l) => l.id === task)?.path.split("/")[1]?.split("-");
    const line = readFileSync(join(w.dir, "index.md"), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`- [${ref?.[0] ?? ""}-${ref?.[1] ?? ""}]`));
    expect(line).toContain("due 2026-11-18");
  });
});

describe("[A1.5.projection.reconcile] a catalogued file that is not there comes back while the projection runs", () => {
  test("one file taken from the folder, then another task renamed: both files are there when it settles", async () => {
    const p = w.projector();
    await p.start();
    await settle(p);
    const [gone, renamed] = catalogOf(w.dir).filter((l) => l.path.startsWith("open/"));
    if (gone === undefined || renamed === undefined) throw new Error("two open tasks");
    const abs = join(w.dir, ...gone.path.split("/"));
    chmodSync(abs, 0o600);
    rmSync(abs);
    w.submit([{ kind: "task.patch", task: renamed.id, set: { title: "Renamed fixture task" } }]);
    await settle(p);
    expect(p.pending().dirty).toBe(false);
    for (const line of catalogOf(w.dir)) expect(inTree(w.dir, line.path), line.path).toBe(true);
    checkWatermark(w.dir, w.reader);
  });

  test("a file taken from the folder while nothing changes comes back", async () => {
    let now = Date.UTC(2026, 10, 23, 9);
    const p = w.projector({ now: () => now });
    await p.start();
    await settle(p);
    const [gone] = catalogOf(w.dir);
    if (gone === undefined) throw new Error("a task");
    const abs = join(w.dir, ...gone.path.split("/"));
    chmodSync(abs, 0o600);
    rmSync(abs);
    now += 60_000;
    await settle(p);
    expect(inTree(w.dir, gone.path)).toBe(true);
    checkWatermark(w.dir, w.reader);
  });
});
