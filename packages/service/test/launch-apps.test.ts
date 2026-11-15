// Open in the best-effort apps through the service (A4 3.4.4, 3.4.5, 3.9.2; A7 3.14 M6.11): a
// person's `launch.open` on a Claude Desktop or Codex app instance, the hub's launch machine, the
// link opened through a recording spawner (no real opener runs, no app starts), and the bridge's
// binding through the launch reference as an agent's MCP connection makes it, in this process. The
// receipt waits for the bridge's folder check: only a bridge working in the link's folder confirms
// the launch. Fixture data and temporary folders only.
import { mkdirSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { JsonObject, RpcSession } from "@tasks/bridge/protocol";
import { renderBrief, type SpawnRequest, type SpawnedProcess } from "@tasks/launch";
import { bridgePrincipal, clientOf } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { briefNames } from "../src/launch/open.ts";
import { instanceToml, readLog, tempRoot } from "./harness.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome } from "./ops-helpers.ts";
import { LAB_ROOT, ShimLab } from "./shim-harness.ts";

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

/** A spawner that starts nothing: the opener "ran" and exited 0. */
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

async function addTask(
  r: Rig,
  title: string,
  folder: string,
): Promise<{ id: string; ref: string }> {
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  const added = (await r.user.call(
    "op/call",
    {
      space: r.lab.spaceId,
      op: "task.add",
      input: { tasks: [{ title, place: { root: LAB_ROOT, path: folder } }], request_id: rid() },
    },
    { timeoutMs: 60_000 },
  )) as { tasks: { id: string; ref: string }[] };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  return task;
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

/** An agent's MCP connection working in `cwd`, bound as the endpoint binds one, and its get_task. */
async function agentIn(r: Rig, cwd: string) {
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
  return {
    getTask: async (launch: string) =>
      (await opCall(r.lab.running.ops, caller, { op: "task.get", input: { launch } })) as {
        bound: boolean;
      },
    close: () => {
      r.lab.running.bindings.closed(slot);
    },
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
          title: "Fix appointment time zones",
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

        // A session that started in another folder (a scratch workspace): the binding holds, the
        // launch stays Dispatched ("Opened · not confirmed").
        const elsewhere = await agentIn(r, realpathSync.native(join(r.lab.work, "elsewhere")));
        expect((await elsewhere.getTask(result.launch.reference)).bound).toBe(true);
        const after = await r.lab.running.launches.read(r.lab.spaceId, result.launch.id);
        expect(after?.state).toBe("dispatched");
        expect(after?.evidence.bound_at).toBeTypeOf("number");
        elsewhere.close();

        // A launch of another task in the same folder (a second click on the first would return
        // the first launch, A4 3.9.1), whose bridge works in the link's folder: Confirmed.
        const second = await open(r, { task: twin.ref, instance });
        await r.lab.waitIntent(second.launch.id, (i) => i.state === "dispatched", "Dispatched");
        const here = await agentIn(r, folder);
        expect((await here.getTask(second.launch.reference)).bound).toBe(true);
        const confirmed = await r.lab.running.launches.read(r.lab.spaceId, second.launch.id);
        expect(confirmed?.state).toBe("confirmed");
        here.close();

        // A bridge that names no folder confirms nothing either.
        const third = await open(r, { task: other.ref, instance });
        await r.lab.waitIntent(third.launch.id, (i) => i.state === "dispatched", "Dispatched");
        const nowhere = await agentIn(r, null as unknown as string);
        expect((await nowhere.getTask(third.launch.reference)).bound).toBe(true);
        expect((await r.lab.running.launches.read(r.lab.spaceId, third.launch.id))?.state).toBe(
          "dispatched",
        );
        nowhere.close();

        const checks = readLog(r.lab.home).filter((e) => e["ev"] === "launch.folder_check");
        expect(checks.map((e) => e["result"])).toEqual(["other", "same", "unknown"]);
      },
    );
  }

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
          `TT Tasks context pack for task ${task.ref} (launch ${result.launch.reference})`,
        ),
      ).toBe(true);
      expect(pack).toContain("From the user, for agents:");
      expect(pack).toContain("Don't touch the reminders service.");
      expect(pack).toContain(`Folder: ${LAB_ROOT} › ${FOLDER}`);
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
    },
  );
});
