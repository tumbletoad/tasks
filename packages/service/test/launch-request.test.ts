// What a person types before Open (`launch.open`'s text) becomes a note of theirs on the task at
// the click, which the launch names as its request: per route and catalogue entry that takes it,
// through the service, a real `tasks shim`, and testkit's fake Claude Code and Codex, which read the
// request as their brief says when the tools are missing (`tasks show --launch`). The words never
// travel on a command line, in a link, in a log line or in a file outside the space. The link apps'
// opener is a recording spawner, and an agent's MCP connection stands for the app. No real agent,
// app or agent home is used. Fixture data and temporary folders only.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MCP_SERVER_KEY } from "@tasks/brand";
import { REQUEST_CHARS } from "@tasks/contracts";
import type { JsonObject, RpcSession } from "@tasks/bridge/protocol";
import {
  briefReference,
  powershellPath,
  REQUEST_LINE,
  type SpawnRequest,
  type SpawnedProcess,
} from "@ttasks/launch";
import { FAKE_CLI_AGENT, type CliAgentReport } from "@ttasks/testkit";
import { bridgePrincipal, clientOf, renderResult } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { instanceToml, tempRoot, waitFor } from "./harness.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome } from "./ops-helpers.ts";
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
    `Café, 日本語, ${JOINED}`,
    "",
    "\tindented with a tab",
  ].join("\n");
  return `${head}\n${"z".repeat(length - head.length - 1)}`;
}

/** An emoji that holds a zero-width joiner, a character that carries meaning in written languages too. */
const JOINED = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
const newMarker = (): string => `M4RK${randomBytes(8).toString("hex")}`;
const hex8 = (text: string): string => Buffer.from(text, "utf8").toString("hex");
/** What a result holds of a request: its first REQUEST_CHARS code points. */
const shown = (words: string): string => Array.from(words).slice(0, REQUEST_CHARS).join("");
const cutOf = (words: string): number | undefined => {
  const left = Array.from(words).length - REQUEST_CHARS;
  return left > 0 ? left : undefined;
};

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
  readonly note?: string;
}

interface Request {
  readonly note: string;
  readonly text: string;
  readonly cut?: number;
}

interface Note {
  readonly ref: string;
  readonly author: string;
  readonly for_agents: boolean;
  readonly text: string;
  readonly request_for?: { launch: string; instance: string }[];
  readonly slice?: { from: number; to: number; of: number };
}

const call = async (r: Rig, op: string, input: Record<string, unknown>): Promise<unknown> =>
  r.user.call(
    "op/call",
    { space: r.lab.spaceId, op, input: { ...input, request_id: rid() } },
    { timeoutMs: 60_000 },
  );

async function addTask(r: Rig, folder: string): Promise<{ ref: string }> {
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  const added = (await call(r, "task.add", {
    tasks: [{ title: "Fixture task for a request" }],
  })) as { tasks: { ref: string }[] };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  await call(r, "folder.manage", {
    action: "set",
    task: task.ref,
    folder: join(r.lab.work, folder),
  });
  return task;
}

const open = async (r: Rig, input: Record<string, unknown>, requestId = rid()): Promise<Opened> =>
  (await r.user.call(
    "op/call",
    { space: r.lab.spaceId, op: "launch.open", input: { ...input, request_id: requestId } },
    { timeoutMs: 60_000 },
  )) as Opened;

/** Every note of the task, whole: a sections read, page after page, its slices joined. */
async function notesOf(r: Rig, task: string): Promise<Note[]> {
  const out: Note[] = [];
  let before: string | undefined;
  for (;;) {
    const page = (await r.user.call(
      "op/call",
      {
        space: r.lab.spaceId,
        op: "task.get",
        input: {
          task,
          sections: ["instructions", "notes"],
          ...(before === undefined ? {} : { before }),
        },
      },
      { timeoutMs: 60_000 },
    )) as { sections: { instructions?: Note[]; notes?: Note[] }; before?: string };
    for (const note of [...(page.sections.instructions ?? []), ...(page.sections.notes ?? [])]) {
      const last = out.find((n) => n.ref === note.ref);
      if (last === undefined) out.push(note);
      else out[out.indexOf(last)] = { ...last, text: last.text + note.text };
    }
    before = page.before;
    if (before === undefined) return out;
  }
}

