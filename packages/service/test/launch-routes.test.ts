// Open and Copy through the service (A4 3.4.2, 3.4.3, 3.4.6, 3.15; A7 3.9 M2.10's Verify line): a
// person's `launch.open` over the socket, the hub's one launch machine per space, a real
// `ttasks shim` started in the resolved folder, and testkit's fake Claude Code and Codex in place
// of the real CLIs (machine.toml instances whose `exec` is Node and whose `args_prefix` is the
// fake). The fake reports its argv exactly as it got it, so these tests compare the golden argv
// as arrays and each argument byte for byte, through the OS's real process creation: on Windows
// the runtime's quoting into one command line and the child's parsing back (CreateProcess). The
// link route's opener is a recording spawner: no real link is opened, no real agent starts, and
// no real agent home is read. Fixture data and temporary folders only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { envVar, FOLDER_MARKER, MCP_SERVER_KEY, PRODUCT_NAME } from "@ttasks/brand";
import type { RpcSession } from "@ttasks/bridge/protocol";
import {
  NOTE_LINE,
  OPENER_MS,
  FixedEnvironment,
  presetSession,
  renderBrief,
  sanitiseTitle,
  settingsOf,
  REQUEST_LINE,
  STEP_DEADLINE_MS,
  WAIT_LINE,
  type LaunchIntent,
  type SpawnRequest,
  type SpawnedProcess,
} from "@ttasks/launch";
import { FAKE_CLI_AGENT, testEnv, type CliAgentReport } from "@ttasks/testkit";
import type { OpenDriver, Work } from "@ttasks/runs";
import type { Logger } from "../src/hub/log.ts";
import { briefNames, chooseRoute, codexEntryOf, LaunchUnavailable } from "../src/launch/open.ts";
import { LaunchService } from "../src/launch/service.ts";
import { homeDigest, physicalHome } from "../src/setup/agents.ts";
import { configOf, instanceToml, readLog, stateOf, tempRoot, waitFor } from "./harness.ts";
import { errorOf, classSession } from "./ops-helpers.ts";
import { shell, written } from "./agents.ts";
import { LONG_MS, ShimLab } from "./shim-harness.ts";
import { holdNextWrite } from "./slow-marker.ts";

vi.mock("@ttasks/files", async () => (await import("./slow-marker.ts")).slowFiles());

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

/** The `systemd-run` the rig names: on Linux, its scope probe says scopes work. */
const SYSTEMD_RUN = "/usr/bin/systemd-run";

/**
 * A spawner that starts nothing: the opener "ran" and exited with `code`, or never answers
 * (`hang`). The scope probe answers 0 and is not an opener.
 */
