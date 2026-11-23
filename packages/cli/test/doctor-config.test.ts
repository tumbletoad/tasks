// `ttasks doctor`'s config row (A2 3.13, A2 3.2.4): machine.toml as the service reads it, with the
// command that fixes a file or folder another user could change. Fixture text only.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { currentPerson, shellPath } from "@ttasks/service/permissions";
import { tempRoot } from "@ttasks/service/test/harness";
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
    io: { env: { TTASKS_HOME: h }, platform: process.platform },
    dir: join(h, "config"),
    file: join(h, "config", "machine.toml"),
  };
}

describe("[A2.3.2.2.permissions.rule] ttasks doctor's config row", () => {
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

  test("[A1.3.16.prefs.machine.not-read] a machine key this build does not read is a note that says where the files are", () => {
    const { io, file } = home();
    const named = process.platform === "win32" ? "C:\\elsewhere\\view" : "/srv/elsewhere/view";
    writeFileSync(file, `[preferences]\n"projection.dir" = ${JSON.stringify(named)}\n`, {
      mode: 0o600,
    });
    const check = configCheck(io);
    expect(check.status).toBe("warn");
    expect(check.detail).toBe(
      "machine.toml sets projection.dir, which this build does not read yet, so it changes nothing: the readable files are in each space folder's view/.",
    );
    // Unset: no note.
    writeFileSync(file, '[preferences]\n"ui.theme" = "washi"\n');
    expect(configCheck(io)).toMatchObject({ status: "ok", detail: "machine.toml is valid." });
  });

  test("[A1.3.15.roots.retired] a [roots] section is named once, as lines that do nothing, and the file is left as it is", () => {
    const { io, file } = home();
    const text =
      '[roots.work]\nlabel = "Work"\npath = "/home/mira/work"\n\n[roots.oss]\npath = "/home/mira/oss"\n';
    writeFileSync(file, text, { mode: 0o600 });
    const check = configCheck(io);
    expect(check.status).toBe("warn");
    expect(check.detail.match(/\[roots\]/gu)).toHaveLength(1);
    expect(check.detail).toContain("do nothing now");
    expect(check.detail).not.toContain("drop only their entry");
    expect(readFileSync(file, "utf8")).toBe(text);
    // With another problem beside it, both are named.
    writeFileSync(file, `not_a_key = 1\n${text}`);
    expect(configCheck(io).detail).toContain("not_a_key (unknown_key)");
    expect(configCheck(io).detail).toContain("[roots] lines do nothing now");
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
