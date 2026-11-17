// Terminals end to end (A7 3.9 M2.09, A4 3.6.2, 3.7; SL-09): a real service in this process with
// its own terminal adapters, testkit's fake terminals and fake systemd-run in place of the real
// programs (a recording spawner stands in for the service's), a real `tasks shim` inside them, and
// testkit's fake interactive agent. Nothing starts a real terminal, agent or systemd-run. Fixture
// data and temporary folders only.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PRODUCT_ID } from "@tasks/brand";
import { RpcError } from "@tasks/bridge/protocol";
import { defaultShimCommand, LaunchFolderUnavailable } from "../src/launch/service.ts";
import {
  REFUSED,
  startTimes,
  TICKET,
  type AgentBase,
  type EnvironmentSource,
  type LaunchIntent,
  type PlanFolder,
  type SpawnPlan,
  type TerminalHost,
} from "@tasks/launch";
import {
  FAKE_SYSTEMD_RUN,
  FAKE_TERMINAL,
  FakeSpawner,
  interactiveAgentArgv,
  readJsonLines,
  type InteractiveAgentReport,
} from "@tasks/testkit";
import { readLog, waitFor } from "./harness.ts";
import { LONG_MS, ShimLab, shimSession, type LabOptions } from "./shim-harness.ts";

const WINDOWS = process.platform === "win32";
/** Where the fake machine keeps each terminal. */
const WINDOWS_APPS = "C:\\fake-local\\Microsoft\\WindowsApps";
const WT = `${WINDOWS_APPS}\\wt.exe`;
/** The console's starter on the fake machine (Windows PowerShell). */
const POWERSHELL = "C:\\fake-system\\WindowsPowerShell\\v1.0\\powershell.exe";
const GHOSTTY = "/usr/bin/ghostty";
const GNOME = "/usr/bin/gnome-terminal";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const TRUE = "/usr/bin/true";
/** The handoff terminal of this OS. */
const HANDOFF = WINDOWS ? WT : GNOME;

const labs: ShimLab[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    // Every process the fakes started and the test saw alive: terminals, servers, shims.
    await r.spawner.stopAll();
  }
  for (const lab of labs.splice(0)) await lab.cleanup();
}, 120_000);

interface Rig {
  readonly lab: ShimLab;
  readonly spawner: FakeSpawner;
  /** The fake terminals' log (JSON lines). */
  readonly terminalLog: string;
  readonly systemdLog: string;
}

/**
 * A lab whose service uses its own terminal adapters on a fake machine: these terminal programs
 * exist and behave as `terminals` says; on Linux a fake systemd-run that works unless `scopeFails`.
 */
