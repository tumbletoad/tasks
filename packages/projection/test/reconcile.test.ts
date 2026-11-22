// Reconciliation, file by file (A1 3.13 rule 5): every file of the trusted record is looked at on
// disk at start, after a batch that failed, and on `ttasks view rebuild`; a task's file that is
// missing or different is rendered again (a different file moved aside first), a root file is
// placed again, and a file the record does not hold is left alone. A rebuild of an intact tree
// writes and removes nothing. Fixture text only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { RETRY_MAX_MS, TrustedState, type Reconciled } from "../src/index.ts";
import {
  catalogOf,
  checkWatermark,
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
  root = mkdtempSync(join(tmpdir(), "projection-reconcile-"));
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
  w.close();
});

const freshRender = (): Promise<Map<string, string>> => w.fresh(join(root, `fresh-${String(n)}`));
const rescuedOf = (): Map<string, string> => filesOf(join(w.folder, "exchange", "rescued"));

/** A person removes a generated file, as they may, read-only or not. */
function remove(path: string): void {
  const abs = join(w.dir, ...path.split("/"));
  chmodSync(abs, 0o600);
  rmSync(abs);
}

function edit(path: string, text: string): void {
  const abs = join(w.dir, ...path.split("/"));
  chmodSync(abs, 0o600);
  writeFileSync(abs, text);
}

