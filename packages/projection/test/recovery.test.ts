// The record describes the disk (A1 3.13 "The record", "A kill", "Folders of the tree"): when the
// projection cannot be sure it does, it does not go on as if it did. A record that could not be
// written holds back the next batch, an unreadable journal rebuilds, a retired file that could not
// go is tried again, and a folder of the tree that went missing or became a link is never followed
// and rebuilds the tree, so no catalogue names a file that is not there. Fixture text only.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { JOURNAL_FILE, RECORD_FILE, sha256 } from "../src/index.ts";
import { Tree } from "../src/tree.ts";
import {
  checkWatermark,
  expectClean,
  expectSameTree,
  filesOf,
  settle,
  treeOf,
  world,
  type World,
} from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-recovery-"));
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
  w = await world(folder, 12);
});
afterEach(() => {
  vi.restoreAllMocks();
  w.close();
});

const LINK = process.platform === "win32" ? "junction" : "dir";

interface Line {
  readonly id: string;
  readonly path: string;
}

const catalog = (dir: string): Line[] =>
  readFileSync(join(dir, "catalog.jsonl"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Line);

/** Every path the catalogue names is a file in the tree, reached through real folders only. */
function expectCatalogInTree(dir: string): void {
  for (const line of catalog(dir)) {
    const parts = line.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const folder = lstatSync(join(dir, ...parts.slice(0, i)), { throwIfNoEntry: false });
      expect(folder?.isDirectory(), `${line.path}: a real folder`).toBe(true);
    }
    expect(lstatSync(join(dir, ...parts), { throwIfNoEntry: false })?.isFile(), line.path).toBe(
      true,
    );
  }
}

async function freshRender(): Promise<Map<string, string>> {
  const dir = join(root, `fresh-${String(n)}`);
  const fresh = w.projector({ dir });
  await fresh.start();
  await settle(fresh);
  return treeOf(dir);
}

/** The tree without the rescue's traces: what the database alone gives. */
const recordTasks = (dir: string): Record<string, { path: string; sha256: string }> =>
  (
    JSON.parse(readFileSync(join(dir, RECORD_FILE), "utf8")) as {
      tasks: Record<string, { path: string; sha256: string }>;
    }
  ).tasks;

const activeIds = (): string[] =>
  w.reader
    .prepare("SELECT id FROM tasks WHERE lifecycle = 'active' ORDER BY ref")
    .all<{ id: string }>()
    .map((row) => row.id);

describe("[A1.5.projection.recovery] the record describes the disk: an unwritten record holds back the next batch, an unreadable journal rebuilds, a retired file that could not go is tried again", () => {
  test("a record that could not be written is written before the next batch, and a kill then loses nothing", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [a, b] = activeIds();
    w.submit([{ kind: "task.patch", task: a ?? "", set: { title: "First renamed fixture" } }]);
    const write = vi.spyOn(Tree.prototype, "writeRecord").mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture"), { code: "ENOSPC" });
    });
    // The batch placed its files and reported them; only the record failed. It says so.
    await expect(first.step()).rejects.toMatchObject({ code: "ENOSPC" });
    expect(write).toHaveBeenCalled();
    // The journal stays until the record is written, and the projection has work to do.
    expect(existsSync(join(w.dir, JOURNAL_FILE))).toBe(true);
    expect(first.pending().dirty).toBe(true);
    w.submit([{ kind: "task.patch", task: b ?? "", set: { summary: "Second fixture change" } }]);
    // The next batch is killed right after it wrote its own journal.
    let hit: () => void = () => undefined;
    const killed = new Promise<void>((resolve) => {
      hit = resolve;
    });
    vi.spyOn(Tree.prototype, "writeJournal").mockImplementationOnce(function (this: Tree, j) {
      // The inner call is the spy's own implementation again: the original.
      this.writeJournal(j);
      hit();
      throw new Error("fixture kill");
    });
    await Promise.race([first.step().catch(() => undefined), killed]);
    vi.restoreAllMocks();

    const after = w.projector();
    await after.start();
    await settle(after);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a journal that cannot be read rebuilds the tree: the task the killed batch reported shows as it is now", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [a] = activeIds();
    w.submit([{ kind: "task.patch", task: a ?? "", set: { title: "Journal fixture changed" } }]);
    let hit: () => void = () => undefined;
    const killed = new Promise<void>((resolve) => {
      hit = resolve;
    });
    const doomed = w.projector({
      at: (point) => {
        if (point !== "reported") return;
        hit();
        return new Promise<void>(() => undefined);
      },
    });
    await doomed.start();
    void doomed.step();
    await killed;
    writeFileSync(join(w.dir, JOURNAL_FILE), "{");

    const after = w.projector();
    const start = await after.start();
    expect(start.rebuild).toBe(true);
    expect(existsSync(join(w.dir, ".projection.json"))).toBe(false);
    const reports = await settle(after);
    expect(reports.reduce((sum, r) => sum + r.failed, 0)).toBe(0);
    const line = catalog(w.dir).find((entry) => entry.id === a);
    expect(line?.path).toMatch(/-journal-fixture-changed\.md$/);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a retired file that could not be removed is a failure, and is tried again until it goes", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [a] = activeIds();
    const old = recordTasks(w.dir)[a ?? ""]?.path ?? "";
    w.submit([{ kind: "task.patch", task: a ?? "", set: { title: "Retirement fixture" } }]);
    // The only removal of the batch is the old file's: it fails as a file held open on Windows does.
    const remove = vi.spyOn(Tree.prototype, "remove").mockImplementation(() => {
      throw Object.assign(new Error("fixture"), { code: "EBUSY" });
    });
    const report = await projector.step();
    expect(remove.mock.calls.map(([path]) => path)).toEqual([old]);
    expect(report.failed).toBe(1);
    expect(report.code).toBe("EBUSY");
    expect(existsSync(join(w.dir, ...old.split("/")))).toBe(true);
    expect(projector.pending().dirty).toBe(true);
    // A restart still knows it.
    const again = w.projector();
    await again.start();
    expect(again.pending().dirty).toBe(true);
    vi.restoreAllMocks();
    const reports = await settle(again);
    expect(reports.reduce((sum, r) => sum + r.removed, 0)).toBe(1);
    expect(existsSync(join(w.dir, ...old.split("/")))).toBe(false);
    expect(again.pending().dirty).toBe(false);
    expectSameTree(treeOf(w.dir), await freshRender());
  });
});