/** An agent's MCP connection, as an app's bridge makes it, and its get_task. */
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
  const getTask = async (input: Record<string, unknown>) =>
    (await opCall(r.lab.running.ops, caller, { op: "task.get", input })) as {
      bound: boolean;
      request?: Request;
      task: { notes: Note[] };
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
async function cliShow(r: Rig, brief: string): Promise<{ request?: Request }> {
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
    return JSON.parse(out) as { request?: Request };
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

/**
 * The files outside the space that hold `marker`, by their bytes: under the lab's home, its work
 * folders and the per-user runtime folder (Linux), the space's own folder left out.
 */
function filesOutsideWith(r: Rig, marker: string): string[] {
  const needle = Buffer.from(marker, "utf8");
  return filesUnder([r.lab.root, r.lab.runtime.base]).filter((path) => {
    if (!relative(r.lab.spaceFolder, path).startsWith("..")) return false;
    try {
      return readFileSync(path).includes(needle);
    } catch {
      return false;
    }
  });
}

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
 * outside the space.
 */
async function expectOnlyInSpace(r: Rig, marker: string): Promise<void> {
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
  expect(filesOutsideWith(r, marker)).toEqual([]);
}

/** The task holds the words whole as the person's note, which names the launch it asked. */
async function expectOnTask(
  r: Rig,
  task: string,
  result: Opened,
  words: string,
  instance: string,
): Promise<void> {
  expect(result.note).toMatch(/^n\d+$/u);
  const note = (await notesOf(r, task)).find((n) => n.ref === result.note);
  expect(note).toMatchObject({
    author: "user",
    for_agents: false,
    request_for: [{ launch: result.launch.reference, instance }],
  });
  expect(note?.text).toBe(words);
}

describe("[A4.5.routes.request] what a person types before Open is on the task at the click, reaches the agent through Tasks, and never a command line, a link, a log or a file outside the space", () => {
  for (const instance of ["claude", "codex"] as const) {
    test(
      `${instance}'s terminal route: the brief points at the request, the fake agent reads it with show --launch, the same each time, and the rest is in the note`,
      { timeout: 600_000 },
      async () => {
        opened.length = 0;
        const r = await rig(`request-${instance}`);
        const task = await addTask(r, `folder-${instance}`);
        const marker = newMarker();
        const words = requestOf(marker);
        const result = await open(r, { task: task.ref, instance, text: words });
        expect(result.text).toBe("request");
        await expectOnTask(r, task.ref, result, words, instance);
        const report = await reportAt(r.report(instance));
        // The brief after `--` is the pointer, whose last line says the request comes with it.
        const brief = report.argv.at(-1) ?? "";
        expect(brief.split("\n").at(-1)).toBe(REQUEST_LINE);
        expect(report.read).toEqual({
          code: 0,
          request: hex8(shown(words)),
          note: result.note,
          cut: cutOf(words),
        });
        // Asked again, the same.
        expect((await cliShow(r, brief)).request).toEqual({
          note: result.note,
          text: shown(words),
          cut: cutOf(words),
        });
        await expectOnlyInSpace(r, marker);
        writeFileSync(r.release, "");
      },
    );
  }

  test(
    "a second Open of the app while its launch opens or its agent runs is that launch, and its words are a note of the person's; Open another starts a second session",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-join");
      const task = await addTask(r, "folder-join");
      const marker = newMarker();
      const words = requestOf(marker);
      const first = await open(r, { task: task.ref, instance: "claude", text: words });
      expect(first.text).toBe("request");
      // At once: the launch is still opening, or its agent already runs. Either way it is joined,
      // and a retry of that click after a lost answer says the same of the same note.
      const other = `${newMarker()} other words ${JOINED}`;
      const secondId = rid();
      const second = await open(r, { task: task.ref, instance: "claude", text: other }, secondId);
      expect(second.launch.id).toBe(first.launch.id);
      expect(second.text).toBe("note");
      expect(second.note).not.toBe(first.note);
      const retried = await open(r, { task: task.ref, instance: "claude", text: other }, secondId);
      expect(retried).toMatchObject({
        launch: { id: first.launch.id },
        text: "note",
        note: second.note,
      });
      const report = await reportAt(r.report("claude"));
      expect(report.read).toEqual({
        code: 0,
        request: hex8(shown(words)),
        note: first.note,
        cut: cutOf(words),
      });
      const { launches } = r.lab.running;
      await r.lab.waitIntent(first.launch.id, (i) => i.state === "confirmed", "Confirmed");
      expect(launches.running(first.launch.id)).toBe(true);
      // A page that still showed Ready, or a command line's Open: the running session.
      const late = `${newMarker()} late words ${JOINED}`;
      const third = await open(r, { task: task.ref, instance: "claude", text: late });
      expect(third.launch.id).toBe(first.launch.id);
      expect(third.text).toBe("note");
      const notes = await notesOf(r, task.ref);
      for (const [result, text] of [
        [second, other],
        [third, late],
      ] as const) {
        const note = notes.find((n) => n.ref === result.note);
        expect(note).toMatchObject({ author: "user", for_agents: false, text });
        expect(note?.request_for).toBeUndefined();
      }
      await expectOnlyInSpace(r, marker);
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
    "Codex's assisted open: no prompt on the command line, the brief to paste points at the request, which the agent reads",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-assisted");
      const task = await addTask(r, "folder-assisted");
      const marker = newMarker();
      const words = requestOf(marker, 3_000);
      const result = await open(r, { task: task.ref, instance: "codex-assisted", text: words });
      expect(result.text).toBe("request");
      // The brief goes on the clipboard in the person's click: a pointer, without the words.
      expect(result.copy?.split("\n").at(-1)).toBe(REQUEST_LINE);
      expect(result.copy).not.toContain(marker);
      const report = await reportAt(r.report("codex-assisted"));
      expect(report.argv).not.toContain("--");
      // The person pastes the brief; the agent reads the task with its reference.
      expect(briefReference(result.copy ?? "")).toBe(result.launch.reference);
      await expectOnlyInSpace(r, marker);
      expect((await cliShow(r, result.copy ?? "")).request).toEqual({
        note: result.note,
        text: words,
      });
      writeFileSync(r.release, "");
    },
  );

  for (const [instance, key] of [
    ["claude-link", "q"],
    ["desktop", "q"],
    ["codex-app", "prompt"],
  ] as const) {
    test(
      `${instance}: the link carries the pointer only, and the app's agent gets the request with get_task, as often as it asks`,
      { timeout: 600_000 },
      async () => {
        opened.length = 0;
        const r = await rig(`request-${instance}`);
        const task = await addTask(r, `folder-${instance}`);
        const folder = join(r.lab.work, `folder-${instance}`);
        const marker = newMarker();
        const words = requestOf(marker, 6_000);
        const result = await open(r, { task: task.ref, instance, text: words });
        expect(result.text).toBe("request");
        await r.lab.waitIntent(result.launch.id, (i) => i.state === "dispatched", "Dispatched");
        expect(opened).toHaveLength(1);
        const url = opened[0]?.argv.at(-1) ?? "";
        const prefill = new URL(url).searchParams.get(key) ?? "";
        expect(prefill.split("\n").at(-1)).toBe(REQUEST_LINE);
        if (result.copy !== undefined) expect(result.copy).not.toContain(marker);
        await expectOnlyInSpace(r, marker);

        const agent = await mcpAgent(r, folder);
        const got = await agent.getTask({ launch: result.launch.reference });
        expect(got.bound).toBe(true);
        expect(got.request).toEqual({ note: result.note, text: words });
        // The tool's text holds every line whole, as typed, as the person's request.
        const text = renderResult("task.get", got);
        expect(text).toContain("Request from the user for this launch:");
        for (const line of words.split("\n")) expect(text).toContain(`  ${line}`);
        // The same call again, and an agent of the app without the tools: the same words.
        expect((await agent.getTask({ launch: result.launch.reference })).request).toEqual(
          got.request,
        );
        agent.close();
        expect((await cliShow(r, prefill)).request).toEqual(got.request);
      },
    );
  }

  test(
    "Copy puts the words on the clipboard in the person's click, and saves nothing",
    { timeout: 300_000 },
    async () => {
      const r = await rig("request-copy");
      const task = await addTask(r, "folder-copy");
      const marker = newMarker();
      const words = requestOf(marker, 2_000);
      const result = await open(r, { task: task.ref, text: words });
      expect(result.text).toBe("inline");
      expect(result.note).toBeUndefined();
      // Copy's brief keeps no hidden character, an emoji's joiner included: the rest as typed.
      expect(result.copy?.split("\n").slice(6, 8)).toEqual(words.split("\n").slice(0, 2));
      expect(await notesOf(r, task.ref)).toEqual([]);
      expect(filesOutsideWith(r, marker)).toEqual([]);
    },
  );
});

describe("[A4.5.routes.request-task] the request is task data from the click: what used to lose it cannot", () => {
  test(
    "a service stopped right after the click: the words are on the task when it starts again, and the launch still names them",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-stop");
      const task = await addTask(r, "folder-stop");
      const words = requestOf(newMarker(), 500);
      const result = await open(r, { task: task.ref, instance: "desktop", text: words });
      await r.lab.stopService();
      await r.lab.start();
      const user = await classSession(r.lab.home, r.lab.running.endpoint.path, "cli-interactive");
      sessions.push(user);
      await expectOnTask({ ...r, user }, task.ref, result, words, "desktop");
    },
  );

  test(
    "an answer lost, the page opened again under a new sign-in, the same click again: one launch and one note",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-signin");
      const task = await addTask(r, "folder-signin");
      const words = requestOf(newMarker(), 500);
      const requestId = rid();
      const asPage = async (grant: string): Promise<Opened> =>
        (await opCall(
          r.lab.running.ops,
          { class: "ui", env: {}, grant },
          {
            space: r.lab.spaceId,
            op: "launch.open",
            input: { task: task.ref, instance: "desktop", text: words, request_id: requestId },
          },
        )) as Opened;
      const first = await asPage(`gr_${randomBytes(16).toString("hex")}`);
      const again = await asPage(`gr_${randomBytes(16).toString("hex")}`);
      expect(again).toMatchObject({ launch: { id: first.launch.id }, text: "request" });
      expect(again.note).toBe(first.note);
      expect((await notesOf(r, task.ref)).map((n) => n.ref)).toEqual([first.note]);
    },
  );

  test(
    "a get_task the agent never got, a launch past its day: nothing is marked, the request is served again, and nothing expires",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-day");
      const task = await addTask(r, "folder-day");
      const folder = join(r.lab.work, "folder-day");
      const marker = newMarker();
      const words = requestOf(marker, 500);
      const result = await open(r, { task: task.ref, instance: "desktop", text: words });
      await r.lab.waitIntent(result.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const agent = await mcpAgent(r, folder);
      // An answer the agent never receives (a call it cancelled) is an answer like the next.
      await agent.getTask({ launch: result.launch.reference });
      expect((await agent.getTask({ launch: result.launch.reference })).request).toEqual({
        note: result.note,
        text: words,
      });
      agent.close();

      // A day and more later, after rounds of the service: the request is on the task.
      r.lab.skew += DAY_MS + 1_000;
      await r.lab.running.launches.tick();
      await r.lab.running.launches.tick();
      await expectOnTask(r, task.ref, result, words, "desktop");
      expect(filesOutsideWith(r, marker)).toEqual([]);
    },
  );

  test(
    "a second session with the launch's pointer is refused it; a session that loads the task sees the request as history, with its launch",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-sessions");
      const task = await addTask(r, "folder-sessions");
      const folder = join(r.lab.work, "folder-sessions");
      const result = await open(r, { task: task.ref, instance: "desktop", text: "Fix the offset" });
      await r.lab.waitIntent(result.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const own = await mcpAgent(r, folder);
      expect((await own.getTask({ launch: result.launch.reference })).request?.text).toBe(
        "Fix the offset",
      );
      const other = await mcpAgent(r, folder);
      await expect(other.getTask({ launch: result.launch.reference })).rejects.toMatchObject({
        code: "launch_used",
      });
      const loaded = await other.getTask({ task: task.ref });
      expect(loaded.request).toBeUndefined();
      expect(loaded.task.notes).toEqual([
        expect.objectContaining({
          ref: result.note,
          text: "Fix the offset",
          request_for: [{ launch: result.launch.reference, instance: "desktop" }],
        }),
      ]);
      const text = renderResult("task.get", loaded);
      expect(text).not.toContain("Request from the user for this launch");
      expect(text).toContain(`(request for launch ${result.launch.reference} [desktop])`);
      own.close();
      other.close();
    },
  );

  test(
    "one undo takes back the request and nothing else; Open again with the note writes no second one",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-undo");
      const task = await addTask(r, "folder-undo");
      const folder = join(r.lab.work, "folder-undo");
      const result = await open(r, { task: task.ref, instance: "desktop", text: "Fix the offset" });
      await r.lab.waitIntent(result.launch.id, (i) => i.state === "dispatched", "Dispatched");
      // Open again with the same note, in another app.
      const again = await open(r, {
        task: task.ref,
        instance: "codex-app",
        request: result.note,
      });
      expect(again).toMatchObject({ text: "request", note: result.note });
      expect(again.launch.id).not.toBe(result.launch.id);
      expect((await notesOf(r, task.ref)).map((n) => n.request_for?.map((l) => l.launch))).toEqual([
        [result.launch.reference, again.launch.reference],
      ]);

      await call(r, "history.undo", {});
      expect(await notesOf(r, task.ref)).toEqual([]);
      // The launches stay as they were, with no request to give.
      const state = await r.lab.running.launches.read(r.lab.spaceId, result.launch.id);
      expect(state?.state).toBe("dispatched");
      const agent = await mcpAgent(r, folder);
      expect((await agent.getTask({ launch: result.launch.reference })).request).toBeUndefined();
      agent.close();
      // The folder is still the task's: the undo took the note only.
      const digest = (await r.user.call(
        "op/call",
        { space: r.lab.spaceId, op: "task.get", input: { task: task.ref } },
        { timeoutMs: 60_000 },
      )) as { task: { folder?: { path: string } } };
      expect(digest.task.folder?.path).toBeDefined();
      // A note that is gone is no request to open again.
      expect(
        errorOf(
          await open(r, { task: task.ref, instance: "desktop", request: result.note }).catch(
            (e: unknown) => e,
          ),
        ),
      ).toMatchObject({ code: "not_found" });
    },
  );

  test(
    "a refused click writes nothing: no route here, a folder that is gone, a marker that is gone",
    { timeout: 600_000 },
    async () => {
      opened.length = 0;
      const r = await rig("request-refused");
      const task = await addTask(r, "folder-refused");
      const refusedWith = async (input: Record<string, unknown>): Promise<unknown> =>
        errorOf(
          await open(r, { task: task.ref, text: "Fix it", ...input }).catch((e: unknown) => e),
        );
      expect(await refusedWith({ instance: "not-here" })).toMatchObject({
        data: { reason: "not_set_up" },
      });
      // The folder's checkout is moved aside: a terminal and a link find no folder.
      renameSync(join(r.lab.work, "folder-refused"), join(r.lab.work, "folder-aside"));
      for (const instance of ["claude", "desktop"]) {
        expect(await refusedWith({ instance }), instance).toMatchObject({
          data: { reason: "path_missing" },
        });
      }
      // Another folder at the same path: its marker is not the task's.
      mkdirSync(join(r.lab.work, "folder-refused"));
      for (const instance of ["claude", "desktop"]) {
        expect(await refusedWith({ instance }), instance).toMatchObject({
          data: { reason: "marker_missing" },
        });
      }
      expect(await notesOf(r, task.ref)).toEqual([]);
      expect(opened).toEqual([]);
    },
  );
});
