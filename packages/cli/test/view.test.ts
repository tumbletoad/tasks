// `tasks view rebuild` through the service (A1 3.13, M3.10): the user rebuilds a space's view from
// an interactive terminal and a deleted generated file comes back; a script is refused; help names
// the command. A real service child, fixture text only.
import { chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { waitFor } from "@tasks/service/test/harness";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("vw");
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const user = (argv: string[]) => runMain(argv, { home: world.home, cwd: world.root, tty: true });
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe("[A1.5.projection.cli] tasks view rebuild from the CLI", () => {
  test("the user rebuilds the view and a deleted file comes back; a script is refused; help names it", async () => {
    const script = await world.tasks(["view", "rebuild", "--json"]);
    expect(script.code).toBe(5);
    expect(parsed(script.stdout)).toMatchObject({ error: { code: "forbidden" } });

    const added = await world.tasks(["add", "Fixture for the view", "--json"]);
    expect(added.code, added.stdout).toBe(0);
    const open = join(world.spaceFolder, "view", "open");
    const name = await waitFor(
      () =>
        existsSync(open)
          ? readdirSync(open).find((file) => file.endsWith("-fixture-for-the-view.md"))
          : undefined,
      30_000,
      "the task's file",
    );
    const file = join(open, name);
    chmodSync(file, 0o600);
    rmSync(file);

    const rebuilt = await user(["view", "rebuild", "--json"]);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect(parsed(rebuilt.stdout)).toMatchObject({ queued: 1, forgotten: 0 });
    await waitFor(() => (existsSync(file) ? true : undefined), 30_000, "the file again");

    const text = await user(["view", "rebuild"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^Checked \d+ generated files\. 1 task is rendered again/);
    const help = await user(["help", "view"]);
    expect(help.stdout).toContain("rebuild [<space>]");
    expect((await user(["view"])).code).not.toBe(0);
  });
});
