// `tasks doctor`'s config row (A2 3.13, A2 3.2.4): machine.toml as the service reads it, with the
// command that fixes a file or folder another user could change. Fixture text only.
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { currentPerson, shellPath } from "@tasks/service/permissions";
import { tempRoot } from "@tasks/service/test/harness";
import { configCheck } from "../src/doctor.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function home(): {
  io: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform };
  dir: string;
  file: string;
} {
  const { root, cleanup } = tempRoot("dc");
  cleanups.push(cleanup);
  const h = join(root, "h");
  mkdirSync(join(h, "config"), { recursive: true, mode: 0o700 });
  return {
    io: { env: { TASKS_HOME: h }, platform: process.platform },
    dir: join(h, "config"),
    file: join(h, "config", "machine.toml"),
  };
}

describe("[A2.3.2.2.permissions.rule] tasks doctor's config row", () => {
  test("no machine.toml, a valid one, one the service refuses, one with an entry dropped", () => {
    const { io, file } = home();
    expect(configCheck(io)).toMatchObject({ id: "config", status: "ok" });
    writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
    expect(configCheck(io)).toMatchObject({ status: "ok", detail: "machine.toml is valid." });
    writeFileSync(file, 'not_a_key = 1\n[log]\nlevel = "warn"\n');
    expect(configCheck(io)).toMatchObject({ status: "warn" });
    expect(configCheck(io).detail).toContain("not_a_key (unknown_key)");
    writeFileSync(file, "[spaces\n");
    expect(configCheck(io)).toMatchObject({ status: "fail" });
    expect(configCheck(io).detail).toContain("syntax at line 1");
  });

  test.skipIf(process.platform === "win32")(
    "a machine.toml or folder another user could change fails with the command that fixes it",
    () => {
      const { io, dir, file } = home();
      writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
      // As an editor makes it under umask 002, in this account's group: that group may write it
      // only when it is the account's own private group (A2 3.2.2 rule 5).
      chmodSync(file, 0o664);
      const group = configCheck(io);
      if (currentPerson()?.ownGroup() === statSync(file).gid) {
        expect(group.status).toBe("ok");
      } else {
        expect(group.status).toBe("fail");
        expect(group.detail).toContain("can be changed by the members of its group");
        expect(group.detail).toContain(`To fix it, run: chmod g-w ${shellPath(file)}`);
      }
      chmodSync(file, 0o646);
      const world = configCheck(io);
      expect(world.status).toBe("fail");
      expect(world.detail).toContain("can be changed by every user");
      expect(world.detail).toContain(`To fix it, run: chmod o-w ${shellPath(file)}`);
      // The folder and the file, both open to every user: one command.
      chmodSync(dir, 0o757);
      expect(configCheck(io).detail).toContain(
        `To fix it, run: chmod o-w ${shellPath(dir)} ${shellPath(file)}`,
      );
      chmodSync(dir, 0o700);
      chmodSync(file, 0o600);
      expect(configCheck(io)).toMatchObject({ status: "ok" });
    },
  );

  test.skipIf(process.platform === "win32")(
    "[A2.3.2.2.permissions.repair] a config folder that fails the rule fails before machine.toml exists too, as the service's start does",
    () => {
      const { io, dir } = home();
      chmodSync(dir, 0o757);
      const check = configCheck(io);
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("can be changed by every user");
      expect(check.detail).toContain(`To fix it, run: chmod o-w ${shellPath(dir)}`);
      chmodSync(dir, 0o700);
      expect(configCheck(io)).toMatchObject({ status: "ok" });
    },
  );
});