async function rig(
  label: string,
  terminals: Record<string, Record<string, string>>,
  options: {
    scopeFails?: boolean;
    serviceEnv?: Record<string, string>;
    missing?: string[];
    environment?: EnvironmentSource;
  } = {},
): Promise<Rig> {
  const made: { lab?: ShimLab; spawner?: FakeSpawner } = {};
  const node = (script: string): string[] => [process.execPath, script];
  const programs: Record<string, string[]> = {
    [SYSTEMD_RUN]: node(FAKE_SYSTEMD_RUN),
    [TRUE]: [process.execPath, "-e", "process.exit(0)"],
  };
  for (const program of Object.keys(terminals)) programs[program] = node(FAKE_TERMINAL);
  const host = (
    session: Readonly<Record<string, string>>,
    path: readonly string[],
  ): TerminalHost => ({
    platform: process.platform,
    path: WINDOWS ? path : ["/usr/bin"],
    terminalVar: session["TERMINAL"],
    home: made.lab?.root ?? "",
    windowsApps: WINDOWS_APPS,
    powershell: POWERSHELL,
    // Windows: "Let Windows decide".
    delegation: { console: undefined, terminal: undefined },
    // Linux: only the fake terminals, so a real x-terminal-emulator on the machine running the test
    // never becomes the default.
    executable: (p) =>
      p in programs ||
      (WINDOWS &&
        (() => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        })()),
    readText: () => undefined,
    realpath: (p) => p,
  });
  const adapters: LabOptions["adapters"] = {
    spawn: (request) => {
      const spawner = made.spawner;
      if (spawner === undefined) return Promise.reject(new Error("no spawner yet"));
      return spawner.spawn(request);
    },
    host,
    systemdRun: WINDOWS ? undefined : SYSTEMD_RUN,
    trueProgram: TRUE,
  };
  const lab = await ShimLab.create(label, {
    adapters,
    ...(options.serviceEnv === undefined ? {} : { serviceEnv: options.serviceEnv }),
    ...(options.environment === undefined ? {} : { launch: { environment: options.environment } }),
  });
  made.lab = lab;
  labs.push(lab);
  const terminalLog = join(lab.root, "terminals.jsonl");
  const systemdLog = join(lab.root, "systemd.jsonl");
  const envFor: Record<string, Record<string, string>> = {};
  for (const [program, env] of Object.entries(terminals)) {
    envFor[program] = { FAKE_TERMINAL_PRODUCT_LENGTH: String(lab.product.length), ...env };
  }
  const spawner = new FakeSpawner({
    programs,
    env: {
      FAKE_TERMINAL_LOG: terminalLog,
      FAKE_SYSTEMD_LOG: systemdLog,
      ...(options.scopeFails === true ? { FAKE_SYSTEMD_FAIL: "1" } : {}),
    },
    envFor,
    ...(options.missing === undefined ? {} : { missing: options.missing }),
    identify: (pids) => startTimes(pids),
  });
  made.spawner = spawner;
  const result: Rig = { lab, spawner, terminalLog, systemdLog };
  rigs.push(result);
  return result;
}

/** A plan whose agent is testkit's fake interactive agent, reporting to `report`. */
function agentPlan(
  lab: ShimLab,
  report: string,
  options: {
    release?: string;
    argv?: readonly string[];
    title?: string;
    folder?: PlanFolder | null;
  } = {},
): SpawnPlan {
  return {
    argv: interactiveAgentArgv({
      report,
      ...(options.release === undefined ? {} : { release: options.release }),
      maxMs: 120_000,
      argv: options.argv ?? [],
    }),
    folder: options.folder === undefined ? lab.labFolder() : options.folder,
    env: {},
    title: options.title ?? "Fixture launch",
    afterExit: "close",
  };
}

/** The terminals the service started (the scope probe left out), as the spawner recorded them. */
const terminalsStarted = (r: Rig) => r.spawner.records.filter((rec) => !rec.argv.includes(TRUE));

/** The ticket a terminal's argv carries: its last element. */
const ticketOf = (argv: readonly string[]): string => argv.at(-1) ?? "";