function recordingSpawner(code: number | "hang") {
  return (request: SpawnRequest): Promise<SpawnedProcess> => {
    if (request.argv[0] === SYSTEMD_RUN && request.argv.includes("--quiet")) {
      return Promise.resolve({
        pid: 1,
        exited: Promise.resolve({ code: 0, signal: null }),
        stop: () => undefined,
      });
    }
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

/** The writer that serves the rig's space now: what a call's request path checks a click against. */
function writerOf(r: Rig) {
  const writer = r.lab.running.ops.spaces().find((s) => s.id === r.lab.spaceId)?.writer;
  if (writer === undefined) throw new Error("the space is not open for writing");
  return writer;
}

/** More of a rig: instances whose fake reports under their ID, and the person's environment. */
interface RigMore {
  readonly instances?: readonly {
    readonly id: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly [key: string]:
      string | readonly string[] | Readonly<Record<string, string>> | undefined;
  }[];
  /** The person's own environment as the agent's base (a `user` base), on top of the test's. */
  readonly person?: Readonly<Record<string, string>>;
  /**
   * The terminal adapters over a desktop where none can start: on Linux the default terminal has
   * no adapter (Alacritty) and no other is installed; on Windows neither console nor Windows
   * Terminal is there.
   */
  readonly noTerminal?: boolean;
}

/** The desktop of RigMore's `noTerminal`: only a terminal TTasks has no adapter for. */
const ALACRITTY = "/usr/bin/alacritty";
const noTerminalHost = (_session: unknown, path: readonly string[]) => ({
  platform: process.platform,
  path,
  terminalVar: WINDOWS ? undefined : ALACRITTY,
  home: WINDOWS ? "C:\\Users\\mira" : "/home/mira",
  windowsApps: undefined,
  executable: (program: string) => program === ALACRITTY,
  readText: () => undefined,
  realpath: (program: string) => program,
});

/**
 * A lab whose machine.toml has the fake Claude Code and Codex as instances: Claude Code with full
 * access (`claude`), Claude Code without a command, which opens through its link (`claude-link`),
 * and Codex (`codex`), with a Codex home of the lab's own whose TTasks entry lacks `env_vars`.
 */
async function rig(label: string, opener: number | "hang" = 0, more: RigMore = {}): Promise<Rig> {
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
  const terminals = {
    spawn: recordingSpawner(opener),
    systemdRun: SYSTEMD_RUN,
    // The recording spawner's hang never ends: what is proved is the answer once the
    // deadline passes, not the deadline's length (opener.test.ts covers that).
    ...(opener === "hang" ? { openerMs: 200 } : {}),
    ...(more.noTerminal === true ? { host: noTerminalHost } : {}),
  };
  const lab = await ShimLab.create(label, {
    // The real adapters in place of the lab's terminal, which always starts the shim.
    ...(more.noTerminal === true ? { adapters: terminals } : {}),
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
        instanceToml({ id: "claude-link", target: "claude-cli", label: "Claude link · test" }),
        instanceToml({
          id: "codex",
          target: "codex-cli",
          label: "Codex · test",
          config_home: codexHome,
          open_permission: "full-access",
          ...withReport("codex", { FAKE_CLI_ROLLOUT_HOME: codexHome }),
        }),
        instanceToml({ id: "t3-later", target: "t3", label: "T3 · test" }),
        ...(more.instances ?? []).map(({ env, ...fields }) => {
          const made = withReport(fields.id);
          return instanceToml({
            target: "claude-cli",
            label: `${fields.id} · test`,
            ...made,
            ...fields,
            env: { ...made.env, ...env },
          });
        }),
      ].join("");
    },
    launch: {
      ...(more.person === undefined
        ? {}
        : { environment: new FixedEnvironment({ kind: "user", env: testEnv(more.person) }) }),
      terminals,
    },
    ...(WINDOWS
      ? {}
      : { serviceEnv: { DISPLAY: ":0", PATH: `${bin.root}:${process.env["PATH"] ?? ""}` } }),
  });
  labs.push(lab);
  // A Codex home whose TTasks entry exists without `env_vars` (setup skipped it).
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
): Promise<{ id: string; ref: string; title: string; folder?: string }> {
  const added = (await write(r, "task.add", {
    tasks: [{ title, ...(project === undefined ? {} : { area: "Client work", project }) }],
  })) as { tasks: { id: string; ref: string }[] };
  const made = added.tasks[0];
  if (made === undefined) throw new Error("no task");
  const task = { ...made, title };
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
    left_out?: string[];
  };
  readonly copy?: string;
  readonly text: string;
  readonly brief_sent?: true;
  readonly note?: string;
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
  task: { ref: string; title?: string },
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
    title: task.title,
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
    "Claude Code's terminal route: the fake agent gets the golden argv, each element byte for byte, in the resolved folder, the brief in its prompt box unsent",
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
      expect(result.text).toBe("request");
      const launch = result.launch;
      // The click recorded the agent's app and home, its preset, and the session the launch is.
      const clicked = r.lab.running.launches.host.record(launch.id);
      expect(clicked).toMatchObject({
        app: "claude-code",
        preset: presetSession(r.lab.spaceId, requestId),
        session: `se_${launch.id.slice("la_".length)}`,
      });
      expect(basename(clicked?.home ?? "")).toBe(".claude");
      const confirmed = await r.lab.waitIntent(
        launch.id,
        (i) => i.state === "confirmed",
        "Confirmed",
      );
      const report = await reportAt(r.report("claude"));

      const session = presetSession(r.lab.spaceId, requestId);
      const brief = briefFor("prefilled", r.lab.spaceId, task, launch.reference, {
        composer: COMPOSER,
      });
      const golden = [
        "--session-id",
        session,
        "-n",
        `${task.ref} ${sanitiseTitle(HOSTILE_TITLE)}`,
        "--permission-mode",
        "bypassPermissions",
        `--prefill=${brief}`,
      ];
      expect(report.argv).toEqual(golden);
      expect(report.utf8).toEqual(golden.map(hex8));
      expect(report.utf16).toEqual(golden.map(hex16));
      // The two references and the title, and the person's words saved for the agent.
      expect(brief.split("\n")[0]).toBe(
        `${PRODUCT_NAME} task ${task.ref} "${sanitiseTitle(HOSTILE_TITLE)}" (launch ${launch.reference}).`,
      );
      expect(brief.split("\n").slice(4)).toEqual([REQUEST_LINE]);
      for (const arg of report.argv) expect(arg).not.toContain("Look at");
      // It started in the resolved folder, by identity.
      const id = statSync(folder, { bigint: true });
      expect(report.cwdId).toBe(`${id.dev.toString()}:${id.ino.toString()}`);
      expect(report.envNames).toContain(envVar("TICKET"));
      // The record holds the preset session, the home the click started the agent in as a digest
      // (never its path), and the brief's hash, never its text.
      expect(confirmed.evidence.preset).toBe(session);
      expect(confirmed.evidence.home).toBe(
        homeDigest(process.platform, await physicalHome(process.platform, clicked?.home ?? "")),
      );
      expect(confirmed.briefHash).toMatch(/^[0-9a-f]{64}$/);
      // Nothing of the task, the folder or the composer text in the service's log.
      const log = readFileSync(join(r.lab.home, "state", "logs", "service.log"), "utf8");
      for (const secret of ["quotes", "Café", "Look at", "tests (v2)", launch.reference]) {
        expect(log).not.toContain(secret);
      }
      expect(result.brief_sent).toBeUndefined();
    },
  );

  test(
    "a Claude Code too old to hold the brief in its prompt box gets it sent, and the result and the terminal's plan say so",
    { timeout: 300_000 },
    async () => {
      const r = await rig("claude-old", 0, {
        instances: [{ id: "claude-old", env: { FAKE_CLI_VERSION: "2.1.300" } }],
      });
      const task = await addTask(r, "Fixture old Claude Code");
      const { result, requestId } = await open(r, { task: task.ref, instance: "claude-old" });
      expect(result.launch).toMatchObject({ route: "terminal", instance: "claude-old" });
      expect(result.brief_sent).toBe(true);
      expect(r.lab.running.launches.host.record(result.launch.id)?.plan.notice).toBe("brief_sent");
      const report = await reportAt(r.report("claude-old"));
      const brief = briefFor("sent", r.lab.spaceId, task, result.launch.reference);
      expect(report.argv).toEqual([
        "--session-id",
        presetSession(r.lab.spaceId, requestId),
        "-n",
        `${task.ref} Fixture old Claude Code`,
        "--",
        brief,
      ]);
      expect(brief.split("\n").at(-1)).toBe(WAIT_LINE);
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
      const clicked = r.lab.running.launches.host.record(launch.id);
      expect(clicked).toMatchObject({ app: "codex", home: r.codexHome });
      expect(clicked).not.toHaveProperty("preset");
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
      // Never tied to the service: on Linux in a scope of its own, outside the service's unit.
      expect(opened[0]?.detached).toBe(true);
      const gio: unknown[] = [expect.stringMatching(/\/gio$/u), "open", url];
      expect(argv).toEqual(
        WINDOWS
          ? [expect.stringMatching(/rundll32\.exe$/iu), "url.dll,FileProtocolHandler", url]
          : process.platform === "linux"
            ? [
                SYSTEMD_RUN,
                "--user",
                "--scope",
                "--collect",
                "--slice=app.slice",
                expect.stringMatching(/^--unit=[a-z0-9]+-[0-9a-z]+-open-[0-9a-f]{16}$/u),
                "--",
                ...gio,
              ]
            : gio,
      );
      const query = new URL(url).searchParams;
      expect(url.startsWith("claude-cli://open?cwd=")).toBe(true);
      expect([...query.keys()]).toEqual(["cwd", "q"]);
      expect(query.get("cwd")).toBe(folder);
      expect(query.get("q")).toBe(
        // A link carries no title: it would stand in the URL.
        briefFor("prefilled", r.lab.spaceId, { ref: task.ref }, result.launch.reference, {
          budget: 1000,
        }),
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
      // An opener that does not end in time: "it may have opened".
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
      // The real opener's deadline ends before the launch step's, so its answer always comes.
      expect(OPENER_MS).toBeLessThan(STEP_DEADLINE_MS);
    },
  );

  test(
    "Copy: the pointer brief with the folder line, Dispatched at once; a repeat replays; words past Copy's budget become a note, and Open saves them as the launch's request",
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

      // Open saves the words whatever their length as the launch's request, a note of the
      // person's that is not addressed to every agent: a pointer in the link.
      opened.length = 0;
      const held = await open(r, { task: task.ref, instance: "claude-link", text: long });
      expect(held.result.text).toBe("request");
      await r.lab.waitIntent(held.result.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const q = new URL(opened[0]?.argv.at(-1) ?? "x:").searchParams.get("q") ?? "";
      expect(q.split("\n").at(-1)).toBe(REQUEST_LINE);
      expect(q).not.toContain("Please read this first.");
      expect(await notes()).toBe(1);
      // A repeated click replays: the same note is the request, and nothing more opens.
      const again2 = await open(r, {
        task: task.ref,
        instance: "claude-link",
        text: long,
        request_id: held.requestId,
      });
      expect(again2.result.launch.id).toBe(held.result.launch.id);
      expect(again2.result.text).toBe("request");
      expect(again2.result.note).toBe(held.result.note);
      expect(opened).toHaveLength(1);
      // The link only asked the app: another tab's click after it is a launch of its own, whose
      // request is that tab's words, and a retry of that click says so too.
      const other = await open(r, { task: task.ref, instance: "claude-link", text: "Other words" });
      expect(other.result.launch.id).not.toBe(held.result.launch.id);
      expect(other.result.text).toBe("request");
      expect(other.result.note).not.toBe(held.result.note);
      const otherAgain = await open(r, {
        task: task.ref,
        instance: "claude-link",
        text: "Other words",
        request_id: other.requestId,
      });
      expect(otherAgain.result).toMatchObject({
        launch: { id: other.result.launch.id },
        text: "request",
        note: other.result.note,
      });
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
        `${PRODUCT_NAME} task ${task.ref} "Fix appointment time zones today" (launch ${first.result.launch.reference}).`,
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
        writer: writerOf(r),
        task: { id: task.id, ref: task.ref, title, version, folder: { kind: "none" as const } },
        instance: undefined,
        composer: undefined,
        requestId,
        saveNote: () => Promise.resolve("n1"),
      });
      const service = r.lab.running.launches;
      const [first, retry] = await Promise.all([
        service.openTask(request("Fix appointment time zones", 1)),
        service.openTask(request("Fix appointment time zones today", 2)),
      ]);
      expect(retry.intent.id).toBe(first.intent.id);
      expect(retry.intent.state).toBe("dispatched");
      expect(retry.copy?.split("\n")[0]).toBe(
        `${PRODUCT_NAME} task ${task.ref} "Fix appointment time zones today" (launch ${first.intent.reference}).`,
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
      viaLoginShell: false,
      remoteAllowed: false,
      enabled: true,
    } as const;
    // On Windows `claude_config_dir` selects another home, which the link (default home only)
    // cannot open; on Linux it is another variable.
    expect(settingsOf(claude, "C:\\Users\\mira", "win32")).toEqual(["environment", "home"]);
    expect(settingsOf(claude, "/home/mira", "linux")).toEqual(["environment"]);
    // The Codex home's entry: its own names are kept, a list TTasks cannot repeat exactly is left.
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
    "refused before anything is recorded: an instance not set up, T3 Code that does not run, a folder not found on this machine",
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
        data: { reason: "t3", t3: "not_running" },
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
      expect(events.map((e) => e["reason"])).toEqual(["not_set_up", "t3"]);
    },
  );
});

