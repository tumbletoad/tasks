// The Agent Monitor's child against the test kit's fake `ttam`, which answers from TTAM's own
// recorded conversations: every rule of the conversation, every way the fake misbehaves, and after
// each test no fake left running. Nothing here starts the real `ttam`.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DetectHost } from "@ttasks/launch";
import { fakeTtam, readJsonLines, TTAM_CONVERSATIONS } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { Logger } from "../src/hub/log.ts";
import {
  findMonitor,
  Monitor,
  type MonitorAnswer,
  type MonitorCommand,
  type MonitorTimes,
} from "../src/monitor/index.ts";

/** Long enough never to fire in a test that does not wait for it, however loaded the machine. */
const NEVER: Partial<MonitorTimes> = {
  helloMs: 60_000,
  slowMs: 60_000,
  slowMaxMs: 60_000,
  answerMs: 120_000,
  idleMs: 600_000,
  killMs: 2_000,
  retryMs: [60_000],
};

const dirs: string[] = [];
const monitors: Monitor[] = [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Resolves once `ok()` holds, polled; fails the test after 30 s. */
async function until(ok: () => boolean): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!ok()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const monitor of monitors.splice(0)) await monitor.close();
  for (const dir of dirs.splice(0)) {
    const pids = readJsonLines(join(dir, "fake.log")).map((line) => (line as { pid: number }).pid);
    for (const pid of new Set(pids)) await until(() => !alive(pid));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

interface Setup {
  readonly monitor: Monitor;
  readonly dir: string;
  readonly events: [string, Readonly<Record<string, unknown>>][];
  /** Each fake's PID, in the order they started. */
  readonly pids: () => number[];
  /** Each `get` the fakes read: its ID and usage. */
  readonly gets: () => { get: number; usage: string }[];
}

function setup(
  options: {
    mode?: string;
    conversation?: keyof typeof TTAM_CONVERSATIONS;
    times?: Partial<MonitorTimes>;
    command?: MonitorCommand;
    onChange?: (monitor: Monitor) => void;
  } = {},
): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ttasks-monitor-"));
  dirs.push(dir);
  const log = join(dir, "fake.log");
  const fake = fakeTtam({
    log,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
  });
  const events: Setup["events"] = [];
  const monitor: Monitor = new Monitor({
    command: () =>
      Promise.resolve(
        options.command ?? {
          ok: true,
          file: fake.file,
          args: fake.args,
          env: process.env,
          cwd: dir,
        },
      ),
    times: { ...NEVER, ...options.times },
    log: (event, fields) => events.push([event, fields]),
    onChange: () => options.onChange?.(monitor),
  });
  monitors.push(monitor);
  const lines = () => readJsonLines(log) as { pid: number; get?: number; usage?: string }[];
  return {
    monitor,
    dir,
    events,
    pids: () => [...new Set(lines().map((line) => line.pid))],
    gets: () =>
      lines().flatMap((line) =>
        line.get === undefined ? [] : [{ get: line.get, usage: line.usage ?? "" }],
      ),
  };
}

function snapshotOf(answer: MonitorAnswer) {
  if (!answer.ok) throw new Error(`no snapshot: ${JSON.stringify(answer.problem)}`);
  return answer.snapshot;
}

