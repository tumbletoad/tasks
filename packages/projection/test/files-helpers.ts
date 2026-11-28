// A tree space and its readable files on disk, for the pass's tests. Fixture text only.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Act } from "../src/index.ts";
import { FilesProjector, readSnapshot, renderTree } from "../src/index.ts";
import { FilesRecord } from "../src/files/record.ts";
import { checkedDriver, TEST_MACHINE } from "../../storage/test/space-helpers.ts";
import { openTree, type TreeFixture } from "../../storage/test/tree-helpers.ts";

export interface FilesWorld {
  readonly fx: TreeFixture;
  readonly space: string;
  readonly view: string;
  readonly record: string;
  projector(at?: (act: Act, path: string) => void): FilesProjector;
  /** A fresh render of the space as it is now. */
  fresh(): Map<string, string>;
  ok(command: string, input: Record<string, unknown>): unknown;
  add(draft: Record<string, unknown>): string;
  project(title: string, under?: string): string;
}

export async function filesWorld(folder: string): Promise<FilesWorld> {
  const fx = openTree(await checkedDriver(), folder, true);
  const view = join(folder, "view");
  const record = join(folder, "state", "files.json");
  const ok = (command: string, input: Record<string, unknown>): unknown => {
    const result = fx.send(command, input);
    expect(result.error).toBeUndefined();
    return result.result;
  };
  return {
    fx,
    space: folder,
    view,
    record,
    projector: (at) =>
      new FilesProjector({
        conn: fx.conn,
        machine: TEST_MACHINE,
        dir: view,
        spaceFolder: folder,
        record,
        timeZone: "UTC",
        ...(at === undefined ? {} : { at }),
      }),
    fresh: () => renderTree(readSnapshot(fx.conn, TEST_MACHINE), "UTC"),
    ok,
    add: (draft) =>
      (ok("tasks.add", { tasks: [draft] }) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "",
    project: (title, under) =>
      (
        ok("project.create", { title, ...(under === undefined ? {} : { under }) }) as {
          project: { id: string };
        }
      ).project.id,
  };
}

/** A small tree: two projects, tasks with a subtask and a page, a finished task. */
export function smallTree(w: FilesWorld): {
  site: string;
  menu: string;
  widths: string;
  dns: string;
} {
  const client = w.project("Client work");
  const site = w.project("Website", client);
  w.project("Studio");
  w.add({ title: "Renew passport" });
  const menu = w.add({ under: site, title: "Fix the menu" });
  const widths = w.add({ under: menu, title: "Check widths" });
  w.ok("page.create", { on: menu, title: "Breakpoints", body: "## Sizes\n\n- 390\n- 1440" });
  const dns = w.add({ under: site, title: "Move the DNS" });
  w.ok("task.finish", { task: dns, outcome: "Moved" });
  return { site, menu, widths, dns };
}

/** Every file below `dir`, by its path relative to it with `/`. Links are not followed. */
export function filesBelow(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(rel === "" ? dir : join(dir, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stats = lstatSync(join(dir, path));
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) out.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  visit("");
  return out;
}

/** The folders below `dir`, by their relative paths. */
export function foldersBelow(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const name of readdirSync(rel === "" ? dir : join(dir, rel))) {
      const path = rel === "" ? name : `${rel}/${name}`;
      if (lstatSync(join(dir, path)).isDirectory()) {
        out.push(path);
        visit(path);
      }
    }
  };
  visit("");
  return out;
}

export const TEMP = /(^|\/)\.[^/]+\.[0-9a-f]{32}\.[0-9a-f]{8}\.tmp$/;

/** The tree holds exactly a fresh render, besides `theirs` (a person's paths), and no temporary file. */
export function expectConverged(w: FilesWorld, theirs: ReadonlySet<string> = new Set()): void {
  const want = w.fresh();
  const have = filesBelow(w.view);
  for (const [path, text] of want) expect(have.get(path), path).toBe(text);
  for (const path of have.keys()) {
    if (!want.has(path)) expect(theirs.has(path), `not the render's: ${path}`).toBe(true);
  }
  expect([...have.keys()].filter((p) => TEMP.test(p))).toEqual([]);
  const record = FilesRecord.load(w.record);
  expect([...record.files.values()].filter((e) => e.pending !== undefined)).toEqual([]);
}

/** Runs `pass` until a pass places everything and writes nothing more. */
export function settle(p: FilesProjector): void {
  for (let i = 0; i < 10; i += 1) {
    const report = p.pass();
    if (report.failed === 0 && report.written === 0 && report.removed === 0) return;
  }
  throw new Error("The pass does not settle");
}

/** A kill: the act it is thrown at does not happen, nor any after it. */
export class Killed extends Error {}
