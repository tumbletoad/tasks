// `tasks space use <space>` (A2 3.1, 3.10.5; M5.01): the person makes a space the machine's
// default, which an unbound command of the person then uses; scripts and agents cannot change it.
// Fixture text only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("su");
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const user = (argv: string[]) => runMain(argv, { home: world.home, cwd: world.root, tty: true });
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe("[A2.3.10.cli.space-use] tasks space use: the machine's default space", () => {
  test("the person sets the default by name or folder; an unbound command then uses it", async () => {
    const life = await user(["space", "create", "Life", "--path", join("s", "life"), "--json"]);
    expect(life.code, life.stdout + life.stderr).toBe(0);
    const lifeId = (parsed(life.stdout)["space"] as { id: string }).id;
    // Two spaces and no default: a command must name one.
    expect((await world.tasks(["status"])).code).toBe(2);

    const used = await user(["space", "use", "life", "--json"]);
    expect(used.code, used.stdout + used.stderr).toBe(0);
    expect(parsed(used.stdout)).toEqual({ default: lifeId });
    const listed = await user(["space", "list"]);
    expect(listed.stdout).toMatch(/^Life \(\S+\) {2}open, default {2}/m);
    expect(listed.stdout).not.toMatch(/^Mira .*default/m);
    // The person's unbound command uses the default; an agent's still names its space.
    const status = await user(["status", "--json"]);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(status.stdout).toContain(lifeId);
    const agent = await world.tasks(["status", "--json"], { env: { CLAUDECODE: "1" } });
    expect(agent.code).toBe(2);

    // By folder, back to Mira.
    const byFolder = await user(["space", "use", world.spaceFolder, "--json"]);
    expect(byFolder.code, byFolder.stdout + byFolder.stderr).toBe(0);
    expect(parsed(byFolder.stdout)["default"]).not.toBe(lifeId);
  }, 180_000);

  test("the space commands use the default too, but a restore in place asks for the space", async () => {
    expect((await user(["space", "use", "Life"])).code).toBe(0);
    const backup = await user(["space", "backup", "--json"]);
    expect(backup.code, backup.stdout + backup.stderr).toBe(0);
    const name = (parsed(backup.stdout)["backup"] as { name: string }).name;
    const backups = await user(["space", "backups", "--json"]);
    expect(backups.code, backups.stdout + backups.stderr).toBe(0);
    expect(parsed(backups.stdout)["folder"]).toContain(join("s", "life"));
    expect(parsed(backups.stdout)["backups"]).toContainEqual(expect.objectContaining({ name }));
    const recover = await user(["recover"]);
    expect(recover.code, recover.stdout + recover.stderr).toBe(0);
    expect(recover.stdout).toBe("Life needs no recovery.\n");
    // A backup's name is the default space's, also into a new folder.
    const copy = await user(["space", "restore", name, "--to", join("s", "life-copy")]);
    expect(copy.code, copy.stdout + copy.stderr).toBe(0);
    expect(copy.stdout).toMatch(/^Restored Life /mu);
    expect((await user(["space", "close", join(world.root, "s", "life-copy")])).code).toBe(0);
    const inPlace = await user(["space", "restore", name, "--in-place"]);
    expect(inPlace.code).toBe(2);
    expect(inPlace.stderr).toContain("does not take the default space");
    expect((await user(["space", "use", "Mira"])).code).toBe(0);
  }, 180_000);

  test("scripts and agents cannot change it; an unknown space is a usage error", async () => {
    for (const env of [{}, { CLAUDECODE: "1" }]) {
      const ran = await world.tasks(["space", "use", "Mira", "--json"], { env });
      expect(ran.code).toBe(5);
      expect(parsed(ran.stdout)).toMatchObject({ error: { code: "forbidden" } });
    }
    expect((await user(["space", "use", "Nowhere", "--json"])).code).toBe(2);
    expect((await user(["space", "use", "--json"])).code).toBe(2);
  }, 180_000);
});
