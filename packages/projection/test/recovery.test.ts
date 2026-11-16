// The trusted state and the tree's folders (A1 3.13 rules 1 to 5): the record lives in machine
// state; one the projection could not write holds back the next batch; one that is missing or
// unreadable starts a reconciliation from scratch that deletes nothing on its word, and so does a
// journal that is there and does not read back; one of another identity in the same folder keeps
// its files, proved by their bytes, and queues every task; a temporary file proves itself by its
// bytes, never by its name alone; what a batch moved aside is told from its rescue folders until a
// telling succeeds; a retired file that could not go is tried again; and a folder of the tree that
// went missing or became a link is never followed, its link moved aside as it is, and what the
// record had below it rendered again. Fixture text only.
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
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Tree, TrustedState, type Rescued } from "../src/index.ts";
import {
  catalogOf,
  checkWatermark,
  expectClean,
  expectSameTree,
  faultState,
  filesOf,
  holdOpen,
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

/** A batch's rescue stem as onRescued names it. */
const STEM_PATH = /^exchange\/rescued\/[0-9]{8}T[0-9]{9}Z-[0-9a-f]{4}$/;

const activeIds = (): string[] =>
  w.reader
    .prepare("SELECT id FROM tasks WHERE lifecycle = 'active' ORDER BY ref")
    .all<{ id: string }>()
    .map((row) => row.id);

describe("[A1.5.projection.recovery] the trusted state: an unwritten record holds back the next batch; a record missing or unreadable reconciles from scratch and deletes nothing on its word, and so does a journal that does not read back; one of another identity in the same folder queues every task; a leftover a person typed into is kept; rescues are told from their folders until saved; a retired file that could not go is tried again", () => {
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

  test("a short write of the trusted state, then a full volume, while a task is deleted: after the restart the task is gone from the catalogue and the tree", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [a] = activeIds();
    const path = catalogOf(w.dir).find((line) => line.id === a)?.path ?? "";
    w.submit([{ kind: "task.delete", task: a ?? "" }]);
    // The volume of the machine state fills: its first write takes half its bytes, every later
    // one fails. The space's database, elsewhere, keeps working.
    const end = faultState(w.state, (k) => (k === 1 ? "short" : "enospc"));
    try {
      await expect(first.step()).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      end();
    }
    // Space is freed and the service starts again.
    const after = w.projector();
    await after.start();
    await settle(after);
    expect(catalogOf(w.dir).map((line) => line.id)).not.toContain(a);
    expect(existsSync(join(w.dir, ...path.split("/")))).toBe(false);
    expectCatalogInTree(w.dir);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  for (const torn of ["cut short", "of another format", "not an object"] as const) {
    test(`a journal ${torn} is no "nothing pending": the start rebuilds every task, and a task its batch found gone leaves the catalogue`, async () => {
      const first = w.projector();
      await first.start();
      await settle(first);
      const [a] = activeIds();
      const path = catalogOf(w.dir).find((line) => line.id === a)?.path ?? "";
      w.submit([{ kind: "task.delete", task: a ?? "" }]);
      // The batch that found it gone was marked rendered by the writer; only its journal says
      // so, and that journal does not read back.
      w.writer.projected({ seq: w.writer.asOf().seq, keys: [a ?? ""] });
      const whole = { format: 1, temps: [], gone: [a], placing: {} };
      const text = JSON.stringify(whole);
      writeFileSync(
        w.journal,
        torn === "cut short"
          ? text.slice(0, -9)
          : torn === "of another format"
            ? JSON.stringify({ ...whole, format: 2 })
            : "[]",
      );
      const after = w.projector();
      const start = await after.start();
      expect(start.rebuild).toBe(true);
      expect(existsSync(w.journal)).toBe(false);
      const reports = await settle(after);
      expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(0);
      expect(catalogOf(w.dir).map((line) => line.id)).not.toContain(a);
      expect(existsSync(join(w.dir, ...path.split("/")))).toBe(false);
      expectCatalogInTree(w.dir);
      checkWatermark(w.dir, w.reader);
      expectSameTree(treeOf(w.dir), await freshRender());
    });
  }

  for (const [which, what, killed] of [
    ["journal", "folder", false],
    ["journal", "link", false],
    ["record", "folder", false],
    ["record", "link", false],
    ["journal", "folder", true],
    ["record", "link", true],
  ] as const) {
    const kill = killed ? ", also when killed right after the move," : "";
    test(`a ${what} at the ${which}'s path (a mistaken restore, a slip) is unknown and never removed: the start rebuilds every task, then moves it aside once, as it is, under a name that says so${kill} and the projection goes on`, async () => {
      const first = w.projector();
      await first.start();
      await settle(first);
      const [a] = activeIds();
      const path = catalogOf(w.dir).find((line) => line.id === a)?.path ?? "";
      // What only the lost state knew, already marked rendered by the writer: for a journal a
      // task its batch found gone, for a record a task that differs from its file.
      w.submit([
        which === "journal"
          ? { kind: "task.delete", task: a ?? "" }
          : { kind: "task.patch", task: a ?? "", set: { summary: "Known only to the record" } },
      ]);
      w.writer.projected({ seq: w.writer.asOf().seq, keys: [a ?? ""] });
      const at = which === "journal" ? w.journal : w.record;
      rmSync(at, { force: true });
      const theirs = join(root, `theirs-${String(n)}`);
      mkdirSync(theirs);
      writeFileSync(join(theirs, "notes.txt"), "A person's notes.\n");
      if (what === "folder") renameSync(theirs, at);
      else symlinkSync(theirs, at, LINK);
      const asideOf = (): string[] =>
        readdirSync(w.state).filter((name) => name.startsWith(`${basename(at)}.moved-aside-`));
      const moved: string[] = [];
      const onAside = (file: string): void => {
        moved.push(file);
      };
      if (killed) {
        // The start moves it aside, and the process ends at its next act: for a record before
        // the record is written, for a journal at the first batch's journal.
        let gone = false;
        const doomed = w.projector({
          onAside,
          at: (act) => {
            if (gone) throw new Error("fixture kill");
            if (act === "aside") gone = true;
          },
        });
        const run = async (): Promise<void> => {
          await doomed.start();
          await doomed.step();
        };
        await expect(run()).rejects.toThrow("fixture kill");
        expect(moved).toEqual([which]);
      }
      const after = w.projector({ onAside });
      const start = await after.start();
      // Unknown, it rebuilds; once moved aside, the queue the earlier start sent stands.
      if (!killed) expect(start.rebuild).toBe(true);
      await settle(after);
      // Moved aside once, beside its path, as it was: nothing in it removed, nothing followed.
      expect(moved).toEqual([which]);
      const [name] = asideOf();
      expect(asideOf()).toHaveLength(1);
      expect(name).toMatch(/\.moved-aside-[0-9]{8}T[0-9]{9}Z$/);
      const aside = join(w.state, name ?? "");
      if (what === "folder") {
        expect(lstatSync(aside).isDirectory()).toBe(true);
        expect(readFileSync(join(aside, "notes.txt"), "utf8")).toBe("A person's notes.\n");
      } else {
        expect(lstatSync(aside).isSymbolicLink()).toBe(true);
        expect(readdirSync(theirs)).toEqual(["notes.txt"]);
        expect(readFileSync(join(theirs, "notes.txt"), "utf8")).toBe("A person's notes.\n");
      }
      // The path is the projection's own again: its record, or no journal at rest.
      if (which === "record") expect(lstatSync(w.record).isFile()).toBe(true);
      else expect(existsSync(w.journal)).toBe(false);
      if (which === "journal") {
        expect(catalogOf(w.dir).map((line) => line.id)).not.toContain(a);
        expect(existsSync(join(w.dir, ...path.split("/")))).toBe(false);
      }
      expectClean(w.dir);
      expectCatalogInTree(w.dir);
      checkWatermark(w.dir, w.reader);
      expectSameTree(treeOf(w.dir), await freshRender());
      // Once: the next start moves nothing.
      await w.projector({ onAside }).start();
      expect(moved).toEqual([which]);
      expect(asideOf()).toEqual([name]);
    });
  }

  for (const lost of ["missing", "of another incarnation"] as const) {
    test(`a record ${lost}, and a kill right after the start wrote its new one: the next start still renders every task`, async () => {
      const first = w.projector();
      await first.start();
      await settle(first);
      if (lost === "missing") rmSync(w.record);
      else {
        const record = JSON.parse(readFileSync(w.record, "utf8")) as Record<string, unknown>;
        writeFileSync(w.record, JSON.stringify({ ...record, incarnation: "ai_other" }));
      }
      // A task that differs from its file with no outbox row for it, as after a restore: only
      // the full rebuild renders it again.
      const [line, other] = catalogOf(w.dir);
      w.submit([{ kind: "task.patch", task: other?.id ?? "", set: { summary: "Restored state" } }]);
      w.writer.projected({ seq: w.writer.asOf().seq, keys: [other?.id ?? ""] });
      // And a file a person removed meanwhile.
      const abs = join(w.dir, ...(line?.path ?? "").split("/"));
      chmodSync(abs, 0o600);
      rmSync(abs);
      // The start writes its new record, then is killed at its next act.
      let saved = false;
      const doomed = w.projector({
        at: (act) => {
          if (saved) throw new Error("fixture kill");
          if (act === "record") saved = true;
        },
      });
      await expect(doomed.start()).rejects.toThrow("fixture kill");
      const after = w.projector();
      await after.start();
      await settle(after);
      expect(catalogOf(w.dir)).toHaveLength(12);
      expectCatalogInTree(w.dir);
      checkWatermark(w.dir, w.reader);
      expectSameTree(treeOf(w.dir), await freshRender());
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

  test("a temporary file a kill left, edited by a person before the restart, is kept: only one that proves itself goes", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [a] = activeIds();
    w.submit([{ kind: "task.patch", task: a ?? "", set: { summary: "Left as a temporary file" } }]);
    // Killed right before its first rename: the temporary file is whole, and the journal names it.
    let dead = false;
    const refuse = (): Promise<never> => Promise.reject(new Error("fixture kill"));
    const doomed = w.projector({
      at: (act) => {
        if (dead || act === "rename") {
          dead = true;
          throw new Error("fixture kill");
        }
      },
      writer: {
        projected: (batch) => (dead ? refuse() : Promise.resolve(w.writer.projected(batch))),
        queueProjection: (keys) =>
          dead ? refuse() : Promise.resolve(w.writer.queueProjection(keys)),
      },
    });
    await doomed.start();
    await doomed.step().catch(() => undefined);
    expect(dead).toBe(true);
    const temps = [...filesOf(w.dir).keys()].filter((path) => path.endsWith(".tmp"));
    expect(temps).toHaveLength(1);
    const temp = join(w.dir, ...(temps[0] ?? "").split("/"));
    chmodSync(temp, 0o600);
    writeFileSync(temp, "A person's text, typed into a leftover.\n");
    const after = w.projector();
    expect((await after.start()).temps).toBe(0);
    expect(readFileSync(temp, "utf8")).toBe("A person's text, typed into a leftover.\n");
    await settle(after);
    expect(readFileSync(temp, "utf8")).toBe("A person's text, typed into a leftover.\n");
    rmSync(temp);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("what a batch moved aside is told from its rescue folders: also when its record could not be written, again after a kill before the record kept it, and again at the next batch and the next start while the receiver cannot record it; never again once recorded", async () => {
    const told: Rescued[] = [];
    let refuse = false;
    const onRescued = (r: Rescued): Promise<void> => {
      if (refuse) return Promise.reject(Object.assign(new Error("fixture"), { code: "EBUSY" }));
      told.push(r);
      return Promise.resolve();
    };
    const one = { stem: expect.stringMatching(STEM_PATH) as string, files: 1 };
    const first = w.projector({ onRescued });
    await first.start();
    await settle(first);
    const [a, b, c, d, e] = catalogOf(w.dir);
    const edit = (line: { id: string; path: string } | undefined, text: string): void => {
      const abs = join(w.dir, ...(line?.path ?? "").split("/"));
      chmodSync(abs, 0o600);
      writeFileSync(abs, text);
      w.submit([{ kind: "task.patch", task: line?.id ?? "", set: { summary: text.trim() } }]);
    };
    // A batch whose record then could not be written tells once.
    edit(a, "A person's edit before a failed batch.\n");
    vi.spyOn(TrustedState.prototype, "writeRecord").mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture"), { code: "ENOSPC" });
    });
    await expect(first.step()).rejects.toMatchObject({ code: "ENOSPC" });
    vi.restoreAllMocks();
    expect(told).toEqual([one]);
    await settle(first);
    expect(told).toHaveLength(1);
    // Told, then killed before the record kept it: the next start tells it again (at least once;
    // the service keeps one entry per stem).
    edit(b, "A person's edit before a kill.\n");
    let armed = false;
    const doomed = w.projector({
      onRescued,
      at: (act) => {
        if (armed && act === "record") throw new Error("fixture kill");
      },
    });
    await doomed.start();
    armed = true;
    await expect(doomed.step()).rejects.toThrow();
    expect(told).toHaveLength(2);
    const again = w.projector({ onRescued });
    expect((await again.start()).rescued).toBe(1);
    expect(told).toHaveLength(3);
    expect(told[2]).toEqual(told[1]);
    await settle(again);
    // The receiver cannot record it: the stem stays untold; the next batch tells again.
    refuse = true;
    edit(c, "A person's edit while the settings are locked.\n");
    await settle(again);
    w.submit([{ kind: "task.patch", task: d?.id ?? "", set: { summary: "Still locked" } }]);
    await settle(again);
    expect(told).toHaveLength(3);
    refuse = false;
    w.submit([{ kind: "task.patch", task: d?.id ?? "", set: { summary: "Unlocked" } }]);
    await settle(again);
    expect(told).toHaveLength(4);
    expect(told[3]).toEqual(one);
    expect(told[3]?.stem).not.toBe(told[0]?.stem);
    // And the next start tells one its batch could not.
    refuse = true;
    edit(e, "A person's edit before a restart.\n");
    await settle(again);
    expect(told).toHaveLength(4);
    refuse = false;
    const after = w.projector({ onRescued });
    expect((await after.start()).rescued).toBe(1);
    expect(told).toHaveLength(5);
    // Never again once recorded.
    const last = w.projector({ onRescued });
    expect((await last.start()).rescued).toBe(0);
    await settle(last);
    expect(told).toHaveLength(5);
    expect(new Set(told.map((r) => r.stem)).size).toBe(4);
    expect([...rescuedOf().values()].sort()).toEqual([
      "A person's edit before a failed batch.\n",
      "A person's edit before a kill.\n",
      "A person's edit before a restart.\n",
      "A person's edit while the settings are locked.\n",
    ]);
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

  test("a retired file held open while the projection reconciles stays its own: it goes once it is let go", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [a] = activeIds();
    const old = catalogOf(w.dir).find((line) => line.id === a)?.path ?? "";
    const oldAbs = join(w.dir, ...old.split("/"));
    // Renamed while its old file is held open: the batch places the new file and cannot remove
    // the old one; the next batch and a restart reconcile while it is still held.
    w.submit([{ kind: "task.patch", task: a ?? "", set: { title: "Held while retired" } }]);
    const again = w.projector();
    const release = holdOpen(oldAbs);
    try {
      expect((await projector.step()).failed).toBe(1);
      await projector.step();
      await again.start();
      await again.step();
    } finally {
      release();
    }
    expect(again.pending().dirty).toBe(true);
    await settle(again);
    expect(existsSync(oldAbs)).toBe(false);
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