describe("[A3.3.7.grant.space] Open says at the click when its agent's home is registered for another space", () => {
  test(
    "refused before anything is saved or started, naming the space it works in; a home of no row is not, and registered for the space it opens",
    { timeout: 300_000 },
    async () => {
      const r = await rig("home-space");
      const task = await addTask(r, "Fixture task for a home");
      const life = (
        (await r.user.call(
          "space/create",
          { name: "Life", path: join(r.lab.root, "spaces", "life"), ref_prefix: "L" },
          { timeoutMs: 60_000 },
        )) as { space: { id: string } }
      ).space.id;
      const register = (space: string) =>
        r.user.call(
          "setup/home_grant",
          { app: "codex", home: r.codexHome, instance: "codex-home", account: "", space },
          { timeoutMs: 60_000 },
        );
      const spawns = opened.length;
      await register(life);
      let refused;
      try {
        await open(r, { task: task.ref, instance: "codex", text: "Fixture words." });
      } catch (error) {
        refused = errorOf(error);
      }
      expect(refused).toMatchObject({
        code: "invalid_input",
        message: `This agent app works in the space Life, so it could not use ${PRODUCT_NAME} in this one. Nothing was started.`,
        hint: expect.stringContaining("Agent apps") as unknown,
        data: { field: "instance", reason: "other_space", space: "Life" },
      });
      // The refused click saved no words and started nothing.
      const digest = (await r.user.call(
        "op/call",
        { space: r.lab.spaceId, op: "task.get", input: { task: task.ref } },
        { timeoutMs: 60_000 },
      )) as { task: { instructions: unknown[]; more: { instructions: number } } };
      expect(digest.task.instructions.length + digest.task.more.instructions).toBe(0);
      expect(opened.length).toBe(spawns);
      // Claude Code's home never had a row: Open starts it, as before.
      expect((await open(r, { task: task.ref, instance: "claude" })).result.launch.route).toBe(
        "terminal",
      );
      // Registered for this space, Codex opens.
      await register(r.lab.spaceId);
      const { result } = await open(r, { task: task.ref, instance: "codex" });
      expect(result.launch.route).toBe("terminal");
      for (const name of ["claude", "codex"]) {
        expect((await reportAt(r.report(name))).argv.length, name).toBeGreaterThan(0);
      }
    },
  );
});