describe("[A1.5.projection.folders] a folder of the tree that went missing or became a link is never followed, and the tree is rebuilt so the catalogue names only files that are there", () => {
  test("a link where a folder of the tree was: a removal never goes through it", () => {
    const space = join(root, `space-${String(n)}`);
    const dir = join(root, `view-${String(n)}`);
    const outside = join(root, `outside-${String(n)}`);
    for (const folder of [space, dir, outside]) mkdirSync(folder);
    const name = "M-1-fixture.md";
    writeFileSync(join(outside, name), "fixture");
    symlinkSync(outside, join(dir, "open"), LINK);
    const tree = new Tree({ spaceFolder: space, dir, now: () => 0 });
    expect(tree.hashOf(`open/${name}`)).toBeUndefined();
    expect(tree.remove(`open/${name}`, (hash) => hash === sha256("fixture"))).toBe("missing");
    expect(readFileSync(join(outside, name), "utf8")).toBe("fixture");
  });

  test("open/ moved away and a link put in its place: the link is rescued, never followed, and every task is rendered again", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const outside = join(root, `moved-open-${String(n)}`);
    renameSync(join(w.dir, "open"), outside);
    const before = readdirSync(outside).sort();
    symlinkSync(outside, join(w.dir, "open"), LINK);
    const [a] = activeIds();
    w.submit([{ kind: "task.patch", task: a ?? "", set: { summary: "Folder fixture" } }]);
    const reports = await settle(projector);
    expect(reports.reduce((sum, r) => sum + r.failed, 0)).toBe(0);
    expect(lstatSync(join(w.dir, "open")).isDirectory()).toBe(true);
    // Nothing was written, moved or removed through the link.
    expect(readdirSync(outside).sort()).toEqual(before);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("open/ removed while the projection runs: the tree is rebuilt, not left naming files that are gone", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    rmSync(join(w.dir, "open"), { recursive: true, force: true });
    // Nothing changed in the space: the projection notices the folder by itself.
    expect(projector.pending().dirty).toBe(true);
    await settle(projector);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("the projection's folder removed while it runs: it is made again and rebuilt", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    rmSync(w.dir, { recursive: true, force: true });
    expect(projector.pending().dirty).toBe(true);
    await settle(projector);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("during a rebuild the folder holds no catalogue or index that names the old tree", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const recordPath = join(w.dir, RECORD_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath, JSON.stringify({ ...record, incarnation: "ai_other" }));
    const again = w.projector();
    const start = await again.start();
    expect(start.rebuild).toBe(true);
    const files = [...filesOf(w.dir).keys()];
    expect(files).not.toContain(".projection.json");
    expect(files).not.toContain("catalog.jsonl");
    expect(files).not.toContain("index.md");
    await settle(again);
    expectCatalogInTree(w.dir);
    expectSameTree(treeOf(w.dir), await freshRender());
  });
});
