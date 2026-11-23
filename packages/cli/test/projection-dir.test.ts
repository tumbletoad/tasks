// A machine preference this build does not read yet, set in machine.toml: the service starts and
// uses the rest of the file, the readable files stay in the space's view/, nothing is made at the
// folder it names, and the person is told where they look. A real service child, fixture text only.
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "@ttasks/storage";
import { waitFor } from "@ttasks/service/test/harness";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

const named = join(tmpdir(), `ttasks-${newId("sp")}`, "view");
let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("pd", {
    machineToml: `[preferences]\n"projection.dir" = ${JSON.stringify(named)}\n`,
  });
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const user = (argv: string[]) => runMain(argv, { home: world.home, cwd: world.root, tty: true });
const script = (argv: string[]) => runMain(argv, { home: world.home, cwd: world.root });

describe("[A1.3.16.prefs.machine.not-read] projection.dir in machine.toml changes nothing and says so", () => {
  test("the files stay in the space, nothing is made at the named folder, doctor and prefs say so", async () => {
    const added = await script(["add", "Fixture for the named folder", "--json"]);
    expect(added.code, added.stdout).toBe(0);
    const open = join(world.spaceFolder, "view", "open");
    await waitFor(
      () =>
        existsSync(open)
          ? readdirSync(open).find((file) => file.endsWith("-fixture-for-the-named-folder.md"))
          : undefined,
      30_000,
      "the task's file in the space's view/",
    );
    const rebuilt = await user(["view", "rebuild", "--json"]);
    expect(rebuilt.code, rebuilt.stdout).toBe(0);
    expect(existsSync(named)).toBe(false);

    const doctor = await user(["doctor", "--json"]);
    const checks = (
      JSON.parse(doctor.stdout) as { checks: { id: string; status: string; detail: string }[] }
    ).checks;
    expect(checks.find((c) => c.id === "config")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining(
        "projection.dir, which this build does not read yet",
      ) as string,
    });

    const set = await user(["prefs", "set", "projection.dir", named, "--json"]);
    expect(set.code).not.toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      error: {
        code: "invalid_input",
        message: "This build does not act on this key yet, so it is not changed.",
      },
    });
    expect(existsSync(named)).toBe(false);
  }, 180_000);
});
