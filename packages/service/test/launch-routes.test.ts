// Open and Copy through the service (A4 3.4.2, 3.4.3, 3.4.6, 3.15; A7 3.9 M2.10's Verify line): a
// person's `launch.open` over the socket, the hub's one launch machine per space, a real
// `tasks shim` started in the resolved folder, and testkit's fake Claude Code and Codex in place
// of the real CLIs (machine.toml instances whose `exec` is Node and whose `args_prefix` is the
// fake). The fake reports its argv exactly as it got it, so these tests compare the golden argv
// as arrays and each argument byte for byte, through the OS's real process creation: on Windows
// the runtime's quoting into one command line and the child's parsing back (CreateProcess). The
// link route's opener is a recording spawner: no real link is opened, no real agent starts, and
// no real agent home is read. Fixture data and temporary folders only.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { envVar, FOLDER_MARKER, MCP_SERVER_KEY, PRODUCT_NAME } from "@tasks/brand";
import type { RpcSession } from "@tasks/bridge/protocol";
import {
  NOTE_LINE,
  presetSession,
  renderBrief,
  REQUEST_LINE,
  type LaunchIntent,
  type SpawnRequest,
  type SpawnedProcess,
} from "@tasks/launch";
import { FAKE_CLI_AGENT, type CliAgentReport } from "@tasks/testkit";
import { briefNames, chooseRoute, codexEntryOf, LaunchUnavailable } from "../src/launch/open.ts";
import { instanceToml, readLog, stateOf, tempRoot, waitFor } from "./harness.ts";
import { errorOf, classSession } from "./ops-helpers.ts";
import { LONG_MS, ShimLab } from "./shim-harness.ts";

const WINDOWS = process.platform === "win32";

/** A folder name with what a shell or a command line would read: quotes, %, ^, &, ;, (, $. */
const HOSTILE_FOLDER = WINDOWS
  ? "R&D; tests (v2) %PATH% ^caret $HOME 'q' Café"
  : "R&D; tests (v2) %PATH% ^caret $HOME 'q' \"dq\" `tick` Café";
/** A title with fences, instructions, quotes and characters a shell would read. */
const HOSTILE_TITLE =
  'Fix "quotes" & `ticks` ; rm -rf ~ %PATH% ^| $(sub) -- --help \u{201C}smart\u{201D} Café 😀';
/** The person's own words: line breaks, quotes, a backslash before a quote and at the end. */
const COMPOSER = 'Look at "this" first.\nThen run it with %PATH% & ^ \\" and end with \\';

const labs: ShimLab[] = [];
const sessions: RpcSession[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const lab of labs.splice(0)) await lab.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
}, 120_000);

/** What the recording spawner saw: the link route's opener, which never really runs. */
const opened: SpawnRequest[] = [];

/**
 * A spawner that starts nothing: the opener "ran" and exited with `code`, or never answers
 * (`hang`) and is stopped at the opener's deadline.
 */
function recordingSpawner(code: number | "hang") {
  return (request: SpawnRequest): Promise<SpawnedProcess> => {
    opened.push(request);
    let stop = (): void => undefined;
    const exited =
      code === "hang"
        ? new Promise<{ code: number | null; signal: string | null }>((resolve) => {
            stop = () => {
              resolve({ code: null, signal: "SIGKILL" });
            };
          })
        : Promise.resolve({ code, signal: null });
    return Promise.resolve({
      pid: 1,
      exited,
      stop: () => {
        stop();
      },
    });
  };
}

interface Rig {
  readonly lab: ShimLab;
  readonly user: RpcSession;
  readonly codexHome: string;
  readonly report: (name: string) => string;
}

/**
 * A lab whose machine.toml has the fake Claude Code and Codex as instances: Claude Code with full
 * access (`claude`), Claude Code with the prefill route (`claude-link`), Codex with the brief sent
 * (`codex`) and assisted (`codex-assisted`), with a Codex home of the lab's own whose Tasks entry
 * lacks `env_vars`.
 */