/** The fake agent's report once it is there. */
async function reportOf(path: string): Promise<InteractiveAgentReport> {
  await waitFor(
    () => {
      try {
        return statSync(path).size > 0 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    LONG_MS,
    "the fake agent's report",
  );
  return JSON.parse(readFileSync(path, "utf8")) as InteractiveAgentReport;
}

function identityOf(path: string): string {
  const found = statSync(path, { bigint: true });
  return `${found.dev.toString()}:${found.ino.toString()}`;
}

describe("[A4.5.terminal.service] the service's terminal adapters, with fake terminals and a real shim", () => {
  test(
    "the fake terminal receives only tasks shim <ticket>; a client that exits 0 at once and whose shim claims after 5 s gives one window and Confirmed",
    { timeout: 300_000 },
    async () => {
      const r = await rig(
        "handoff-late",
        {
          [HANDOFF]: {
            FAKE_TERMINAL_MODE: "handoff",
            FAKE_TERMINAL_EXIT: "0",
            FAKE_TERMINAL_DELAY_MS: "5000",
          },
        },
        {
          serviceEnv: {
            CLAUDECODE: "1",
            CLAUDE_CODE_ENTRYPOINT: "cli",
            NODE_OPTIONS: "--no-warnings",
          },
        },
      );
      // Only the handoff terminal is on this fake machine's chain first: Linux picks it by name.
      const { lab } = r;
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const t0 = performance.now();
      const intent = await lab.open(agentPlan(lab, report, { release }));
      const dispatched = await lab.running.launches.dispatch(lab.spaceId, intent.id);
      // Dispatched at once: the client exited 0 long before its shim's claim.
      expect(dispatched?.state).toBe("dispatched");
      expect(performance.now() - t0).toBeLessThan(5_000);
      // The receipt's words: this fake machine has no default set, so Windows decides
      // (Windows Terminal), and on Linux the first installed is GNOME Terminal.
      expect(dispatched?.evidence).toMatchObject(
        WINDOWS
          ? { terminal: "wt", terminal_source: "windows" }
          : { terminal: "gnome-terminal", terminal_source: "installed" },
      );

      const confirmed = await lab.waitIntent(
        intent.id,
        (i) => i.state === "confirmed",
        "Confirmed",
      );
      r.spawner.trackLogs([r.terminalLog]); // its shim and terminal, alive now
      expect(confirmed.evidence.claim).toMatch(/^claim-/);
      // The claim came after the 5 s.
      const claimedAt = confirmed.evidence.claimed_at ?? 0;
      expect(claimedAt - (dispatched?.at.dispatching ?? claimedAt)).toBeGreaterThanOrEqual(4_900);

      // One terminal, one window: exactly one terminal started, one client and one server.
      const started = terminalsStarted(r);
      expect(started).toHaveLength(1);
      const record = started[0];
      if (record === undefined) throw new Error("no terminal started");
      const ticket = ticketOf(record.argv);
      expect(ticket).toMatch(TICKET);
      const own = WINDOWS
        ? [WT, "-w", "new", "new-tab", "--"]
        : [
            SYSTEMD_RUN,
            "--user",
            "--scope",
            "--collect",
            "--slice=app.slice",
            `--unit=${PRODUCT_ID}-${lab.running.installId}-launch-${intent.id}-1`,
            "--",
            GNOME,
            "--",
          ];
      expect(record.argv).toEqual([...own, ...lab.product, "shim", ticket]);
      expect(record.cwd).toBe(lab.folder);
      // The fake terminal received only `tasks shim <ticket>` after its own fixed flag.
      const log = readJsonLines(r.terminalLog) as {
        role: string;
        event: string;
        argv?: string[];
      }[];
      const starts = log.filter((e) => e.event === "start");
      expect(starts.map((e) => e.role)).toEqual(["client", "server"]);
      for (const start of starts) {
        expect(start.argv).toEqual(
          WINDOWS
            ? ["-w", "new", "new-tab", "--", ...lab.product, "shim", ticket]
            : ["--", ...lab.product, "shim", ticket],
        );
      }
      // The terminal's environment: the service's, scrubbed, with the install's home.
      expect(record.envNames).toContain("TASKS_HOME");
      for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "NODE_OPTIONS"]) {
        expect(record.envNames.map((n) => n.toUpperCase())).not.toContain(name);
      }
      // Neither does the agent get them.
      const seen = await reportOf(report);
      for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "NODE_OPTIONS", "TASKS_HOME"]) {
        expect(seen.envNames.map((n) => n.toUpperCase())).not.toContain(name);
      }
      expect(seen.envNames).toContain("TASKS_TICKET");
      expect(seen.cwdId).toBe(identityOf(lab.folder));

      // The agent ends: the exit is reported, the launch stays Confirmed.
      writeFileSync(release, "");
      const ended = await lab.waitIntent(
        intent.id,
        (i) => i.evidence.exit_code !== undefined,
        "the exit",
      );
      expect(ended).toMatchObject({ state: "confirmed", evidence: { exit_code: 0 } });
      const events = readLog(lab.home).filter((e) => e["ev"] === "launch.terminal");
      expect(events.map((e) => [e["app"], e["kind"], e["result"]])).toEqual([
        [WINDOWS ? "wt" : "gnome-terminal", "handoff", "dispatched"],
      ]);
      // Never a ticket or a path in the log.
      const text = readFileSync(join(lab.home, "state", "logs", "service.log"), "utf8");
      expect(text).not.toContain(ticket);
      expect(text).not.toContain("portal");
    },
  );

  test(
    "a handoff client that exits non-zero is ambiguous: still one window, and its shim's claim confirms",
    { timeout: 300_000 },
    async () => {
      const r = await rig("handoff-nonzero", {
        [HANDOFF]: {
          FAKE_TERMINAL_MODE: "handoff",
          FAKE_TERMINAL_EXIT: "1",
          FAKE_TERMINAL_DELAY_MS: "1000",
        },
      });
      const { lab } = r;
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const intent = await lab.launch(agentPlan(lab, report, { release }));
      await lab.waitIntent(intent.id, (i) => i.state === "confirmed", "Confirmed");
      r.spawner.trackLogs([r.terminalLog]); // its shim and terminal, alive now
      expect(terminalsStarted(r)).toHaveLength(1);
      writeFileSync(release, "");
    },
  );

  test.runIf(!WINDOWS)(
    "a direct terminal that dies at once before any claim: its ticket is revoked and refused, and the next terminal's shim claims",
    { timeout: 300_000 },
    async () => {
      const r = await rig("direct-dies", {
        [GHOSTTY]: { FAKE_TERMINAL_MODE: "exit", FAKE_TERMINAL_EXIT: "1" },
        [GNOME]: { FAKE_TERMINAL_MODE: "handoff", FAKE_TERMINAL_DELAY_MS: "0" },
      });
      const { lab } = r;
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const intent = await lab.launch(agentPlan(lab, report, { release }));
      await lab.waitIntent(intent.id, (i) => i.state === "confirmed", "Confirmed");
      r.spawner.trackLogs([r.terminalLog]); // its shim and terminal, alive now
      const started = terminalsStarted(r);
      expect(started.map((s) => s.argv[7])).toEqual([GHOSTTY, GNOME]);
      const [first, second] = started.map((s) => ticketOf(s.argv));
      expect(first).not.toBe(second);
      expect(started[1]?.argv.at(6)).toBe("--");
      expect(started[0]?.argv[5]).toBe(
        `--unit=${PRODUCT_ID}-${lab.running.installId}-launch-${intent.id}-1`,
      );
      expect(started[1]?.argv[5]).toBe(
        `--unit=${PRODUCT_ID}-${lab.running.installId}-launch-${intent.id}-2`,
      );
      // A late claim with the first ticket is refused, from a live process with its start time.
      const own = (await startTimes([process.pid])).get(process.pid) ?? "";
      const session = await shimSession(lab.home, lab.running.endpoint.path);
      try {
        await expect(
          session.call(
            "launch.claim",
            { ticket: first, role: "shim", pid: process.pid, start_time: own },
            { timeoutMs: 60_000 },
          ),
        ).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof RpcError &&
            (error.data as { data?: { reason?: string } }).data?.reason === REFUSED,
        );
      } finally {
        session.close();
      }
      const events = readLog(lab.home).filter((e) => e["ev"] === "launch.terminal");
      expect(events.map((e) => [e["app"], e["result"], e["code"]])).toEqual([
        ["ghostty", "exited_early", 1],
        ["gnome-terminal", "dispatched", undefined],
      ]);
      writeFileSync(release, "");
    },
  );

  test.runIf(!WINDOWS)(
    "without a working user manager the terminal starts detached in a session of its own, outside any scope",
    { timeout: 300_000 },
    async () => {
      const r = await rig(
        "no-scope",
        { [GNOME]: { FAKE_TERMINAL_MODE: "handoff", FAKE_TERMINAL_DELAY_MS: "0" } },
        { scopeFails: true },
      );
      const { lab } = r;
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const intent = await lab.launch(agentPlan(lab, report, { release }));
      await lab.waitIntent(intent.id, (i) => i.state === "confirmed", "Confirmed");
      r.spawner.trackLogs([r.terminalLog]); // its shim and terminal, alive now
      const started = terminalsStarted(r);
      expect(started).toHaveLength(1);
      expect(started[0]?.argv.slice(0, 2)).toEqual([GNOME, "--"]);
      expect(started[0]?.detached).toBe(true);
      // The probe ran once, and only the probe went to systemd-run.
      const probes = readJsonLines(r.systemdLog) as { argv: string[] }[];
      expect(probes.map((p) => p.argv)).toEqual([
        ["--user", "--scope", "--collect", "--quiet", "--", TRUE],
      ]);
      expect(readLog(lab.home).find((e) => e["ev"] === "launch.terminal")?.["scoped"]).toBe(false);
      writeFileSync(release, "");
    },
  );

  test.runIf(WINDOWS)(
    "Windows: without Windows Terminal the console's starter starts the shim with the product's command from its variables, and it confirms",
    { timeout: 300_000 },
    async () => {
      const r = await rig(
        "console",
        {
          [WT]: { FAKE_TERMINAL_MODE: "handoff" },
          [POWERSHELL]: { FAKE_TERMINAL_MODE: "console" },
        },
        { missing: [WT] },
      );
      const { lab } = r;
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const intent = await lab.launch(agentPlan(lab, report, { release }));
      await lab.waitIntent(intent.id, (i) => i.state === "confirmed", "Confirmed");
      r.spawner.trackLogs([r.terminalLog]); // its shim and terminal, alive now
      const started = terminalsStarted(r);
      expect(started.map((s) => [s.argv[0], s.detached])).toEqual([
        [WT, false],
        [POWERSHELL, false],
      ]);
      const ticket = ticketOf(started[0]?.argv ?? []);
      expect(ticket).toMatch(TICKET);
      // The starter's argv is fixed text: no product path, no ticket, no folder.
      expect(started[1]?.argv.slice(1, -1)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
      ]);
      expect(started[1]?.argv.join("\u0000")).not.toContain(ticket);
      // It started exactly `<product> shim <ticket>`, the ticket the first terminal never used.
      const log = readJsonLines(r.terminalLog) as {
        event: string;
        program?: string;
        arguments?: string;
      }[];
      const consoleStart = log.find((e) => e.event === "console");
      const [program, ...rest] = lab.product;
      expect(consoleStart?.program).toBe(program);
      expect(consoleStart?.arguments).toBe([...rest, "shim", ticket].join(" "));
      const seen = await reportOf(report);
      expect(seen.cwdId).toBe(identityOf(lab.folder));
      for (const pid of started.flatMap((s) => (s.pid === undefined ? [] : [s.pid])))
        r.spawner.track(pid);
      writeFileSync(release, "");
    },
  );
});

