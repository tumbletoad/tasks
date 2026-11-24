// Where runs cannot be grouped, the probe says why in plain words, and nothing starts. These
// read files only, so they run on every platform; the real probe is in process-group.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  processGroups,
  LinuxProcessGroups,
  placement,
  quoteWindowsArg,
  windowsCommandLine,
  WindowsProcessGroups,
  type UnavailableReason,
} from "../src/process-group/index.ts";

const UNIT = "/user.slice/user-1000.slice/user@1000.service/app.slice/ttasks.service";

describe("[A4.3.11.8.group.probe] the probe says why runs cannot be grouped, and start refuses there", () => {
  test("placement reads the service's own unit from /proc/self/cgroup", () => {
    expect(placement(`0::${UNIT}\n`, 1000)).toEqual({
      ok: true,
      unit: "ttasks.service",
      root: UNIT,
      inMain: false,
    });
    expect(placement(`0::${UNIT}/main\n`, 1000)).toEqual({
      ok: true,
      unit: "ttasks.service",
      root: UNIT,
      inMain: true,
    });
    const no = (text: string, uid = 1000) => {
      const placed = placement(text, uid);
      return placed.ok ? "ok" : placed.reason;
    };
    // cgroup v1, or the hybrid layout beside v2.
    expect(no("12:pids:/user.slice\n0::/user.slice\n")).toBe("no_cgroup_v2");
    expect(no("4:memory:/user.slice\n")).toBe("no_cgroup_v2");
    // A system service, a login session, another user's manager, WSL without systemd.
    expect(no("0::/system.slice/ttasks.service\n")).toBe("no_user_manager");
    expect(no("0::/user.slice/user-1000.slice/session-3.scope\n")).toBe("no_user_manager");
    expect(no(`0::${UNIT}\n`, 1001)).toBe("no_user_manager");
    expect(no("0::/\n")).toBe("no_user_manager");
    // Started by hand in a terminal, or the manager itself.
    expect(
      no("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-vte-spawn-1.scope\n"),
    ).toBe("not_a_service");
    expect(no("0::/user.slice/user-1000.slice/user@1000.service\n")).toBe("not_a_service");
  });

  describe("Linux probe outside a delegated unit", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ttasks-probe-"));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** A fake machine: which of systemd, cgroup2 and cgroup.kill exist, and the service's cgroup. */
    function machine(
      label: string,
      facts: {
        systemd?: boolean;
        v2?: boolean;
        kill?: boolean;
        self?: string;
        delegate?: string | (() => string | undefined);
      },
    ) {
      const root = join(dir, label);
      const cgroups = join(root, "cgroup");
      mkdirSync(join(cgroups, UNIT), { recursive: true });
      if (facts.systemd !== false) mkdirSync(join(root, "systemd"));
      if (facts.v2 !== false) writeFileSync(join(cgroups, "cgroup.controllers"), "");
      if (facts.kill !== false) writeFileSync(join(cgroups, UNIT, "cgroup.kill"), "");
      writeFileSync(join(root, "self"), facts.self ?? `0::${UNIT}\n`);
      return new LinuxProcessGroups({
        cgroupRoot: cgroups,
        selfCgroup: join(root, "self"),
        systemdRunDir: join(root, "systemd"),
        unitDelegate: () =>
          Promise.resolve(typeof facts.delegate === "function" ? facts.delegate() : facts.delegate),
        uid: 1000,
      });
    }

    const cases: [string, Parameters<typeof machine>[1], UnavailableReason][] = [
      ["no-systemd", { systemd: false, delegate: "yes" }, "no_systemd"],
      ["v1", { v2: false, delegate: "yes" }, "no_cgroup_v2"],
      ["by-hand", { self: "0::/user.slice/user-1000.slice/session-2.scope\n" }, "no_user_manager"],
      ["no-answer", {}, "no_user_manager"],
      ["not-delegated", { delegate: "no" }, "not_delegated"],
      ["old-kernel", { kill: false, delegate: "yes" }, "no_cgroup_kill"],
    ];
    for (const [label, facts, reason] of cases) {
      test(`${label}: ${reason}`, async () => {
        const box = machine(label, facts);
        const probed = await box.probe();
        expect(probed).toMatchObject({ available: false, reason });
        if (!probed.available) expect(probed.message.length).toBeGreaterThan(20);
        await expect(
          box.start({ name: "r1", command: "/bin/true", args: [], cwd: "/", env: {} }),
        ).rejects.toMatchObject({ code: "unavailable" });
      });
    }

    test("a user manager that did not answer once is asked again", async () => {
      const answers = [undefined, "yes"];
      const box = machine("asked-again", { delegate: () => answers.shift() });
      expect(await box.probe()).toMatchObject({ available: false, reason: "no_user_manager" });
      // Asked again, it answers: the fake machine then fails at the next step, moving the service.
      expect(await box.probe()).toMatchObject({ available: false, reason: "check_failed" });
      expect(answers).toEqual([]);
    });
  });

  test("Windows without ttasks-run.exe, and other platforms", async () => {
    const missing = new WindowsProcessGroups({ helper: join(tmpdir(), "no-such-dir", "x.exe") });
    expect(await missing.probe()).toMatchObject({ available: false, reason: "helper_missing" });
    await expect(
      missing.start({ name: "r1", command: "C:\\x.exe", args: [], cwd: "C:\\", env: {} }),
    ).rejects.toMatchObject({ code: "unavailable" });
    // Elsewhere no process group exists: a run starts as the agent's process tree, so a program
    // that is not there fails its start.
    const other = processGroups({ platform: "darwin" });
    expect(await other.probe()).toMatchObject({
      available: false,
      reason: "unsupported_platform",
    });
    await expect(
      other.start({
        name: "r1",
        command: join(tmpdir(), "no-such-dir", "x"),
        args: [],
        cwd: tmpdir(),
        env: {},
      }),
    ).rejects.toMatchObject({ code: "start_failed" });
  });

  test("process group names are checked before anything is made", async () => {
    const box = new WindowsProcessGroups({ helper: "C:\\x.exe" });
    for (const name of ["", "-a", "a/b", "a\\b", "a b", "Global\\x", "x".repeat(101)]) {
      await expect(box.confirmEmpty(name)).rejects.toMatchObject({ code: "bad_name" });
    }
  });
});

describe("[A4.3.11.8.group.command-line] a Windows command line quotes each argument as the C runtime reads it back", () => {
  test("quoting", () => {
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArg("a\\b")).toBe("a\\b");
    expect(quoteWindowsArg("a b\\")).toBe('"a b\\\\"');
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
    expect(windowsCommandLine(["C:\\Program Files\\x.exe", "-e", "a b"])).toBe(
      '"C:\\Program Files\\x.exe" -e "a b"',
    );
    expect(() => windowsCommandLine(['C:\\a"b.exe'])).toThrow();
  });
});
