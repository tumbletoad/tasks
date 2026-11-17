// The launch shim end to end (A7 3.9 M2.08, A4 3.6.3, 3.9.3, A4 5.1 "Shim re-attachment"): a real
// service in this process, `tasks shim <ticket>` as a real child process started the way a
// terminal would, and a fake agent as the shim's child. Fixture data and temporary folders only.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcError } from "@tasks/bridge/protocol";
import {
  BRIDGE_WINDOW_MS,
  CLAIM_WINDOW_MS,
  REFUSED,
  startTimes,
  type PlanFolder,
} from "@tasks/launch";
import type { FakeAgentReport } from "@tasks/runs/fake-agents";
import { readLog, stateOf, waitFor } from "./harness.ts";
import {
  CLI_BIN,
  FAILURE_FIXTURE,
  LONG_MS,
  ShimLab,
  shimEnv,
  shimSession,
  track,
  type LabOptions,
} from "./shim-harness.ts";

const labs: ShimLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.cleanup();
}, 120_000);

async function lab(label: string, options: LabOptions = {}): Promise<ShimLab> {
  const made = await ShimLab.create(label, options);
  labs.push(made);
  return made;
}

/** The names libuv copies into a Windows child's environment from its parent when missing. */
const LIBUV_REQUIRED = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

/** The reason word of a refused call: one word for every refusal. */
async function refusedWith(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof RpcError) {
      const data = error.data as { data?: { reason?: string } } | undefined;
      return data?.data?.reason ?? "no reason";
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("[A4.5.shim.reattach] restart after both ticket windows: reattach, exit report, no second claim", () => {
  test(
    "the shim reattaches, reports its exit, and cannot obtain a second claim",
    { timeout: 300_000 },
    async () => {
      const l = await lab("verify");
      const intent = await l.launch(l.plan());
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      const ticket = l.tickets.get(intent.id) ?? "";

      // The one claim, the agent's start and its settle: Confirmed, with the agent's PID.
      const confirmed = await l.waitIntent(
        intent.id,
        (i) => i.state === "confirmed" && i.evidence.pid !== undefined,
        "the launch confirmed",
      );
      expect(confirmed.evidence.claim).toMatch(/^claim-/);
      expect(confirmed.evidence.folder_checked).toBe(true);
      const held = l.running.launches.host.record(intent.id);
      expect(held?.ticket?.shimUsed).toBe(true);
      expect(held?.attachment?.pid).toBe(shim.pid);

      // Both windows pass while the service is down: 120 s from the ticket's issue (shim role),
      // 15 minutes from the agent's start (bridge role).
      await l.stopService();
      l.skew += BRIDGE_WINDOW_MS + CLAIM_WINDOW_MS + 60_000;
      const service = await l.start();

      // The shim reattaches with its credential: no new claim, an attachment.
      await waitFor(
        () => (readLog(l.home).some((e) => e["ev"] === "launch.attached") ? true : undefined),
        LONG_MS,
        "the shim's reattach",
      );
      expect(readLog(l.home).filter((e) => e["ev"] === "launch.claimed")).toHaveLength(1);

      // No second claim: the ticket again, even from the shim's own live process, and its bridge
      // role, are refused.
      const own = (await startTimes([shim.pid])).get(shim.pid) ?? "";
      const session = await shimSession(l.home, service.endpoint.path);
      try {
        const again = session.call(
          "launch.claim",
          { ticket, role: "shim", pid: shim.pid, start_time: own },
          { timeoutMs: 60_000 },
        );
        expect(await refusedWith(again)).toBe(REFUSED);
      } finally {
        session.close();
      }
      expect(service.launches.host.redeemBridge(ticket)).toBeUndefined();

      // The agent ends: the shim reports its exit through the attachment, and exits with its code.
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });
      const ended = await l.waitIntent(
        intent.id,
        (i) => i.evidence.exit_code !== undefined,
        "the exit report",
      );
      expect(ended.state).toBe("confirmed");
      expect(ended.evidence.exit_code).toBe(0);
      // The credential lived as long as the shim: its machine state goes once the exit is
      // recorded.
      await waitFor(
        () => (service.launches.host.record(intent.id) === undefined ? true : undefined),
        LONG_MS,
        "the launch's machine state removed",
      );

      // Neither secret reaches the log.
      const log = readFileSync(join(stateOf(l.home), "logs", "service.log"), "utf8");
      expect(log).not.toContain(ticket);
      expect(log).toContain("launch.attached");
    },
  );
});