/** Hostile values for titles: each must reach the agent's argv exactly or not start it. */
const HOSTILE_TITLES = [
  `Fix "double" and 'single' quotes`,
  "semi;colon & ampersand | pipe > out < in",
  "%PATH% ^caret !bang! %%",
  "$(id) `id` ${HOME} $HOME \\$",
  "--leading-dashes",
  "-e",
  "new\nline\r\nand\ttab",
  "non-ASCII: é ü ß 漢字 🙂 \u202e",
  "trailing backslash \\",
  `"\\"`,
  "",
];

/** Hostile folder names a folder may have on this OS. */
const HOSTILE_FOLDERS = WINDOWS
  ? [
      "it's quoted",
      "with space",
      "semi;colon",
      "percent %PATH% ^caret & amp",
      "dollar $HOME and `id`",
      "-leading-dash",
      "non-ASCII é 漢字 🙂",
      "(paren) [bracket] {brace} !bang",
      "x".repeat(200),
    ]
  : [
      `it's "quoted"`,
      "with space",
      "semi;colon",
      "percent %PATH% ^caret & amp",
      "dollar $HOME and `id` $(id)",
      "-leading-dash",
      "--",
      "non-ASCII é 漢字 🙂",
      "new\nline",
      "back\\slash",
      "x".repeat(250),
    ];

