import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  captureIO,
  fakeContext,
  MemoryRegistry,
  NOT_ELEVATED,
  TEST_INSTALL_ID,
  type FakeContext,
} from "../../test/install-fakes.ts";
import { blockedMessage, movedMessage } from "../http/messages.ts";
import { autostartAnswer } from "./commands.ts";
import { probeService, readServiceRecord } from "./context.ts";
import { parseServiceArgs, serviceEntry } from "./entries.ts";
import { RegExe, RegistryError } from "./registry.ts";
import { runKeys } from "./render.ts";

// Windows's flow on every OS: the registry is in memory and the tools are stand-ins, so this file
// never writes a real Run value. The real reg.exe runs against a scratch key in
// test/install-windows.test.ts, and the unit and plist flows in test/install-posix.test.ts.

let dir: string;
let fake: FakeContext;
let registry: MemoryRegistry;
const RUN_NAME = `TTasks (${TEST_INSTALL_ID})`;
const keys = runKeys("HKCU\\Software\\ttasks-test-memory");

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-svc-entries-")));
  registry = new MemoryRegistry();
  // Another program's Run value and Task Manager's record of it, and the daily install's value.
  registry.set(keys.run, { name: "OtherApp", kind: "REG_SZ", data: '"C:\\Other\\other.exe" -m' });
  registry.set(keys.run, {
    name: "TTasks",
    kind: "REG_SZ",
    data: '"C:\\Users\\m\\.local\\bin\\ttasksw.exe"',
  });
  registry.set(keys.approved, {
    name: "OtherApp",
    kind: "REG_BINARY",
    data: "030000000000000000000000",
  });
  fake = fakeContext({ platform: "win32", dir, registry });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (
  verb: Parameters<typeof serviceEntry>[0],
  flags: Parameters<typeof serviceEntry>[1],
  capture: ReturnType<typeof captureIO>,
  context: FakeContext = fake,
) => serviceEntry(verb, flags, capture.io, () => context.ctx);

