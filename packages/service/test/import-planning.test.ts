// The dry run's checks before it writes anything (A7 3.15.4): options it cannot use, a prototype
// folder that holds the space's run folders, and a run-folder parent that is a link or no folder
// are refused, and nothing is made in the space, in the prototype folder or behind a link. The
// refusals come before the space is read, so no space is opened here.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError } from "@tasks/contracts";
import type { WorkerConnection } from "@tasks/storage";
import { planningPreview } from "../src/ops/import-planning.ts";

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-04-run-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** A space folder and a prototype folder of its own, under `name`. */
function world(name: string): { base: string; space: string; prototype: string } {
  const base = join(scratch, name);
  const space = join(base, "space");
  const prototype = join(base, "prototype");
  mkdirSync(space, { recursive: true });
  mkdirSync(prototype, { recursive: true });
  writeFileSync(join(prototype, "TODO.md"), "- [ ] **A** <!-- task:a -->\n");
  writeFileSync(join(prototype, "DONE.md"), "");
  return { base, space, prototype };
}

/** The refusal of one dry run. The reader is never reached. */
async function refusal(space: string, folder: string, timeZone = "Europe/Lisbon") {
  try {
    await planningPreview({
      folder: space,
      reader: {} as WorkerConnection,
      input: { folder },
      roots: [],
      platform: process.platform,
      timeZone,
    });
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, data: error.data };
    throw error;
  }
  throw new Error("The dry run was not refused");
}

const tree = (folder: string): string[] =>
  readdirSync(folder, { recursive: true })
    .map((p) => String(p).replaceAll("\\", "/"))
    .sort();

describe("[A7.3.15.importer.dry-run] the dry run refuses before it writes", () => {
  test("options it cannot use: nothing is made in the space", async () => {
    const w = world("options");
    expect(await refusal(w.space, w.prototype, "Nowhere/City")).toMatchObject({
      code: "invalid_input",
    });
    expect(tree(w.space)).toEqual([]);
  });

  test("a prototype folder that holds the space's run folders: neither folder changes", async () => {
    const w = world("overlap");
    const before = tree(w.base);
    // The folder above the space, the space itself, and its exchange folder.
    mkdirSync(join(w.space, "exchange"));
    for (const folder of [w.base, w.space, join(w.space, "exchange")]) {
      expect(await refusal(w.space, folder), folder).toMatchObject({ code: "invalid_input" });
    }
    expect(tree(w.base)).toEqual([...before, "space/exchange"].sort());
  });

  test("a run-folder parent that is a link or no folder: nothing is made behind it", async () => {
    const w = world("linked");
    const elsewhere = join(w.base, "elsewhere");
    mkdirSync(elsewhere);
    // A junction on Windows, which needs no privilege; a symbolic link elsewhere.
    symlinkSync(elsewhere, join(w.space, "exchange"), "junction");
    expect(await refusal(w.space, w.prototype)).toMatchObject({
      code: "space_unavailable",
      data: { retryable: false },
    });
    expect(tree(elsewhere)).toEqual([]);

    const file = world("file");
    mkdirSync(join(file.space, "exchange"));
    writeFileSync(join(file.space, "exchange", "planning"), "");
    expect(await refusal(file.space, file.prototype)).toMatchObject({ code: "space_unavailable" });
    expect(tree(file.space)).toEqual(["exchange", "exchange/planning"]);
  });
});