async function rig(label: string, opener: number | "hang" = 0): Promise<Rig> {
  const fake = (name: string, extra: Record<string, string> = {}) => ({
    exec: process.execPath,
    args_prefix: [FAKE_CLI_AGENT],
    env: { FAKE_CLI_REPORT: "", FAKE_CLI_HOLD_MS: "4000", ...extra, FAKE_CLI_NAME: name },
  });
  let codexHome = "";
  const reportOf = (root: string, name: string) => join(root, `report-${name}.json`);
  // The link route's opener on Linux needs a desktop session and a `gio` on the PATH: a file of
  // the test's own, which the recording spawner never runs.
  const bin = tempRoot(`${label}-bin`);
  cleanups.push(bin.cleanup);
  if (!WINDOWS) {
    writeFileSync(join(bin.root, "gio"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin.root, "gio"), 0o755);
  }
  const lab = await ShimLab.create(label, {
    toml: (root) => {
      codexHome = join(root, "codex-home");
      const withReport = (name: string, extra: Record<string, string> = {}) => {
        const made = fake(name, extra);
        return { ...made, env: { ...made.env, FAKE_CLI_REPORT: reportOf(root, name) } };
      };
      return [
        instanceToml({
          id: "claude",
          target: "claude-cli",
          label: "Claude Code · test",
          open_permission: "full-access",
          ...withReport("claude"),
        }),
        instanceToml({
          id: "claude-link",
          target: "claude-cli",
          label: "Claude link · test",
          prompt: "prefill",
          ...withReport("claude-link"),
        }),
        instanceToml({
          id: "codex",
          target: "codex-cli",
          label: "Codex · test",
          config_home: codexHome,
          open_permission: "full-access",
          ...withReport("codex", { FAKE_CLI_ROLLOUT_HOME: codexHome }),
        }),
        instanceToml({
          id: "codex-assisted",
          target: "codex-cli",
          label: "Codex assisted · test",
          config_home: codexHome,
          prompt: "prefill",
          ...withReport("codex-assisted"),
        }),
        instanceToml({ id: "t3-later", target: "t3", label: "T3 · test" }),
      ].join("");
    },
    launch: { terminals: { spawn: recordingSpawner(opener) } },
    ...(WINDOWS
      ? {}
      : { serviceEnv: { DISPLAY: ":0", PATH: `${bin.root}:${process.env["PATH"] ?? ""}` } }),
  });
  labs.push(lab);
  // A Codex home whose Tasks entry exists without `env_vars` (setup skipped it).
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    `[mcp_servers.${MCP_SERVER_KEY}]\ncommand = "tasks"\nargs = ["mcp"]\n`,
  );
  const user = await classSession(lab.home, lab.running.endpoint.path, "cli-interactive");
  sessions.push(user);
  return { lab, user, codexHome, report: (name) => reportOf(lab.root, name) };
}

let requests = 0;
const rid = (): string => `routes-request-${String((requests += 1)).padStart(6, "0")}`;

/** One write through the request path as the person. */
const write = (r: Rig, op: string, input: Record<string, unknown>) =>
  r.user.call(
    "op/call",
    { space: r.lab.spaceId, op, input: { ...input, request_id: rid() } },
    { timeoutMs: 60_000 },
  );

/**
 * Adds a task as the person, with its own folder `<work>/<folder>` (made first), in `project`
 * when one is named. The folder as the space stores it comes back with it.
 */
async function addTask(
  r: Rig,
  title: string,
  folder?: string,
  project?: string,
): Promise<{ id: string; ref: string; folder?: string }> {
  const added = (await write(r, "task.add", {
    tasks: [{ title, ...(project === undefined ? {} : { area: "Client work", project }) }],
  })) as { tasks: { id: string; ref: string }[] };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  if (folder === undefined) return task;
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  const set = (await write(r, "folder.manage", {
    action: "set",
    task: task.ref,
    folder: join(r.lab.work, folder),
  })) as { folder: string };
  return { ...task, folder: set.folder };
}

/** Makes the project `name` for the folder `<work>/<folder>` (made first): its stored form. */
async function addProject(r: Rig, name: string, folder: string): Promise<string> {
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  const made = (await write(r, "folder.manage", {
    action: "add_project",
    project: name,
    area: "Client work",
    folder: join(r.lab.work, folder),
  })) as { folder: string };
  return made.folder;
}

interface Opened {
  readonly launch: {
    id: string;
    reference: string;
    state: string;
    route: string;
    instance: string;
  };
  readonly copy?: string;
  readonly text: string;
}

const open = async (
  r: Rig,
  input: Record<string, unknown>,
): Promise<{ result: Opened; requestId: string }> => {
  const requestId = typeof input["request_id"] === "string" ? input["request_id"] : rid();
  const result = (await r.user.call(
    "op/call",
    { space: r.lab.spaceId, op: "launch.open", input: { ...input, request_id: requestId } },
    { timeoutMs: 60_000 },
  )) as Opened;
  return { result, requestId };
};

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