describe("[A4.5.shim.claim] what the service cannot decide yet is no refusal", () => {
  test(
    "while the process table cannot be read the claim is answered as retryable, the ticket stays unspent, and the real shim claims once it can",
    { timeout: 300_000 },
    async () => {
      let unreadable = true;
      const l = await lab("not-yet", {
        launch: {
          probe: {
            startTimes: (pids) =>
              unreadable ? Promise.reject(new Error("fixture")) : startTimes(pids),
          },
        },
      });
      const intent = await l.launch(l.plan());
      const refusedFor = (reason: string): boolean =>
        readLog(l.home).some((e) => e["ev"] === "launch.refused" && e["reason"] === reason);
      await waitFor(() => (refusedFor("check_failed") ? true : undefined), LONG_MS, "a claim");
      expect(l.running.launches.host.record(intent.id)?.ticket?.shimUsed).toBe(false);

      // The OS answers again: the shim's next try claims, once.
      unreadable = false;
      await l.waitIntent(intent.id, (i) => i.state === "confirmed", "the launch confirmed");
      expect(readLog(l.home).filter((e) => e["ev"] === "launch.claimed")).toHaveLength(1);
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });
    },
  );
});

describe("[A4.5.shim.environment] the agent sees exactly the expected environment", () => {
  test(
    "an allow-list of the base, the instance's env and A4's additions, plus the terminal's own TERM; never the shim's or the service's other variables",
    { timeout: 300_000 },
    async () => {
      // The base the service picks from: what a process needs to run on this OS, the home
      // variables a shell may have exported, and names that are on no list.
      const real = (name: string): [string, string][] => {
        const value = Object.entries(process.env).find(
          ([n]) => n.toUpperCase() === name.toUpperCase(),
        );
        return value?.[1] === undefined ? [] : [[value[0], value[1]]];
      };
      const needed =
        process.platform === "win32"
          ? [...LIBUV_REQUIRED, "TMP", "ComSpec", "PATHEXT"]
          : ["PATH", "HOME"];
      const base: Record<string, string> = {
        ...Object.fromEntries(needed.flatMap(real)),
        CODEX_HOME: "/inherited/codex",
        CLAUDE_CONFIG_DIR: "/inherited/claude",
        TASKS_HOME: "/inherited/tasks",
        FIXTURE_NOT_LISTED: "1",
        NODE_OPTIONS: "--no-warnings",
      };
      const l = await lab("env", {
        launch: { baseEnv: () => base },
        shimEnv: { TERM: "xterm-fixture", FIXTURE_SHIM_ONLY: "1" },
      });
      const report = join(l.work, "agent-report.json");
      const intent = await l.launch(
        l.plan({ report, env: { CODEX_HOME: join(l.work, "codex-home"), FIXTURE_INSTANCE: "1" } }),
      );
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      await l.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });

      const seen = (JSON.parse(readFileSync(report, "utf8")) as { envNames: string[] }).envNames;
      const fold = (name: string): string =>
        process.platform === "win32" ? name.toUpperCase() : name;
      const expected = new Set(
        [
          ...needed.flatMap(real).map(([name]) => name),
          // Windows: each name libuv would fill from the shim, named even when empty.
          ...(process.platform === "win32" ? LIBUV_REQUIRED : []),
          "CODEX_HOME",
          "FIXTURE_INSTANCE",
          "TASKS_TICKET",
          "TASKS_TASK",
          "TASKS_SPACE",
          "TERM",
        ].map(fold),
      );
      expect(
        seen
          .filter((name) => !name.startsWith("="))
          .map(fold)
          .sort(),
      ).toEqual([...expected].sort());
    },
  );
});

