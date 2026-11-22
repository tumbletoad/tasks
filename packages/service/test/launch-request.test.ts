// What a person types before Open (`launch.open`'s text) never travels on a command line, in a
// link, in a log line or in a file other than the launch's own request: per route and catalogue
// entry that takes it, through the service, a real `ttasks shim`, and testkit's fake Claude Code and
// Codex, which read the request as their brief says when the tools are missing (`ttasks show
// --launch`). The link apps' opener is a recording spawner, and an agent's MCP connection stands
// for the app. The words arrive exactly, a 20,000-character request with line breaks, quotes and
// other scripts; the file goes with its launch and after a restart. No real agent, app or agent
// home is used. Fixture data and temporary folders only.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@ttasks/brand";
import type { JsonObject, RpcSession } from "@ttasks/bridge/protocol";
import {
  briefReference,
  powershellPath,
  REQUEST_FILE,
  REQUEST_LINE,
  type SpawnRequest,
  type SpawnedProcess,
} from "@ttasks/launch";
import { FAKE_CLI_AGENT, type CliAgentReport } from "@ttasks/testkit";
import { bridgePrincipal, clientOf, renderResult } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { instanceToml, tempRoot, waitFor } from "./harness.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { classSession, grantHome } from "./ops-helpers.ts";
import { CLI_BIN, LONG_MS, ShimLab } from "./shim-harness.ts";

const WINDOWS = process.platform === "win32";
const DAY_MS = 24 * 60 * 60_000;

/**
 * A request of `length` characters that starts with `marker`, an ASCII mark found in no other
 * text of the test, then line breaks, quotes, what a shell would read, other scripts and an emoji.
 */
function requestOf(marker: string, length = 20_000): string {
  const head = [
    `${marker}: look at "this" first, it's 'quoted'.`,
    'Then run it with %PATH% & ^ \\" and $HOME `x` $(y);',
    `Café, 日本語, ${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)}`,
    "",
    "\tindented with a tab",
  ].join("\n");
  return `${head}\n${"z".repeat(length - head.length - 1)}`;
}

const newMarker = (): string => `M4RK${randomBytes(8).toString("hex")}`;
const hex8 = (text: string): string => Buffer.from(text, "utf8").toString("hex");

/** Rounds of the service until one ran wholly after this call: a round under way may predate it. */
async function settle(r: Rig): Promise<void> {
  await r.lab.running.launches.tick();
  await r.lab.running.launches.tick();
}

const labs: ShimLab[] = [];
const sessions: RpcSession[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const lab of labs.splice(0)) await lab.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
}, 120_000);

const opened: SpawnRequest[] = [];
const recordingSpawner = (request: SpawnRequest): Promise<SpawnedProcess> => {
  opened.push(request);
  return Promise.resolve({
    pid: 1,
    exited: Promise.resolve({ code: 0, signal: null }),
    stop: () => undefined,
  });
};

interface Rig {
  readonly lab: ShimLab;
  readonly user: RpcSession;
  readonly report: (name: string) => string;
  /** Ends the fake agents: they run until this file exists. */
  readonly release: string;
}