const hex8 = (text: string): string => Buffer.from(text, "utf8").toString("hex");
const hex16 = (text: string): string =>
  Array.from({ length: text.length }, (_, i) =>
    text.charCodeAt(i).toString(16).padStart(4, "0"),
  ).join("");

/** The brief a route renders for this launch, as the test computes it. */
function briefFor(
  kind: "sent" | "prefilled" | "pointer",
  space: string,
  task: { ref: string },
  reference: string,
  options: {
    composer?: string;
    budget?: number;
    folder?: Parameters<typeof renderBrief>[0]["folder"];
  } = {},
): string {
  const brief = renderBrief({
    kind,
    task: task.ref,
    space,
    reference,
    budget: options.budget ?? 8000,
    names: briefNames(),
    ...(options.composer === undefined ? {} : { composer: options.composer }),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
  });
  if (brief.status !== "ok") throw new Error("no brief");
  return brief.text;
}

describe("[A4.5.routes.service] Open and Copy through the service: golden argv, and the brief reaches the fake agent byte-identical", () => {
  test(
    "Claude Code's terminal route: the fake agent gets the golden argv, each element byte for byte, in the resolved folder",
    { timeout: 300_000 },
    async () => {
      const r = await rig("claude-terminal");
      const task = await addTask(r, HOSTILE_TITLE, HOSTILE_FOLDER);
      const folder = realpathSync.native(join(r.lab.work, HOSTILE_FOLDER));
      const { result, requestId } = await open(r, {
        task: task.ref,
        instance: "claude",
        text: COMPOSER,
      });
      expect(result.launch).toMatchObject({ route: "terminal", instance: "claude" });
      expect(result.copy).toBeUndefined();
      expect(result.text).toBe("held");
      const launch = result.launch;
      const confirmed = await r.lab.waitIntent(
        launch.id,
        (i) => i.state === "confirmed",
        "Confirmed",
      );
      const report = await reportAt(r.report("claude"));

      const session = presetSession(r.lab.spaceId, requestId);
      const brief = briefFor("sent", r.lab.spaceId, task, launch.reference, { composer: COMPOSER });
      const golden = [
        "--session-id",
        session,
        "-n",
        task.ref,
        "--permission-mode",
        "bypassPermissions",
        "--",
        brief,
      ];
      expect(report.argv).toEqual(golden);
      expect(report.utf8).toEqual(golden.map(hex8));
      expect(report.utf16).toEqual(golden.map(hex16));
      // A pointer: the two references, no title, and the person's words held for the agent.
      expect(brief.split("\n")[0]).toBe(
        `${PRODUCT_NAME} task ${task.ref} (launch ${launch.reference}).`,
      );
      expect(brief.split("\n").slice(4)).toEqual([REQUEST_LINE]);
      for (const arg of report.argv) {
        expect(arg).not.toContain("quotes");
        expect(arg).not.toContain("Look at");
      }
      // It started in the resolved folder, by identity.
      const id = statSync(folder, { bigint: true });
      expect(report.cwdId).toBe(`${id.dev.toString()}:${id.ino.toString()}`);
      expect(report.envNames).toContain(envVar("TICKET"));
      // The record holds the preset session and the brief's hash, never its text.
      expect(confirmed.evidence.preset).toBe(session);
      expect(confirmed.briefHash).toMatch(/^[0-9a-f]{64}$/);
      // Nothing of the task, the folder or the composer text in the service's log.
      const log = readFileSync(join(r.lab.home, "state", "logs", "service.log"), "utf8");
      for (const secret of ["quotes", "Café", "Look at", "tests (v2)", launch.reference]) {
        expect(log).not.toContain(secret);
      }
    },
  );

  test(
    "Codex's terminal route: -C with the resolved folder, --no-daemon, the env_vars override its home lacks, and the reference match finds its thread",
    { timeout: 300_000 },
    async () => {
      const r = await rig("codex-terminal");
      const task = await addTask(r, HOSTILE_TITLE, HOSTILE_FOLDER);
      const folder = realpathSync.native(join(r.lab.work, HOSTILE_FOLDER));
      const { result } = await open(r, { task: task.ref, instance: "codex" });
      const launch = result.launch;
      const report = await reportAt(r.report("codex"));
      const golden = [
        "-C",
        folder,
        "--no-daemon",
        "-c",
        `mcp_servers.${MCP_SERVER_KEY}.env_vars=["${envVar("TICKET")}"]`,
        "--dangerously-bypass-approvals-and-sandbox",
        "--",
        briefFor("sent", r.lab.spaceId, task, launch.reference),
      ];
      expect(report.argv).toEqual(golden);
      expect(report.utf16).toEqual(golden.map(hex16));
      // The fake wrote its session file in the Codex home: the match records its thread ID.
      const matched = await r.lab.waitIntent(
        launch.id,
        (i) => i.evidence.thread !== undefined,
        "the reference match",
      );
      expect(matched.evidence.thread).toMatch(/^[0-9a-f-]{36}$/);
      const events = readLog(r.lab.home).filter((e) => e["ev"] === "launch.native_id");
      expect(events.map((e) => e["result"])).toEqual(["matched"]);
    },
  );

  test(
    "Codex's assisted open: no prompt in argv, and the prefilled brief comes back to be copied",
    { timeout: 300_000 },
    async () => {
      const r = await rig("codex-assisted");
      const task = await addTask(r, "Fix appointment time zones");
      const { result } = await open(r, { task: task.ref, instance: "codex-assisted" });
      const report = await reportAt(r.report("codex-assisted"));
      expect(report.argv).not.toContain("--");
      expect(report.argv.slice(0, 1)).toEqual(["-C"]);
      expect(report.argv.slice(2)).toEqual([
        "--no-daemon",
        "-c",
        `mcp_servers.${MCP_SERVER_KEY}.env_vars=["${envVar("TICKET")}"]`,
      ]);
      expect(result.copy).toBe(briefFor("prefilled", r.lab.spaceId, task, result.launch.reference));
    },
  );

  test(
    "the claude-cli:// link: one URL element whose values decode to the folder and the prefilled brief, and Dispatched",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("claude-link");
      const task = await addTask(r, HOSTILE_TITLE, HOSTILE_FOLDER);
      const folder = realpathSync.native(join(r.lab.work, HOSTILE_FOLDER));
      const { result } = await open(r, { task: task.ref, instance: "claude-link" });
      expect(result.launch.route).toBe("link");
      const dispatched = await r.lab.waitIntent(
        result.launch.id,
        (i) => i.state === "dispatched",
        "Dispatched",
      );
      expect(dispatched.reason).toBeNull();
      expect(opened).toHaveLength(1);
      const argv = opened[0]?.argv ?? [];
      const url = argv.at(-1) ?? "";
      expect(argv).toEqual(
        WINDOWS
          ? [expect.stringMatching(/rundll32\.exe$/iu), "url.dll,FileProtocolHandler", url]
          : [expect.stringMatching(/\/gio$/u), "open", url],
      );
      const query = new URL(url).searchParams;
      expect(url.startsWith("claude-cli://open?cwd=")).toBe(true);
      expect([...query.keys()]).toEqual(["cwd", "q"]);
      expect(query.get("cwd")).toBe(folder);
      expect(query.get("q")).toBe(
        briefFor("prefilled", r.lab.spaceId, task, result.launch.reference, { budget: 1000 }),
      );
      expect(url).toMatch(/^[A-Za-z0-9:/?&=%._~-]+$/u);
      // The link only asked the app: a click after it, from this tab or another, opens it again.
      const next = await open(r, { task: task.ref, instance: "claude-link" });
      expect(next.result.launch.id).not.toBe(result.launch.id);
    },
  );

  test(
    "an opener whose answer does not tell makes the link launch Unknown, never a second open",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      // An opener that does not end in time is stopped: "it may have opened".
      const r = await rig("claude-link-unknown", "hang");
      const task = await addTask(r, "Fix appointment time zones");
      const { result } = await open(r, { task: task.ref, instance: "claude-link" });
      const after = await r.lab.waitIntent(
        result.launch.id,
        (i) => i.state !== "prepared" && i.state !== "dispatching",
        "the opener's answer",
      );
      expect(after).toMatchObject({ state: "unknown", reason: "no_answer" });
      expect(opened).toHaveLength(1);
      const events = readLog(r.lab.home).filter((e) => e["ev"] === "launch.opener");
      expect(events.map((e) => e["result"])).toEqual(["unknown"]);
    },
  );

  test(
    "Copy: the pointer brief with the folder line, Dispatched at once; a repeat replays; words past Copy's budget become a note, and Open holds them instead",
    { timeout: 300_000 },
    async () => {
      const r = await rig("copy");
      const task = await addTask(r, HOSTILE_TITLE, HOSTILE_FOLDER);
      const first = await open(r, { task: task.ref });
      expect(first.result.launch).toMatchObject({
        route: "clipboard",
        instance: "clipboard",
        state: "dispatched",
      });
      expect(first.result.copy).toBe(
        briefFor("pointer", r.lab.spaceId, task, first.result.launch.reference, {
          budget: 20_000,
          folder: { kind: "folder", path: task.folder ?? "", found: true },
        }),
      );
      const again = await open(r, { task: task.ref, request_id: first.requestId });
      expect(again.result.launch.id).toBe(first.result.launch.id);
      expect(again.result.copy).toBe(first.result.copy);

      // Words longer than Copy's budget: saved as a note for agents, and the brief says so.
      const notes = async (): Promise<number> => {
        const digest = (await r.user.call(
          "op/call",
          { space: r.lab.spaceId, op: "task.get", input: { task: task.ref } },
          { timeoutMs: 60_000 },
        )) as { task: { instructions: unknown[]; more: { instructions: number } } };
        return digest.task.instructions.length + digest.task.more.instructions;
      };
      const long = `${"Please read this first. ".repeat(900)}End.`;
      const longer = `${long}\n${long}`;
      const noted = await open(r, { task: task.ref, text: longer });
      expect(noted.result.text).toBe("note");
      expect(await notes()).toBe(1);
      expect(noted.result.copy?.split("\n").at(-1)).toBe(NOTE_LINE);
      expect(noted.result.copy).not.toContain("Please read this first.");
      // A repeated click saves no second note.
      const repeat = await open(r, { task: task.ref, text: longer, request_id: noted.requestId });
      expect(repeat.result.launch.id).toBe(noted.result.launch.id);
      expect(await notes()).toBe(1);

      // Open holds the words for the agent whatever their length: no note, a pointer in the link.
      opened.length = 0;
      const held = await open(r, { task: task.ref, instance: "claude-link", text: long });
      expect(held.result.text).toBe("held");
      await r.lab.waitIntent(held.result.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const q = new URL(opened[0]?.argv.at(-1) ?? "x:").searchParams.get("q") ?? "";
      expect(q.split("\n").at(-1)).toBe(REQUEST_LINE);
      expect(q).not.toContain("Please read this first.");
      expect(await notes()).toBe(1);
      // A repeated click replays: the words are still held, and nothing more opens.
      const again2 = await open(r, {
        task: task.ref,
        instance: "claude-link",
        text: long,
        request_id: held.requestId,
      });
      expect(again2.result.launch.id).toBe(held.result.launch.id);
      expect(again2.result.text).toBe("held");
      expect(opened).toHaveLength(1);
      // The link only asked the app: another tab's click after it is a launch of its own, which
      // holds that tab's words, and a retry of that click says so too.
      const other = await open(r, { task: task.ref, instance: "claude-link", text: "Other words" });
      expect(other.result.launch.id).not.toBe(held.result.launch.id);
      expect(other.result.text).toBe("held");
      const otherAgain = await open(r, {
        task: task.ref,
        instance: "claude-link",
        text: "Other words",
        request_id: other.requestId,
      });
      expect(otherAgain.result.launch.id).toBe(other.result.launch.id);
      expect(otherAgain.result.text).toBe("held");
    },
  );

  test(
    "a retry replays its launch even after the task changed; the same request ID for another task is a conflict",
    { timeout: 300_000 },
    async () => {
      const r = await rig("replay");
      const task = await addTask(r, "Fix appointment time zones");
      const other = await addTask(r, "Another task");
      const first = await open(r, { task: task.ref });
      // The task changes between the click and its retry.
      const read = (await r.user.call(
        "op/call",
        { space: r.lab.spaceId, op: "task.get", input: { task: task.ref } },
        { timeoutMs: 60_000 },
      )) as { as_of: string };
      await r.user.call(
        "op/call",
        {
          space: r.lab.spaceId,
          op: "task.update",
          input: {
            task: task.ref,
            set: { title: "Fix appointment time zones today" },
            base: read.as_of,
            request_id: rid(),
          },
        },
        { timeoutMs: 60_000 },
      );
      const again = await open(r, { task: task.ref, request_id: first.requestId });
      expect(again.result.launch.id).toBe(first.result.launch.id);
      expect(again.result.launch.state).toBe("dispatched");
      expect(again.result.copy?.split("\n")[0]).toBe(
        `${PRODUCT_NAME} task ${task.ref} (launch ${first.result.launch.reference}).`,
      );
      // The request ID names one click: another task under it is refused, and nothing is made.
      let refused: unknown;
      try {
        await open(r, { task: other.ref, request_id: first.requestId });
      } catch (error) {
        refused = errorOf(error);
      }
      expect(refused).toMatchObject({ code: "request_id_conflict" });
      let conflict: unknown;
      try {
        await open(r, { task: task.ref, instance: "claude-link", request_id: first.requestId });
      } catch (error) {
        conflict = errorOf(error);
      }
      expect(conflict).toMatchObject({ code: "request_id_conflict" });
    },
  );

  test(
    "a retry that arrives while its first call is under way waits for it and replays, though the task changed in between",
    { timeout: 300_000 },
    async () => {
      const r = await rig("replay-race");
      const task = await addTask(r, "Fix appointment time zones");
      const requestId = rid();
      // What the request path read for each call: the retry read the task after an edit.
      const request = (title: string, version: number) => ({
        space: r.lab.spaceId,
        task: { id: task.id, ref: task.ref, title, version, folder: { kind: "none" as const } },
        instance: undefined,
        composer: undefined,
        requestId,
        saveNote: () => Promise.resolve(),
      });
      const service = r.lab.running.launches;
      const [first, retry] = await Promise.all([
        service.openTask(request("Fix appointment time zones", 1)),
        service.openTask(request("Fix appointment time zones today", 2)),
      ]);
      expect(retry.intent.id).toBe(first.intent.id);
      expect(retry.intent.state).toBe("dispatched");
      expect(retry.copy?.split("\n")[0]).toBe(
        `${PRODUCT_NAME} task ${task.ref} (launch ${first.intent.reference}).`,
      );
    },
  );

  test("the routes read the agent's home by launch's one rule: a Windows home variable in any case, and the entry's own env_vars", () => {
    const home = tempRoot("routes-homes");
    cleanups.push(home.cleanup);
    const claude = {
      id: "claude-x",
      target: "claude-cli",
      label: "Claude · x",
      account: "",
      spaces: [],
      exec: undefined,
      argsPrefix: [],
      configHome: undefined,
      env: { claude_config_dir: "D:\\claude-work" },
      openPermission: "inherit",
      runPermission: "inherit",
      extraArgs: [],
      prompt: "prefill",
      viaLoginShell: false,
      remoteAllowed: false,
      enabled: true,
    } as const;
    // On Windows `claude_config_dir` selects another home: the link (default home only) is not
    // this instance's route.
    expect(() =>
      chooseRoute(claude, { terminal: false, home: "C:\\Users\\mira", platform: "win32" }),
    ).toThrow(LaunchUnavailable);
    expect(
      chooseRoute(claude, { terminal: false, home: "/home/mira", platform: "linux" }).route,
    ).toBe("link");
    // The Codex home's entry: its own names are kept, a list Tasks cannot repeat exactly is left.
    const entry = (toml: string) => {
      writeFileSync(join(home.root, "config.toml"), toml);
      return codexEntryOf(home.root);
    };
    const table = `[mcp_servers.${MCP_SERVER_KEY}]\ncommand = "tasks"\n`;
    expect(entry(table)).toEqual({ kind: "lacks_env_vars", names: [] });
    expect(entry(`${table}env_vars = ["HTTPS_PROXY"]\n`)).toEqual({
      kind: "lacks_env_vars",
      names: ["HTTPS_PROXY"],
    });
    expect(entry(`${table}env_vars = ["HTTPS_PROXY", "${envVar("TICKET")}"]\n`)).toEqual({
      kind: "has_env_vars",
    });
    expect(entry(`${table}env_vars = ["A B"]\n`)).toEqual({ kind: "unknown" });
    expect(entry(`${table}env_vars = "HTTPS_PROXY"\n`)).toEqual({ kind: "unknown" });
    expect(entry(`[mcp_servers.other]\ncommand = "x"\n`)).toEqual({ kind: "absent" });
  });

  test(
    "refused before anything is recorded: an instance not set up, a route not built here, a folder not found on this machine",
    { timeout: 300_000 },
    async () => {
      const r = await rig("refusals");
      const placed = await addTask(r, "Placed task", "gone");
      // The folder goes before the click.
      statSync(join(r.lab.work, "gone"));
      const { rmSync } = await import("node:fs");
      rmSync(join(r.lab.work, "gone"), { recursive: true, force: true });
      const refusal = async (input: Record<string, unknown>) => {
        try {
          await open(r, input);
        } catch (error) {
          return errorOf(error);
        }
        throw new Error("expected a refusal");
      };
      expect(await refusal({ task: placed.ref, instance: "nope" })).toMatchObject({
        code: "invalid_input",
        data: { reason: "not_set_up" },
      });
      expect(await refusal({ task: placed.ref, instance: "t3-later" })).toMatchObject({
        code: "invalid_input",
        data: { reason: "no_route" },
      });
      expect(await refusal({ task: placed.ref, instance: "claude" })).toMatchObject({
        code: "invalid_input",
        message: "Folder not found on this machine.",
        hint: expect.stringContaining("give the task or its project another folder") as unknown,
        data: { field: "task", reason: "path_missing", folder: placed.folder },
      });
      // A refused click with words saves no note and holds nothing.
      const long = `${"Please read this first. ".repeat(400)}End.`;
      expect(await refusal({ task: placed.ref, instance: "claude", text: long })).toMatchObject({
        code: "invalid_input",
        data: { reason: "path_missing" },
      });
      const digest = (await r.user.call(
        "op/call",
        { space: r.lab.spaceId, op: "task.get", input: { task: placed.ref } },
        { timeoutMs: 60_000 },
      )) as { task: { instructions: unknown[]; more: { instructions: number } } };
      expect(digest.task.instructions.length + digest.task.more.instructions).toBe(0);
      expect(await refusal({ task: "M-999", instance: "claude" })).toMatchObject({
        code: "not_found",
      });
      // Nothing was recorded for any of them; Copy still works and says the folder is not here.
      const copied = await open(r, { task: placed.ref });
      expect(copied.result.copy).toContain(
        `Folder: ${placed.folder ?? ""} (not found on this machine)`,
      );
      const launches: LaunchIntent | undefined = await r.lab.running.launches.read(
        r.lab.spaceId,
        copied.result.launch.id,
      );
      expect(launches?.route).toBe("clipboard");
      // Copy is the only launch the task has: the refused clicks recorded nothing.
      const receipts = (await r.lab.running.launches.read(r.lab.spaceId, copied.result.launch.id))
        ?.reference;
      expect(receipts).toMatch(/^L[0-9A-Z]{5}$/u);
      const events = readLog(r.lab.home).filter((e) => e["ev"] === "launch.unavailable");
      expect(events.map((e) => e["reason"])).toEqual(["not_set_up", "no_route"]);
    },
  );
});

