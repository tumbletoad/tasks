// Open in the best-effort apps through the service (A4 3.4.4, 3.4.5, 3.9.2; A7 3.14 M6.11): a
// person's `launch.open` on a Claude Desktop or Codex app instance, the hub's launch machine, the
// link opened through a recording spawner (no real opener runs, no app starts), and the bridge's
// binding through the launch reference as an agent's MCP connection makes it, in this process. The
// receipt waits for the bridge's folder check: only a bridge working in the link's folder confirms
// the launch. Fixture data and temporary folders only.
import { mkdirSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RpcSession } from "@ttasks/bridge/protocol";
import {
  briefReference,
  PACK_CEILING,
  renderBrief,
  type SpawnRequest,
  type SpawnedProcess,
} from "@ttasks/launch";
import { briefNames } from "../src/launch/open.ts";
import { bridge } from "./agents.ts";
import { instanceToml, readLog, tempRoot } from "./harness.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome } from "./ops-helpers.ts";
import { ShimLab } from "./shim-harness.ts";

const WINDOWS = process.platform === "win32";
/** A folder name with what a URL or a shell would read. */
const FOLDER = "R&D #2 (50%+) Café";

const labs: ShimLab[] = [];
const sessions: RpcSession[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const lab of labs.splice(0)) await lab.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
}, 120_000);

const opened: SpawnRequest[] = [];
/** While set, the opener "runs" until the test releases it: an app may start before it exits. */
let held: Promise<void> | undefined;

/**
 * The question whether this machine can start a program in a scope of its own (it can where a
 * user systemd runs, as on CI's Linux): asked through the same spawner, answered, and no opener.
 */
const scopeProbe = (request: SpawnRequest): boolean =>
  /systemd-run$/u.test(request.argv[0] ?? "") && request.argv.includes("--quiet");

/** A spawner that starts nothing: the opener "ran" and exited 0, once released when held. */
const recordingSpawner = (request: SpawnRequest): Promise<SpawnedProcess> => {
  if (scopeProbe(request)) {
    return Promise.resolve({
      pid: 1,
      exited: Promise.resolve({ code: 0, signal: null }),
      stop: () => undefined,
    });
  }
  opened.push(request);
  const gate = held;
  return Promise.resolve({
    pid: 1,
    exited: (gate ?? Promise.resolve()).then(() => ({ code: 0, signal: null })),
    stop: () => undefined,
  });
};

interface Rig {
  readonly lab: ShimLab;
  readonly user: RpcSession;
}

async function rig(label: string): Promise<Rig> {
  // The opener on Linux needs a desktop session and a `gio` on the PATH: a file of the test's own,
  // which the recording spawner never runs.
  const bin = tempRoot(`${label}-bin`);
  cleanups.push(bin.cleanup);
  if (!WINDOWS) {
    writeFileSync(join(bin.root, "gio"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin.root, "gio"), 0o755);
  }
  const lab = await ShimLab.create(label, {
    toml: () =>
      [
        instanceToml({ id: "desktop", target: "claude-desktop", label: "Claude Desktop · test" }),
        instanceToml({ id: "codex-app", target: "codex-app", label: "Codex app · test" }),
        // Claude Code's own link (`claude-cli://`), which asks for no folder check.
        instanceToml({
          id: "claude-link",
          target: "claude-cli",
          label: "Claude link · test",
          prompt: "prefill",
        }),
      ].join(""),
    launch: { terminals: { spawn: recordingSpawner } },
    ...(WINDOWS
      ? {}
      : { serviceEnv: { DISPLAY: ":0", PATH: `${bin.root}:${process.env["PATH"] ?? ""}` } }),
  });
  labs.push(lab);
  const user = await classSession(lab.home, lab.running.endpoint.path, "cli-interactive");
  sessions.push(user);
  // The agent home the bridge's connection names, registered for the space as setup does.
  await grantHome(lab.home, lab.running.endpoint.path, {
    instance: "app-agent",
    space: lab.spaceId,
  });
  return { lab, user };
}

