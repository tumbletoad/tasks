// The systemd unit and the LaunchAgent in temporary folders, with systemctl, loginctl and launchctl
// played by a recorder (install-fakes.ts): no test writes ~/.config/systemd/user or
// ~/Library/LaunchAgents, or calls a real systemctl, loginctl or launchctl. The "no trace" check is
// a file-level diff of the stand-in home folder. Linux and macOS hosts only: the unit's and plist's
// paths are POSIX paths.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderPlist, renderUnit } from "../src/install/render.ts";
import { serviceEntry } from "../src/install/entries.ts";
import {
  captureIO,
  fakeContext,
  snapshot,
  TEST_INSTALL_ID,
  type FakeContext,
} from "./install-fakes.ts";

const posix = process.platform !== "win32";
const UNIT = `tasks-${TEST_INSTALL_ID}.service`;
const LABEL = `local.tasks.service.${TEST_INSTALL_ID}`;

let dir = "";
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-svc-posix-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (
  fake: FakeContext,
  verb: Parameters<typeof serviceEntry>[0],
  flags: Parameters<typeof serviceEntry>[1] = { yes: true },
) => {
  const io = captureIO();
  return serviceEntry(verb, flags, io.io, () => fake.ctx).then((code) => ({ code, io }));
};

/** The recorder's calls that change something: the reads (show, is-active, print…) left out. */
const changes = (fake: FakeContext) =>
  fake.tools
    .lines()
    .filter(
      (line) =>
        !/^(systemctl --user (show|is-active|is-enabled)|loginctl|launchctl print)/.test(line),
    );