describe("[A2.3.3.5.service-install.commands] ttasks service install, uninstall, start, stop, restart and status", () => {
  test("install shows its preview first and changes nothing until it gets a yes", async () => {
    const before = registry.dump();
    const declined = captureIO(false);
    expect(await run("install", {}, declined)).toBe(0);
    expect(declined.text()).toBe(
      [
        `ttasks service install, for the test install at ${fake.ctx.layout.root} (install ID ${TEST_INSTALL_ID}).`,
        "This will:",
        `  1. Set the value "${RUN_NAME}" (REG_SZ) in ${keys.run}`,
        `       to "${fake.ctx.program}". Windows starts it at each sign-in.`,
        `  2. Start the service through Explorer, as Windows does at sign-in: explorer.exe "${fake.ctx.program}", and wait until it is ready.`,
        "Nothing else changes. To undo it: ttasks service uninstall",
        "Nothing was changed.",
        "",
      ].join("\n"),
    );
    expect(declined.asked).toEqual(["Continue? [y/N] "]);
    expect(registry.dump()).toEqual(before);
    expect(fake.tools.calls).toEqual([]);

    // No one to ask and no --yes: the preview, then exit 2 and nothing changed.
    const unattended = captureIO();
    expect(await run("install", {}, unattended)).toBe(2);
    expect(unattended.errors()).toContain("Try: ttasks service install --yes");
    const asJson = captureIO(true);
    expect(await run("install", { json: true }, asJson)).toBe(2);
    expect(JSON.parse(asJson.text())).toMatchObject({
      error: { code: "confirmation_needed", class: "usage" },
    });
    const dry = captureIO(true);
    expect(await run("install", { dryRun: true }, dry)).toBe(0);
    expect(dry.asked).toEqual([]);
    expect(dry.text()).toContain("This will:");
    expect(registry.dump()).toEqual(before);
    expect(registry.writes).toEqual([]);
  });

  test("install --yes writes its one value, starts through Explorer and waits for a ready service", async () => {
    const before = registry.dump();
    const out = captureIO();
    expect(await run("install", { yes: true }, out)).toBe(0);
    expect(registry.writes).toEqual([`set ${keys.run} ${RUN_NAME}`]);
    const added = registry.dump().filter((line) => !before.includes(line));
    expect(added).toEqual([
      `${keys.run.toLowerCase()} | ${RUN_NAME} | REG_SZ | "${fake.ctx.program}"`,
    ]);
    expect(before.every((line) => registry.dump().includes(line))).toBe(true);
    expect(fake.tools.lines()).toEqual([
      `tasklist.exe /FO CSV /NH /FI PID eq ${String(process.pid)}`,
      "tasklist.exe /FO CSV /NH /FI IMAGENAME eq explorer.exe",
      `explorer.exe "${fake.ctx.program}"`,
    ]);
    // Explorer gets only the time start has left.
    expect(fake.tools.options.at(-1)).toMatchObject({ verbatim: true });
    expect(fake.tools.options.at(-1)?.timeoutMs).toBeLessThanOrEqual(fake.ctx.readyTimeoutMs);
    expect(out.text()).toContain("Done. TTasks's service is installed.");
    expect(out.text()).toContain(
      "runs: ready, PID 4121, version 0.0.0-test (test), started by ttasksw.",
    );

    // A second install finds its value and changes nothing, and the service already runs.
    const again = captureIO();
    expect(await run("install", { yes: true }, again)).toBe(0);
    expect(again.text()).toContain("It is already there and the same, so it is left as it is.");
    expect(again.text()).toContain("TTasks's service runs: ready");
    expect(fake.tools.lines().filter((line) => line.startsWith("explorer.exe"))).toHaveLength(1);
    expect(registry.writes).toHaveLength(1);
  });

  test("without Explorer in this session, start runs ttasksw.exe directly; from a package it refuses", async () => {
    const noShell = fakeContext({
      platform: "win32",
      dir: join(dir, "b"),
      tools: { explorer: false },
    });
    const out = captureIO();
    expect(await run("start", {}, out, noShell)).toBe(0);
    expect(noShell.detached).toEqual([{ tool: noShell.ctx.program, args: [] }]);
    expect(noShell.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);

    const packaged = fakeContext({
      platform: "win32",
      dir: join(dir, "c"),
      tools: { explorer: false },
      identity: { ...NOT_ELEVATED, package: "Claude_1.0.0.0_x64__pzs8sxrjxfjjc" },
    });
    const refused = captureIO();
    expect(await run("start", {}, refused, packaged)).toBe(5);
    expect(packaged.detached).toEqual([]);
    // Through Explorer the package does not matter: Explorer is the parent, outside it.
    const viaShell = fakeContext({
      platform: "win32",
      dir: join(dir, "d"),
      identity: { ...NOT_ELEVATED, package: "Claude_1.0.0.0_x64__pzs8sxrjxfjjc" },
    });
    expect(await run("start", {}, captureIO(), viaShell)).toBe(0);
  });

  test("install and uninstall refuse root, an elevated or unknown token and package identity before reading anything", async () => {
    for (const identity of [
      { ...NOT_ELEVATED, root: true },
      { ...NOT_ELEVATED, elevated: true },
      { ...NOT_ELEVATED, elevated: undefined },
      { ...NOT_ELEVATED, package: "OpenAI.Codex_1.0.0.0_x64__abc" },
    ]) {
      const refused = fakeContext({ platform: "win32", dir: join(dir, "r"), registry, identity });
      for (const verb of ["install", "uninstall"] as const) {
        const out = captureIO(true);
        expect(await run(verb, { yes: true }, out, refused)).toBe(5);
        expect(out.text()).toBe("");
      }
    }
    expect(registry.writes).toEqual([]);
  });

  test("a value of something else at the install's name is never changed: install and uninstall exit 4", async () => {
    registry.set(keys.run, {
      name: RUN_NAME.toUpperCase(),
      kind: "REG_SZ",
      data: '"C:\\Other\\updater.exe"',
    });
    const before = registry.dump();
    for (const verb of ["install", "uninstall"] as const) {
      const out = captureIO(true);
      expect(await run(verb, { yes: true }, out)).toBe(4);
      expect(out.errors()).toContain("belongs to something else");
    }
    expect(registry.dump()).toEqual(before);
    expect(registry.writes).toEqual([]);
  });

  test("install without a build at the program's path exits 3 and writes nothing", async () => {
    rmSync(fake.ctx.program);
    const out = captureIO(true);
    expect(await run("install", { yes: true }, out)).toBe(3);
    expect(out.errors()).toContain("No TTasks build at");
    expect(registry.writes).toEqual([]);
  });

  test("status shows the UI's listener: its address, a moved port's line, a blocked port's message (A2 3.8.2)", async () => {
    expect(await run("install", { yes: true }, captureIO())).toBe(0);
    const statusOf = async (http: typeof fake.service.http) => {
      fake.service.http = http;
      const text = captureIO();
      expect(await run("status", {}, text)).toBe(0);
      const json = captureIO();
      expect(await run("status", { json: true }, json)).toBe(0);
      return { text: text.text(), json: JSON.parse(json.text()) as { service: unknown } };
    };
    const base = { host: "127.0.0.1", persisted: 7713, moved: false, blocked: null } as const;
    const served = await statusOf({ ...base, port: 7713 });
    expect(served.text).toContain("  UI:       http://127.0.0.1:7713");
    expect(served.json.service).toMatchObject({ http: { port: 7713, blocked: null } });
    const moved = await statusOf({ ...base, port: 41385, moved: true });
    expect(moved.text).toContain(`  UI:       ${movedMessage(7713, 41385)}`);
    const blocked = await statusOf({ ...base, port: 7713, blocked: "foreign_port_holder" });
    expect(blocked.text).toContain(`  UI:       ${blockedMessage(7713)}`);
    expect(blocked.json.service).toMatchObject({ http: { blocked: "foreign_port_holder" } });
    expect((await statusOf(null)).text).toContain("  UI:       no listener");
  });

  test("Task Manager's off choice is reported by status, kept by install, and removed with the entry by uninstall", async () => {
    const before = registry.dump();
    expect(await run("install", { yes: true }, captureIO())).toBe(0);
    // The user turns the entry off in Task Manager: Windows writes its record.
    registry.set(keys.approved, {
      name: RUN_NAME,
      kind: "REG_BINARY",
      data: "03000000a1b2c3d4e5f60718",
    });

    const status = captureIO();
    expect(await run("status", { json: true }, status)).toBe(0);
    expect(JSON.parse(status.text())).toMatchObject({
      install_id: TEST_INSTALL_ID,
      ttasks_home: fake.ctx.layout.root,
      entry: { kind: "run-value", name: RUN_NAME, state: "ours", current: true },
      autostart: { kind: "run", startup_apps: "off" },
      service: { answers: true, state: "ready", manager: "ttasksw" },
    });
    const text = captureIO();
    expect(await run("status", {}, text)).toBe(0);
    expect(text.text()).toContain(
      "  Autostart: off: TTasks is turned off in Startup apps (Task Manager), so Windows does not start it at sign-in. Turn it on there to have it start\n",
    );

    const reinstall = captureIO();
    const writes = registry.writes.length;
    expect(await run("install", { yes: true }, reinstall)).toBe(0);
    expect(reinstall.text()).toContain("TTasks is turned off in Startup apps (Task Manager)");
    expect(registry.writes).toHaveLength(writes);
    expect(registry.dump().some((line) => line.includes(`${RUN_NAME} | REG_BINARY | 03`))).toBe(
      true,
    );

    const removed = captureIO();
    expect(await run("uninstall", { yes: true }, removed)).toBe(0);
    expect(removed.text()).toContain(`Remove the value "${RUN_NAME}" from ${keys.run}.`);
    expect(removed.text()).toContain(
      `Remove Task Manager's on or off record for "${RUN_NAME}" from ${keys.approved}.`,
    );
    expect(removed.text()).toContain("TTasks's service has stopped.");
    expect(fake.service.running).toBe(false);
    // The key-level diff: exactly what was there before install.
    expect(registry.dump()).toEqual(before);

    const nothing = captureIO();
    expect(await run("uninstall", { yes: true }, nothing)).toBe(0);
    expect(nothing.text()).toContain(`Nothing to remove: ${keys.run} has no value "${RUN_NAME}".`);
  });

  test("autostart is on only with this install's own entry, and off says what to run", async () => {
    const statusOf = async () => {
      const text = captureIO();
      expect(await run("status", {}, text)).toBe(0);
      const json = captureIO();
      expect(await run("status", { json: true }, json)).toBe(0);
      return { text: text.text(), json: JSON.parse(json.text()) as { starts: unknown } };
    };
    // No entry of this install, whatever another program's Startup apps record says.
    const absent = await statusOf();
    expect(absent.text).not.toMatch(/Startup apps: on/);
    expect(absent.json.starts).toEqual({
      on: false,
      text: "off: this install has no entry, so Windows does not start the service at sign-in",
      fix: "ttasks service install",
    });
    expect(absent.text).toContain(
      "  Autostart: off: this install has no entry, so Windows does not start the service at sign-in. To have it start by itself: ttasks service install\n",
    );

    expect(await run("install", { yes: true }, captureIO())).toBe(0);
    const on = await statusOf();
    expect(on.json.starts).toEqual({
      on: true,
      text: "on: Windows starts the service when you sign in",
    });
    expect(on.text).toContain("  Autostart: on: Windows starts the service when you sign in\n");
  });

  test("on Linux autostart is on only for this install's unit, and only while systemd has it enabled", () => {
    const unit = {
      kind: "systemd-unit",
      name: "u",
      where: "/u",
      state: "ours",
      current: true,
    } as const;
    const systemd = (enabled: string | null, linger: "yes" | "no" | "unknown") =>
      ({ kind: "systemd", user_manager: true, enabled, active: "active", linger }) as const;
    expect(autostartAnswer(unit, systemd("enabled", "no"))).toEqual({
      on: true,
      text: "on: the service starts when you sign in. To start it at boot: loginctl enable-linger",
    });
    expect(autostartAnswer(unit, systemd("enabled", "yes")).on).toBe(true);
    // Disabled, linger or not: off, and install enables it again.
    for (const linger of ["yes", "no"] as const) {
      expect(autostartAnswer(unit, systemd("disabled", linger))).toEqual({
        on: false,
        text: "off: systemd has the unit disabled, so it does not start the service at sign-in or boot",
        fix: "ttasks service install",
      });
    }
    expect(autostartAnswer(unit, systemd(null, "yes")).on).toBeNull();
    expect(autostartAnswer({ ...unit, state: "absent" }, systemd("enabled", "yes"))).toMatchObject({
      on: false,
      fix: "ttasks service install",
    });
    expect(autostartAnswer(unit, { ...systemd("enabled", "yes"), user_manager: false }).on).toBe(
      false,
    );
  });

  test("start waits for ready and says so when it does not come; a running service is left alone", async () => {
    fake.service.becomesReady = false;
    const late = captureIO();
    expect(await run("start", {}, late)).toBe(6);
    expect(late.errors()).toContain("did not become ready within 0 s");
    fake.service.becomesReady = true;
    const again = captureIO();
    expect(await run("start", { json: true }, again)).toBe(0);
    expect(JSON.parse(again.text())).toMatchObject({ outcome: "already_running", via: "none" });
    expect(fake.tools.lines().filter((line) => line.startsWith("explorer.exe"))).toHaveLength(1);
  });

  test("restart is stop, then start through Explorer, with one answer that names the version that runs now; status names an installed version the service does not run", async () => {
    fake.service.version = "0.1.0";
    fake.service.start("ttasksw");
    // An install put 0.2.0 in place while the service ran.
    writeFileSync(join(fake.ctx.layout.root, "current"), "0.2.0");
    fake.service.current = "0.2.0";
    const pending = captureIO();
    expect(await run("status", {}, pending)).toBe(0);
    expect(pending.text()).toContain(
      "  Installed: 0.2.0, not yet running. To run it: ttasks service restart\n",
    );
    const pendingJson = captureIO();
    expect(await run("status", { json: true }, pendingJson)).toBe(0);
    expect(JSON.parse(pendingJson.text())).toMatchObject({
      installed: "0.2.0",
      service: { answers: true, version: "0.1.0" },
    });

    const restarted = captureIO();
    expect(await run("restart", {}, restarted)).toBe(0);
    expect(restarted.text()).toBe(
      `TTasks's service restarted on version 0.2.0 (it ran 0.1.0 before): ready, PID ${String(fake.service.pid)}, build test, started by ttasksw.\n`,
    );
    expect(fake.service.events.slice(-2)).toEqual(["stop", "start ttasksw"]);
    const after = captureIO();
    expect(await run("status", {}, after)).toBe(0);
    expect(after.text()).not.toContain("Installed:");

    // A restart with nothing running starts it.
    expect(await run("stop", {}, captureIO())).toBe(0);
    const started = captureIO();
    expect(await run("restart", { json: true }, started)).toBe(0);
    expect(JSON.parse(started.text())).toMatchObject({
      outcome: "started",
      was: null,
      stop: { outcome: "not_running" },
      start: { outcome: "started", via: "explorer", status: { version: "0.2.0" } },
    });
    const again = captureIO();
    expect(await run("restart", {}, again)).toBe(0);
    expect(again.text()).toMatch(/^TTasks's service restarted on version 0\.2\.0: ready, /);

    // An agent's shell may not restart it, as it may not stop it: refused before anything is asked.
    const agent = fakeContext({ platform: "win32", dir: join(dir, "agent"), agentShell: true });
    agent.service.start("ttasksw");
    const refused = captureIO();
    expect(await run("restart", {}, refused, agent)).toBe(5);
    expect(refused.errors()).toContain("ttasks service restart is not run from an agent's shell");
    expect(agent.service.events).toEqual(["start ttasksw"]);
  });

  test("restart leaves a running service alone when it could not start it again, and says so when the start fails after the stop", async () => {
    // No program to start: the running service keeps running.
    const gone = fakeContext({ platform: "win32", dir: join(dir, "gone") });
    gone.service.start("ttasksw");
    rmSync(gone.ctx.program);
    const refused = captureIO();
    expect(await run("restart", {}, refused, gone)).toBe(3);
    expect(refused.errors()).toContain("No TTasks build at");
    expect(gone.service.events).toEqual(["start ttasksw"]);
    expect(gone.service.running).toBe(true);

    // The stop worked and the new service never became ready: the error says the old one stopped.
    fake.service.start("ttasksw");
    fake.service.becomesReady = false;
    const failed = captureIO();
    expect(await run("restart", {}, failed)).not.toBe(0);
    expect(failed.errors()).toContain(
      "TTasks's service stopped for the restart, and the start failed: TTasks's service did not become ready",
    );
    expect(failed.errors()).toContain("Try: ttasks service status");
  });

  test("stop asks the service over its endpoint, and an agent's shell may not", async () => {
    const idle = captureIO();
    expect(await run("stop", {}, idle)).toBe(0);
    expect(idle.text()).toBe("TTasks's service is not running.\n");

    fake.service.start("ttasksw");
    const stopped = captureIO();
    expect(await run("stop", { json: true }, stopped)).toBe(0);
    expect(JSON.parse(stopped.text())).toEqual({ outcome: "stopped", via: "shutdown" });

    fake.service.start("ttasksw");
    fake.service.shutdownAnswer = "forbidden";
    const agent = captureIO();
    expect(await run("stop", {}, agent)).toBe(5);
    expect(agent.errors()).toContain("An agent's shell cannot stop");

    fake.service.shutdownAnswer = "stopping"; // answers, but never ends
    const stuck = captureIO();
    expect(await run("stop", {}, stuck)).toBe(6);
    expect(stuck.errors()).toContain("did not stop within");
    // The shutdown request gets only the time left of stop's own bound.
    expect(fake.service.budgets.at(-1)).toBeLessThanOrEqual(fake.ctx.stopTimeoutMs);
  });

  test("service.json says where to look, not what runs: stale records read as not running, a live one with an unreadable key does not", async () => {
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const id = TEST_INSTALL_ID;
    const write = (record: Record<string, unknown>, ageMs = 0) => {
      const file = join(state, "service.json");
      writeFileSync(file, JSON.stringify({ install_id: id, instance: "i1", ...record }));
      const at = new Date(Date.now() - ageMs);
      utimesSync(file, at, at);
    };
    const live = process.pid;
    const dead = 2 ** 30 + 7; // above any PID the OS hands out
    const probe = () => probeService(state, id, {}, 1_000);

    expect(await probe()).toEqual({ answers: false, reason: "not_running" });
    // A record whose process has ended is what a crash left.
    write({ pid: dead, state: "ready", endpoint: { kind: "pipe", path: "\\\\.\\pipe\\none" } });
    expect(await probe()).toEqual({ answers: false, reason: "not_running" });
    // Starting and draining are short: such a record a minute old is stale, whoever has the PID now.
    write({ pid: live, state: "starting", endpoint: null });
    expect(await probe()).toEqual({ answers: false, reason: "starting" });
    write({ pid: live, state: "starting", endpoint: null }, 2 * 60_000);
    expect(await probe()).toEqual({ answers: false, reason: "not_running" });
    write({ pid: live, state: "draining", endpoint: { kind: "pipe", path: "x" } });
    expect(await probe()).toEqual({ answers: false, reason: "stopping" });
    write({ pid: live, state: "draining", endpoint: { kind: "pipe", path: "x" } }, 2 * 60_000);
    expect(await probe()).toEqual({ answers: false, reason: "not_running" });
    // A live service whose key cannot be read is not reported absent.
    write({ pid: live, state: "ready", endpoint: { kind: "pipe", path: "x" } });
    expect(await probe()).toEqual({ answers: false, reason: "unreachable" });
    expect(readServiceRecord(state)).toMatchObject({ pid: live, state: "ready", endpoint: "x" });
    // Through the commands: start does not start a second service, stop does not say "not running".
    const record = readServiceRecord(state);
    const blind = fakeContext({ platform: "win32", dir: join(dir, "blind"), registry });
    const ctx = {
      ...blind.ctx,
      record: () =>
        record === undefined ? undefined : { ...record, installId: blind.ctx.installId },
      alive: (pid: number) => pid === live,
      probe: () => Promise.resolve({ answers: false as const, reason: "unreachable" as const }),
    };
    expect(await serviceEntry("start", {}, captureIO().io, () => ctx)).toBe(6);
    expect(await serviceEntry("stop", {}, captureIO().io, () => ctx)).toBe(6);
    expect(blind.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);
  });

  test("an entry that changes while the question is open is left as it is: install and uninstall stop with exit 4", async () => {
    /** A person who answers yes after another program changed the registry. */
    const answering = (meanwhile: () => void) => {
      const capture = captureIO();
      return {
        ...capture,
        io: {
          ...capture.io,
          ask: () => {
            meanwhile();
            return Promise.resolve(true);
          },
        },
      };
    };
    const foreign = { name: RUN_NAME, kind: "REG_SZ", data: '"C:\\Other\\updater.exe"' };

    // install: the value appears while the question is open, and is not overwritten.
    const install = answering(() => {
      registry.set(keys.run, foreign);
    });
    expect(await run("install", {}, install)).toBe(4);
    expect(install.errors()).toContain("changed after the preview was shown");
    expect(install.errors()).toContain("stopped before step 1");
    expect(registry.writes).toEqual([]);
    expect(fake.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);
    await registry.remove(keys.run, RUN_NAME);

    // uninstall: our value is replaced while the question is open, and is not removed.
    expect(await run("install", { yes: true }, captureIO())).toBe(0);
    registry.writes.length = 0;
    const uninstall = answering(() => {
      registry.set(keys.run, foreign);
    });
    expect(await run("uninstall", {}, uninstall)).toBe(4);
    // The stop is checked too: the service the changed entry may now start is left running.
    expect(uninstall.errors()).toContain("stopped before step 1 and changed nothing more");
    expect(fake.service.running).toBe(true);
    expect((await registry.values(keys.run))?.get(RUN_NAME.toLowerCase())).toEqual(foreign);
    expect(registry.writes.filter((line) => line.startsWith("remove"))).toEqual([]);

    // uninstall: Task Manager's record appears while the question is open; uninstall would have
    // left it behind, so it stops and says to look again.
    registry.set(keys.run, { name: RUN_NAME, kind: "REG_SZ", data: `"${fake.ctx.program}"` });
    const toggled = answering(() => {
      registry.set(keys.approved, { name: RUN_NAME, kind: "REG_BINARY", data: "03000000" });
    });
    expect(await run("uninstall", {}, toggled)).toBe(4);
    expect(registry.writes.filter((line) => line.startsWith("remove"))).toEqual([]);
    // Looked at again, the plan includes the record, and uninstall leaves no trace.
    expect(await run("uninstall", { yes: true }, captureIO())).toBe(0);
    const left = registry
      .dump()
      .filter((line) => line.toLowerCase().includes(RUN_NAME.toLowerCase()));
    expect(left).toEqual([]);
  });

  /** A person who answers yes, after which `meanwhile` arms what another program will do. */
  const answeringYes = (meanwhile: () => void) => {
    const capture = captureIO();
    return {
      ...capture,
      io: {
        ...capture.io,
        ask: () => {
          meanwhile();
          return Promise.resolve(true);
        },
      },
    };
  };
  const foreignValue = { name: RUN_NAME, kind: "REG_SZ", data: '"C:\\Other\\updater.exe"' };
  const runValue = () => registry.keys.get(keys.run.toLowerCase())?.get(RUN_NAME.toLowerCase());
  const once = (action: () => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      action();
    };
  };

  test("round 3: the entry is the last thing read before each change, so a change during any read before it is never overwritten or removed", async () => {
    // Another program replaces the Run value during the n-th registry read after the question,
    // for every read the apply makes. Each read looks after the change, so each run stops (exit 4)
    // and the other program's value stays. A read after a write that finds it replaced is the
    // check after the step: the run stops there too.
    for (const verb of ["install", "uninstall"] as const) {
      for (let n = 1; ; n += 1) {
        const reads = { count: 0, writesAtChange: -1 };
        if (verb === "uninstall") {
          registry.set(keys.run, { name: RUN_NAME, kind: "REG_SZ", data: `"${fake.ctx.program}"` });
          if (!fake.service.running) fake.service.start("ttasksw");
        } else {
          await registry.remove(keys.run, RUN_NAME).catch(() => undefined);
          fake.service.stop();
        }
        const io = answeringYes(() => {
          registry.onRead = () => {
            reads.count += 1;
            if (reads.count !== n) return;
            registry.set(keys.run, foreignValue);
            reads.writesAtChange = registry.writes.length;
          };
        });
        const code = await run(verb, {}, io);
        registry.onRead = undefined;
        if (reads.count < n) {
          // n is past the last read: the run went through untouched.
          expect(code).toBe(0);
          expect(n).toBeGreaterThan(4);
          break;
        }
        expect(code, `${verb}, a change during read ${String(n)}`).toBe(4);
        expect(io.errors()).toContain("changed");
        // The other program's value stays, and nothing was written after it was.
        expect(runValue()).toEqual(foreignValue);
        expect(registry.writes).toHaveLength(reads.writesAtChange);
      }
    }
  });

  test("round 3: a change during start's first probe stops install before the service is started", async () => {
    // A review's second probe: the Run value is replaced while start's first probe runs.
    const io = answeringYes(() => {
      fake.service.onProbe = once(() => {
        registry.set(keys.run, foreignValue);
      });
    });
    expect(await run("install", {}, io)).toBe(4);
    expect(io.errors()).toContain("changed after the preview was shown");
    expect(io.errors()).toContain(
      "stopped before step 2 and changed nothing more. Step 1 was carried out.",
    );
    expect(fake.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);
    expect(fake.service.running).toBe(false);
    expect(runValue()).toEqual(foreignValue);
  });

  test("round 3: a change during stop's probe stops uninstall before the service is asked to stop", async () => {
    // A review's third probe: the Run value is replaced while the stop step's probe runs.
    expect(await run("install", { yes: true }, captureIO())).toBe(0);
    expect(fake.service.running).toBe(true);
    const io = answeringYes(() => {
      fake.service.onProbe = once(() => {
        registry.set(keys.run, foreignValue);
      });
    });
    expect(await run("uninstall", {}, io)).toBe(4);
    expect(io.errors()).toContain("stopped before step 1 and changed nothing more");
    expect(fake.service.running).toBe(true);
    expect(runValue()).toEqual(foreignValue);
    expect(registry.writes.filter((line) => line.startsWith("remove"))).toEqual([]);
  });

  test("round 3: a change right after a write or a start is found by the read after it: the run stops and says what was done", async () => {
    // Another program writes the value right after install's write: found before the start.
    const written = answeringYes(() => {
      registry.afterWrite = once(() => {
        registry.set(keys.run, foreignValue);
      });
    });
    expect(await run("install", {}, written)).toBe(4);
    registry.afterWrite = undefined;
    expect(written.errors()).toContain(
      "changed while ttasks service install was running: after step 1 it is not what that step left there. ttasks service install stopped and did not go on. Step 1 was carried out.",
    );
    expect(fake.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);
    expect(runValue()).toEqual(foreignValue);

    // Changed while Explorer starts the service (after the last read before the start): the start
    // happened, and the read after it reports the change.
    await registry.remove(keys.run, RUN_NAME);
    const started = answeringYes(() => {
      fake.tools.onCall = (line) => {
        if (line.startsWith("explorer.exe")) registry.set(keys.run, foreignValue);
      };
    });
    expect(await run("install", {}, started)).toBe(4);
    fake.tools.onCall = undefined;
    expect(started.errors()).toContain("after step 2 it is not what that step left there");
    expect(started.errors()).toContain("Steps 1 to 2 were carried out.");
    expect(fake.service.running).toBe(true);
  });

  test("round 3: the window the decision states: a change between the last read and the write itself is replaced, and nothing reports it", async () => {
    // reg.exe offers no compare-and-swap: a value another program writes after install's last
    // read and before reg add runs is overwritten. This pins that limit; it does not endorse it.
    const io = answeringYes(() => {
      registry.beforeWrite = once(() => {
        registry.set(keys.run, foreignValue);
      });
    });
    expect(await run("install", {}, io)).toBe(0);
    registry.beforeWrite = undefined;
    expect(runValue()?.data).toBe(`"${fake.ctx.program}"`);
  });

  test("round 3: every tool start runs gets only the time left, and nothing is started after start's deadline", async () => {
    // A review's probe: three slow tools and a short budget launched the service after the
    // deadline.
    // Tools that end at the timeout they are given: the first one runs out, and nothing starts.
    const slow = fakeContext({
      platform: "win32",
      dir: join(dir, "slow"),
      registry,
      tools: { delayMs: 1_000 },
    });
    const ctx = { ...slow.ctx, readyTimeoutMs: 100 };
    const t0 = Date.now();
    const out = captureIO();
    expect(await serviceEntry("start", {}, out.io, () => ctx)).toBe(6);
    expect(Date.now() - t0).toBeLessThan(800);
    expect(out.errors()).toContain("was not started");
    expect(slow.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);
    expect(slow.service.running).toBe(false);
    expect(slow.tools.options.length).toBeGreaterThan(0);
    for (const options of slow.tools.options) {
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(100);
    }

    // Tools that ignore their timeout: the time is checked again before the start itself.
    const stubborn = fakeContext({
      platform: "win32",
      dir: join(dir, "stubborn"),
      registry,
      tools: { delayMs: 70, honorTimeouts: false },
    });
    const late = captureIO();
    expect(
      await serviceEntry("start", {}, late.io, () => ({ ...stubborn.ctx, readyTimeoutMs: 100 })),
    ).toBe(6);
    expect(late.errors()).toContain("was not started");
    expect(stubborn.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);
    expect(stubborn.service.running).toBe(false);

    // Linux: a question to the user manager that runs out is not "no user manager", so the
    // service is not started by hand instead.
    const linux = fakeContext({
      platform: "linux",
      dir: join(dir, "linux"),
      tools: { delayMs: 1_000 },
    });
    expect(
      await serviceEntry("start", {}, captureIO().io, () => ({
        ...linux.ctx,
        readyTimeoutMs: 100,
      })),
    ).toBe(6);
    expect(linux.detached).toEqual([]);
    expect(linux.service.running).toBe(false);
  });

  test("round 3: install then uninstall from a registry root that does not exist leaves no key behind", async () => {
    const fresh = new MemoryRegistry();
    const root = "HKCU\\Software\\ttasks-test-fresh";
    const freshKeys = runKeys(root);
    const ctx = fakeContext({
      platform: "win32",
      dir: join(dir, "fresh"),
      registry: fresh,
      registryRoot: root,
    });
    const preview = captureIO();
    expect(await serviceEntry("install", { dryRun: true }, preview.io, () => ctx.ctx)).toBe(0);
    expect(preview.text()).toContain(
      `It creates the keys ${root}, ${freshKeys.run}, which do not exist yet.`,
    );
    expect(preview.text()).toContain(
      `The folders and keys this creates are noted in ${join(ctx.ctx.layout.state, "service-entry.json")}`,
    );
    expect(await serviceEntry("install", { yes: true }, captureIO().io, () => ctx.ctx)).toBe(0);
    expect(fresh.dump()).toEqual([
      `${freshKeys.run.toLowerCase()} |`,
      `${freshKeys.run.toLowerCase()} | ${RUN_NAME} | REG_SZ | "${ctx.ctx.program}"`,
    ]);
    // A later process: a new context reads the note install left.
    const later = fakeContext({
      platform: "win32",
      dir: join(dir, "fresh"),
      registry: fresh,
      registryRoot: root,
    });
    const removed = captureIO();
    expect(await serviceEntry("uninstall", { yes: true }, removed.io, () => later.ctx)).toBe(0);
    expect(removed.text()).toContain(
      `Remove the key ${freshKeys.run} if it is empty: install created it.`,
    );
    expect(removed.text()).toContain(`Remove the key ${root} if it is empty: install created it.`);
    expect(fresh.dump()).toEqual([]);
    expect(fresh.has(root)).toBe(false);
    expect(existsSync(join(later.ctx.layout.state, "service-entry.json"))).toBe(false);

    // A key that existed before install is never noted, so never removed.
    expect(await run("install", { yes: true }, captureIO())).toBe(0);
    expect(existsSync(join(fake.ctx.layout.state, "service-entry.json"))).toBe(false);
  });

  test("an agent's shell may read status and start the service, not install, uninstall or stop it", async () => {
    const agent = fakeContext({
      platform: "win32",
      dir: join(dir, "agent"),
      registry,
      agentShell: true,
    });
    const before = registry.dump();
    for (const verb of ["install", "uninstall", "stop"] as const) {
      const out = captureIO(true);
      expect(await run(verb, { yes: true }, out, agent)).toBe(5);
      expect(out.errors()).toContain("is not run from an agent's shell");
      expect(out.text()).toBe("");
    }
    expect(agent.tools.calls).toEqual([]);
    expect(registry.dump()).toEqual(before);
    expect(await run("start", {}, captureIO(), agent)).toBe(0);
    expect(await run("stop", {}, captureIO(), agent)).toBe(5);
    expect(agent.service.running).toBe(true);
    expect(await run("status", { json: true }, captureIO(), agent)).toBe(0);
  });

  test("start succeeds only with a ready service: one starting is waited for, one stopping is let end first", async () => {
    // Someone else's start, still without an endpoint: waited for, not started twice.
    fake.service.hiddenProbes = 2;
    fake.service.start("ttasksw");
    const starting = captureIO();
    expect(await run("start", { json: true }, starting)).toBe(0);
    expect(JSON.parse(starting.text())).toMatchObject({
      outcome: "already_running",
      via: "none",
      status: { state: "ready" },
    });
    expect(fake.tools.lines().some((line) => line.startsWith("explorer.exe"))).toBe(false);

    // A service that answers "starting": the same.
    fake.service.stop();
    fake.service.hiddenProbes = 0;
    fake.service.startingProbes = 3;
    fake.service.start("ttasksw");
    const answering = captureIO();
    expect(await run("start", { json: true }, answering)).toBe(0);
    expect(JSON.parse(answering.text())).toMatchObject({ outcome: "already_running" });

    // A service that is draining: start waits for its process to end, then starts a new one.
    fake.service.startingProbes = 1;
    fake.service.drainTicks = 3;
    const old = fake.service.pid;
    await fake.ctx.shutdown();
    expect(fake.ctx.alive(old)).toBe(true);
    const after = captureIO();
    expect(await run("start", { json: true }, after)).toBe(0);
    expect(JSON.parse(after.text())).toMatchObject({ outcome: "started", via: "explorer" });
    expect(fake.ctx.alive(old)).toBe(false);
    expect(fake.service.events.slice(-2)).toEqual(["stop", "start ttasksw"]);
  });

  test("stop waits for a service still starting, and for its process to end, not only its endpoint", async () => {
    fake.service.hiddenProbes = 3;
    fake.service.start("ttasksw");
    const pid = fake.service.pid;
    const early = captureIO();
    expect(await run("stop", { json: true }, early)).toBe(0);
    expect(JSON.parse(early.text())).toEqual({ outcome: "stopped", via: "shutdown" });
    expect(fake.service.running).toBe(false);
    expect(fake.ctx.alive(pid)).toBe(false);

    // The endpoint closes at once, the process ends three waits later: stop returns after that.
    fake.service.drainTicks = 3;
    fake.service.start("ttasksw");
    const draining = fake.service.pid;
    const late = captureIO();
    expect(await run("stop", { json: true }, late)).toBe(0);
    expect(JSON.parse(late.text())).toEqual({ outcome: "stopped", via: "shutdown" });
    expect(fake.ctx.alive(draining)).toBe(false);

    // One already draining is waited for too.
    fake.service.start("ttasksw");
    const other = fake.service.pid;
    await fake.ctx.shutdown();
    const already = captureIO();
    expect(await run("stop", { json: true }, already)).toBe(0);
    expect(JSON.parse(already.text())).toEqual({ outcome: "stopped", via: "none" });
    expect(fake.ctx.alive(other)).toBe(false);
  });

  test("every probe gets only the time left, so start's wait for ready ends at its deadline", async () => {
    const slow = fakeContext({ platform: "win32", dir: join(dir, "slow"), registry });
    const ctx = { ...slow.ctx, readyTimeoutMs: 250 };
    slow.service.becomesReady = false;
    slow.service.probeMs = 1_000;
    const t0 = performance.now();
    expect(await serviceEntry("start", {}, captureIO().io, () => ctx)).toBe(6);
    // One probe before the start and the wait for ready, each within its 250 ms.
    expect(performance.now() - t0).toBeLessThan(900);
    expect(slow.service.budgets.every((ms) => ms !== undefined && ms <= 250)).toBe(true);
  });

  test("a preview of start, stop, restart or status is refused before anything runs: a running service and its runs are left alone", async () => {
    fake.service.start("ttasksw");
    const before = [...fake.service.events];
    const accepted: string[] = [];
    for (const verb of ["start", "stop", "restart", "status"]) {
      for (const flags of [["--dry-run"], ["--yes"], ["--json", "--dry-run"]]) {
        // The CLI's path: parse, and dispatch only what parsed.
        const parsed = parseServiceArgs([verb, ...flags]);
        if (parsed === undefined) continue;
        accepted.push([verb, ...flags].join(" "));
        await run(parsed.verb, parsed.flags, captureIO());
      }
    }
    expect(fake.service.events).toEqual(before);
    expect(fake.service.running).toBe(true);
    expect(fake.tools.calls).toEqual([]);
    expect(accepted).toEqual([]);
  });

  test("the registry is reached only under HKCU\\Software, and the flags parse strictly", async () => {
    const calls: string[] = [];
    const reg = new RegExe({
      regExe: "reg.exe",
      scratch: join(dir, "scratch"),
      run: (file, args) => {
        calls.push([file, ...args].join(" "));
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });
    for (const key of [
      "HKLM\\Software\\X",
      "HKCU\\Environment",
      "HKCU\\Software\\",
      "HKCU\\Software\\\\X",
    ]) {
      await expect(reg.setString(key, "x", "y")).rejects.toThrow(RegistryError);
      await expect(reg.remove(key, "x")).rejects.toThrow(RegistryError);
      await expect(reg.tree(key)).rejects.toThrow(RegistryError);
    }
    expect(calls).toEqual([]);

    expect(parseServiceArgs(["install", "--yes", "--json"])).toEqual({
      verb: "install",
      flags: { yes: true, json: true },
    });
    expect(parseServiceArgs(["status"])).toEqual({ verb: "status", flags: {} });
    expect(parseServiceArgs(["restart"])).toEqual({ verb: "restart", flags: {} });
    expect(parseServiceArgs(["reload"])).toBeUndefined();
    expect(parseServiceArgs(["install", "--force"])).toBeUndefined();
    expect(parseServiceArgs(["install", "toString"])).toBeUndefined();
    expect(parseServiceArgs([])).toBeUndefined();
  });
});