describe("[A5.agents.monitor] the monitor module speaks TTAM's line protocol", () => {
  test("it starts the child on the first ask, reads its hello, and gets one snapshot per get", async () => {
    const { monitor, gets, pids } = setup();
    expect(monitor.status().state).toBe("off");
    expect(pids()).toEqual([]);
    const first = snapshotOf(await monitor.ask());
    expect(first).toMatchObject({ settling: true, usage: "cached", generation: 1 });
    expect(monitor.status()).toMatchObject({
      state: "ready",
      slow: false,
      build: { version: "0.1.0", build: "0123456789ab" },
      problem: null,
    });
    const second = snapshotOf(await monitor.ask("live"));
    expect(second).toMatchObject({ settling: false, usage: "live", generation: 2 });
    expect(gets()).toEqual([
      { get: 1, usage: "cached" },
      { get: 2, usage: "live" },
    ]);
    expect(pids()).toHaveLength(1);
  });

  test("asks while one request is out share the next one, sent after the answer: never busy", async () => {
    const { monitor, gets } = setup({ mode: "slow=200" });
    // Asks before the hello wait for it, and share the first request.
    const [early, alsoEarly] = await Promise.all([monitor.ask(), monitor.ask()]);
    expect(early).toBe(alsoEarly);
    expect(snapshotOf(early).generation).toBe(1);
    const a = monitor.ask();
    const b = monitor.ask();
    const c = monitor.ask("live");
    const [first, second, third] = await Promise.all([a, b, c]);
    expect(snapshotOf(first).generation).toBe(2);
    expect(second).toBe(third);
    expect(snapshotOf(second)).toMatchObject({ generation: 3, usage: "live" });
    expect(gets()).toEqual([
      { get: 1, usage: "cached" },
      { get: 2, usage: "cached" },
      { get: 3, usage: "live" },
    ]);
  });

  test("busy means ask again, with a new ID", async () => {
    const { monitor, gets } = setup({ mode: "busy" });
    expect(snapshotOf(await monitor.ask()).generation).toBe(1);
    expect(gets()).toEqual([
      { get: 1, usage: "cached" },
      { get: 2, usage: "cached" },
    ]);
  });

  test("a TTAM whose configuration has usage queries off answers a live get as cached", async () => {
    const { monitor } = setup({ conversation: "off" });
    expect(snapshotOf(await monitor.ask("live"))).toMatchObject({
      usage: "cached",
      settling: true,
    });
  });

  test("not installed: no ttam, a script by that name, a build without ttam query", async () => {
    const missing = setup({ command: { ok: false, reason: "not_found" } });
    expect(await missing.monitor.ask()).toEqual({
      ok: false,
      problem: { kind: "not_installed", reason: "not_found" },
    });
    const script = setup({ command: { ok: false, reason: "script" } });
    expect(await script.monitor.ask()).toMatchObject({ problem: { reason: "script" } });

    const old = setup({ mode: "no_query" });
    const answer = { ok: false, problem: { kind: "not_installed", reason: "no_query" } };
    expect(await old.monitor.ask()).toEqual(answer);
    // Kept until a page looks again: nothing is started meanwhile.
    expect(await old.monitor.ask()).toEqual(answer);
    expect(old.pids()).toHaveLength(1);
    old.monitor.recheck();
    expect(await old.monitor.ask()).toEqual(answer);
    expect(old.pids()).toHaveLength(2);
  });

  test("a hello with other versions does not fit, and names the side to update", async () => {
    const cases = [
      ["version=5,1", "ttasks"],
      ["version=4,2", "ttasks"],
      ["version=3,1", "monitor"],
      ["version=4,0", "monitor"],
    ] as const;
    for (const [mode, update] of cases) {
      const { monitor, pids } = setup({ mode });
      expect(await monitor.ask()).toEqual({
        ok: false,
        problem: {
          kind: "does_not_fit",
          update,
          found: { version: "0.1.0", build: "0123456789ab" },
        },
      });
      expect(await monitor.ask()).toMatchObject({ problem: { kind: "does_not_fit" } });
      expect(pids()).toHaveLength(1);
      expect(monitor.status().state).toBe("problem");
    }
  });

  test("a snapshot whose fields do not have their shape does not fit: never an empty answer", async () => {
    const { monitor } = setup({ mode: "bad_shape" });
    expect(await monitor.ask()).toMatchObject({
      ok: false,
      problem: { kind: "does_not_fit", update: "monitor" },
    });
  });

  test("no hello in time, or another first line, fails the child", async () => {
    const silent = setup({ mode: "silent", times: { helloMs: 300 } });
    expect(await silent.monitor.ask()).toEqual({
      ok: false,
      problem: { kind: "failed", reason: "no_hello" },
    });
    const other = setup({ mode: "not_hello" });
    expect(await other.monitor.ask()).toMatchObject({ problem: { reason: "no_hello" } });
  });

  test("a line that is not JSON, or longer than 8 MiB, fails the child", async () => {
    for (const mode of ["garbage", "long"]) {
      const { monitor } = setup({ mode });
      expect(await monitor.ask()).toEqual({
        ok: false,
        problem: { kind: "failed", reason: "bad_output" },
      });
    }
  });

  test("an exit mid-answer fails the child; it is started again only after a wait, and only when asked", async () => {
    const { monitor, pids } = setup({ mode: "die", times: { retryMs: [400] } });
    const failed = { ok: false, problem: { kind: "failed", reason: "exited" } };
    expect(await monitor.ask()).toEqual(failed);
    expect(await monitor.ask()).toEqual(failed);
    expect(pids()).toHaveLength(1);
    expect(monitor.status()).toMatchObject({ state: "problem", problem: failed.problem });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(pids()).toHaveLength(1);
    expect(await monitor.ask()).toEqual(failed);
    expect(pids()).toHaveLength(2);
  });

  test("a stalled answer marks the monitor slow first, then ends the child, killing what stays", async () => {
    let slowBeforeEnd = false;
    let answered = false;
    const { monitor, events } = setup({
      mode: "stall",
      times: { slowMs: 200, slowMaxMs: 200, answerMs: 600, killMs: 300 },
      onChange: (m) => {
        if (m.status().slow && !answered) slowBeforeEnd = true;
      },
    });
    const answer = await monitor.ask();
    answered = true;
    expect(answer).toEqual({ ok: false, problem: { kind: "failed", reason: "not_answering" } });
    expect(slowBeforeEnd).toBe(true);
    expect(monitor.status().slow).toBe(false);
    await until(() => events.some(([event]) => event === "monitor.ended"));
    expect(events).toContainEqual(["monitor.ended", { why: "not_answering", killed: true }]);
  });

  test("a child that failed is owned until it is gone: the next starts after it, close waits for both", async () => {
    const { monitor, events, pids } = setup({
      mode: "stall",
      times: { answerMs: 300, killMs: 1_000, retryMs: [0] },
    });
    const failed = { ok: false, problem: { kind: "failed", reason: "not_answering" } };
    expect(await monitor.ask()).toEqual(failed);
    expect(await monitor.ask()).toEqual(failed);
    await monitor.close();
    expect(pids()).toHaveLength(2);
    for (const pid of pids()) expect(alive(pid)).toBe(false);
    expect(events.map(([event]) => event)).toEqual([
      "monitor.started",
      "monitor.ended",
      "monitor.started",
      "monitor.ended",
    ]);
  });

  test("ten minutes after the last request the input is closed and TTAM ends by itself; output after the end is no answer", async () => {
    const { monitor, events, pids } = setup({ mode: "after_end", times: { idleMs: 300 } });
    expect(snapshotOf(await monitor.ask()).generation).toBe(1);
    await until(() => events.some(([event]) => event === "monitor.ended"));
    expect(events).toContainEqual(["monitor.ended", { why: "idle", killed: false }]);
    expect(monitor.status()).toMatchObject({ state: "off", problem: null });
    // A new process: its counters start again.
    expect(snapshotOf(await monitor.ask())).toMatchObject({ generation: 1, settling: true });
    expect(pids()).toHaveLength(2);
  });

  test("close ends the child with the service, killing it after two seconds when it stays", async () => {
    const { monitor, events, pids } = setup({ mode: "deaf", times: { killMs: 300 } });
    const asked = monitor.ask();
    await until(() => monitor.status().state === "ready");
    await monitor.close();
    expect(await asked).toEqual({ ok: false, problem: { kind: "failed", reason: "closed" } });
    expect(events).toContainEqual(["monitor.ended", { why: "closed", killed: true }]);
    for (const pid of pids()) expect(alive(pid)).toBe(false);
    expect(await monitor.ask()).toMatchObject({ problem: { reason: "closed" } });
  });

  test("when TTasks is killed, TTAM sees its input end and is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ttasks-monitor-"));
    dirs.push(dir);
    const fake = fakeTtam({ log: join(dir, "fake.log") });
    const parent = spawn(
      process.execPath,
      [fileURLToPath(new URL("./monitor-parent.ts", import.meta.url)), fake.file, ...fake.args],
      { cwd: dir, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    try {
      let out = "";
      parent.stdout.setEncoding("utf8");
      parent.stdout.on("data", (chunk: string) => (out += chunk));
      await until(() => out.includes("\n"));
      expect(out).toBe("ok\n");
      const [pid] = readJsonLines(join(dir, "fake.log")).map((l) => (l as { pid: number }).pid);
      expect(pid !== undefined && alive(pid)).toBe(true);
      parent.kill("SIGKILL");
      await until(() => pid === undefined || !alive(pid));
    } finally {
      parent.kill("SIGKILL");
    }
  });

  test("nothing of a snapshot reaches the service log", async () => {
    const logs = mkdtempSync(join(tmpdir(), "ttasks-monitor-log-"));
    dirs.push(logs);
    const logger = new Logger({ dir: logs, stderr: false, level: "debug" });
    const fake = fakeTtam({ log: join(logs, "fake.log") });
    const monitor = new Monitor({
      command: () =>
        Promise.resolve({
          ok: true,
          file: fake.file,
          args: fake.args,
          env: process.env,
          cwd: logs,
        }),
      times: NEVER,
      log: (event, fields) => {
        logger.log(event, fields);
      },
    });
    monitors.push(monitor);
    for (let i = 0; i < 4; i++) snapshotOf(await monitor.ask(i % 2 === 0 ? "cached" : "live"));
    await monitor.close();
    const text = readFileSync(logger.path, "utf8");
    expect(text).toContain('"ev":"monitor.started"');
    expect(text).toContain('"ev":"monitor.ended"');
    const strings = new Set<string>();
    const collect = (value: unknown): void => {
      // Free text, not the schema's own words such as `started`, which a log event may share.
      if (typeof value === "string" && value.length >= 6 && !/^[a-z_]+$/u.test(value)) {
        strings.add(value);
      } else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
    };
    for (const line of readFileSync(TTAM_CONVERSATIONS.on, "utf8").split("\n")) {
      if (line === "") continue;
      const record = JSON.parse(line) as { from: string; line?: string };
      if (record.from === "ttam" && record.line !== undefined) collect(JSON.parse(record.line));
    }
    expect(strings.size).toBeGreaterThan(50);
    expect([...strings].filter((s) => text.includes(s))).toEqual([]);
  });
});