describe.skipIf(!posix)(
  "[A2.3.3.3.service-install.no-trace-files] the unit and the plist in temporary folders",
  () => {
    test("Linux: install writes exactly its unit, enables it and starts it, never linger; install then uninstall leaves no trace", async () => {
      const fake = fakeContext({ platform: "linux", dir, tools: { linger: "no" } });
      const home = fake.ctx.home;
      const before = snapshot(home);
      const note = join(fake.ctx.layout.state, "service-entry.json");

      const preview = await run(fake, "install", { dryRun: true });
      expect(preview.code).toBe(0);
      const unitPath = join(fake.ctx.roots.unitDir, UNIT);
      const text = renderUnit({ program: fake.ctx.program, tasksHome: fake.ctx.layout.root });
      expect(preview.io.text()).toBe(
        [
          `tasks service install, for the test install at ${fake.ctx.layout.root} (install ID ${TEST_INSTALL_ID}).`,
          "This will:",
          `  1. Create the folder ${fake.ctx.roots.unitDir}.`,
          `  2. Write ${unitPath}:`,
          ...text
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => `       | ${line}`.trimEnd()),
          "  3. Run: systemctl --user daemon-reload",
          `  4. Run: systemctl --user enable ${UNIT}`,
          `       It creates the folder ${join(fake.ctx.roots.unitDir, "default.target.wants")}.`,
          `  5. Start the service: systemctl --user start ${UNIT}, and wait until it is ready.`,
          "Linger is off: the service starts when you sign in and stops when you sign out. TT Tasks does not change that. To start it at boot, you can run: loginctl enable-linger",
          `The folders and keys this creates are noted in ${note}, so tasks service uninstall removes them again when they are empty.`,
          "Nothing else changes. To undo it: tasks service uninstall",
          "",
        ].join("\n"),
      );
      expect(snapshot(home)).toEqual(before);

      const installed = await run(fake, "install");
      expect(installed.code).toBe(0);
      expect(changes(fake)).toEqual([
        "systemctl --user daemon-reload",
        `systemctl --user enable ${UNIT}`,
        `systemctl --user start ${UNIT}`,
      ]);
      const after = snapshot(home);
      expect(after.filter((entry) => !before.includes(entry))).toEqual([
        "dir .config",
        "dir .config/systemd",
        "dir .config/systemd/user",
        "dir .config/systemd/user/default.target.wants",
        `file .config/systemd/user/${UNIT} ${text}`,
        `link .config/systemd/user/default.target.wants/${UNIT} -> ../${UNIT}`,
      ]);
      expect(installed.io.text()).toContain("started by systemd");

      const status = await run(fake, "status", { json: true });
      expect(JSON.parse(status.io.text())).toMatchObject({
        entry: { kind: "systemd-unit", name: UNIT, where: unitPath, state: "ours", current: true },
        autostart: {
          kind: "systemd",
          user_manager: true,
          enabled: "enabled",
          active: "active",
          linger: "no",
        },
        service: { answers: true, state: "ready", manager: "systemd" },
      });

      // The note of what install created, for an uninstall in a later process.
      expect(JSON.parse(readFileSync(note, "utf8"))).toEqual({
        format: 1,
        entry: `systemd-unit ${unitPath}`,
        folders: [
          fake.ctx.roots.unitDir,
          join(home, ".config", "systemd"),
          join(home, ".config"),
          join(fake.ctx.roots.unitDir, "default.target.wants"),
        ],
        keys: [],
      });

      // A later process: a new context, the same folders.
      const later = { ...fake, ctx: { ...fake.ctx } };
      const removed = await run(later, "uninstall");
      expect(removed.code).toBe(0);
      expect(changes(fake).slice(3)).toEqual([
        `systemctl --user stop ${UNIT}`,
        `systemctl --user disable ${UNIT}`,
        "systemctl --user daemon-reload",
      ]);
      expect(removed.io.text()).toContain(
        `Remove the folder ${join(home, ".config")} if it is empty: install created it.`,
      );
      // From a home without .config: every folder install made, .config included, is gone again,
      // and so is the note.
      expect(snapshot(home)).toEqual(before);
      expect(existsSync(note)).toBe(false);
      expect(fake.tools.lines().some((line) => line.includes("enable-linger"))).toBe(false);
      expect(fake.tools.lines().some((line) => line.includes("--now"))).toBe(false);
    });

    test("round 3: a unit with a NUL, text that is not UTF-8 or an empty unknown section is someone else's: never removed", async () => {
      const fake = fakeContext({ platform: "linux", dir });
      expect((await run(fake, "install")).code).toBe(0);
      const unitPath = join(fake.ctx.roots.unitDir, UNIT);
      const ours = readFileSync(unitPath);
      for (const tail of [
        // A review's probe: systemd reads NUL as a line end, so this unit runs another program
        // first.
        Buffer.from("# comment\u0000[Service]\u0000ExecStartPre=/usr/bin/other\n"),
        Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]),
        Buffer.from("[Timer]\n"),
      ]) {
        const changed = Buffer.concat([ours, tail]);
        writeFileSync(unitPath, changed);
        const calls = fake.tools.lines().length;
        for (const verb of ["uninstall", "install"] as const) {
          const result = await run(fake, verb);
          expect(result.code).toBe(4);
          expect(result.io.errors()).toMatch(/never writes|settings that tasks service install/);
        }
        expect(readFileSync(unitPath).equals(changed)).toBe(true);
        expect(
          fake.tools
            .lines()
            .slice(calls)
            .filter((line) => /systemctl --user (stop|disable|enable|daemon-reload)/.test(line)),
        ).toEqual([]);
      }
    });

    test("round 3: a change while a manager acts is found by the read after it, and one before a stop leaves the service running", async () => {
      const fake = fakeContext({ platform: "linux", dir });
      expect((await run(fake, "install")).code).toBe(0);
      const unitPath = join(fake.ctx.roots.unitDir, UNIT);
      const ours = readFileSync(unitPath, "utf8");
      const foreign = ours.replace("RestartSec=2", "RestartSec=2\nExecStartPre=/usr/bin/other");

      // Changed while systemctl checks whether the unit is active, right before the stop: the
      // stop is not asked for, and the service runs on.
      fake.tools.onCall = (line) => {
        if (line.startsWith("systemctl --user is-active")) writeFileSync(unitPath, foreign);
      };
      const calls = fake.tools.lines().length;
      const stopped = await run(fake, "uninstall");
      fake.tools.onCall = undefined;
      expect(stopped.code).toBe(4);
      expect(stopped.io.errors()).toContain("stopped before step 1 and changed nothing more");
      expect(fake.tools.lines().slice(calls)).not.toContain(`systemctl --user stop ${UNIT}`);
      expect(fake.service.running).toBe(true);
      expect(readFileSync(unitPath, "utf8")).toBe(foreign);

      // Changed while systemctl disables the unit, after the last read before it: the disable ran,
      // and the read after it stops the uninstall before the next step.
      writeFileSync(unitPath, ours);
      fake.tools.onCall = (line) => {
        if (line === "systemctl --user disable tasks-gz2r16ezc2.service") {
          writeFileSync(unitPath, foreign);
        }
      };
      const reloaded = await run(fake, "uninstall");
      fake.tools.onCall = undefined;
      expect(reloaded.code).toBe(4);
      expect(reloaded.io.errors()).toContain(
        "after step 2 it is not what that step left there. tasks service uninstall stopped and did not go on. Steps 1 to 2 were carried out.",
      );
      expect(readFileSync(unitPath, "utf8")).toBe(foreign);
    });

    test("round 3: stop reports stopped only once the process it was asked to stop has ended, even when service.json goes first", async () => {
      for (const platform of ["linux", "darwin"] as const) {
        const fake = fakeContext({ platform, dir: join(dir, platform) });
        expect((await run(fake, "install")).code).toBe(0);
        // The drain removes service.json, then the process ends three waits later.
        fake.service.recordGoesFirst = true;
        fake.service.drainTicks = 3;
        const pid = fake.service.pid;
        const stopped = await run(fake, "stop", { json: true });
        expect(stopped.code).toBe(0);
        expect(JSON.parse(stopped.io.text())).toEqual({
          outcome: "stopped",
          via: platform === "linux" ? "systemd" : "launchd",
        });
        expect(fake.ctx.alive(pid)).toBe(false);
      }
    });

    test("round 3: a PID taken by another process during stop's wait counts as ended only where the OS gives start times", async () => {
      for (const startTimes of [true, false]) {
        const fake = fakeContext({ platform: "linux", dir: join(dir, String(startTimes)) });
        expect((await run(fake, "install")).code).toBe(0);
        fake.service.startTimes = startTimes;
        fake.service.drainTicks = 1_000;
        let ticks = 0;
        fake.service.onTick = () => {
          ticks += 1;
          if (ticks === 2) fake.service.reusePid();
        };
        const pid = fake.service.pid;
        const result = await run(fake, "stop", { json: true });
        // The PID still names a process, now another one.
        expect(fake.ctx.alive(pid)).toBe(true);
        if (startTimes) {
          expect(result.code).toBe(0);
          expect(JSON.parse(result.io.text())).toEqual({ outcome: "stopped", via: "systemd" });
        } else {
          // Without a start time the reused PID looks like the service: the wait runs out (exit 6),
          // never a stop reported for a process that may still run.
          expect(result.code).toBe(6);
        }
      }
    });

    test("Linux: another program's unit and link stay, and a foreign file at the unit's name is never changed", async () => {
      const fake = fakeContext({ platform: "linux", dir, tools: { linger: "yes" } });
      const unitDir = fake.ctx.roots.unitDir;
      mkdirSync(join(unitDir, "default.target.wants"), { recursive: true });
      writeFileSync(join(unitDir, "other.service"), "[Service]\nExecStart=/usr/bin/other\n");
      symlinkSync("../other.service", join(unitDir, "default.target.wants", "other.service"));
      const before = snapshot(fake.ctx.home);

      const installed = await run(fake, "install");
      expect(installed.code).toBe(0);
      expect(installed.io.text()).toContain(
        "Linger is on: the service starts at boot, before you sign in.",
      );
      expect((await run(fake, "uninstall")).code).toBe(0);
      expect(snapshot(fake.ctx.home)).toEqual(before);

      writeFileSync(join(unitDir, UNIT), "[Service]\nExecStart=/usr/bin/someone-else serve\n");
      const foreign = snapshot(fake.ctx.home);
      for (const verb of ["install", "uninstall"] as const) {
        const result = await run(fake, verb);
        expect(result.code).toBe(4);
        expect(result.io.errors()).toContain("belongs to something else");
      }
      expect(snapshot(fake.ctx.home)).toEqual(foreign);
      // A link at the name is someone else's too: unlink would remove it, so nothing does.
      rmSync(join(unitDir, UNIT));
      symlinkSync("other.service", join(unitDir, UNIT));
      expect((await run(fake, "uninstall")).code).toBe(4);
    });

    test("Linux: a unit that names other units, or that changes while the question is open, is never enabled, disabled or removed", async () => {
      const fake = fakeContext({ platform: "linux", dir });
      expect((await run(fake, "install")).code).toBe(0);
      const unitPath = join(fake.ctx.roots.unitDir, UNIT);
      const ours = readFileSync(unitPath, "utf8");

      // Also= in [Install]: `systemctl disable` would disable backup.service too.
      writeFileSync(
        unitPath,
        ours.replace("WantedBy=default.target", "WantedBy=default.target\nAlso=backup.service"),
      );
      const named = await run(fake, "uninstall");
      expect(named.code).toBe(4);
      expect(named.io.errors()).toContain("names other units in its [Install] section (Also=)");
      // Our header is still there, but the unit runs another program: not ours either.
      writeFileSync(unitPath, ours.replace(/^ExecStart=.*$/m, "ExecStart=/usr/bin/other-daemon"));
      expect((await run(fake, "uninstall")).code).toBe(4);
      expect((await run(fake, "install")).code).toBe(4);
      writeFileSync(unitPath, ours);
      const calls = fake.tools.lines().length;

      // The unit is changed while the question is open: uninstall stops before it disables it.
      const capture = captureIO();
      const io = {
        ...capture.io,
        ask: () => {
          writeFileSync(
            unitPath,
            ours.replace("WantedBy=default.target", "WantedBy=default.target\nAlso=backup.service"),
          );
          return Promise.resolve(true);
        },
      };
      expect(await serviceEntry("uninstall", {}, io, () => fake.ctx)).toBe(4);
      expect(capture.errors()).toContain("changed after the preview was shown");
      expect(capture.errors()).toContain("stopped before step 1");
      // Not even the stop ran: it is checked like every step a manager carries out.
      expect(
        fake.tools
          .lines()
          .slice(calls)
          .filter((line) => /systemctl --user (stop|disable|daemon-reload)/.test(line)),
      ).toEqual([]);
      expect(fake.service.running).toBe(true);
      expect(readFileSync(unitPath, "utf8")).toContain("Also=backup.service");
    });

    test("Linux: a drop-in that overrides the unit makes it someone's own, also when it appears during the question", async () => {
      const fake = fakeContext({ platform: "linux", dir });
      expect((await run(fake, "install")).code).toBe(0);
      const unitDir = fake.ctx.roots.unitDir;
      for (const folder of [`${UNIT}.d`, "tasks-.service.d"]) {
        mkdirSync(join(unitDir, folder), { recursive: true });
        writeFileSync(
          join(unitDir, folder, "override.conf"),
          "[Install]\nAlso=backup.service\n[Service]\nExecStart=\nExecStart=/usr/bin/other\n",
        );
        const calls = fake.tools.lines().length;
        for (const verb of ["uninstall", "install"] as const) {
          const result = await run(fake, verb);
          expect(result.code).toBe(4);
          expect(result.io.errors()).toContain("is changed by drop-in files");
        }
        expect(fake.tools.lines().slice(calls)).toEqual([]);
        rmSync(join(unitDir, folder), { recursive: true });
      }
      // A .d folder with no .conf in it changes nothing, and the type-wide service.d is the
      // person's setting for every service.
      mkdirSync(join(unitDir, `${UNIT}.d`));
      mkdirSync(join(unitDir, "service.d"));
      writeFileSync(join(unitDir, "service.d", "all.conf"), "[Service]\nNice=5\n");
      expect((await run(fake, "install")).code).toBe(0);

      // Added while the question is open: uninstall stops before it touches the unit.
      const capture = captureIO();
      const io = {
        ...capture.io,
        ask: () => {
          writeFileSync(
            join(unitDir, `${UNIT}.d`, "override.conf"),
            "[Install]\nAlso=backup.service\n",
          );
          return Promise.resolve(true);
        },
      };
      const calls = fake.tools.lines().length;
      expect(await serviceEntry("uninstall", {}, io, () => fake.ctx)).toBe(4);
      expect(
        fake.tools
          .lines()
          .slice(calls)
          .filter((line) => !/ (show|is-active|is-enabled) /.test(line)),
      ).toEqual([]);
    });

    test("Linux and macOS: an agent's shell may not stop the service, not even through its manager", async () => {
      for (const platform of ["linux", "darwin"] as const) {
        const fake = fakeContext({ platform, dir: join(dir, platform) });
        expect((await run(fake, "install")).code).toBe(0);
        const agent = { ...fake, ctx: { ...fake.ctx, agentShell: true } };
        const calls = fake.tools.lines().length;
        for (const verb of ["stop", "uninstall", "install"] as const) {
          const result = await run(agent, verb);
          expect(result.code).toBe(5);
        }
        expect(fake.tools.lines().slice(calls)).toEqual([]);
        expect(fake.service.running).toBe(true);
      }
    });

    test("Linux without a user manager: install writes nothing, and start runs the service detached", async () => {
      const fake = fakeContext({ platform: "linux", dir, tools: { userManager: false } });
      const before = snapshot(fake.ctx.home);
      const installed = await run(fake, "install");
      expect(installed.code).toBe(1);
      expect(installed.io.errors()).toContain("no systemd user manager");
      expect(snapshot(fake.ctx.home)).toEqual(before);

      const started = await run(fake, "start", { json: true });
      expect(started.code).toBe(0);
      expect(JSON.parse(started.io.text())).toMatchObject({ outcome: "started", via: "manual" });
      expect(fake.detached).toEqual([{ tool: fake.ctx.program, args: ["serve"] }]);
      // With a user manager but no unit, start says to install instead of starting by hand.
      const managed = fakeContext({ platform: "linux", dir: join(dir, "m") });
      const notInstalled = await run(managed, "start", {});
      expect(notInstalled.code).toBe(3);
      expect(notInstalled.io.errors()).toContain("Try: tasks service install");
    });

    test("macOS: install writes exactly its plist and bootstraps it; install then uninstall leaves no trace", async () => {
      const fake = fakeContext({ platform: "darwin", dir });
      const agents = fake.ctx.roots.launchAgentsDir;
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "com.example.other.plist"), "<plist/>\n");
      const before = snapshot(fake.ctx.home);
      const plistPath = join(agents, `${LABEL}.plist`);

      const installed = await run(fake, "install");
      expect(installed.code).toBe(0);
      const text = renderPlist({
        label: LABEL,
        program: fake.ctx.program,
        home: fake.ctx.home,
        logs: fake.ctx.layout.logs,
      });
      expect(snapshot(fake.ctx.home).filter((entry) => !before.includes(entry))).toEqual([
        `file Library/LaunchAgents/${LABEL}.plist ${text}`,
      ]);
      expect(changes(fake)).toEqual([`launchctl bootstrap gui/501 ${plistPath}`]);
      expect(installed.io.text()).toContain("TT Tasks's service runs: ready");

      const stopped = await run(fake, "stop", { json: true });
      expect(JSON.parse(stopped.io.text())).toEqual({ outcome: "stopped", via: "launchd" });
      const started = await run(fake, "start", { json: true });
      expect(JSON.parse(started.io.text())).toMatchObject({ outcome: "started", via: "launchd" });

      const removed = await run(fake, "uninstall");
      expect(removed.code).toBe(0);
      expect(changes(fake)).toEqual([
        `launchctl bootstrap gui/501 ${plistPath}`,
        `launchctl kill TERM gui/501/${LABEL}`,
        `launchctl kickstart gui/501/${LABEL}`,
        `launchctl bootout gui/501/${LABEL}`,
      ]);
      expect(snapshot(fake.ctx.home)).toEqual(before);

      writeFileSync(
        plistPath,
        "<plist><dict><key>Label</key><string>other</string></dict></plist>\n",
      );
      expect((await run(fake, "install")).code).toBe(4);
    });
  },
);