describe("[A4.5.terminal.hostile] hostile titles and folders reach the fake agent byte for byte or are refused", () => {
  test(
    "titles: in the agent's argv exactly, never in a terminal's argv; one too long for the OS is refused before an agent starts",
    { timeout: 300_000 },
    async () => {
      const r = await rig("hostile-titles", {
        [HANDOFF]: { FAKE_TERMINAL_MODE: "handoff", FAKE_TERMINAL_DELAY_MS: "0" },
      });
      const { lab } = r;
      const runs: [LaunchIntent, string, readonly string[]][] = [];
      for (const [i, title] of HOSTILE_TITLES.entries()) {
        const report = join(lab.work, `title-${String(i)}.json`);
        const argv = ["--title", title, title];
        const intent = await lab.launch(
          agentPlan(lab, report, { title, argv }),
          `title-${String(i)}`,
        );
        runs.push([intent, report, argv]);
      }
      // Very long: within one argument's limit on Linux (128 KiB), past Windows' command line.
      const long = `long ${"é".repeat(40_000)}`;
      const longReport = join(lab.work, "title-long.json");
      const longIntent = await lab.launch(
        agentPlan(lab, longReport, { title: long.slice(0, 1_000), argv: [long] }),
        "title-long",
      );
      for (const [intent, report, argv] of runs) {
        const seen = await reportOf(report);
        expect(seen.argv, JSON.stringify(argv)).toEqual(argv);
        expect(seen.cwdId).toBe(identityOf(lab.folder));
        await lab.waitIntent(intent.id, (i) => i.state !== "dispatched", "settled");
      }
      if (WINDOWS) {
        const failed = await lab.waitIntent(longIntent.id, (i) => i.state === "failed", "refused");
        expect(failed.reason).toBe("verify_failed");
        expect(() => statSync(longReport)).toThrow();
      } else {
        expect((await reportOf(longReport)).argv).toEqual([long]);
      }
      // No title, and no part of one, reached a terminal's argv.
      for (const record of terminalsStarted(r)) {
        expect(record.argv.slice(0, -1)).toEqual(
          WINDOWS
            ? [WT, "-w", "new", "new-tab", "--", ...lab.product, "shim"]
            : expect.arrayContaining([GNOME, ...lab.product, "shim"]),
        );
        for (const title of [...HOSTILE_TITLES.filter((t) => t.length > 3), long]) {
          expect(record.argv.join("\u0000")).not.toContain(title);
        }
      }
    },
  );

  test(
    "folders: the agent works in exactly the folder, by path and by identity, or the launch is refused and no agent starts",
    { timeout: 300_000 },
    async () => {
      const r = await rig("hostile-folders", {
        [HANDOFF]: { FAKE_TERMINAL_MODE: "handoff", FAKE_TERMINAL_DELAY_MS: "0" },
      });
      const { lab } = r;
      const outcomes: string[] = [];
      for (const [i, name] of HOSTILE_FOLDERS.entries()) {
        let folder: string;
        try {
          mkdirSync(join(lab.work, name));
          folder = realpathSync.native(join(lab.work, name));
        } catch {
          outcomes.push(`${String(i)}:cannot-exist`);
          continue;
        }
        const report = join(lab.root, `folder-${String(i)}.json`);
        const path = join(lab.work, name);
        const plan = agentPlan(lab, report, { folder: { stored: path, path }, argv: [name] });
        let intent: LaunchIntent;
        try {
          intent = await lab.launch(plan, `folder-${String(i)}`);
        } catch (error) {
          // Refused at the click: the plan's folder holds a control character (the plan check),
          // or the folder cannot be used on this machine. Nothing was made, nothing started.
          if (error instanceof LaunchFolderUnavailable) {
            outcomes.push(`${String(i)}:refused-${error.reason}`);
          } else {
            expect(String(error)).toContain("The spawn plan is not one the shim can start");
            outcomes.push(`${String(i)}:refused-plan`);
          }
          expect(() => statSync(report)).toThrow();
          continue;
        }
        const settled = await lab.waitIntent(
          intent.id,
          (x) => x.state === "failed" || x.evidence.pid !== undefined,
          "the agent's start or the refusal",
        );
        // The fake agent writes its report and ends at once, so on a loaded machine the launch can
        // already be Failed `agent_exited` (an agent that ran for under 3 s) when this looks: that
        // agent did start, and its report is checked below like any other.
        if (settled.state === "failed" && settled.reason !== "agent_exited") {
          // Refused before an agent started: nothing ran anywhere.
          expect(["verify_failed", "refused", "cancelled"]).toContain(settled.reason);
          expect(() => statSync(report)).toThrow();
          outcomes.push(`${String(i)}:failed-${settled.reason ?? ""}`);
          continue;
        }
        const seen = await reportOf(report);
        expect(seen.cwd, name).toBe(folder);
        expect(seen.cwdId, name).toBe(identityOf(folder));
        expect(seen.argv).toEqual([name]);
        outcomes.push(`${String(i)}:exact`);
      }
      // Every name a folder can hold reached the agent exactly. Linux: a newline in a name is a
      // control character no folder holds (the plan check refuses it at the click). Windows: a
      // folder past the OS's limit for a process's working directory starts nothing (Failed
      // refused), or works where the path fits.
      const exact = (from: number, to: number): string[] =>
        Array.from({ length: to - from }, (_, k) => `${String(from + k)}:exact`);
      if (WINDOWS) {
        expect(outcomes.slice(0, 8)).toEqual(exact(0, 8));
        expect(["8:exact", "8:failed-refused", "8:failed-verify_failed"]).toContain(outcomes[8]);
      } else {
        expect(outcomes).toEqual([...exact(0, 8), "8:refused-plan", "9:exact", "10:exact"]);
      }
      // No folder, and no part of one, reached a terminal's argv: only its working directory.
      for (const record of terminalsStarted(r)) {
        for (const name of HOSTILE_FOLDERS.filter((n) => n.length > 2)) {
          expect(record.argv.join("\u0000")).not.toContain(name);
        }
      }
    },
  );
});

