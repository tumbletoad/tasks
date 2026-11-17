// `tasks roots` from the CLI (A1 3.15, A2 3.10; M2.07): the user adds a root from an interactive
// terminal, with a folder relative to the working folder; a script cannot. A real service child,
// fixture text only.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { configOf } from "@tasks/service/test/harness";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("rt");
  mkdirSync(join(world.root, "work", "lumen", "portal"), { recursive: true });
  mkdirSync(join(world.root, "work", "lumen", "api"), { recursive: true });
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const run = (argv: string[], cwd: string, tty = false) =>
  runMain(argv, { home: world.home, cwd, tty });
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe("[A1.3.15.roots.add] tasks roots from the CLI", () => {
  test("the user adds a root with a relative folder, and a script is refused", async () => {
    const script = await run(["roots", "add", "work", "work", "--json"], world.root);
    expect(script.code).toBe(5);
    expect(parsed(script.stdout)).toMatchObject({ error: { code: "forbidden" } });

    const added = await run(
      ["roots", "add", "work", "work", "--label", "Work", "--runs", "--json"],
      world.root,
      true,
    );
    expect(added.code, added.stderr).toBe(0);
    expect(parsed(added.stdout)).toEqual({
      root: { id: "work", label: "Work", path: join(world.root, "work"), runs: true, rev: 1 },
    });
    const toml = readFileSync(join(configOf(world.home), "machine.toml"), "utf8");
    expect(toml).toContain("[roots.work]");
    expect(toml).toContain("runs = true");

    const listed = await run(["roots", "--json"], world.root);
    expect(parsed(listed.stdout)).toMatchObject({ roots: [{ id: "work", label: "Work" }] });
    const text = await run(["roots"], world.root);
    expect(text.stdout).toContain("work  Work");
  }, 180_000);

  test("--help prints the help and runs nothing", async () => {
    for (const args of [
      ["roots", "add", "x", "y", "--help"],
      ["help", "roots"],
    ]) {
      const ran = await run(args, world.root, true);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toMatch(/^Usage: tasks roots/);
    }
  });
});
