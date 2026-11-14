// The projection over a real space (A1 3.13, A7 3.10 M3.10's Verify line): after quiescence the
// tree equals a fresh render, the watermark never covers an unrendered task, batches cross moves,
// files are read-only, and what is not the projection's is never written through, overwritten,
// deleted or changed in mode: where a generated file needs its place it is moved aside by one
// rename. Fixture text only.
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Id } from "@tasks/storage";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  catalogOf,
  checkWatermark,
  expectClean,
  expectSameTree,
  filesOf,
  frontMatter,
  inTree,
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

const LINK = process.platform === "win32" ? "junction" : "dir";

/** A fresh render of the space as it is now, in a folder of its own. */
const freshRender = (): Promise<Map<string, string>> => w.fresh(join(root, `fresh-${String(n)}`));

/** A person makes a file writable before they change it: its mode is theirs from then on. */
function personWrites(path: string, text: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, text);
}

/** Every entry under the space's exchange/rescued/, relative to it, mapped to its text. */
const rescuedOf = (w: World): Map<string, string> => filesOf(join(w.folder, "exchange", "rescued"));

async function settled(): Promise<void> {
  const projector = w.projector();
  await projector.start();
  await settle(projector);
}

describe("[A1.5.projection.fresh] after quiescence the projection equals a fresh render, and its watermark never covers an unrendered task", () => {
  test("the sample space: every task is in the catalogue, every file is read-only, the tree equals a fresh render, the trusted state is outside it", async () => {
    const projector = w.projector();
    const start = await projector.start();
    expect(start.rebuild).toBe(true);
    await settle(projector);
    const lastSeq = Number(w.reader.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
    expect(checkWatermark(w.dir, w.reader)).toBe(lastSeq);
    const ids = taskIds(w.reader);
    expect(
      catalogOf(w.dir)
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
      const mode = statSync(join(w.dir, ...path.split("/"))).mode;
      if (process.platform === "win32") expect(mode & 0o200, path).toBe(0);
      else expect(mode & 0o777, path).toBe(0o400);
    }
    // Nothing in the tree authorizes anything: the record and the journal are in machine state.
    expect([...files.keys()].filter((path) => !/\.(md|jsonl)$/.test(path))).toEqual([
      ".projection.json",
    ]);
    expect(existsSync(w.record)).toBe(true);
    expect(existsSync(w.journal)).toBe(false);
    expectClean(w.dir);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("600 dirty tasks in batches of 200, with renames, completions and reopenings crossing batch boundaries", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
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
      expect(report.rescued).toBe(0);
      checkWatermark(w.dir, w.reader);
      if (steps <= 3) {
        const active = w.reader
          .prepare(
            "SELECT id FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL ORDER BY ref",
          )
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
        // A delete, an archive, and a restore of what an earlier step deleted.
        w.submit([{ kind: "task.delete", task: pick(3) }]);
        w.submit([{ kind: "task.archive", task: pick(4) }]);
        const gone = w.reader
          .prepare("SELECT id FROM tasks WHERE deleted_at IS NOT NULL ORDER BY ref LIMIT 1")
          .get()?.["id"];
        if (typeof gone === "string" && steps > 1) w.submit([{ kind: "task.restore", task: gone }]);
        checkWatermark(w.dir, w.reader);
      }
      if (steps > 50) throw new Error("no quiescence");
    }
    expect(steps).toBeGreaterThanOrEqual(3);
    expectClean(w.dir);
    const live = w.reader
      .prepare("SELECT count(*) AS n FROM tasks WHERE deleted_at IS NULL")
      .get()?.["n"];
    expect(catalogOf(w.dir)).toHaveLength(Number(live));
    expect(Number(live)).toBeLessThan(ids.length);
    expectSameTree(treeOf(w.dir), await freshRender());
  });

  test("a launch's commit moves no task's file, and the watermark still reaches last_seq", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const before = treeOf(w.dir);
    const [first] = catalogOf(w.dir);
    const version = Number(
      w.reader.prepare("SELECT version FROM tasks WHERE id = $id").get({ id: first?.id ?? "" })?.[
        "version"
      ],
    );
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

describe("[A1.5.projection.rescue] what is not the projection's is never written through, overwritten, deleted or changed in mode; where a generated file needs its place it is moved aside by one rename", () => {
  test("an edited task file is rescued with its edit and its mode, and replaced; a file of the person's elsewhere is left alone", async () => {
    await settled();
    const [first] = catalogOf(w.dir);
    const path = first?.path ?? "";
    const abs = join(w.dir, ...path.split("/"));
    personWrites(abs, "My own notes, typed into the generated file.\n");
    const mode = statSync(abs).mode;
    const stray = join(w.dir, "open", "notes-of-mine.txt");
    writeFileSync(stray, "Not the projection's.\n");
    w.submit([
      { kind: "task.patch", task: first?.id ?? "", set: { summary: "Changed after the edit" } },
    ]);
    const projector = w.projector();
    await projector.start();
    const reports = await settle(projector);
    const rescued = reports.find((r) => r.rescued > 0);
    expect(rescued?.rescued).toBe(1);
    expect(rescued?.rescueStem).toMatch(/^exchange\/rescued\/\d{8}T\d{9}Z-[0-9a-f]{4}$/);
    const kept = join(
      w.folder,
      ...`${rescued?.rescueStem ?? ""}-1`.split("/"),
      "view",
      ...path.split("/"),
    );
    expect(readFileSync(kept, "utf8")).toBe("My own notes, typed into the generated file.\n");
    // Its mode is the person's, unchanged.
    expect(statSync(kept).mode).toBe(mode);
    expect(readFileSync(abs, "utf8")).toContain("Changed after the edit");
    expect(readFileSync(stray, "utf8")).toBe("Not the projection's.\n");
    checkWatermark(w.dir, w.reader);
  });

  test("a person's file where a task's file goes, and a link where a folder goes, are moved aside as they are, never followed", async () => {
    const outside = join(root, `outside-${String(n)}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "canary.txt"), "Outside the tree.\n");
    mkdirSync(w.dir);
    // A link in place of open/: writing through it would write outside the tree.
    symlinkSync(outside, join(w.dir, "open"), LINK);
    const projector = w.projector();
    await projector.start();
    const reports = await settle(projector);
    expect(readdirSync(outside)).toEqual(["canary.txt"]);
    expect(lstatSync(join(w.dir, "open")).isDirectory()).toBe(true);
    const box = reports.find((r) => r.rescued > 0)?.rescueStem ?? "";
    const link = join(w.folder, ...`${box}-1`.split("/"), "view", "open");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // A file of the person's at the path of a task's file.
    const [first] = catalogOf(w.dir);
    const path = first?.path ?? "";
    const abs = join(w.dir, ...path.split("/"));
    chmodSync(abs, 0o600);
    rmSync(abs);
    writeFileSync(abs, "Mine.\n");
    w.submit([{ kind: "task.patch", task: first?.id ?? "", set: { summary: "Rendered again" } }]);
    const again = await settle(projector);
    expect(again.reduce((sum, r) => sum + r.rescued, 0)).toBe(1);
    expect(readFileSync(abs, "utf8")).toContain("Rendered again");
    expect([...rescuedOf(w).values()]).toContain("Mine.\n");
    expect(readFileSync(join(outside, "canary.txt"), "utf8")).toBe("Outside the tree.\n");
  });

  test("a hard link to a file outside, at a generated path, is not the projection's: the outside file keeps its bytes and its mode", async () => {
    await settled();
    const [first] = catalogOf(w.dir);
    const abs = join(w.dir, ...(first?.path ?? "").split("/"));
    // The outside file holds exactly the generated bytes, and is writable.
    const outside = join(root, `outside-${String(n)}.md`);
    writeFileSync(outside, readFileSync(abs));
    chmodSync(outside, 0o644);
    const mode = statSync(outside).mode;
    chmodSync(abs, 0o600);
    rmSync(abs);
    linkSync(outside, abs);
    w.submit([{ kind: "task.patch", task: first?.id ?? "", set: { summary: "After the link" } }]);
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    expect(statSync(outside).mode).toBe(mode);
    expect(readFileSync(abs, "utf8")).toContain("After the link");
    expect(readFileSync(outside, "utf8")).not.toContain("After the link");
  });

  test("files with temporary-looking names, and text where the old control files were, are a person's: kept", async () => {
    mkdirSync(join(w.dir, "open"), { recursive: true });
    const decoys = new Map([
      [".projection-files.json", "Notes kept where an old record was."],
      [".projection-journal.json", "Notes kept where an old journal was."],
      [`open/.M-1-x.md.${"0".repeat(32)}.0123abcd.tmp`, "Looks like a temporary file."],
      [".index.md.tmp-0123456789abcdef", "Looks like an old temporary file."],
    ]);
    for (const [path, text] of decoys) writeFileSync(join(w.dir, ...path.split("/")), text);
    await settled();
    // A restart cleans temporaries again.
    await settled();
    for (const [path, text] of decoys) {
      expect(readFileSync(join(w.dir, ...path.split("/")), "utf8"), path).toBe(text);
    }
  });

  test("a rescue that cannot happen leaves the person's file in place: the task's file is not written, and it is tried again", async () => {
    await settled();
    const [first] = catalogOf(w.dir);
    const path = first?.path ?? "";
    const abs = join(w.dir, ...path.split("/"));
    personWrites(abs, "Edited by a person.\n");
    // The space's exchange/ is a file: no rescue folder can be made, so nothing is moved.
    writeFileSync(join(w.folder, "exchange"), "Not a folder.\n");
    w.submit([{ kind: "task.patch", task: first?.id ?? "", set: { summary: "Rendered later" } }]);
    const projector = w.projector();
    await projector.start();
    const report = await projector.step();
    expect(report.failed).toBe(1);
    expect(report.code).toBe("ENOTDIR");
    expect(report.rescued).toBe(0);
    expect(readFileSync(abs, "utf8")).toBe("Edited by a person.\n");
    // The watermark stays below the task, which waits.
    expect(report.watermark).toBeLessThan(report.seq);
    expect(projector.pending().dirty).toBe(true);
    // Once exchange/ is a folder, it goes through.
    rmSync(join(w.folder, "exchange"));
    await settle(projector);
    expect(readFileSync(abs, "utf8")).toContain("Rendered later");
    expect([...rescuedOf(w).values()]).toContain("Edited by a person.\n");
    checkWatermark(w.dir, w.reader);
  });

  test("a task whose file cannot be placed holds the watermark below it, never stops the tasks after it, and the catalogue names only files that are there", async () => {
    const projector = w.projector();
    await projector.start();
    await settle(projector);
    const [first, second] = catalogOf(w.dir);
    const blocked = join(w.dir, ...(first?.path ?? "").split("/"));
    personWrites(blocked, "Blocking edit.\n");
    writeFileSync(join(w.folder, "exchange"), "Not a folder.\n");
    // The first task's file must take the edited file's place, which cannot be rescued now; the
    // second moves to a path nothing blocks.
    w.submit([{ kind: "task.patch", task: first?.id ?? "", set: { summary: "Blocked" } }]);
    const blockedAt = w.writer.asOf().seq;
    w.submit([{ kind: "task.patch", task: second?.id ?? "", set: { title: "Free rename" } }]);
    const report = await projector.step();
    expect(report.failed).toBe(1);
    expect(report.published).toBe(true);
    expect(report.watermark).toBe(blockedAt - 1);
    const lines = catalogOf(w.dir);
    expect(lines.find((l) => l.id === second?.id)?.path).toMatch(/-free-rename\.md$/);
    for (const line of lines) expect(inTree(w.dir, line.path), line.path).toBe(true);
    // The second task's old file went, once the catalogue no longer named it.
    expect(existsSync(join(w.dir, ...(second?.path ?? "").split("/")))).toBe(false);
    expect(readFileSync(blocked, "utf8")).toBe("Blocking edit.\n");
    // The person's edit stands where the first task's file was: only that task's claim is theirs.
    expect(checkWatermark(w.dir, w.reader, new Set([first?.id ?? ""]))).toBeLessThan(blockedAt);
    rmSync(join(w.folder, "exchange"));
    await settle(projector);
    checkWatermark(w.dir, w.reader);
    expectSameTree(treeOf(w.dir), await freshRender());
  });
});

describe("[A1.5.projection.render] what a task's file shows", () => {
  test("front matter: generated first, A1's fixed keys in order, seq is the task's last change", async () => {
    await settled();
    const [first] = catalogOf(w.dir);
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