async function rig(label: string): Promise<Rig> {
  const bin = tempRoot(`${label}-bin`);
  cleanups.push(bin.cleanup);
  if (!WINDOWS) {
    writeFileSync(join(bin.root, "gio"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin.root, "gio"), 0o755);
  }
  let release = "";
  const reportOf = (root: string, name: string) => join(root, `report-${name}.json`);
  const lab = await ShimLab.create(label, {
    toml: (root) => {
      release = join(root, "release");
      const codexHome = join(root, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(
        join(codexHome, "config.toml"),
        `[mcp_servers.${MCP_SERVER_KEY}]\ncommand = "tasks"\nargs = ["mcp"]\n`,
      );
      const fake = (name: string) => ({
        exec: process.execPath,
        args_prefix: [FAKE_CLI_AGENT],
        env: {
          FAKE_CLI_REPORT: reportOf(root, name),
          FAKE_CLI_RELEASE: release,
          FAKE_CLI_MAX_MS: "240000",
          // The product's command and the install's home, as the brief's fallback reaches them.
          FAKE_CLI_TASKS: JSON.stringify({
            argv: [process.execPath, CLI_BIN],
            home: join(root, "h"),
          }),
        },
      });
      return [
        instanceToml({
          id: "claude",
          target: "claude-cli",
          label: "Claude Code · test",
          open_permission: "full-access",
          ...fake("claude"),
        }),
        instanceToml({
          id: "codex",
          target: "codex-cli",
          label: "Codex · test",
          config_home: codexHome,
          open_permission: "full-access",
          ...fake("codex"),
        }),
        instanceToml({
          id: "codex-assisted",
          target: "codex-cli",
          label: "Codex assisted · test",
          config_home: codexHome,
          prompt: "prefill",
          ...fake("codex-assisted"),
        }),
        instanceToml({
          id: "claude-link",
          target: "claude-cli",
          label: "Claude link · test",
          prompt: "prefill",
        }),
        instanceToml({ id: "desktop", target: "claude-desktop", label: "Claude Desktop · test" }),
        instanceToml({ id: "codex-app", target: "codex-app", label: "Codex app · test" }),
      ].join("");
    },
    launch: { terminals: { spawn: recordingSpawner } },
    ...(WINDOWS
      ? {}
      : { serviceEnv: { DISPLAY: ":0", PATH: `${bin.root}:${process.env["PATH"] ?? ""}` } }),
  });
  labs.push(lab);
  const user = await classSession(lab.home, lab.running.endpoint.path, "cli-interactive");
  sessions.push(user);
  await grantHome(lab.home, lab.running.endpoint.path, {
    instance: "app-agent",
    space: lab.spaceId,
  });
  return { lab, user, report: (name) => reportOf(lab.root, name), release };
}

let requests = 0;
const rid = (): string => `request-test-${String((requests += 1)).padStart(6, "0")}`;

interface Opened {
  readonly launch: { id: string; reference: string; state: string; route: string };
  readonly copy?: string;
  readonly text: string;
}

async function addTask(r: Rig, folder: string): Promise<{ ref: string }> {
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  const call = (op: string, input: Record<string, unknown>) =>
    r.user.call(
      "op/call",
      { space: r.lab.spaceId, op, input: { ...input, request_id: rid() } },
      { timeoutMs: 60_000 },
    );
  const added = (await call("task.add", { tasks: [{ title: "Fixture task for a request" }] })) as {
    tasks: { ref: string }[];
  };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  await call("folder.manage", { action: "set", task: task.ref, folder: join(r.lab.work, folder) });
  return task;
}

const open = async (r: Rig, input: Record<string, unknown>): Promise<Opened> =>
  (await r.user.call(
    "op/call",
    { space: r.lab.spaceId, op: "launch.open", input: { ...input, request_id: rid() } },
    { timeoutMs: 60_000 },
  )) as Opened;

/** An agent's MCP connection, as an app's bridge makes it, and its get_task by the reference. */
async function mcpAgent(r: Rig, cwd: string) {
  const context: JsonObject = bridgeContext({ space: r.lab.spaceId, instance: "app-agent", cwd });
  const connection = { context };
  await r.lab.running.bindings.bridge(connection);
  const slot = r.lab.running.bindings.attach(connection);
  if (slot === undefined) throw new Error("no slot");
  const caller: Caller = {
    class: "bridge",
    env: {},
    principal: bridgePrincipal(context, r.lab.running.ops.machine.id),
    client: clientOf(context),
    binding: slot,
  };
  const getTask = async (launch: string) =>
    (await opCall(r.lab.running.ops, caller, { op: "task.get", input: { launch } })) as {
      bound: boolean;
      request?: string;
    };
  return {
    getTask,
    close: () => {
      r.lab.running.bindings.closed(slot);
    },
  };
}

/**
 * The command a brief says to run without the tools, with `--json`, as an agent's shell in an app
 * that TTasks did not start runs it: an agent marker and no TTASKS_SPACE. A process of its own,
 * waited for without blocking this one, where the service runs.
 */
async function cliShow(r: Rig, brief: string): Promise<{ request?: string }> {
  const command = /run `\S+ ([^`]+)`\.$/mu.exec(brief)?.[1];
  if (command === undefined) throw new Error("The brief names no command");
  const outside = { ...process.env };
  delete outside["TTASKS_SPACE"];
  const child = spawn(process.execPath, [CLI_BIN, ...command.split(" "), "--json"], {
    env: { ...outside, TTASKS_HOME: r.lab.home, CLAUDECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  try {
    return JSON.parse(out) as { request?: string };
  } catch {
    throw new Error(`show --launch exited ${String(code)} without a result`);
  }
}
/** The fake CLI's report once it is there. */
async function reportAt(path: string): Promise<CliAgentReport> {
  await waitFor(
    () => {
      try {
        return statSync(path).size > 0 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    LONG_MS,
    "the fake CLI's report",
  );
  return JSON.parse(readFileSync(path, "utf8")) as CliAgentReport;
}

/** Every file under `roots`, depth first. */
function filesUnder(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (folder: string) => {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(folder, name);
      let isDir: boolean;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(path);
      else out.push(path);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** The lab's folders: its home, spaces, work folders and the per-user runtime folder (Linux). */
const labRoots = (r: Rig): string[] => [r.lab.root, r.lab.runtime.base];

/** The files that hold `marker`, by their bytes. */
function filesWith(r: Rig, marker: string): string[] {
  const needle = Buffer.from(marker, "utf8");
  return filesUnder(labRoots(r)).filter((path) => {
    try {
      return readFileSync(path).includes(needle);
    } catch {
      return false;
    }
  });
}

/** The request files under the lab, by the launch folder that holds them. */
const requestFiles = (r: Rig): string[] =>
  filesUnder(labRoots(r)).filter((path) => basename(path) === REQUEST_FILE);

/**
 * The command lines of every process this account can read now: Linux's /proc, Windows' process
 * table through CIM. Undefined where the system offers no such list to this test.
 */
async function commandLines(): Promise<string[] | undefined> {
  if (process.platform === "linux") {
    const lines: string[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        lines.push(
          readFileSync(join("/proc", entry, "cmdline"), "utf8")
            .split("\0")
            .join(" "),
        );
      } catch {
        // Gone, or not this account's.
      }
    }
    return lines;
  }
  if (WINDOWS) {
    // Asked without blocking this process, where the service runs.
    const child = spawn(
      powershellPath(process.env),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.CommandLine }",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error("the process list could not be read");
    return out.split(/\r?\n/u);
  }
  return undefined;
}

/**
 * The marker is in no process's command line, no URL the launch opened, no log line, and no file
 * but the request of `launch` in its own folder.
 */
async function expectOnlyHeld(r: Rig, marker: string, launch: string): Promise<void> {
  const lines = await commandLines();
  if (lines !== undefined) {
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.filter((line) => line.includes(marker))).toEqual([]);
  }
  for (const request of opened) {
    for (const arg of request.argv) expect(decodeURIComponent(arg)).not.toContain(marker);
  }
  const log = join(r.lab.home, "state", "logs", "service.log");
  expect(readFileSync(log, "utf8")).not.toContain(marker);
  const held = filesWith(r, marker);
  expect(held.map((path) => [basename(dirname(path)), basename(path)])).toEqual([
    [launch, REQUEST_FILE],
  ]);
}

describe("[A4.5.routes.request] what a person types before Open reaches the agent through TTasks, never a command line, a link, a log or another file", () => {
  for (const instance of ["claude", "codex"] as const) {
    test(
      `${instance}'s terminal route: the brief points at the request, the fake agent reads it exactly with show --launch, and the file goes with the launch`,
      { timeout: 600_000 },
      async () => {
        opened.length = 0;
        const r = await rig(`request-${instance}`);
        const task = await addTask(r, `folder-${instance}`);
        const marker = newMarker();
        const words = requestOf(marker);
        const result = await open(r, { task: task.ref, instance, text: words });
        expect(result.text).toBe("held");
        const report = await reportAt(r.report(instance));
        // The brief after `--` is the pointer, whose last line says the request comes with it.
        expect(report.argv.at(-1)?.split("\n").at(-1)).toBe(REQUEST_LINE);
        expect(report.read).toEqual({ code: 0, request: hex8(words) });
        expect(r.lab.running.launches.requestState(result.launch.id)).toBe("read");
        await expectOnlyHeld(r, marker, result.launch.id);

        // The agent ends: its launch's folder goes, the request with it.
        writeFileSync(r.release, "");
        await waitFor(
          () => (requestFiles(r).length === 0 ? true : undefined),
          LONG_MS,
          "the request's removal",
        );
        expect(filesWith(r, marker)).toEqual([]);
        // The page still learns that it was read.
        expect(r.lab.running.launches.requestState(result.launch.id)).toBe("read");
      },
    );
  }

  test(
    "a second Open of the app while its launch opens or its agent runs is that launch, and holds none of its own words; Open another starts a second session",
    { timeout: 600_000 },
    async () => {
      const r = await rig("request-join");
      const task = await addTask(r, "folder-join");
      const marker = newMarker();
      const words = requestOf(marker);
      const first = await open(r, { task: task.ref, instance: "claude", text: words });
      expect(first.text).toBe("held");
      const other = newMarker();
      // At once: the launch is still opening, or its agent already runs. Either way it is joined.
      const second = await open(r, { task: task.ref, instance: "claude", text: other });
      expect(second.launch.id).toBe(first.launch.id);
      expect(second.text).toBe("none");
      const report = await reportAt(r.report("claude"));
      expect(report.read).toEqual({ code: 0, request: hex8(words) });
      const { launches } = r.lab.running;
      await r.lab.waitIntent(first.launch.id, (i) => i.state === "confirmed", "Confirmed");
      expect(launches.running(first.launch.id)).toBe(true);
      // A page that still showed Ready, or a command line's Open: the running session.
      const third = await open(r, { task: task.ref, instance: "claude", text: other });
      expect(third.launch.id).toBe(first.launch.id);
      expect(third.text).toBe("none");
      await expectOnlyHeld(r, marker, first.launch.id);
      expect(filesWith(r, other)).toEqual([]);
      // The person's explicit choice, offered once the session is confirmed: a second agent.
      const another = await open(r, { task: task.ref, instance: "claude", another: true });
      expect(another.launch.id).not.toBe(first.launch.id);
      await waitFor(
        () => (launches.running(another.launch.id) ? true : undefined),
        LONG_MS,
        "the second agent running",
      );
      writeFileSync(r.release, "");
      await waitFor(
        () =>
          launches.running(first.launch.id) || launches.running(another.launch.id)
            ? undefined
            : true,
        LONG_MS,
        "both agents ending",
      );
    },
  );

  test(
    "Codex's assisted open: no prompt on the command line, the brief to paste points at the request, which the agent reads exactly",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-assisted");
      const task = await addTask(r, "folder-assisted");
      const marker = newMarker();
      const words = requestOf(marker);
      const result = await open(r, { task: task.ref, instance: "codex-assisted", text: words });
      expect(result.text).toBe("held");
      // The brief goes on the clipboard in the person's click: a pointer, without the words.
      expect(result.copy?.split("\n").at(-1)).toBe(REQUEST_LINE);
      expect(result.copy).not.toContain(marker);
      const report = await reportAt(r.report("codex-assisted"));
      expect(report.argv).not.toContain("--");
      // The person pastes the brief; the agent reads the task with its reference.
      const reference = briefReference(result.copy ?? "") ?? "";
      expect(reference).toBe(result.launch.reference);
      await expectOnlyHeld(r, marker, result.launch.id);
      expect((await cliShow(r, result.copy ?? "")).request).toBe(words);
      expect(r.lab.running.launches.requestState(result.launch.id)).toBe("read");
      writeFileSync(r.release, "");
      await waitFor(
        () => (requestFiles(r).length === 0 ? true : undefined),
        LONG_MS,
        "the request's removal",
      );
    },
  );

  for (const [instance, key] of [
    ["claude-link", "q"],
    ["desktop", "q"],
    ["codex-app", "prompt"],
  ] as const) {
    test(
      `${instance}: the link carries the pointer only, the app's agent gets the request whole with get_task, and it goes once the launch reference no longer binds`,
      { timeout: 600_000 },
      async () => {
        opened.length = 0;
        const r = await rig(`request-${instance}`);
        const task = await addTask(r, `folder-${instance}`);
        const folder = join(r.lab.work, `folder-${instance}`);
        const marker = newMarker();
        const words = requestOf(marker);
        const result = await open(r, { task: task.ref, instance, text: words });
        expect(result.text).toBe("held");
        await r.lab.waitIntent(result.launch.id, (i) => i.state === "dispatched", "Dispatched");
        expect(opened).toHaveLength(1);
        const url = opened[0]?.argv.at(-1) ?? "";
        const prefill = new URL(url).searchParams.get(key) ?? "";
        expect(prefill.split("\n").at(-1)).toBe(REQUEST_LINE);
        if (result.copy !== undefined) expect(result.copy).not.toContain(marker);
        expect(r.lab.running.launches.requestState(result.launch.id)).toBe("waiting");
        await expectOnlyHeld(r, marker, result.launch.id);

        const agent = await mcpAgent(r, folder);
        const got = await agent.getTask(result.launch.reference);
        expect(got.bound).toBe(true);
        expect(got.request).toBe(words);
        // The tool's text holds every line whole, as typed.
        const text = renderResult("task.get", got);
        for (const line of words.split("\n")) expect(text).toContain(`  ${line}`);
        expect(r.lab.running.launches.requestState(result.launch.id)).toBe("read");
        agent.close();
        // An agent of the app without the tools runs the command the link's brief names.
        expect((await cliShow(r, prefill)).request).toBe(words);

        // Kept while the reference binds, also across a restart; gone at the first round after.
        await r.lab.stopService();
        await r.lab.start();
        expect(requestFiles(r)).toHaveLength(1);
        r.lab.skew += DAY_MS + 1_000;
        await settle(r);
        expect(requestFiles(r)).toEqual([]);
        expect(filesWith(r, marker)).toEqual([]);
      },
    );
  }

  test(
    "Copy puts the words on the clipboard in the person's click, and holds nothing",
    { timeout: 300_000 },
    async () => {
      const r = await rig("request-copy");
      const task = await addTask(r, "folder-copy");
      const marker = newMarker();
      const words = requestOf(marker, 2_000);
      const result = await open(r, { task: task.ref, text: words });
      expect(result.text).toBe("inline");
      // Copy's brief keeps no hidden character, an emoji's joiner included: the rest as typed.
      expect(result.copy?.split("\n").slice(6, 8)).toEqual(words.split("\n").slice(0, 2));
      expect(requestFiles(r)).toEqual([]);
      expect(filesWith(r, marker)).toEqual([]);
    },
  );
});