/** A directory's identity as the fake agent reports its own: `<dev>:<ino>`. */
function identityOf(path: string): string {
  const found = statSync(path, { bigint: true });
  return `${found.dev.toString()}:${found.ino.toString()}`;
}

/** The fake agent's report, once its stdin ended. */
const reportOf = (path: string): FakeAgentReport =>
  JSON.parse(readFileSync(path, "utf8")) as FakeAgentReport;

describe("[A4.5.shim.folder] the folder: resolved right before the launch, checked by the shim inside it", () => {
  test(
    "an unchanged folder starts the agent in exactly that directory, which the terminal started in",
    { timeout: 300_000 },
    async () => {
      const l = await lab("folder-same");
      const report = join(l.work, "agent-report.json");
      const intent = await l.launch(l.plan({ report }));
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      await l.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
      // The terminal started in the folder's real path, as the service resolved it right before
      // the launch, and machine state keeps that folder with its check.
      expect(l.folders.get(intent.id)).toBe(l.folder);
      const held = l.running.launches.host.record(intent.id);
      expect(held?.folder?.path).toBe(l.folder);
      expect(held?.folder?.check).toMatchObject({ depth: 0 });
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });
      // The agent started in the very directory that was resolved: by identity, not by path.
      expect(reportOf(report).cwdId).toBe(identityOf(l.folder));
    },
  );

  test(
    "a folder swapped for another directory between the resolve and the shim's start is refused with the reason, and no agent starts",
    { timeout: 300_000 },
    async () => {
      const l = await lab("folder-swap", {
        // After the resolve, before the shim: the folder's path now names another directory.
        beforeShim: (folder) => {
          renameSync(folder, `${folder}-before`);
          mkdirSync(folder);
        },
      });
      const report = join(l.work, "agent-report.json");
      const intent = await l.launch(l.plan({ report }));
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      const failed = await l.waitIntent(intent.id, (i) => i.state === "failed", "the failure");
      expect(failed.reason).toBe("verify_failed");
      expect(failed.evidence.pid).toBeUndefined();
      shim.endInput(); // Enter, for the line the person reads
      expect((await l.shimExit(shim)).code).toBe(1);
      expect(shim.stderr()).toContain("(folder_changed). This launch did not start.");
      // No agent ran: it would have written its report once its stdin ended.
      expect(existsSync(report)).toBe(false);
      await waitFor(
        () =>
          readLog(l.home).some(
            (e) =>
              e["ev"] === "launch.folder_refused" &&
              e["stage"] === "shim" &&
              e["reason"] === "folder_changed",
          )
            ? true
            : undefined,
        LONG_MS,
        "the reason in the log",
      );
    },
  );

  test(
    "a folder that is not there or is a file refuses the click with its reason; one removed before the launch fails it before anything starts",
    { timeout: 300_000 },
    async () => {
      const l = await lab("folder-gone");
      const missing = join(l.work, "not-there");
      const file = join(l.work, "notes.txt");
      writeFileSync(file, "fixture\n");
      const unavailable: [PlanFolder, string][] = [
        [{ stored: missing, path: missing }, "path_missing"],
        [{ stored: file, path: file }, "not_a_directory"],
      ];
      for (const [folder, reason] of unavailable) {
        await expect(l.open(l.plan({ folder })), reason).rejects.toMatchObject({
          name: "LaunchFolderUnavailable",
          reason,
          folder: folder.stored,
        });
      }
      // A background run checks the same folder before it starts: there, a work folder, not there,
      // a file, or only on another machine, which is never this machine's work folder.
      const usable = (folder: Parameters<typeof l.running.launches.folderUsable>[1]) =>
        l.running.launches.folderUsable(l.spaceId, folder);
      expect(await usable({ kind: "task", path: l.folder })).toBe(true);
      expect(await usable({ kind: "none" })).toBe(true);
      expect(await usable({ kind: "project", path: missing })).toBe(false);
      expect(await usable({ kind: "task", path: file })).toBe(false);
      expect(await usable({ kind: "other_machine", machine: "mira-laptop" })).toBe(false);

      // It resolves at the click; its folder goes before the person confirms.
      const intent = await l.open(l.plan());
      renameSync(l.folder, `${l.folder}-moved`);
      const after = await l.running.launches.dispatch(l.spaceId, intent.id);
      expect(after).toMatchObject({ state: "failed", reason: "cancelled" });
      // No ticket, no terminal, no shim, and nothing left in machine state.
      expect(l.tickets.size).toBe(0);
      expect(l.shims).toEqual([]);
      expect(l.running.launches.host.record(intent.id)).toBeUndefined();
      const refused = readLog(l.home).filter((e) => e["ev"] === "launch.folder_refused");
      expect(refused.map((e) => [e["stage"], e["reason"]])).toEqual([
        ["open", "path_missing"],
        ["open", "not_a_directory"],
        ["dispatch", "path_missing"],
      ]);
    },
  );

  test(
    "a task with no folder works in the space's work folder, made user-only on first use and checked",
    { timeout: 300_000 },
    async () => {
      const l = await lab("work-folder");
      const report = join(l.work, "agent-report.json");
      const intent = await l.launch(l.plan({ report, folder: null }));
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      await l.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
      const workdirs = join(stateOf(l.home), "workdirs");
      const folder = realpathSync.native(join(workdirs, `space-${l.spaceId}`));
      expect(l.folders.get(intent.id)).toBe(folder);
      // Below the machine state folder, by identity.
      expect(l.running.launches.host.record(intent.id)?.folder?.check).toMatchObject({ depth: 2 });
      if (process.platform !== "win32") {
        expect(statSync(workdirs).mode & 0o777).toBe(0o700);
        expect(statSync(folder).mode & 0o777).toBe(0o700);
      }
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });
      expect(reportOf(report).cwdId).toBe(identityOf(folder));
    },
  );
});

