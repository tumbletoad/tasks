// `tasks roots` and places from the CLI (A1 3.15, A2 3.10; M2.07): the user adds a root from an
// interactive terminal, with a folder relative to the working folder; a script cannot. A task's
// place is given as `--place .`, `place=cwd` or a relative folder, which the CLI makes absolute,
// and the space keeps the root and the relative path. A real service child, fixture text only.
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  test("the user adds a root with a relative folder; a script is refused; places bind under it", async () => {
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

    // --place . from the folder itself; place=../api relative to the working folder; place=cwd.
    const portal = join(world.root, "work", "lumen", "portal");
    const add = await run(["add", "Fixture portal task", "--place", ".", "--json"], portal);
    expect(add.code, add.stdout).toBe(0);
    const ref = (parsed(add.stdout)["tasks"] as { ref: string }[])[0]?.ref ?? "";
    // The place as bound: its root and path (the digest also names the folder it resolves to).
    const show = async () => {
      const task = parsed((await run(["show", ref, "--json"], world.root)).stdout)[
        "task"
      ] as Record<string, unknown>;
      const place = task["place"] as { root?: unknown; path?: unknown } | undefined;
      return place === undefined ? undefined : { root: place.root, path: place.path };
    };
    expect(await show()).toEqual({ root: "work", path: "lumen/portal" });

    const set = await run(["set", ref, "place=../api", "--json"], portal);
    expect(set.code, set.stdout).toBe(0);
    expect(await show()).toEqual({ root: "work", path: "lumen/api" });

    const back = await run(["set", ref, "place=cwd", "--json"], portal);
    expect(back.code, back.stdout).toBe(0);
    expect(await show()).toEqual({ root: "work", path: "lumen/portal" });

    // A folder under no root: refused for an update, with the root IDs and no path.
    const outside = await run(["set", ref, "place=.", "--json"], world.root);
    expect(outside.code).toBe(2);
    const body = parsed(outside.stdout);
    expect(body).toMatchObject({
      error: { code: "invalid_input", data: { reason: "outside_roots", roots: ["work"] } },
    });
    expect(outside.stdout).not.toContain(basename(world.root));
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