describe("[A4.5.routes.request-restart] a request a crashed service left is removed at its next start once its launch no longer needs it", () => {
  test(
    "a terminal launch whose agent ended while the service was down, and a link launch past its day",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-restart");
      const task = await addTask(r, "folder-restart");
      const other = await addTask(r, "folder-restart-link");
      const terminal = await open(r, {
        task: task.ref,
        instance: "claude",
        text: requestOf(newMarker(), 500),
      });
      await reportAt(r.report("claude"));
      const link = await open(r, {
        task: other.ref,
        instance: "desktop",
        text: requestOf(newMarker(), 500),
      });
      await r.lab.waitIntent(link.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const held = () => requestFiles(r).map((path) => basename(dirname(path)));
      expect(held().sort()).toEqual([terminal.launch.id, link.launch.id].sort());

      // The service goes away without a word to anyone; the agent ends meanwhile.
      await r.lab.stopService();
      writeFileSync(r.release, "");
      expect(held().sort()).toEqual([terminal.launch.id, link.launch.id].sort());

      // The next start: the ended launch's request goes with its folder; the link's still binds.
      await r.lab.start();
      await waitFor(
        () => (held().length === 1 ? true : undefined),
        LONG_MS,
        "the ended launch's request removed",
      );
      expect(held()).toEqual([link.launch.id]);

      // A start a day later: the link's reference no longer binds, and its request goes too.
      await r.lab.stopService();
      r.lab.skew += DAY_MS + 1_000;
      await r.lab.start();
      await waitFor(() => (held().length === 0 ? true : undefined), LONG_MS, "the link's request");
    },
  );
});