describe("[A4.5.launch.open-replay] a repeated Open request returns its intent, whatever its folder did meanwhile", () => {
  test(
    "the same request ID replays the original intent although the folder went; a new request is checked before any intent; a replay never makes machine state again",
    { timeout: 300_000 },
    async () => {
      const l = await lab("open-replay");
      const click = {
        task: l.taskId,
        instance: "fixture-agent",
        route: "terminal" as const,
        place: null,
        taskVersion: 1,
        briefHash: "b".repeat(64),
      };
      const request = "open-replay-request-000001";
      const first = await l.running.launches.open(l.spaceId, click, request, l.plan());
      // Open succeeded, its reply was lost, and the folder went before the caller tried again.
      renameSync(l.folder, `${l.folder}-moved`);
      const again = await l.running.launches.open(l.spaceId, click, request, l.plan());
      expect(again.id).toBe(first.id);
      expect(again.state).toBe("prepared");
      expect(l.running.launches.host.record(first.id)?.plan.folder).toEqual(l.labFolder());
      // The same request ID with another click is the store's refusal, not the folder's.
      await expect(
        l.running.launches.open(l.spaceId, { ...click, taskVersion: 2 }, request, l.plan()),
      ).rejects.toMatchObject({ name: "ExecutionRefused", code: "request_id_reused" });
      // A new request is checked first: refused with the reason, and no intent is made for it.
      await expect(
        l.running.launches.open(l.spaceId, click, "open-replay-request-000002", l.plan()),
      ).rejects.toMatchObject({ name: "LaunchFolderUnavailable", reason: "path_missing" });
      // The confirmation fails it before anything starts; its machine state goes, and a replay of
      // its Open returns it as it is now without making any again.
      const after = await l.running.launches.dispatch(l.spaceId, first.id);
      expect(after).toMatchObject({ state: "failed", reason: "cancelled" });
      const late = await l.running.launches.open(l.spaceId, click, request, l.plan());
      expect(late).toMatchObject({ id: first.id, state: "failed" });
      expect(l.running.launches.host.record(first.id)).toBeUndefined();
      const refused = readLog(l.home).filter((e) => e["ev"] === "launch.folder_refused");
      expect(refused.map((e) => [e["stage"], e["reason"]])).toEqual([
        ["open", "path_missing"],
        ["dispatch", "path_missing"],
      ]);
    },
  );
});