describe("[A4.5.routes.chosen] Open starts the agent as its instance is set up: its permission, its account and its spaces", () => {
  const SPACE = { id: "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7", name: "Personal" };
  const base = {
    id: "claude-x",
    target: "claude-cli",
    label: "Claude · x",
    account: "",
    spaces: [],
    exec: "/usr/bin/claude",
    argsPrefix: [],
    configHome: undefined,
    env: {},
    openPermission: "inherit",
    runPermission: "inherit",
    extraArgs: [],
    viaLoginShell: false,
    remoteAllowed: false,
    enabled: true,
  } as const;
  const here = { home: "/home/mira", platform: "linux", space: SPACE } as const;
  const reason = (run: () => unknown): string | undefined => {
    try {
      run();
    } catch (error) {
      if (error instanceof LaunchUnavailable) return error.reason;
      throw error;
    }
    return undefined;
  };

  test("Open takes the route that carries what the instance sets, with the prompt unsent where the app can; without one it names what it left out", () => {
    type Given = Parameters<typeof chooseRoute>[0];
    const pick = (instance: Given, terminal: boolean) => {
      const chosen = chooseRoute(instance, { ...here, terminal });
      // A route that leaves something out never sends the prompt: the person reads what it left
      // out first.
      if (chosen.leftOut.length > 0) expect(chosen.kind).toBe("prefilled");
      return [chosen.route, chosen.kind, [...chosen.leftOut]];
    };
    const desktop = { ...base, id: "desktop", target: "claude-desktop", exec: undefined } as const;
    const codex = { ...base, id: "codex-x", target: "codex-cli" } as const;
    const ownHome = { configHome: "/home/mira/.claude-work" } as const;
    // instance, with a terminal, without one.
    const table: readonly (readonly [string, Given, unknown, unknown])[] = [
      ["nothing set", base, ["terminal", "prefilled", []], ["link", "prefilled", []]],
      [
        "read-only",
        { ...base, openPermission: "read-only" },
        ["terminal", "prefilled", []],
        ["link", "prefilled", ["read-only"]],
      ],
      [
        "arguments",
        { ...base, extraArgs: ["--model", "fixture"] },
        ["terminal", "prefilled", []],
        ["link", "prefilled", ["arguments"]],
      ],
      [
        "environment",
        { ...base, env: { FIXTURE_SETTING: "1" } },
        ["terminal", "prefilled", []],
        ["link", "prefilled", ["environment"]],
      ],
      [
        // The agent never gets a TTASKS_* variable: it is no setting to carry.
        "a reserved variable only",
        { ...base, env: { [envVar("FIXTURE")]: "1" } },
        ["terminal", "prefilled", []],
        ["link", "prefilled", []],
      ],
      [
        // Its link would open the default home's Claude Code: what the person types there goes
        // to another account. Only a terminal opens it (below).
        "a home of its own",
        { ...base, ...ownHome },
        ["terminal", "prefilled", []],
        null,
      ],
      [
        "an app with its own settings",
        { ...desktop, openPermission: "auto-edit", env: { FIXTURE_SETTING: "1" }, ...ownHome },
        ["link", "prefilled", ["auto-edit", "environment", "home"]],
        ["link", "prefilled", ["auto-edit", "environment", "home"]],
      ],
      // Codex cannot start with its prompt unsent: it sends the brief, as its first turn.
      ["Codex", { ...codex, openPermission: "read-only" }, ["terminal", "sent", []], null],
    ];
    for (const [name, instance, withTerminal, without] of table) {
      expect(pick(instance, true), name).toEqual(withTerminal);
      if (without !== null) expect(pick(instance, false), name).toEqual(without);
    }
    // Codex opens only in a terminal: without one, or without its command, nothing opens.
    expect(reason(() => chooseRoute(codex, { ...here, terminal: false }))).toBe("no_terminal");
    expect(
      reason(() => chooseRoute({ ...codex, exec: undefined }, { ...here, terminal: true })),
    ).toBe("not_set_up");
    // A home of its own opens only where a route carries it: never the default home instead.
    for (const own of [
      { ...base, ...ownHome },
      { ...base, ...ownHome, openPermission: "read-only" },
      { ...base, env: { CLAUDE_CONFIG_DIR: "/home/mira/.claude-work" } },
    ] as const) {
      expect(reason(() => chooseRoute(own, { ...here, terminal: false }))).toBe("own_home");
    }
  });

  test("where no terminal opens (macOS), each instance that can open or run for the space keeps its tile, offering what works", () => {
    const root = tempRoot("chosen-tiles");
    cleanups.push(root.cleanup);
    const service = new LaunchService({
      machine: "m_7c0hq2m4w9d8k1r6t3v5x0b2nf",
      root: join(root.root, "launch"),
      stateDir: join(root.root, "state"),
      platform: "darwin",
      env: {},
      home: "/Users/mira",
      spaces: () => [],
      log: { log: () => undefined } as unknown as Logger,
      instances: [
        { ...base, id: "claude-plan", openPermission: "read-only" },
        { ...base, id: "claude-work", configHome: "/Users/mira/.claude-work" },
        { ...base, id: "codex-x", target: "codex-cli" },
        { ...base, id: "claude-elsewhere", spaces: ["Research"] },
        { ...base, id: "t3-x", target: "t3", exec: undefined },
        { ...base, id: "claude-off", enabled: false },
      ],
    });
    // Claude Code opens through its link, saying what it left out; with a home of its own, and
    // Codex, it only runs here; T3 Code opens through its own route, whether or not it runs now.
    expect(service.instances(SPACE.id).map((t) => [t.key, t.route ?? "runs only"])).toEqual([
      ["claude-plan", "link"],
      ["claude-work", "runs only"],
      ["codex-x", "runs only"],
      ["t3-x", "t3-mcp"],
    ]);
  });

  test("an instance set for some spaces opens only there, named by ID or name in any case", () => {
    const listed = (spaces: readonly string[]) =>
      reason(() => chooseRoute({ ...base, spaces }, { ...here, terminal: true }));
    expect(listed([])).toBeUndefined();
    expect(listed(["personal"])).toBeUndefined();
    expect(listed([SPACE.id])).toBeUndefined();
    expect(listed(["Research"])).toBe("not_for_space");
    expect(listed(["sp_000000000000000000000000000"])).toBe("not_for_space");
  });

  test(
    "through the service: read-only opens in a terminal in plan mode with the brief in its prompt box; an instance for another space is not offered and opens nothing",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("chosen", 0, {
        instances: [
          { id: "claude-plan", open_permission: "read-only" },
          { id: "claude-research", spaces: ["Research"] },
          { id: "desktop-plan", target: "claude-desktop", open_permission: "read-only" },
        ],
      });
      const tiles = r.lab.running.launches.instances(r.lab.spaceId);
      expect(tiles.find((t) => t.key === "claude-plan")?.route).toBe("terminal");
      expect(tiles.find((t) => t.key === "desktop-plan")?.route).toBe("link");
      expect(tiles.map((t) => t.key)).not.toContain("claude-research");

      // The app opens with its own settings: it opens, with the prompt unsent, and the receipt
      // names what it left out, also for a repeat of the click.
      const linked = await addTask(r, "Fixture desktop plan");
      const viaLink = await open(r, { task: linked.ref, instance: "desktop-plan" });
      // The rig gives every instance its fake's env: the app cannot carry that either.
      const leftOut = ["read-only", "environment"];
      expect(viaLink.result.launch).toMatchObject({ route: "link", left_out: leftOut });
      const again = await open(r, {
        task: linked.ref,
        instance: "desktop-plan",
        request_id: viaLink.requestId,
      });
      expect(again.result.launch).toMatchObject({
        id: viaLink.result.launch.id,
        left_out: leftOut,
      });
      await waitFor(() => (opened.length > 0 ? true : undefined), LONG_MS, "the link's opener");
      opened.length = 0;

      const task = await addTask(r, "Fixture plan only");
      const { result } = await open(r, { task: task.ref, instance: "claude-plan" });
      expect(result.launch.route).toBe("terminal");
      const report = await reportAt(r.report("claude-plan"));
      expect(report.argv.slice(4)).toEqual([
        "--permission-mode",
        "plan",
        `--prefill=${briefFor("prefilled", r.lab.spaceId, task, result.launch.reference)}`,
      ]);
      expect(result.copy).toBeUndefined();
      expect(opened).toHaveLength(0);

      const started = r.lab.folders.size;
      const refused = errorOf(
        await open(r, { task: task.ref, instance: "claude-research" }).catch((e: unknown) => e),
      );
      expect(refused).toMatchObject({
        code: "invalid_input",
        message: "This instance is set up for other spaces only. Nothing was started.",
        data: { field: "instance", reason: "not_for_space" },
      });
      expect(r.lab.folders.size).toBe(started);
    },
  );

  test(
    "a launch keeps what it left out: a repeat of its click after the instance changed and the service restarted still names it",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("chosen-kept", 0, {
        instances: [{ id: "desktop-plan", target: "claude-desktop", open_permission: "read-only" }],
      });
      const task = await addTask(r, "Fixture kept left out");
      const first = await open(r, { task: task.ref, instance: "desktop-plan" });
      const leftOut = ["read-only", "environment"];
      expect(first.result.launch.left_out).toEqual(leftOut);
      await waitFor(() => (opened.length > 0 ? true : undefined), LONG_MS, "the link's opener");
      // The person takes the permission away, and the service starts again.
      await r.lab.stopService();
      const toml = join(configOf(r.lab.home), "machine.toml");
      const before = readFileSync(toml, "utf8");
      writeFileSync(toml, before.replace('open_permission = "read-only"', ""));
      await r.lab.start();
      const user = await classSession(r.lab.home, r.lab.running.endpoint.path, "cli-interactive");
      sessions.push(user);
      const again = await open(
        { ...r, user },
        { task: task.ref, instance: "desktop-plan", request_id: first.requestId },
      );
      expect(again.result.launch).toMatchObject({ id: first.result.launch.id, left_out: leftOut });
      // A new click opens as the instance is set up now.
      const now = await open({ ...r, user }, { task: task.ref, instance: "desktop-plan" });
      expect(now.result.launch.left_out).toEqual(["environment"]);
    },
  );

  test(
    "through the service: where no terminal of the launch's chain can start, a permission opens through the link with the prompt unsent and is named",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const homes = tempRoot("chosen-no-terminal-home");
      cleanups.push(homes.cleanup);
      const r = await rig("chosen-no-terminal", 0, {
        noTerminal: true,
        instances: [
          { id: "claude-plan", open_permission: "read-only" },
          { id: "claude-work", config_home: join(homes.root, "claude-work") },
        ],
      });
      const task = await addTask(r, "Fixture no terminal");
      const { result } = await open(r, { task: task.ref, instance: "claude-plan" });
      // The rig gives every instance its fake's env: the link cannot carry that either.
      expect(result.launch).toMatchObject({
        route: "link",
        left_out: ["read-only", "environment"],
      });
      await waitFor(() => (opened.length > 0 ? true : undefined), LONG_MS, "the link's opener");
      // A home of its own: the link would open the default account's Claude Code instead.
      opened.length = 0;
      const refused = errorOf(
        await open(r, { task: task.ref, instance: "claude-work" }).catch((e: unknown) => e),
      );
      expect(refused).toMatchObject({
        code: "invalid_input",
        message:
          "Only a terminal opens this instance with the account chosen for it, and none can start here. Nothing was started.",
        data: { field: "instance", reason: "own_home" },
      });
      expect(opened).toHaveLength(0);
    },
  );

  test(
    "through the service: an instance with a home of its own gets no account variable from the person's environment, and its own env wins; the default home keeps the person's",
    { timeout: 300_000 },
    async () => {
      // Inert stand-ins: no value here is a credential, and only the names are reported.
      const inert = "inert-stand-in";
      const home = tempRoot("chosen-home");
      cleanups.push(home.cleanup);
      // What says which account or endpoint, and one variable of the person's that does not.
      const account = [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_PROFILE",
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_MANTLE",
      ];
      const r = await rig("chosen-account", 0, {
        person: { ...Object.fromEntries(account.map((n) => [n, inert])), FIXTURE_PERSON: "1" },
        instances: [
          {
            id: "claude-own",
            env: { CLAUDE_CONFIG_DIR: join(home.root, "claude"), CLAUDE_CODE_USE_BEDROCK: "1" },
          },
          // A home of its own by `config_home` alone: the program is told it.
          { id: "claude-config", config_home: join(home.root, "claude-config") },
        ],
      });
      const task = await addTask(r, "Fixture account");
      await open(r, { task: task.ref, instance: "claude-own" });
      await open(r, { task: task.ref, instance: "claude-config" });
      await open(r, { task: task.ref, instance: "claude", another: true });
      const names = async (id: string) =>
        (await reportAt(r.report(id))).envNames.map((n) => n.toUpperCase());
      const own = await names("claude-own");
      expect(own).toContain("CLAUDE_CONFIG_DIR");
      expect(own).toContain("CLAUDE_CODE_USE_BEDROCK");
      expect(own).toContain("FIXTURE_PERSON");
      for (const name of account) expect(own, name).not.toContain(name);
      const configured = await names("claude-config");
      expect(configured).toContain("CLAUDE_CONFIG_DIR");
      for (const name of account) expect(configured, name).not.toContain(name);
      const usual = await names("claude");
      expect(usual).not.toContain("CLAUDE_CONFIG_DIR");
      for (const name of [...account, "FIXTURE_PERSON"]) expect(usual, name).toContain(name);
    },
  );

  test(
    "a folder replaced at its path after its marker was checked opens nothing: the launch fails as folder_changed",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("chosen-folder");
      for (const instance of ["claude", "claude-link"]) {
        const task = await addTask(r, `Fixture replaced folder ${instance}`, `swapped-${instance}`);
        const folder = join(r.lab.work, `swapped-${instance}`);
        // Only its marker went (`git clean -x`): the check puts it back, and the checkout is
        // replaced while it writes.
        rmSync(join(folder, FOLDER_MARKER), { recursive: true, force: true });
        const held = holdNextWrite();
        const opening = open(r, { task: task.ref, instance });
        await held.reached;
        renameSync(folder, join(r.lab.work, `swapped-aside-${instance}`));
        mkdirSync(folder);
        await held.land();
        const { result } = await opening;
        const settled = await waitFor(
          async () => {
            const now = await r.lab.running.launches.read(r.lab.spaceId, result.launch.id);
            return now?.state === "failed" ? now : undefined;
          },
          LONG_MS,
          "the refused dispatch",
        );
        expect(settled.reason, instance).toBe("folder_changed");
        expect(r.lab.folders.get(result.launch.id), instance).toBeUndefined();
      }
      expect(opened).toHaveLength(0);
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
          writer: writerOf(r),
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
          saveNote: () => Promise.resolve("n1"),
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

      // A task's own folder replaced by one whose marker names another project of the space.
      const own = await addTask(r, "Fixture own folder", "shared-folder");
      renameSync(join(r.lab.work, "shared-folder"), join(r.lab.work, "shared-aside"));
      mkdirSync(join(r.lab.work, "shared-folder", FOLDER_MARKER), { recursive: true });
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

      // A marked folder replaced by one that takes no marker (a read-only share that came back as
      // another device) asks once: opened anyway, it opens from then on without a marker.
      renameSync(join(r.lab.work, "shared-folder"), join(r.lab.work, "shared-aside-2"));
      mkdirSync(join(r.lab.work, "shared-folder"));
      writeFileSync(join(r.lab.work, "shared-folder", FOLDER_MARKER), "the person's own file");
      const asks = errorOf(
        await open(r, { task: own.ref, instance: "claude" }).catch((e: unknown) => e),
      );
      expect(asks).toMatchObject({ data: { reason: "marker_missing", of: "task" } });
      const chosen = (await open(r, { task: own.ref, instance: "claude", mark_folder: true }))
        .result.launch;
      await waitFor(() => r.lab.folders.get(chosen.id), LONG_MS, "the terminal's folder");
      const again = (await open(r, { task: own.ref, instance: "claude" })).result.launch;
      await waitFor(() => r.lab.folders.get(again.id), LONG_MS, "the terminal's folder");

      const events = readLog(r.lab.home).filter((e) => e["ev"] === "launch.folder_unmarked");
      expect(events.map((e) => e["reason"])).toEqual([
        "marker_missing",
        "marker_other",
        "marker_missing",
      ]);
    },
  );

  test(
    "a folder whose marker was not written within its bound, replaced at its path, opens nothing",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("routes-markers-late");
      // The set answers once the bound passed; the marker's write was given up and puts nothing
      // in place after that.
      const held = holdNextWrite();
      const late = await addTask(r, "Fixture late marker", "late-checkout");
      expect(await held.land()).toBeInstanceOf(Error);
      expect(existsSync(join(r.lab.work, "late-checkout", FOLDER_MARKER, "owners.json"))).toBe(
        false,
      );

      renameSync(join(r.lab.work, "late-checkout"), join(r.lab.work, "late-aside"));
      mkdirSync(join(r.lab.work, "late-checkout"));
      const started = r.lab.folders.size;
      const missing = errorOf(
        await open(r, { task: late.ref, instance: "claude" }).catch((e: unknown) => e),
      );
      expect(missing).toMatchObject({ data: { reason: "marker_missing", of: "task" } });
      expect(r.lab.folders.size).toBe(started);
      expect(opened).toHaveLength(0);
    },
  );
});