let requests = 0;
const rid = (): string => `apps-request-${String((requests += 1)).padStart(6, "0")}`;

/** Adds a task with its own folder `<work>/<folder>` (made first), and that folder as stored. */
async function addTask(
  r: Rig,
  title: string,
  folder: string,
): Promise<{ id: string; ref: string; folder: string }> {
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  const call = (op: string, input: Record<string, unknown>) =>
    r.user.call(
      "op/call",
      { space: r.lab.spaceId, op, input: { ...input, request_id: rid() } },
      { timeoutMs: 60_000 },
    );
  const added = (await call("task.add", { tasks: [{ title }] })) as {
    tasks: { id: string; ref: string }[];
  };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  const set = (await call("folder.manage", {
    action: "set",
    task: task.ref,
    folder: join(r.lab.work, folder),
  })) as { folder: string };
  return { ...task, folder: set.folder };
}

interface Opened {
  readonly launch: { id: string; reference: string; state: string; route: string };
  readonly copy?: string;
}

const open = async (r: Rig, input: Record<string, unknown>): Promise<Opened> =>
  (await r.user.call(
    "op/call",
    { space: r.lab.spaceId, op: "launch.open", input: { ...input, request_id: rid() } },
    { timeoutMs: 60_000 },
  )) as Opened;

/** An agent's MCP connection working in `cwd`, as an app's bridge makes it, and its get_task. */
async function agentIn(r: Rig, cwd: string) {
  const served = { service: r.lab.running, home: r.lab.home, path: r.lab.running.endpoint.path };
  const agent = await bridge(
    served,
    bridgeContext({ space: r.lab.spaceId, instance: "app-agent", cwd }),
  );
  return {
    /** Whether the read by the launch's reference gave the task, to a connection that is no session. */
    getTask: async (launch: string) => ({
      read: (await agent.call("task.get", { launch })).includes("act on it: this connection"),
    }),
    close: () => agent.close(),
  };
}

const keyOf = (folder: string): string => {
  const found = statSync(folder, { bigint: true });
  return `${found.dev.toString()}:${found.ino.toString()}`;
};