describe("[A4.5.shim.client] the shim's own steps", () => {
  test(
    "an executable that is not there fails verify: no agent, launch.failed, one line, exit 1",
    { timeout: 300_000 },
    async () => {
      const l = await lab("verify-fail");
      const plan = l.plan();
      const missing = join(l.work, process.platform === "win32" ? "not-there.exe" : "not-there");
      const intent = await l.launch({ ...plan, argv: [missing, ...plan.argv.slice(1)] });
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      const failed = await l.waitIntent(intent.id, (i) => i.state === "failed", "the failure");
      expect(failed.reason).toBe("verify_failed");
      expect(failed.evidence.pid).toBeUndefined();
      shim.endInput(); // Enter, for the line the person reads
      expect((await l.shimExit(shim)).code).toBe(1);
      expect(shim.stderr()).toContain("The agent's program is not where it should be.");
      await waitFor(
        () => (l.running.launches.host.record(intent.id) === undefined ? true : undefined),
        LONG_MS,
        "the launch's machine state removed",
      );
    },
  );

  test(
    "an agent that ends at once fails its launch, and the shim exits with the agent's code",
    { timeout: 300_000 },
    async () => {
      const l = await lab("exit-code");
      const intent = await l.launch(l.plan({ fixture: FAILURE_FIXTURE }));
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 1, signal: null });
      const failed = await l.waitIntent(intent.id, (i) => i.state === "failed", "the failure");
      expect(failed).toMatchObject({ reason: "agent_exited", evidence: { exit_code: 1 } });
    },
  );

  test(
    "with the service down at the agent's end, the shim writes exit.json, which the service settles when it is back",
    { timeout: 300_000 },
    async () => {
      const l = await lab("exit-json");
      const intent = await l.launch(l.plan());
      const shim = l.shims[0];
      if (shim === undefined) throw new Error("no shim was started");
      const ticket = l.tickets.get(intent.id) ?? "";
      await l.waitIntent(intent.id, (i) => i.state === "confirmed", "the launch confirmed");
      if (process.platform === "linux") {
        // The title replaced the argv area: the ticket no longer shows in the process listing.
        const cmdline = readFileSync(`/proc/${String(shim.pid)}/cmdline`, "utf8");
        expect(cmdline).not.toContain(ticket);
      }
      await l.stopService();
      shim.endInput();
      expect(await l.shimExit(shim)).toEqual({ code: 0, signal: null });
      const service = await l.start();
      const ended = await l.waitIntent(
        intent.id,
        (i) => i.evidence.exit_code !== undefined,
        "exit.json collected",
      );
      expect(ended).toMatchObject({ state: "confirmed", evidence: { exit_code: 0 } });
      await waitFor(
        () => (service.launches.host.record(intent.id) === undefined ? true : undefined),
        LONG_MS,
        "the launch folder removed",
      );
    },
  );

  test(
    "a ticket nobody issued is refused with one line; a bad argument exits 2 and is never repeated",
    { timeout: 300_000 },
    async () => {
      const l = await lab("refused");
      const stray = track(
        spawn(process.execPath, [CLI_BIN, "shim", "0".repeat(24)], {
          env: shimEnv(l.home),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }),
      );
      l.shims.push(stray);
      await waitFor(
        () => (stray.stderr().includes("This launch expired.") ? true : undefined),
        LONG_MS,
        "the refusal",
      );
      stray.endInput();
      expect((await l.shimExit(stray)).code).toBe(1);

      for (const args of [[], ["not-a-ticket"], ["0".repeat(24), "extra"]]) {
        const bad = track(
          spawn(process.execPath, [CLI_BIN, "shim", ...args], {
            env: shimEnv(l.home),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        );
        l.shims.push(bad);
        expect((await l.shimExit(bad)).code, args.join(" ")).toBe(2);
        expect(bad.stderr()).toMatch(/usage: tasks shim <ticket>/);
        expect(bad.stderr()).not.toContain("not-a-ticket");
        expect(bad.stdout()).toBe("");
      }
    },
  );
});
