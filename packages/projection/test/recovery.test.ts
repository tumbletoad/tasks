// The trusted state and the tree's folders (A1 3.13 rules 1, 2, 3 and 5): the record lives in
// machine state; one the projection could not write holds back the next batch; one that is missing,
// unreadable or of another identity starts a reconciliation from scratch that deletes nothing on
// its word; a retired file that could not go is tried again; and a folder of the tree that went
// missing or became a link is never followed, its link moved aside as it is, and what the record
// had below it rendered again. Fixture text only.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Tree, TrustedState } from "../src/index.ts";
import {
  catalogOf,
  checkWatermark,
  expectClean,
  expectSameTree,
  filesOf,
  inTree,
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

/**
 * Moves a folder. Windows refuses while another program (a virus scanner) holds a file in it that
 * was just written, so it is tried again, up to 50 times over at least 5 s.
 */
async function moveFolder(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Every path the catalogue names is a file in the tree, reached through real folders only. */
function expectCatalogInTree(dir: string): void {
  for (const line of catalogOf(dir)) expect(inTree(dir, line.path), line.path).toBe(true);
}

const freshRender = (): Promise<Map<string, string>> => w.fresh(join(root, `fresh-${String(n)}`));

const rescuedOf = (): Map<string, string> => filesOf(join(w.folder, "exchange", "rescued"));

const activeIds = (): string[] =>
  w.reader
    .prepare("SELECT id FROM tasks WHERE lifecycle = 'active' ORDER BY ref")
    .all<{ id: string }>()
    .map((row) => row.id);

describe("[A1.5.projection.recovery] the trusted state: an unwritten record holds back the next batch; a record missing, unreadable or of another identity reconciles from scratch and deletes nothing on its word; a retired file that could not go is tried again", () => {
  test("a record that could not be written is written before the next batch, and a kill then loses nothing", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [a, b] = activeIds();
    w.submit([{ kind: "task.patch", task: a ?? "", set: { title: "First renamed fixture" } }]);
    const write = vi.spyOn(TrustedState.prototype, "writeRecord").mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture"), { code: "ENOSPC" });
    });
    // The batch placed its files and reported them; only the record failed. It says so.
    await expect(first.step()).rejects.toMatchObject({ code: "ENOSPC" });
    expect(write).toHaveBeenCalled();
    // The journal stays until the record is written, and the projection has work to do.
    expect(existsSync(w.journal)).toBe(true);
    expect(first.pending().dirty).toBe(true);
    w.submit([{ kind: "task.patch", task: b ?? "", set: { summary: "Second fixture change" } }]);
    // The next batch writes the record first, then is killed right after its own journal.
    vi.spyOn(TrustedState.prototype, "writeJournal").mockImplementationOnce(() => {
      throw new Error("fixture kill");
    });
    await expect(first.step()).rejects.toThrow("fixture kill");
    vi.restoreAllMocks();
    const after = w.projector();
    const start = await after.start();
    expect(start.rescued).toBe(0);
    const reports = await settle(after);
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(0);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  for (const lost of ["missing", "unreadable"] as const) {
    test(`a ${lost} record: the tree is reconciled from scratch; files that hold what would be written are kept, an edited one is moved aside, nothing is deleted`, async () => {
      const first = w.projector();
      await first.start();
      await settle(first);
      const [line] = catalogOf(w.dir);
      const edited = join(w.dir, ...(line?.path ?? "").split("/"));
      chmodSync(edited, 0o600);
      writeFileSync(edited, "Edited while the record was lost.\n");
      // A file the projection wrote that no task names any more: unknown without the record.
      const stray = join(w.dir, "open", "M-999-an-older-render.md");
      writeFileSync(stray, "---\ngenerated: true\n---\n");
      if (lost === "missing") rmSync(w.record);
      else writeFileSync(w.record, "{ not json");
      const before = filesOf(w.dir).size;
      const after = w.projector();
      const start = await after.start();
      expect(start.rebuild).toBe(true);
      const reports = await settle(after);
      expect(reports.reduce((sum, r) => sum + r.removed, 0)).toBe(0);
      // Moved aside: the edited file, and the two root files whose header carries the time of
      // their render, so a fresh render never holds their bytes. The rest held exactly them.
      const rescued = rescuedOf();
      expect([...rescued.keys()].map((path) => path.split("/").slice(2).join("/")).sort()).toEqual(
        [".projection.json", "catalog.jsonl", line?.path ?? ""].sort(),
      );
      expect([...rescued.values()]).toContain("Edited while the record was lost.\n");
      expect(readFileSync(stray, "utf8")).toBe("---\ngenerated: true\n---\n");
      expect(filesOf(w.dir).size).toBe(before);
      checkWatermark(w.dir, w.reader);
    });
  }

  test("a record of another incarnation (a restore): every task again, the record's own unchanged files replaced or removed, an edited one moved aside", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const record = JSON.parse(readFileSync(w.record, "utf8")) as Record<string, unknown>;
    writeFileSync(w.record, JSON.stringify({ ...record, incarnation: "ai_other" }));
    const [, second] = catalogOf(w.dir);
    const edited = join(w.dir, ...(second?.path ?? "").split("/"));
    chmodSync(edited, 0o600);
    writeFileSync(edited, "Edited before the rebuild.\n");
    const again = w.projector();
    const start = await again.start();
    expect(start.rebuild).toBe(true);
    const reports = await settle(again);
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a retired file that could not be removed is a failure, and is tried again until it goes", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [a] = activeIds();
    const old = catalogOf(w.dir).find((line) => line.id === a)?.path ?? "";
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

describe("[A1.5.projection.folders] a folder of the tree that went missing or became a link is never followed: its link is moved aside as it is, and what the record had below it is rendered again", () => {
  test("a link where a folder of the tree was: a look or a removal never goes through it", () => {
    const space = join(root, `space-${String(n)}`);
    const dir = join(root, `view-${String(n)}`);
    const outside = join(root, `outside-${String(n)}`);
    for (const folder of [space, dir, outside]) mkdirSync(folder);
    const name = "M-1-fixture.md";
    writeFileSync(join(outside, name), "fixture");
    symlinkSync(outside, join(dir, "open"), LINK);
    const tree = new Tree({ spaceFolder: space, dir });
    expect(tree.look(`open/${name}`)).toEqual({ kind: "unreachable" });
    const owned = { sha256: "", size: 7 };
    expect(tree.remove(`open/${name}`, owned)).toBe("not-ours");
    expect(readFileSync(join(outside, name), "utf8")).toBe("fixture");
  });

  test("open/ moved away and a link put in its place while the projection runs: the link is moved aside, never followed, and every task in open/ is rendered again", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const outside = join(root, `moved-open-${String(n)}`);
    await moveFolder(join(w.dir, "open"), outside);
    const before = readdirSync(outside).sort();
    symlinkSync(outside, join(w.dir, "open"), LINK);
    const [a] = activeIds();
    w.submit([{ kind: "task.patch", task: a ?? "", set: { summary: "Folder fixture" } }]);
    const reports = await settle(projector);
    expect(reports.reduce((sum, r) => sum + r.failed, 0)).toBe(0);
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expect(lstatSync(join(w.dir, "open")).isDirectory()).toBe(true);
    // Nothing was written, moved or removed through the link.
    expect(readdirSync(outside).sort()).toEqual(before);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("open/ removed while nothing changes: the next start renders its files again", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    rmSync(join(w.dir, "open"), { recursive: true, force: true });
    const after = w.projector();
    const start = await after.start();
    expect(start.reconciled.queued).toBeGreaterThan(0);
    await settle(after);
    expectClean(w.dir);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("open/ swapped for a link while a batch waits on the writer: nothing is removed through it, and the tree is rendered again", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [a] = activeIds();
    const old = catalogOf(w.dir).find((line) => line.id === a)?.path ?? "";
    // Renamed: the batch writes its new file in open/, then retires the old one there.
    w.submit([{ kind: "task.patch", task: a ?? "", set: { title: "Swapped mid-batch" } }]);
    const outside = join(root, `swapped-open-${String(n)}`);
    let swapped = false;
    const projector = w.projector({
      writer: {
        projected: async (batch) => {
          const answer = w.writer.projected(batch);
          if (!swapped) {
            swapped = true;
            await moveFolder(join(w.dir, "open"), outside);
            symlinkSync(outside, join(w.dir, "open"), LINK);
          }
          return answer;
        },
        queueProjection: (keys) => Promise.resolve(w.writer.queueProjection(keys)),
      },
    });
    await projector.start();
    await projector.step();
    const kept = join(outside, old.split("/").at(-1) ?? "");
    // The old file the rename left behind is still where the link points: nothing was removed there.
    expect(existsSync(kept)).toBe(true);
    const contents = readdirSync(outside).sort();
    await settle(projector);
    expect(lstatSync(join(w.dir, "open")).isDirectory()).toBe(true);
    expect(readdirSync(outside).sort()).toEqual(contents);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("the tree's own folder replaced by a link: the link is moved aside, never followed, and the tree made again", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const outside = join(root, `moved-view-${String(n)}`);
    await moveFolder(w.dir, outside);
    const before = [...filesOf(outside).keys()].sort();
    symlinkSync(outside, w.dir, LINK);
    const after = w.projector();
    await after.start();
    const reports = await settle(after);
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expect(lstatSync(w.dir).isDirectory()).toBe(true);
    expect([...filesOf(outside).keys()].sort()).toEqual(before);
    expectCatalogInTree(w.dir);
    expectSameTree(treeOf(w.dir), await freshRender());
  });
});