describe("[A5.agents.fake-ttam] the fake ttam answers TTAM's recorded conversations as TTAM did", () => {
  for (const name of ["on", "off"] as const) {
    test(`query-usage-${name}`, async () => {
      const records = readFileSync(TTAM_CONVERSATIONS[name], "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map(
          (line) =>
            JSON.parse(line) as { from: string; line?: string; close?: string; exit?: number },
        );
      const dir = mkdtempSync(join(tmpdir(), "ttasks-fake-ttam-"));
      dirs.push(dir);
      const fake = fakeTtam({ conversation: name, log: join(dir, "fake.log") });
      const child = spawn(fake.file, [...fake.args, "query"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const got: string[] = [];
      let rest = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        rest += chunk;
        for (let at = rest.indexOf("\n"); at !== -1; at = rest.indexOf("\n")) {
          got.push(rest.slice(0, at));
          rest = rest.slice(at + 1);
        }
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const expected: unknown[] = [];
      let pending = "";
      // The consumer's lines go out together up to TTAM's next line, as one write.
      for (const record of records) {
        if (record.from === "consumer" && record.line !== undefined) pending += `${record.line}\n`;
        else if (record.from === "consumer" && record.close === "input") {
          child.stdin.end(pending);
          pending = "";
        } else if (record.from === "ttam" && record.line !== undefined) {
          if (pending !== "") child.stdin.write(pending);
          pending = "";
          expected.push(JSON.parse(record.line));
          const count = expected.length;
          await until(() => got.length >= count);
        } else if (record.from === "ttam" && record.exit !== undefined) {
          if (pending !== "") child.stdin.end(pending);
          expect(await exited).toBe(record.exit);
        }
      }
      expect(got.map((line) => JSON.parse(line) as unknown)).toEqual(expected);
    });
  }
});

describe("[A3.3.14.doctor.monitor] where ttam comes from, and whether it fits", () => {
  const host = (platform: NodeJS.Platform, files: readonly string[]): DetectHost => ({
    platform,
    env:
      platform === "win32"
        ? { Path: "C:\\bin;C:\\tools", PATHEXT: ".EXE;.CMD" }
        : { PATH: "/usr/bin:/opt/bin" },
    home: platform === "win32" ? "C:\\home" : "/home/fixture",
    stat: (path) => (files.includes(path) ? { kind: "file", executable: true } : undefined),
    list: () => undefined,
    realpath: (path) => path,
    output: () => Promise.resolve(undefined),
  });

  test("the ttam on the PATH; on Windows an executable only, never a script", () => {
    expect(findMonitor(host("linux", ["/opt/bin/ttam"]), "/home/fixture")).toMatchObject({
      ok: true,
      file: "/opt/bin/ttam",
    });
    expect(findMonitor(host("win32", ["C:\\tools\\ttam.exe"]), "C:\\home")).toMatchObject({
      ok: true,
      file: "C:\\tools\\ttam.exe",
    });
    expect(findMonitor(host("win32", ["C:\\bin\\ttam.cmd"]), "C:\\home")).toEqual({
      ok: false,
      reason: "script",
    });
    expect(findMonitor(host("linux", []), "/home/fixture")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  /** A monitor that starts no child, and a command for the fake in `mode`, which logs to `log`. */
  function prober(times: Partial<MonitorTimes> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ttasks-monitor-probe-"));
    dirs.push(dir);
    const log = join(dir, "fake.log");
    const monitor = new Monitor({
      command: () => Promise.resolve({ ok: false, reason: "not_found" }),
      times: { ...NEVER, ...times },
    });
    monitors.push(monitor);
    const command = (mode?: string): MonitorCommand => {
      const fake = fakeTtam({ log, ...(mode === undefined ? {} : { mode }) });
      return { ok: true, file: fake.file, args: fake.args, env: process.env, cwd: dir };
    };
    const pids = () => [...new Set(readJsonLines(log).map((line) => (line as { pid: number }).pid))];
    return { monitor, command, log, pids };
  }

  test("the probe reads the hello of a child whose input is closed: no pass runs", async () => {
    const { monitor, command, log } = prober();
    expect(await monitor.probe(command())).toEqual({
      fits: true,
      build: { version: "0.1.0", build: "0123456789ab" },
    });
    expect(
      readJsonLines(log).filter((line) => (line as { get?: number }).get !== undefined),
    ).toEqual([]);
    expect(await monitor.probe(command("version=5,1"))).toMatchObject({
      fits: false,
      problem: { kind: "does_not_fit", update: "ttasks" },
    });
    expect(await monitor.probe(command("no_query"))).toEqual({
      fits: false,
      problem: { kind: "not_installed", reason: "no_query" },
    });
    expect(await monitor.probe({ ok: false, reason: "not_found" })).toEqual({
      fits: false,
      problem: { kind: "not_installed", reason: "not_found" },
    });
  });

  test("a probe under way when the service stops is ended, and close waits until it is gone", async () => {
    const { monitor, command, pids } = prober({ helloMs: 60_000, killMs: 60_000 });
    const probed = monitor.probe(command("deaf"));
    await until(() => pids().length === 1);
    await monitor.close();
    expect(await probed).toEqual({ fits: false, problem: { kind: "failed", reason: "closed" } });
    for (const pid of pids()) expect(alive(pid)).toBe(false);
    expect(await monitor.probe(command())).toMatchObject({ problem: { reason: "closed" } });
  });
});
