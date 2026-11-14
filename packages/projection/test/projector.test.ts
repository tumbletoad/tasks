// The projection over a real space (A1 3.13, A7 3.10 M3.10's Verify line): after quiescence the
// tree equals a fresh render, the watermark never covers an unrendered task, batches cross moves,
// files are read-only, and a person's edit is rescued, never lost. Fixture text only.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Id } from "@tasks/storage";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { projectionFolder, RECORD_FILE } from "../src/index.ts";
import {
  checkWatermark,
  expectClean,
  expectSameTree,
  filesOf,
  frontMatter,
  settle,
  taskIds,
  treeOf,
  world,
  type World,
} from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-"));
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
  w = await world(folder);
});
afterEach(() => {
  w.close();
});

/** A fresh render of the space as it is now, in a folder of its own. */
async function freshRender(): Promise<Map<string, string>> {
  const dir = join(root, `fresh-${String(n)}`);
  const fresh = w.projector({ dir });
  await fresh.start();
  await settle(fresh);
  return treeOf(dir);
}

const catalog = (dir: string): { id?: string; path?: string; kind?: string }[] =>
  readFileSync(join(dir, "catalog.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id?: string; path?: string; kind?: string });

describe("[A1.5.projection.fresh] after quiescence the projection equals a fresh render, and its watermark never covers an unrendered task", () => {
  test("the sample space: every task is in the catalogue, every file is read-only, the tree equals a fresh render", async () => {
    const projector = w.projector();
    const start = await projector.start();
    expect(start.rebuild).toBe(true);
    await settle(projector);
    const lastSeq = Number(w.reader.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
    expect(checkWatermark(w.dir, w.reader)).toBe(lastSeq);
    const ids = taskIds(w.reader);
    const lines = catalog(w.dir);
    expect(lines[0]?.kind).toBe("header");
    expect(
      lines
        .slice(1)
        .map((line) => line.id)
        .sort(),
    ).toEqual([...ids].sort());
    const files = filesOf(w.dir);
    expect(files.has("README.md") && files.has("index.md")).toBe(true);
    // The sample has completed tasks: they live under completed/<year>/.
    expect(
      [...files.keys()].some((path) => /^completed\/2026\/M-\d+-[a-z0-9-]+\.md$/.test(path)),
    ).toBe(true);
    for (const path of files.keys()) {
      if (path === RECORD_FILE) continue;
      const mode = statSync(join(w.dir, ...path.split("/"))).mode;
      if (process.platform === "win32") expect(mode & 0o200, path).toBe(0);
      else expect(mode & 0o777, path).toBe(0o400);
    }
    expectClean(w.dir);
    const live = treeOf(w.dir);
    expectSameTree(treeOf(w.dir), await freshRender());
    expectSameTree(treeOf(w.dir), live);
  });

  test("600 dirty tasks in batches of 200, with renames, completions and reopenings crossing batch boundaries", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    // 600 more tasks, then changes that move files while the batches run.
    for (let i = 0; i < 60; i += 1) {
      w.submit(
        Array.from({ length: 10 }, (_, j) => ({
          kind: "task.create" as const,
          title: `Batch fixture ${String(i * 10 + j)}`,
        })),
      );
    }
    const ids = taskIds(w.reader);
    let steps = 0;
    while (projector.pending().dirty) {
      const report = await projector.step();
      steps += 1;
      expect(report.failed).toBe(0);
      checkWatermark(w.dir, w.reader);
      if (steps <= 3) {
        // Mid-run: rename one task, complete one, reopen one: each moves its file.
        const active = w.reader
          .prepare("SELECT id FROM tasks WHERE lifecycle = 'active' ORDER BY ref")
          .all<{ id: string }>()
          .map((row) => row.id);
        const pick = (k: number): string => active[(steps * 97 + k) % active.length] ?? "";
        w.submit([
          { kind: "task.patch", task: pick(1), set: { title: `Renamed in step ${String(steps)}` } },
        ]);
        w.submit([{ kind: "task.complete", task: pick(2) }]);
        const done = w.reader
          .prepare("SELECT id FROM tasks WHERE lifecycle = 'completed' ORDER BY ref LIMIT 1")
          .get()?.["id"];
        if (typeof done === "string") w.submit([{ kind: "task.reopen", task: done }]);
        checkWatermark(w.dir, w.reader);
      }
      if (steps > 50) throw new Error("no quiescence");
    }
    expect(steps).toBeGreaterThanOrEqual(3);
    expectClean(w.dir);
    expect(catalog(w.dir).length - 1).toBe(ids.length);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a launch's commit moves no task's file, and the watermark still reaches last_seq", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const before = treeOf(w.dir);
    const [first] = catalog(w.dir).slice(1);
    const version = Number(
      w.reader.prepare("SELECT version FROM tasks WHERE id = $id").get({ id: first?.id ?? "" })?.[
        "version"
      ],
    );
    // A launch is no child of its task (A1 3.6): its commit writes no projection row.
    w.submit([
      {
        kind: "launch.create",
        task: (first?.id ?? "") as Id<"t">,
        instance: "codex-work",
        route: "terminal",
        place: null,
        task_version: version,
        brief_hash: "a1b2c3d4".repeat(8),
      },
    ]);
    const lastSeq = Number(w.reader.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
    expect(w.reader.prepare("SELECT count(*) AS n FROM outbox").get()?.["n"]).toBe(0);
    expect(projector.pending().dirty).toBe(true);
    await settle(projector);
    expect(checkWatermark(w.dir, w.reader)).toBe(lastSeq);
    const after = treeOf(w.dir);
    for (const [path, text] of before) {
      if (path.endsWith(".md")) expect(after.get(path), path).toBe(text);
    }
  });
});

describe("[A1.5.projection.rescue] a file a person edited is moved to exchange/rescued, never lost, and the projection writes only in its folder", () => {
  test("an edited task file is rescued with its edit and replaced; an unknown file elsewhere is left alone", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [first] = catalog(w.dir).slice(1);
    const path = first?.path ?? "";
    const abs = join(w.dir, ...path.split("/"));
    chmodSync(abs, 0o600);
    writeFileSync(abs, "My own notes, typed into the generated file.\n");
    const stray = join(w.dir, "open", "notes-of-mine.txt");
    writeFileSync(stray, "Not the projection's.\n");
    // The task changes, so its file is rendered again.
    w.submit([
      { kind: "task.patch", task: first?.id ?? "", set: { summary: "Changed after the edit" } },
    ]);
    const reports = await settle(projector);
    const rescued = reports.find((r) => r.rescued > 0);
    expect(rescued?.rescued).toBe(1);
    const folder = rescued?.rescuedFolder ?? "";
    expect(folder).toMatch(/^exchange\/rescued\/\d{8}T\d{9}Z(-\d+)?$/);
    const kept = join(w.folder, ...folder.split("/"), ...path.split("/"));
    expect(readFileSync(kept, "utf8")).toBe("My own notes, typed into the generated file.\n");
    // The rescued copy is the person's: writable.
    expect(statSync(kept).mode & 0o200).not.toBe(0);
    expect(readFileSync(abs, "utf8")).toContain("Changed after the edit");
    expect(readFileSync(stray, "utf8")).toBe("Not the projection's.\n");
    checkWatermark(w.dir, w.reader);
  });

  test("a person's file where a task's file goes, and a link where a folder goes, are rescued, never followed", async () => {
    const outside = join(root, `outside-${String(n)}`);
    mkdirSync(outside);
    mkdirSync(w.dir);
    // A link in place of open/: writing through it would write outside the tree.
    symlinkSync(outside, join(w.dir, "open"), process.platform === "win32" ? "junction" : "dir");
    const projector = w.projector();
    const start = await projector.start();
    await settle(projector);
    expect(readdirOf(outside)).toEqual([]);
    expect(lstatSync(join(w.dir, "open")).isDirectory()).toBe(true);
    expect(start.rebuild).toBe(true);
    // A file of the person's at the path of a task's file.
    const [first] = catalog(w.dir).slice(1);
    const path = first?.path ?? "";
    const abs = join(w.dir, ...path.split("/"));
    chmodSync(abs, 0o600);
    rmSync(abs);
    writeFileSync(abs, "Mine.\n");
    w.submit([{ kind: "task.patch", task: first?.id ?? "", set: { summary: "Rendered again" } }]);
    const reports = await settle(projector);
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toContain("Rendered again");
  });

  test("projection.dir is outside the space's folder and does not hold it", () => {
    const space = join(root, "space-a");
    expect(projectionFolder(space)).toBe(join(space, "view"));
    expect(projectionFolder(space, join(root, "elsewhere"))).toBe(join(root, "elsewhere"));
    expect(projectionFolder(space, join(space, "view"))).toBe(join(space, "view"));
    const refused = (dir: string): void => {
      expect(() => projectionFolder(space, dir)).toThrow(
        expect.objectContaining({ code: "EINVAL" }),
      );
    };
    refused(space);
    refused(root);
    refused(join(space, "backups"));
    refused(join(space, "view", "deeper"));
    refused("relative/view");
  });

  test("a tree of another space or incarnation is rebuilt: its files that still hold what was written go, an edited one is rescued", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    // The record claims another incarnation, as after a restore.
    const recordPath = join(w.dir, RECORD_FILE);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath, JSON.stringify({ ...record, incarnation: "ai_other" }));
    const [first, second] = catalog(w.dir).slice(1);
    const edited = join(w.dir, ...(second?.path ?? "").split("/"));
    chmodSync(edited, 0o600);
    writeFileSync(edited, "Edited before the rebuild.\n");
    const again = w.projector();
    const start = await again.start();
    expect(start.rebuild).toBe(true);
    expect(existsSync(join(w.dir, ".projection.json"))).toBe(false);
    const reports = await settle(again);
    expect(reports.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expect(readFileSync(join(w.dir, ...(first?.path ?? "").split("/")), "utf8")).toContain(
      "generated: true",
    );
    expectSameTree(treeOf(w.dir), await freshRender());
  });
});

const readdirOf = (dir: string): string[] => [...filesOf(dir).keys()];

describe("[A1.5.projection.render] what a task's file shows", () => {
  test("front matter: generated first, A1's fixed keys in order, seq is the task's last change", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [first] = catalog(w.dir).slice(1);
    const text = readFileSync(join(w.dir, ...(first?.path ?? "").split("/")), "utf8");
    expect(Object.keys(frontMatter(text))).toEqual([
      "generated",
      "space",
      "ref",
      "id",
      "status",
      "lifecycle",
      "priority",
      "effort",
      "due",
      "area",
      "project",
      "place",
      "version",
      "seq",
    ]);
    const touched = w.reader
      .prepare("SELECT touched FROM tasks WHERE id = $id")
      .get({ id: first?.id ?? "" })?.["touched"];
    expect(Number(frontMatter(text)["seq"])).toBe(touched);
    expect(text.startsWith("---\ngenerated: true\n")).toBe(true);
  });
});