describe("[A1.5.projection.reconcile] reconciliation file by file: what is missing or different is rendered again, at start, after a failed batch and on rebuild; nothing the record does not hold is touched", () => {
  test("a generated file deleted while the projection runs comes back at the next start", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    const [line] = catalogOf(w.dir);
    remove(line?.path ?? "");
    const after = w.projector();
    const start = await after.start();
    expect(start.reconciled).toMatchObject({ full: false, queued: 1, forgotten: 0 });
    await settle(after);
    expect(inTree(w.dir, line?.path ?? "")).toBe(true);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a batch that failed reconciles before the next one: a file deleted meanwhile comes back without a restart", async () => {
    let clock = Date.now();
    const projector = w.projector({ now: () => clock });
    await projector.start();
    await settle(projector);
    const [a, b] = catalogOf(w.dir);
    remove(a?.path ?? "");
    // The second task's file is the person's now, and nothing can be moved aside: its batch fails.
    edit(b?.path ?? "", "A person's edit.\n");
    writeFileSync(join(w.folder, "exchange"), "Not a folder.\n");
    w.submit([{ kind: "task.patch", task: b?.id ?? "", set: { summary: "Blocked" } }]);
    expect((await projector.step()).failed).toBe(1);
    const next = await projector.step();
    expect(next.reconciled).toMatchObject({ full: false });
    expect(inTree(w.dir, a?.path ?? "")).toBe(true);
    rmSync(join(w.folder, "exchange"));
    // The blocked task waits its pause (rule 7), then goes through.
    clock += RETRY_MAX_MS;
    await settle(projector);
    expect([...rescuedOf().values()]).toEqual(["A person's edit.\n"]);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a rebuild looks at every file and queues every task: a deleted file comes back, an edited one is moved aside, a file the record does not hold stays", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [a, b] = catalogOf(w.dir);
    remove(a?.path ?? "");
    edit(b?.path ?? "", "Edited before the rebuild.\n");
    const stray = join(w.dir, "open", "M-99-looks-generated.md");
    writeFileSync(stray, "---\ngenerated: true\n---\n");
    projector.rebuild();
    expect(projector.pending().dirty).toBe(true);
    const reports = await settle(projector);
    expect(reports[0]?.reconciled).toMatchObject({ full: true, checked: 16, queued: 12 });
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expect(reports.reduce((sum, r) => sum + r.removed, 0)).toBe(0);
    expect([...rescuedOf().values()]).toEqual(["Edited before the rebuild.\n"]);
    expect(readFileSync(stray, "utf8")).toBe("---\ngenerated: true\n---\n");
    rmSync(stray);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a rebuild is answered as soon as its reconciliation ran, whatever the batch does next, and one cut off by a failure runs again", async () => {
    const seen: Reconciled[] = [];
    let refuse = false;
    const projector = w.projector({
      onReconciled: (r) => seen.push(r),
      writer: {
        projected: (batch) => Promise.resolve(w.writer.projected(batch)),
        queueProjection: (keys) =>
          // The writer refuses the rebuild's queue once, as a busy writer can.
          keys === undefined && refuse
            ? ((refuse = false),
              Promise.reject(Object.assign(new Error("fixture"), { code: "STORAGE_OVERLOADED" })))
            : Promise.resolve(w.writer.queueProjection(keys)),
      },
    });
    await projector.start();
    await settle(projector);
    seen.length = 0;
    projector.rebuild();
    refuse = true;
    await expect(projector.step()).rejects.toMatchObject({ code: "STORAGE_OVERLOADED" });
    expect(seen.filter((r) => r.full)).toEqual([]);
    // Still asked for: the next batch runs it, and the batch's own failure does not hide it.
    vi.spyOn(TrustedState.prototype, "writeRecord").mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture"), { code: "EPERM" });
    });
    await expect(projector.step()).rejects.toMatchObject({ code: "EPERM" });
    expect(seen.filter((r) => r.full)).toHaveLength(1);
    vi.restoreAllMocks();
    await settle(projector);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a rebuild asked for while a failing batch waits on the writer stays a full one", async () => {
    const seen: Reconciled[] = [];
    let during: (() => void) | undefined;
    const projector = w.projector({
      onReconciled: (r) => seen.push(r),
      writer: {
        projected: (batch) => {
          const answer = w.writer.projected(batch);
          const act = during;
          during = undefined;
          act?.();
          return Promise.resolve(answer);
        },
        queueProjection: (keys) => Promise.resolve(w.writer.queueProjection(keys)),
      },
    });
    await projector.start();
    await settle(projector);
    seen.length = 0;
    // The task's file is the person's now, and nothing can be moved aside: its batch fails.
    const [a] = catalogOf(w.dir);
    edit(a?.path ?? "", "A person's edit.\n");
    writeFileSync(join(w.folder, "exchange"), "Not a folder.\n");
    w.submit([{ kind: "task.patch", task: a?.id ?? "", set: { summary: "Blocked" } }]);
    during = () => {
      projector.rebuild();
    };
    expect((await projector.step()).failed).toBe(1);
    rmSync(join(w.folder, "exchange"));
    const next = await projector.step();
    expect(next.reconciled).toMatchObject({ full: true });
    expect(seen.filter((r) => r.full)).toHaveLength(1);
    await settle(projector);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a generated file of any size proves itself: one over 16 MiB is left by a rebuild and retired by a rename, never moved aside", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [a] = catalogOf(w.dir);
    // 260 notes of 64 KiB, as many as a request holds at a time: the file grows past 16 MiB.
    const body = `${"Long fixture note ".repeat(3_640)}end`;
    for (let i = 0; i < 260; i += 7) {
      w.submit(
        Array.from({ length: Math.min(7, 260 - i) }, () => ({
          kind: "note.add" as const,
          task: a?.id ?? "",
          body,
        })),
      );
    }
    await settle(projector);
    const big = join(w.dir, ...(a?.path ?? "").split("/"));
    expect(statSync(big).size).toBeGreaterThan(16 * 1024 * 1024);
    projector.rebuild();
    const rebuilt = await settle(projector);
    expect(rebuilt.reduce((sum, r) => sum + r.rescued + r.removed + r.failed, 0)).toBe(0);
    w.submit([{ kind: "task.patch", task: a?.id ?? "", set: { title: "Renamed large fixture" } }]);
    const renamed = await settle(projector);
    expect(renamed.reduce((sum, r) => sum + r.rescued, 0)).toBe(0);
    expect(renamed.reduce((sum, r) => sum + r.removed, 0)).toBe(1);
    expect(existsSync(big)).toBe(false);
    expect(existsSync(join(w.folder, "exchange"))).toBe(false);
    expectSameTree(treeOf(w.dir), await freshRender());
  }, 120_000);

  test("a rebuild of an intact tree writes nothing, removes nothing and moves nothing aside", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const before = treeOf(w.dir);
    projector.rebuild();
    const reports = await settle(projector);
    const sum = (key: "written" | "removed" | "rescued" | "failed"): number =>
      reports.reduce((total, r) => total + r[key], 0);
    // Only the root files whose header carries the time are written again.
    expect(sum("written")).toBeLessThanOrEqual(2);
    expect(sum("removed") + sum("rescued") + sum("failed")).toBe(0);
    expectSameTree(treeOf(w.dir), before);
  });

  test("a root file deleted or edited is placed again at the next start, the edit moved aside", async () => {
    const first = w.projector();
    await first.start();
    await settle(first);
    remove("index.md");
    edit("catalog.jsonl", "A person's catalogue.\n");
    const after = w.projector();
    await after.start();
    expect(after.pending().dirty).toBe(true);
    await settle(after);
    expect(existsSync(join(w.dir, "index.md"))).toBe(true);
    expect([...rescuedOf().values()]).toEqual(["A person's catalogue.\n"]);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });
});