/** A run's driver that hears the agent's conversation ID, and settles at once or at the agent's end. */
const conversation =
  (id: string, holds: boolean): OpenDriver =>
  (_pipes, report) => {
    report({ kind: "native-id", id });
    const work: Work = {
      ok: true,
      outcome: "success",
      nativeId: id,
      text: "Found it in the export.",
      textCut: false,
      textFinal: true,
      error: null,
      usage: null,
      appTools: null,
      declined: 0,
      permissionDenials: 0,
    };
    let settle: (done: Work) => void = () => undefined;
    const settled = new Promise<Work>((resolve) => {
      settle = resolve;
    });
    if (!holds) settle(work);
    return {
      settled,
      interrupt: () => false,
      close: () => undefined,
      ended: () => {
        settle(work);
      },
    };
  };

/**
 * A background run of `task` in `instance`, its agent a Node that ends at once or waits. It
 * records what a real run's start records: the folder it worked in and its agent home.
 */
async function runOf(
  r: Rig,
  task: string,
  instance: string,
  id: string | null,
  evidence: { readonly folder_id: string; readonly home: string },
  holds = false,
): Promise<string> {
  const queued = await r.lab.running.runs.start(
    r.lab.spaceId,
    {
      task,
      routine: null,
      instance,
      adapter: instance === "codex" ? "codex" : "claude-print",
      place: null,
      request: "Look into the export.",
      briefHash: "0a1b2c3d".repeat(8),
      permission: "read-only",
    },
    rid(),
    () => ({
      command: process.execPath,
      args: ["-e", holds ? "setInterval(() => {}, 1e6)" : ""],
      cwd: r.lab.root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      evidence,
      ...(id === null ? {} : { open: conversation(id, holds) }),
    }),
  );
  if (holds) {
    await waitFor(
      async () =>
        (await r.lab.running.runs.read(r.lab.spaceId, queued.id))?.state === "running"
          ? true
          : undefined,
      LONG_MS,
      "the run works",
    );
  } else {
    await r.lab.running.runs.ended(r.lab.spaceId, queued.id);
  }
  return queued.id;
}