describe("[A4.5.routes.folders] a launch opens in the task's folder, else its project's, else on its machine, else in the work folder", () => {
  test(
    "the terminal starts there, the link names it and Copy says it; a folder only on another machine opens nothing here",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("routes-folders");
      const project = await addProject(r, "Portal", "portal-project");
      const own = await addTask(r, "Fixture own folder", "own-folder", "Portal");
      const inProject = await addTask(r, "Fixture in the project", undefined, "Portal");
      const none = await addTask(r, "Fixture without a folder");
      // No session of its own: an Open of an app that runs a task here is that session.
      const far = await addTask(r, "Fixture on another machine");
      const real = (name: string) => realpathSync.native(join(r.lab.work, name));
      const work = () =>
        realpathSync.native(join(stateOf(r.lab.home), "workdirs", `space-${r.lab.spaceId}`));

      /** Where each route opens `task`: the terminal's folder, the link's cwd, Copy's line. */
      const routes = async (task: { ref: string }) => {
        const terminal = (await open(r, { task: task.ref, instance: "claude" })).result.launch;
        const started = await waitFor(
          () => r.lab.folders.get(terminal.id),
          LONG_MS,
          "the terminal's folder",
        );
        const link = (await open(r, { task: task.ref, instance: "claude-link" })).result.launch;
        await r.lab.waitIntent(link.id, (i) => i.state === "dispatched", "Dispatched");
        const url = opened.at(-1)?.argv.at(-1) ?? "";
        const copy = (await open(r, { task: task.ref })).result.copy ?? "";
        return {
          terminal: started,
          link: new URL(url).searchParams.get("cwd"),
          copy: copy.split("\n")[4],
        };
      };

      expect(await routes(own)).toEqual({
        terminal: real("own-folder"),
        link: real("own-folder"),
        copy: `Folder: ${own.folder ?? ""}`,
      });
      expect(await routes(inProject)).toEqual({
        terminal: real("portal-project"),
        link: real("portal-project"),
        copy: `Folder: ${project}`,
      });
      expect(await routes(none)).toEqual({
        terminal: work(),
        link: work(),
        copy: `Folder: ${PRODUCT_NAME} work folder (${work()})`,
      });

      // A folder only on another machine: Open names that machine and never falls back to the
      // work folder; Copy says where it opens. The request path reads it so; here it is given.
      const service = r.lab.running.launches;
      const elsewhere = (instance: string | undefined) =>
        service.openTask({
          space: r.lab.spaceId,
          task: {
            id: far.id,
            ref: far.ref,
            title: "Fixture on another machine",
            version: 1,
            folder: { kind: "other_machine", machine: "mira-laptop" },
          },
          instance,
          composer: undefined,
          requestId: rid(),
          saveNote: () => Promise.resolve(),
        });
      const started = r.lab.folders.size;
      const links = opened.length;
      for (const instance of ["claude", "claude-link"]) {
        await expect(elsewhere(instance), instance).rejects.toMatchObject({
          name: "LaunchUnavailable",
          reason: "other_machine",
        });
      }
      expect(r.lab.folders.size).toBe(started);
      expect(opened).toHaveLength(links);
      expect((await elsewhere(undefined)).copy?.split("\n")[4]).toBe("Folder: on mira-laptop");
    },
  );
});