describe("[A4.5.routes.apps] Open in Claude Desktop and the Codex app: the link, the brief to copy, and receipts that wait for the bridge's folder check", () => {
  for (const [instance, scheme, folderKey, briefKey] of [
    ["desktop", "claude://code/new?folder=", "folder", "q"],
    ["codex-app", "codex://threads/new?path=", "path", "prompt"],
  ] as const) {
    test(
      `${instance}: the link with the resolved folder and the prefilled brief, the same brief to copy, Dispatched with the folder's identity; only a bridge in that folder confirms`,
      { timeout: 300_000 },
      async () => {
        opened.length = 0;
        const r = await rig(`apps-${instance}`);
        const task = await addTask(r, "Fix appointment time zones", FOLDER);
        const twin = await addTask(r, "Fix appointment time zones again", FOLDER);
        const other = await addTask(r, "Another task", "elsewhere");
        const folder = realpathSync.native(join(r.lab.work, FOLDER));
        const result = await open(r, { task: task.ref, instance });
        expect(result.launch.route).toBe("link");
        const brief = renderBrief({
          kind: "prefilled",
          task: task.ref,
          space: r.lab.spaceId,
          reference: result.launch.reference,
          budget: 2_000,
          names: briefNames(),
        });
        if (brief.status !== "ok") throw new Error("no brief");
        // The brief goes on the clipboard too, because the app may drop the prefill.
        expect(result.copy).toBe(brief.text);
        const dispatched = await r.lab.waitIntent(
          result.launch.id,
          (i) => i.state === "dispatched",
          "Dispatched",
        );
        expect(dispatched.evidence.folder_id).toBe(keyOf(folder));
        expect(opened).toHaveLength(1);
        const url = opened[0]?.argv.at(-1) ?? "";
        expect(url.startsWith(scheme)).toBe(true);
        const query = new URL(url).searchParams;
        expect([...query.keys()]).toEqual([folderKey, briefKey]);
        expect(query.get(folderKey)).toBe(folder);
        expect(query.get(briefKey)).toBe(brief.text);

        // A session that started in another folder (a scratch workspace): it reads the task, the
        // read is recorded, and the launch stays Dispatched ("Opened · not confirmed").
        const elsewhere = await agentIn(r, realpathSync.native(join(r.lab.work, "elsewhere")));
        expect((await elsewhere.getTask(result.launch.reference)).read).toBe(true);
        const after = await r.lab.running.launches.read(r.lab.spaceId, result.launch.id);
        expect(after?.state).toBe("dispatched");
        expect(after?.evidence.bound_at).toBeTypeOf("number");
        await elsewhere.close();

        // A launch of another task in the same folder, whose bridge works in the link's folder:
        // Confirmed.
        const second = await open(r, { task: twin.ref, instance });
        await r.lab.waitIntent(second.launch.id, (i) => i.state === "dispatched", "Dispatched");
        const here = await agentIn(r, folder);
        expect((await here.getTask(second.launch.reference)).read).toBe(true);
        const confirmed = await r.lab.running.launches.read(r.lab.spaceId, second.launch.id);
        expect(confirmed?.state).toBe("confirmed");
        await here.close();

        // A bridge that names no folder confirms nothing either.
        const third = await open(r, { task: other.ref, instance });
        await r.lab.waitIntent(third.launch.id, (i) => i.state === "dispatched", "Dispatched");
        const nowhere = await agentIn(r, null as unknown as string);
        expect((await nowhere.getTask(third.launch.reference)).read).toBe(true);
        expect((await r.lab.running.launches.read(r.lab.spaceId, third.launch.id))?.state).toBe(
          "dispatched",
        );
        await nowhere.close();

        const checks = readLog(r.lab.home).filter((e) => e["ev"] === "launch.folder_check");
        expect(checks.map((e) => e["result"])).toEqual(["other", "same", "unknown"]);
      },
    );
  }

  test(
    "an agent that reads the launch while the opener still runs is decided after the dispatch recorded the folder: Confirmed from the link's folder",
    { timeout: 300_000 },
    async () => {
      opened.length = 0;
      const r = await rig("apps-early");
      const task = await addTask(r, "Fix appointment time zones", FOLDER);
      const folder = realpathSync.native(join(r.lab.work, FOLDER));
      let release: () => void = () => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const opening = open(r, { task: task.ref, instance: "desktop" });
        // The opener runs: the app has the link, and its agent reads the task before the opener exits.
        for (let i = 0; opened.length === 0 && i < 3_000; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const url = opened[0]?.argv.at(-1) ?? "";
        const reference = briefReference(new URL(url).searchParams.get("q") ?? "") ?? "";
        expect(reference).not.toBe("");
        const here = await agentIn(r, folder);
        const bound = here.getTask(reference);
        // Whether the read's mark is queued before the opener exits or after, it is decided
        // on the record the dispatch left.
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();
        expect((await bound).read).toBe(true);
        const result = await opening;
        const after = await r.lab.running.launches.read(r.lab.spaceId, result.launch.id);
        expect(after?.evidence.folder_id).toBe(keyOf(folder));
        expect(after?.state).toBe("confirmed");
        await here.close();
        const checks = readLog(r.lab.home).filter((e) => e["ev"] === "launch.folder_check");
        expect(checks.map((e) => e["result"])).toEqual(["same"]);
      } finally {
        held = undefined;
        release();
      }
    },
  );

  test(
    "a link launch whose record holds a folder identity is checked whatever its instance is now; Claude Code's own link is not",
    { timeout: 300_000 },
    async () => {
      const r = await rig("apps-retarget");
      const first = await addTask(r, "First task", FOLDER);
      const second = await addTask(r, "Second task", FOLDER);
      mkdirSync(join(r.lab.work, "elsewhere"), { recursive: true });
      const folder = realpathSync.native(join(r.lab.work, FOLDER));
      const elsewhere = realpathSync.native(join(r.lab.work, "elsewhere"));

      // `claude-cli://`: an agent's read by the reference confirms it, from any folder.
      const plain = await open(r, { task: first.ref, instance: "claude-link" });
      expect(plain.launch.route).toBe("link");
      await r.lab.waitIntent(plain.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const one = await agentIn(r, elsewhere);
      expect((await one.getTask(plain.launch.reference)).read).toBe(true);
      expect((await r.lab.running.launches.read(r.lab.spaceId, plain.launch.id))?.state).toBe(
        "confirmed",
      );
      await one.close();

      // A record as a best-effort app's link leaves it (its folder's identity), under an instance
      // ID that machine.toml now gives another target: the check still applies.
      const marked = await open(r, { task: second.ref, instance: "claude-link" });
      await r.lab.waitIntent(marked.launch.id, (i) => i.state === "dispatched", "Dispatched");
      const machine = await r.lab.running.launches.machine(r.lab.spaceId);
      await machine?.report(marked.launch.id, {
        kind: "evidence",
        evidence: { folder_id: keyOf(folder) },
      });
      const two = await agentIn(r, elsewhere);
      expect((await two.getTask(marked.launch.reference)).read).toBe(true);
      expect((await r.lab.running.launches.read(r.lab.spaceId, marked.launch.id))?.state).toBe(
        "dispatched",
      );
      await two.close();
    },
  );

  test(
    "Shift+Copy: the context pack in place of the pointer brief, as a Copy launch; with an instance it is refused",
    { timeout: 300_000 },
    async () => {
      const r = await rig("apps-pack");
      const task = await addTask(r, "Fix appointment time zones", FOLDER);
      await r.user.call(
        "op/call",
        {
          space: r.lab.spaceId,
          op: "entry.add",
          input: {
            task: task.ref,
            kind: "note",
            text: "Don't touch the reminders service.",
            for_agents: true,
            request_id: rid(),
          },
        },
        { timeoutMs: 60_000 },
      );
      const result = await open(r, { task: task.ref, pack: true });
      expect(result.launch).toMatchObject({ route: "clipboard", state: "dispatched" });
      const pack = result.copy ?? "";
      expect(
        pack.startsWith(
          `TTasks context pack for task ${task.ref} (launch ${result.launch.reference})`,
        ),
      ).toBe(true);
      expect(pack).toContain("From the user, for agents:");
      expect(pack).toContain("Don't touch the reminders service.");
      expect(pack).toContain(`Folder: ${task.folder}`);
      expect(pack).toContain(`launch: ${result.launch.reference}`);
      expect(pack.length).toBeLessThanOrEqual(8_000);
      let refused: unknown;
      try {
        await open(r, { task: task.ref, instance: "desktop", pack: true });
      } catch (error) {
        refused = errorOf(error);
      }
      expect(refused).toMatchObject({
        code: "invalid_input",
        data: { issues: [{ path: "pack" }] },
      });

      // Long notes for agents, far past the budget: the pack keeps them whole and still comes
      // back, the oldest left out whole only past the ceiling.
      const long = await addTask(r, "A task with long notes", FOLDER);
      const note = (i: number) => `Long note ${String(i)}: ${"keep every word ".repeat(3_700)}end.`;
      for (let i = 1; i <= 4; i += 1) {
        await r.user.call(
          "op/call",
          {
            space: r.lab.spaceId,
            op: "entry.add",
            input: {
              task: long.ref,
              kind: "note",
              text: note(i),
              for_agents: true,
              request_id: rid(),
            },
          },
          { timeoutMs: 60_000 },
        );
      }
      const big = (await open(r, { task: long.ref, pack: true })).copy ?? "";
      expect(big.length).toBeGreaterThan(40_000);
      expect(big.length).toBeLessThanOrEqual(PACK_CEILING);
      expect(big).toContain(note(4));
      expect(big).toContain(note(3));
      expect(big).not.toContain("Long note 1:");
      expect(big).toMatch(/- \d+ more notes? for agents: ask me for them\./u);
    },
  );
});