/** Continue's refusal of `asked`, with its reason. */
const refusedFor = (r: Rig, asked: Record<string, unknown>) =>
  open(r, asked).then(
    () => undefined,
    (error: unknown) => {
      const body = errorOf(error);
      return { code: body.code, reason: body.data?.["reason"] };
    },
  );

describe("[A4.5.routes.continue] Continue opens a background run's own conversation in its app's terminal, as Open starts it", () => {
  test(
    "Claude Code opens its run's conversation with --resume in the run's folder and home, and the session writes as itself; a conversation already open is that session, another opens beside it; a working Codex run is stopped first; nothing is stopped for a Continue that cannot open",
    { timeout: 300_000 },
    async () => {
      const homes = tempRoot("continue-homes");
      cleanups.push(homes.cleanup);
      const claudeHome = join(homes.root, "claude-home");
      mkdirSync(claudeHome);
      const r = await rig("continue", 0, {
        instances: [
          // Its agent stays open until the test ends, as a person's terminal does.
          { id: "claude-a", config_home: claudeHome, env: { FAKE_CLI_HOLD_MS: "200000" } },
        ],
      });
      const { spaceId } = r.lab;
      const platform = process.platform;
      const task = await addTask(r, "Look into the export", "portal-continue");
      const stored = task.folder ?? "";
      const folder = realpathSync.native(join(r.lab.work, "portal-continue"));
      const found = await r.lab.running.launches.runFolder(spaceId, {
        kind: "task",
        path: stored,
        owner: task.id,
      });
      if (!("identity" in found)) throw new Error("the task's folder did not resolve");
      const claude = {
        folder_id: found.identity,
        home: homeDigest(platform, await physicalHome(platform, claudeHome)),
      };
      const codex = {
        folder_id: found.identity,
        home: homeDigest(platform, await physicalHome(platform, r.codexHome)),
      };
      const runs = r.lab.running.runs;
      const stateOf = async (id: string) => (await runs.read(spaceId, id))?.state;

      // Nothing is stopped for a Continue that cannot open: another task's run, a run without a
      // conversation, and a run whose instance now runs in another home are refused while they
      // still work. One task runs one run at a time: each is stopped before the next starts.
      const other = await addTask(r, "Another task");
      const cases = [
        [other.id, randomUUID(), claude, { code: "not_found", reason: undefined }],
        [task.id, null, claude, { code: "invalid_input", reason: "conversation" }],
        [
          task.id,
          randomUUID(),
          { ...claude, home: "0".repeat(64) },
          { code: "invalid_input", reason: "home" },
        ],
      ] as const;
      for (const [owner, conversationId, recorded, refusal] of cases) {
        const working = await runOf(r, owner, "claude-a", conversationId, recorded, true);
        expect(await refusedFor(r, { task: task.ref, run: working })).toEqual(refusal);
        expect(await stateOf(working)).toBe("running");
        await runs.stop(spaceId, working);
        await runs.ended(spaceId, working);
      }
      // Words go in the agent app.
      const first = randomUUID();
      const ended = await runOf(r, task.id, "claude-a", first, claude);
      expect(await refusedFor(r, { task: task.ref, run: ended, text: "Go on." })).toMatchObject({
        code: "invalid_input",
      });

      // The run's conversation opens in its folder, with the launch's own ticket.
      const { result } = await open(r, { task: task.ref, run: ended });
      expect(result.launch).toMatchObject({ route: "terminal", instance: "claude-a" });
      expect(result.text).toBe("none");
      const report = await reportAt(r.report("claude-a"));
      expect(report.argv).toEqual(["--resume", first]);
      const id = statSync(folder, { bigint: true });
      expect(report.cwdId).toBe(`${id.dev.toString()}:${id.ino.toString()}`);
      const confirmed = await r.lab.waitIntent(
        result.launch.id,
        (i) => i.state === "confirmed" && i.evidence.pid !== undefined,
        "Confirmed",
      );
      expect(confirmed.evidence).toMatchObject({ preset: first, resumes: first });
      // What the resumed session writes is its own, not the run's.
      const world = {
        service: r.lab.running,
        home: r.lab.home,
        path: r.lab.running.endpoint.path,
      };
      const sh = await shell(world, {
        [envVar("TICKET")]: r.lab.tickets.get(result.launch.id) ?? "",
      });
      const note = { task: task.id, text: "Went on with it.", request_id: rid() };
      await sh.call("entry.add", note, { space: spaceId });
      await sh.close();
      expect((await written(world, spaceId, note.request_id)).map((w) => w.scope)).toEqual([
        `session:se_${result.launch.id.slice("la_".length)}`,
      ]);

      // While it is open, Continue of the same conversation is that session, also as "another";
      // another run's conversation opens beside it.
      const again = await open(r, { task: task.ref, run: ended, another: true });
      expect(again.result.launch.id).toBe(result.launch.id);
      rmSync(r.report("claude-a"));
      const second = randomUUID();
      const next = await runOf(r, task.id, "claude-a", second, claude);
      const beside = await open(r, { task: task.ref, run: next });
      expect(beside.result.launch.id).not.toBe(result.launch.id);
      expect((await reportAt(r.report("claude-a"))).argv).toEqual(["--resume", second]);

      // A working Codex run is stopped and ended before its conversation opens.
      const codexId = "019a3f2c-7c41-7d20-9b6e-3f1c2a4b5d6e";
      const working = await runOf(r, task.id, "codex", codexId, codex, true);
      const stopped = await open(r, { task: task.ref, instance: "codex", run: working });
      expect(await stateOf(working)).toBe("cancelled");
      expect((await reportAt(r.report("codex"))).argv).toEqual([
        "resume",
        codexId,
        "-C",
        folder,
        "--no-daemon",
        "-c",
        `mcp_servers.${MCP_SERVER_KEY}.env_vars=["${envVar("TICKET")}"]`,
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
      const codexLaunch = await r.lab.waitIntent(
        stopped.result.launch.id,
        (i) => i.state === "confirmed",
        "Confirmed",
      );
      expect(codexLaunch.evidence).toMatchObject({ thread: codexId, resumes: codexId });

      // A task whose folder is another one now than the run's opens nothing there.
      mkdirSync(join(r.lab.work, "portal-elsewhere"));
      const seen = (await r.user.call(
        "op/call",
        { space: spaceId, op: "task.get", input: { task: task.ref } },
        { timeoutMs: 60_000 },
      )) as { as_of: string };
      await write(r, "folder.manage", {
        action: "set",
        task: task.ref,
        folder: join(r.lab.work, "portal-elsewhere"),
        base: seen.as_of,
      });
      const third = await runOf(r, task.id, "claude-a", randomUUID(), claude);
      expect(await refusedFor(r, { task: task.ref, run: third })).toMatchObject({
        reason: "folder_moved",
      });
    },
  );
});