describe("[A4.5.routes.markers] a launch reads its folder's marker before an agent starts", () => {
  test(
    "its own marker opens; a marker gone or another's opens nothing and says whose, until the person opens it anyway; a folder that takes none opens",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("routes-markers");
      await addProject(r, "Portal", "portal-checkout");
      const inProject = await addTask(r, "Fixture marked project", undefined, "Portal");
      const marker = join(r.lab.work, "portal-checkout", FOLDER_MARKER);
      // Setting the folder marked it: the IDs only, no task text.
      const held = readFileSync(join(marker, "owners.json"), "utf8");
      expect(held).toContain(r.lab.spaceId);
      expect(held).not.toContain("Fixture");
      expect(readFileSync(join(marker, ".gitignore"), "utf8")).toBe("*\n");

      // The checkout is moved aside, and an unrelated one is made at the same path.
      renameSync(join(r.lab.work, "portal-checkout"), join(r.lab.work, "portal-aside"));
      mkdirSync(join(r.lab.work, "portal-checkout"));
      const started = r.lab.folders.size;
      const missing = errorOf(
        await open(r, { task: inProject.ref, instance: "claude" }).catch((e: unknown) => e),
      );
      expect(missing).toMatchObject({
        code: "invalid_input",
        data: { field: "task", reason: "marker_missing", of: "project" },
      });
      expect(r.lab.folders.size).toBe(started);
      // The person opens it anyway: the folder is marked as the project's, and opens.
      const anyway = (await open(r, { task: inProject.ref, instance: "claude", mark_folder: true }))
        .result.launch;
      await waitFor(() => r.lab.folders.get(anyway.id), LONG_MS, "the terminal's folder");
      expect(readFileSync(join(marker, "owners.json"), "utf8")).toContain(r.lab.spaceId);

      // A project's folder with its own marker opens.
      await addProject(r, "Billing", "billing");
      const billing = await addTask(r, "Fixture billing", undefined, "Billing");
      const ours = (await open(r, { task: billing.ref, instance: "claude" })).result.launch;
      await waitFor(() => r.lab.folders.get(ours.id), LONG_MS, "the terminal's folder");

      // A task's own folder whose marker names another project of the space.
      const own = await addTask(r, "Fixture own folder", "shared-folder");
      writeFileSync(
        join(r.lab.work, "shared-folder", FOLDER_MARKER, "owners.json"),
        readFileSync(join(r.lab.work, "billing", FOLDER_MARKER, "owners.json"), "utf8"),
      );
      const other = errorOf(
        await open(r, { task: own.ref, instance: "claude-link" }).catch((e: unknown) => e),
      );
      expect(other).toMatchObject({
        data: { reason: "marker_other", of: "task", owners: ["the project Billing"] },
      });
      expect(opened).toHaveLength(0);
      // Copy starts nothing, so it reads no marker.
      expect((await open(r, { task: own.ref })).result.launch.state).toBe("dispatched");

      // A folder that takes no marker opens as before.
      mkdirSync(join(r.lab.work, "unmarkable"));
      writeFileSync(join(r.lab.work, "unmarkable", FOLDER_MARKER), "the person's own file");
      const plain = await addTask(r, "Fixture unmarkable", "unmarkable");
      const free = (await open(r, { task: plain.ref, instance: "claude" })).result.launch;
      await waitFor(() => r.lab.folders.get(free.id), LONG_MS, "the terminal's folder");
      const events = readLog(r.lab.home).filter((e) => e["ev"] === "launch.folder_unmarked");
      expect(events.map((e) => e["reason"])).toEqual(["marker_missing", "marker_other"]);
    },
  );
});