/**
 * A person's environment whose login shell, run in a folder, exports FROM_FOLDER and names A4
 * scrubs or only an instance may set. It records the folders and identities it was asked for.
 */
function folderEnvironment(): {
  environment: EnvironmentSource;
  asked: { folder: string; dev: string; ino: string }[];
} {
  const asked: { folder: string; dev: string; ino: string }[] = [];
  const base: AgentBase = { kind: "service", env: { ...process.env } };
  const environment: EnvironmentSource = {
    prepare: () => Promise.resolve(),
    base: () => Promise.resolve(base),
    inFolder: (folder, identity) => {
      asked.push({ folder, dev: identity.dev, ino: identity.ino });
      return Promise.resolve({
        kind: "user",
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          FROM_FOLDER: "1",
          NODE_OPTIONS: "--require /nowhere/profile.js",
          CODEX_HOME: "/nowhere/codex",
          CLAUDECODE: "1",
        },
      });
    },
    session: () => Promise.resolve({}),
  };
  return { environment, asked };
}

describe("[A4.5.environment.login-shell] via_login_shell: a fresh snapshot in the task's folder, and the agent still starts directly", () => {
  test(
    "the dispatch step takes the person's login shell in the resolved folder; the agent starts directly with that environment, scrubbed, and in the checked folder",
    { timeout: 300_000 },
    async () => {
      const { environment, asked } = folderEnvironment();
      const lab = await ShimLab.create("login-shell", { launch: { environment } });
      labs.push(lab);
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const argv = ["--flag", "$(id) `id`"];
      const intent = await lab.launch({
        ...agentPlan(lab, report, { release, argv }),
        loginShell: true,
      });
      await lab.waitIntent(intent.id, (i) => i.state === "confirmed", "Confirmed");
      const seen = await reportOf(report);
      // The agent's own argv, not a shell around it, in exactly the checked folder.
      expect(seen.argv).toEqual(argv);
      expect(seen.cwdId).toBe(identityOf(lab.folder));
      if (WINDOWS) {
        // Windows has no login shell (machine.toml refuses the key): the base applies.
        expect(asked).toEqual([]);
        expect(seen.envNames).not.toContain("FROM_FOLDER");
      } else {
        // Asked once, for the resolved folder and its identity.
        const [dev, ino] = identityOf(lab.folder).split(":");
        expect(asked.map((a) => [a.folder, a.dev, a.ino])).toEqual([[lab.folder, dev, ino]]);
        expect(seen.envNames).toContain("FROM_FOLDER");
        for (const name of ["NODE_OPTIONS", "CODEX_HOME", "CLAUDECODE"]) {
          expect(seen.envNames, name).not.toContain(name);
        }
      }
      writeFileSync(release, "");
    },
  );

  test.runIf(!WINDOWS)(
    "a restart between the dispatch and the claim: the claim takes the folder's snapshot again, never the shared base",
    { timeout: 300_000 },
    async () => {
      const { environment, asked } = folderEnvironment();
      // The terminal's server starts the shim 4 s after its client returned.
      const r = await rig(
        "login-restart",
        { [GNOME]: { FAKE_TERMINAL_MODE: "handoff", FAKE_TERMINAL_DELAY_MS: "4000" } },
        { environment },
      );
      const { lab } = r;
      const report = join(lab.work, "agent-report.json");
      const release = join(lab.work, "release");
      const intent = await lab.launch({ ...agentPlan(lab, report, { release }), loginShell: true });
      expect(asked.map((a) => a.folder)).toEqual([lab.folder]);
      // The service restarts before the shim claims: what the dispatch took is gone with it.
      await lab.stopService();
      await lab.start();
      await lab.waitIntent(intent.id, (i) => i.state === "confirmed", "Confirmed");
      r.spawner.trackLogs([r.terminalLog]); // its shim and terminal, alive now
      const seen = await reportOf(report);
      expect(asked.map((a) => a.folder)).toEqual([lab.folder, lab.folder]);
      expect(seen.envNames).toContain("FROM_FOLDER");
      expect(seen.envNames).not.toContain("NODE_OPTIONS");
      writeFileSync(release, "");
    },
  );
});

describe("[A4.5.terminal.service] the product's command a terminal runs", () => {
  test("the service's own build: its source entry when run from source, else the install's stable launcher, else none", () => {
    const root = mkdtempSync(join(tmpdir(), "tasks-shim-command-"));
    try {
      const platform = process.platform;
      const entry = join(root, "bin.ts");
      writeFileSync(entry, "");
      const node = process.execPath;
      // From source: Node and the entry, even where an install exists.
      expect(
        defaultShimCommand({ commandFolder: join(root, "bin"), platform }, [node, entry], node),
      ).toEqual([node, entry]);
      // Not from source, no install: none, and a terminal launch is refused.
      const bundled = join(root, "entry.mjs");
      expect(
        defaultShimCommand({ commandFolder: join(root, "bin"), platform }, [node, bundled], node),
      ).toBeUndefined();
      // An install: its stable launcher.
      mkdirSync(join(root, "bin"));
      const launcher = join(root, "bin", WINDOWS ? `${PRODUCT_ID}.exe` : PRODUCT_ID);
      writeFileSync(launcher, "");
      expect(
        defaultShimCommand({ commandFolder: join(root, "bin"), platform }, [node, bundled], node),
      ).toEqual([launcher]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
