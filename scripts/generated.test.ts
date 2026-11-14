import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkGenerated, writeGenerated, type Generator } from "./generated.ts";

describe("[A7.3.3.gen.freshness] the generated-file freshness check", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tasks-gen-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const generator: Generator = {
    name: "sample",
    dir: "out",
    render: () =>
      Promise.resolve(
        new Map([
          ["a.txt", "alpha\n"],
          ["nested/b.txt", "beta\n"],
        ]),
      ),
  };

  test("passes with no generators registered", async () => {
    expect(await checkGenerated(root, [])).toEqual([]);
  });

  test("reports missing files, then passes after writing", async () => {
    expect(await checkGenerated(root, [generator])).toEqual([
      "sample: out/a.txt is missing",
      "sample: out/nested/b.txt is missing",
    ]);
    await writeGenerated(root, [generator]);
    expect(await checkGenerated(root, [generator])).toEqual([]);
  });

  test("reports a changed file and an extra file, and gen repairs both", async () => {
    await writeGenerated(root, [generator]);
    await writeFile(join(root, "out", "a.txt"), "edited by hand\n");
    await writeFile(join(root, "out", "stray.txt"), "left over\n");
    expect(await checkGenerated(root, [generator])).toEqual([
      "sample: out/a.txt is out of date",
      "sample: out/stray.txt is not generated",
    ]);
    await writeGenerated(root, [generator]);
    expect(await checkGenerated(root, [generator])).toEqual([]);
    expect(await readFile(join(root, "out", "a.txt"), "utf8")).toBe("alpha\n");
  });
});
