// The pass that keeps a tree space's readable files equal to a fresh render, and what it does with
// a person's files. Fixture text only.
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CAN_HOLD_FILES, holdFile } from "@ttasks/testkit";
import { tempFolders } from "../../storage/test/space-helpers.ts";
import {
  expectConverged,
  filesBelow,
  filesWorld,
  foldersBelow,
  smallTree,
  type FilesWorld,
} from "./files-helpers.ts";

const temp = tempFolders("files-pass");
afterAll(temp.cleanup);

const SITE = "client-work/website";
const edit = (w: FilesWorld, path: string, text: string): void => {
  const abs = join(w.view, ...path.split("/"));
  chmodSync(abs, 0o600);
  writeFileSync(abs, text);
};
const rescued = (w: FilesWorld): Map<string, string> => filesBelow(join(w.space, "rescued"));

describe("[S3.files.pass] a pass writes what differs from a fresh render, and keeps a person's files", () => {
  test("a first pass writes the render, read-only; one with nothing new writes nothing", async () => {
    const w = await filesWorld(temp.make());
    smallTree(w);
    const p = w.projector();
    p.start();
    const first = p.pass();
    expect(first).toMatchObject({ failed: 0, stamped: true, rescued: 0 });
    expect(first.written).toBe(w.fresh().size);
    expectConverged(w);
    expect(statSync(join(w.view, "_index.md")).mode & 0o222).toBe(0);
    expect(p.pass()).toMatchObject({ written: 0, removed: 0, failed: 0 });
    w.fx.close();
  });

  test("a change writes exactly the files whose bytes changed", async () => {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    const before = w.fresh();
    w.ok("task.update", { task: t.menu, set: { status: "waiting" } });
    const after = w.fresh();
    const changed = [...after].filter(([path, text]) => before.get(path) !== text).length;
    expect(p.pass()).toMatchObject({ written: changed, removed: 0, failed: 0 });
    expect(changed).toBeLessThan(5);
    expectConverged(w);
    w.fx.close();
  });

  test("a move removes the old files and the folders it left empty", async () => {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    w.ok("task.move", { task: t.menu, under: "studio" });
    const report = p.pass();
    expect(report.removed).toBe(3);
    expectConverged(w);
    expect(foldersBelow(w.view).filter((f) => f.startsWith(`${SITE}/_${t.menu}`))).toEqual([]);
    w.fx.close();
  });

  test("a generated file a person changed is rescued with its bytes and mode when it must be replaced", async () => {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    const path = `${SITE}/${t.menu}-fix-the-menu.md`;
    edit(w, path, "my own words");
    chmodSync(join(w.view, ...path.split("/")), 0o640);
    const mode = statSync(join(w.view, ...path.split("/"))).mode;
    w.ok("task.update", { task: t.menu, set: { priority: 1 } });
    const report = p.pass();
    expect(report.rescued).toBe(1);
    const box = report.rescueFolder ?? "";
    expect(readFileSync(join(w.space, ...box.split("/"), ...path.split("/")), "utf8")).toBe(
      "my own words",
    );
    expect(statSync(join(w.space, ...box.split("/"), ...path.split("/"))).mode).toBe(mode);
    expectConverged(w);
    w.fx.close();
  });

  test("an edit found at the start is rescued and the file written again, with no new commit", async () => {
    const w = await filesWorld(temp.make());
    smallTree(w);
    const first = w.projector();
    first.start();
    first.pass();
    edit(w, "_index.md", "typed over");
    const again = w.projector();
    expect(again.start().suspect).toBe(1);
    expect(again.pass()).toMatchObject({ rescued: 1, written: 1 });
    expect([...rescued(w).values()]).toEqual(["typed over"]);
    expectConverged(w);
    w.fx.close();
  });

  test.skipIf(!CAN_HOLD_FILES)(
    "an edited file held by another program at the start is rescued and written once it is let go",
    async () => {
      const w = await filesWorld(temp.make());
      const t = smallTree(w);
      const first = w.projector();
      first.start();
      first.pass();
      const path = `${SITE}/${t.menu}-fix-the-menu.md`;
      const abs = join(w.view, ...path.split("/"));
      edit(w, path, "my own words");
      const held = holdFile(abs);
      const again = w.projector();
      expect(again.start().suspect).toBe(1);
      expect(again.pass()).toMatchObject({ failed: 1, stamped: false });
      held.release();
      expect(again.pass()).toMatchObject({ failed: 0, rescued: 1, stamped: true });
      expect([...rescued(w).values()]).toEqual(["my own words"]);
      expectConverged(w);
      w.fx.close();
    },
  );

  test("at a path no longer used, a changed file is left where it is; a person's own file stays", async () => {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    const old = `${SITE}/${t.menu}-fix-the-menu.md`;
    edit(w, old, "notes on the old title");
    writeFileSync(join(w.view, "client-work", "my-notes.txt"), "mine");
    w.ok("task.update", { task: t.menu, set: { title: "Fix the menu bar" } });
    const report = p.pass();
    expect(report.rescued).toBe(0);
    expect(readFileSync(join(w.view, ...old.split("/")), "utf8")).toBe("notes on the old title");
    expectConverged(w, new Set([old, "client-work/my-notes.txt"]));
    w.ok("task.move", { task: t.menu, under: "studio" });
    p.pass();
    expect(readFileSync(join(w.view, "client-work", "my-notes.txt"), "utf8")).toBe("mine");
    w.fx.close();
  });

  test("a generated file that went missing comes back; a folder renamed by hand is left as it is", async () => {
    const w = await filesWorld(temp.make());
    smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    unlinkSync(join(w.view, "studio", "_index.md"));
    expect(p.missing()).toBe(1);
    renameSync(join(w.view, "client-work"), join(w.view, "client-work-old"));
    expect(p.missing()).toBeGreaterThan(1);
    p.pass();
    const old = [...filesBelow(w.view).keys()].filter((path) =>
      path.startsWith("client-work-old/"),
    );
    expect(old.length).toBeGreaterThan(0);
    expectConverged(w, new Set(old));
    w.fx.close();
  });

  test("with no record, a file already holding the render's bytes is taken as it is, other bytes are rescued", async () => {
    const w = await filesWorld(temp.make());
    smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    rmSync(w.record);
    edit(w, "studio/_index.md", "from another machine");
    const again = w.projector();
    again.start();
    const report = again.pass();
    expect(report).toMatchObject({ rescued: 1, written: 1, failed: 0 });
    expect([...rescued(w).values()]).toEqual(["from another machine"]);
    expectConverged(w);
    w.fx.close();
  });

  test("a hard link to a generated file is never written through", async () => {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    const path = join(w.view, "client-work", "website", `${t.menu}-fix-the-menu.md`);
    const outside = join(w.space, "outside.md");
    const was = readFileSync(path, "utf8");
    linkSync(path, outside);
    w.ok("task.update", { task: t.menu, set: { priority: 1 } });
    p.pass();
    expect(readFileSync(outside, "utf8")).toBe(was);
    expectConverged(w);
    w.fx.close();
  });

  test("a link where a folder of the tree goes is moved aside, and nothing is written through it", async () => {
    const w = await filesWorld(temp.make());
    smallTree(w);
    const p = w.projector();
    p.start();
    p.pass();
    const elsewhere = join(w.space, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(join(w.view, "studio"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(w.view, "studio"), "junction");
    p.pass();
    expect(filesBelow(elsewhere).size).toBe(0);
    expect(statSync(join(w.view, "studio", "_index.md")).isFile()).toBe(true);
    expectConverged(w);
    w.fx.close();
  });

  test("a path that cannot be written is tried again without a commit; the README moves only after", async () => {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    let held = true;
    const p = w.projector((act, path) => {
      if (held && act === "rename" && path.endsWith("-fix-the-menu.md")) {
        throw Object.assign(new Error("held"), { code: "EBUSY" });
      }
    });
    p.start();
    const first = p.pass();
    expect(first).toMatchObject({ failed: 1, code: "EBUSY", stamped: false });
    expect(filesBelow(w.view).has("README.md")).toBe(false);
    expect(filesBelow(w.view).has(`${SITE}/_${t.menu}/${t.widths}-check-widths.md`)).toBe(true);
    held = false;
    expect(p.pass()).toMatchObject({ failed: 0, stamped: true });
    expectConverged(w);
    w.fx.close();
  });
});
