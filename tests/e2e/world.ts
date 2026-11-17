// One end-to-end world: a real service process (tests/e2e/serve-entry.ts) in a temporary
// TASKS_HOME, serving the page's build on a loopback port the OS assigns, with two spaces of
// fixture data: the seeded Mira sample (areas, projects, tasks) and an empty "Studio" with one
// task. Sign-in goes the way `tasks open` goes: a code from `ui/mint_code` over the socket, in the
// URL's fragment. The fake agent writes through the socket as an agent does (class `cli-agent`).
// Fixture data only. Tests only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcSession } from "../../packages/bridge/src/protocol/index.ts";
import { openSpace } from "../../packages/storage/src/index.ts";
import {
  registerSpaces,
  removeRuntimeDir,
  Services,
  stateOf,
  tempRoot,
  waitReady,
  within,
  type ServiceJson,
} from "../../packages/service/test/harness.ts";
import { post } from "../../packages/service/test/http-client.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import { checkedDriver, seedMira } from "../../packages/testkit/src/index.ts";
import { addBulkTasks, addFinishedTasks, type FinishedCounts } from "./bulk.ts";
import { FAKE_INSTANCE_TOML, type TerminalCall } from "./fake-terminal.ts";

const ENTRY = fileURLToPath(new URL("./serve-entry.ts", import.meta.url));

/** The service runs as the sample's machine, so that machine's folders take this OS's form. */
const OS =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

/** Generous bounds: a loaded machine must not fail a test that is only slow. */
export const SLOW_MS = 120_000;

/** The service's redeem limit (A2 3.8.3: 10 codes a minute). */
const REDEEMS_PER_WINDOW = 10;
const REDEEM_WINDOW_MS = 60_000;

export interface SpaceInfo {
  readonly id: string;
  readonly name: string;
}

export interface FixtureTask {
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  /** Its area's ID: the area view lists it (Today lists only what A5 3.4 selects). */
  readonly area: string;
}

export interface World {
  readonly origin: string;
  readonly mira: SpaceInfo;
  readonly studio: SpaceInfo;
  /** A task of Mira's in an area, for the launch. */
  readonly task: FixtureTask;
  /**
   * Another task of Mira's in an area, for a second launch: the tests of one worker share the
   * world, and a task already launched shows a Connected tile, which opens nothing.
   */
  readonly spare: FixtureTask;
  /** Mira's portal project's folder, as the space stores it: a temporary folder that exists. */
  readonly portal: string;
  /** The `tasks open` URL of a fresh code, landing on `to`. */
  signInUrl(to: string): Promise<string>;
  /**
   * Sets one of this computer's settings (`ui.theme`, `ui.single_keys`) as the page does, or resets
   * it with null. The tests of a worker share its service: a test that changes one puts it back.
   */
  machine(key: string, value: unknown): Promise<void>;
  /** The fake terminal's command lines so far. */
  terminal(): TerminalCall[];
  /** An agent logs on a task, through the service's request path as an agent does. */
  agentLog(space: string, task: string, text: string): Promise<void>;
  /**
   * An operation through the service's request path, as the person at a terminal (`user`) or an
   * agent makes it, with a fresh request ID. Returns its result.
   */
  op(
    space: string,
    op: string,
    input: Record<string, unknown>,
    as?: "user" | "agent",
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface Described {
  readonly id: string;
  readonly name: string;
}

export interface WorldOptions {
  /** Fixture tasks to add to Mira's space before the service opens it (bulk.ts). */
  readonly bulk?: number;
  /** Finished fixture tasks to add to Mira's space before the service opens it (bulk.ts). */
  readonly finished?: FinishedCounts;
}

export async function startWorld(ui: string, options: WorldOptions = {}): Promise<World> {
  const temp = tempRoot("e2e");
  const services = new Services();
  let json: ServiceJson | undefined;
  const sessions: RpcSession[] = [];
  try {
    const home = join(temp.root, "h");
    const spacesRoot = join(temp.root, "spaces");
    mkdirSync(spacesRoot, { recursive: true });
    const seeded = await seedMira(spacesRoot, { tasks: 12, os: OS });

    // The service's machine is the seeded space's authority, so the space opens for writing.
    const opened = openSpace(await checkedDriver(), seeded.folder, { role: "reader" });
    let machine: string;
    let task: FixtureTask;
    let spare: FixtureTask;
    try {
      machine = opened.space.authority.machineId;
      const rows = opened.conn
        .prepare(
          "SELECT t.id AS id, t.ref AS ref, t.title AS title, t.area_id AS area FROM tasks t " +
            "JOIN areas a ON a.id = t.area_id " +
            "WHERE t.lifecycle = 'active' AND t.deleted_at IS NULL ORDER BY a.position, t.position LIMIT 2",
        )
        .all<{ id: string; ref: number; title: string; area: string }>();
      const [first, second] = rows.map((row) => ({
        id: row.id,
        ref: `${opened.space.refPrefix}-${String(row.ref)}`,
        title: row.title,
        area: row.area,
      }));
      if (first === undefined || second === undefined) {
        throw new Error("the fixture has fewer than two tasks in an area");
      }
      task = first;
      spare = second;
    } finally {
      opened.conn.close();
    }
    if (options.bulk !== undefined) {
      await addBulkTasks(
        seeded.folder,
        { id: machine, name: "mira-desktop", os: OS },
        options.bulk,
      );
    }
    if (options.finished !== undefined) {
      await addFinishedTasks(
        seeded.folder,
        { id: machine, name: "mira-desktop", os: OS },
        options.finished,
      );
    }
    mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateOf(home), "machine.json"),
      JSON.stringify({
        machine_id: machine,
        name: "e2e-desktop",
        created_at: "2026-11-13T08:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    // The fake agent is this machine's one instance: the page draws its tile (A5 3.6).
    registerSpaces(home, [{ path: seeded.folder, id: opened.space.spaceId }], FAKE_INSTANCE_TOML);

    const record = join(temp.root, "terminal.jsonl");
    writeFileSync(record, "");
    const proc = services.start(home, { script: ENTRY, env: { E2E_UI: ui, E2E_TERMINAL: record } });
    json = await waitReady(home, proc.pid);
    const endpoint = json.endpoint?.path;
    const http = json["http"] as { port?: number } | null;
    if (endpoint === undefined || typeof http?.port !== "number") {
      throw new Error("the service reports no endpoint or UI port");
    }
    const origin = `http://127.0.0.1:${String(http.port)}`;

    const user = await classSession(home, endpoint, "cli-interactive");
    sessions.push(user);
    const created = (await user.call(
      "space/create",
      { name: "Studio", path: join(spacesRoot, "studio"), ref_prefix: "S" },
      { timeoutMs: SLOW_MS },
    )) as { space: Described };
    await user.call(
      "op/call",
      {
        space: created.space.id,
        op: "task.add",
        input: {
          tasks: [{ title: "Sketch the spring poster", inbox: true }],
          request_id: "e2e-studio-first-task-01",
        },
      },
      { timeoutMs: SLOW_MS },
    );
    // The sample's portal folders are on Mira's machine, which is not here: this machine's are
    // temporary folders, so a launch of her tasks opens somewhere real. Her first task's own
    // folder inside the portal's moves along with it.
    const portalFolder = join(temp.root, "work", "lumen", "portal");
    mkdirSync(join(portalFolder, "appointments"), { recursive: true });
    const status = (await user.call(
      "op/call",
      { space: opened.space.spaceId, op: "space.status", input: {} },
      { timeoutMs: SLOW_MS },
    )) as { as_of: string };
    const portal = (
      (await user.call(
        "op/call",
        {
          space: opened.space.spaceId,
          op: "folder.manage",
          input: {
            action: "set",
            project: "lumen-portal",
            folder: portalFolder,
            base: status.as_of,
            request_id: "e2e-mira-portal-folder-01",
          },
        },
        { timeoutMs: SLOW_MS },
      )) as { folder: string }
    ).folder;
    const agent = await classSession(home, endpoint, "cli-agent", { CLAUDECODE: "1" });
    sessions.push(agent);

    let logs = 0;
    let ops = 0;
    /** When this world's sign-in URLs were handed out, for the service's redeem limit. */
    const redeems: number[] = [];
    /** The world's own sign-in for `machine`, made once. */
    let token: string | undefined;
    return {
      origin,
      mira: { id: opened.space.spaceId, name: opened.space.name },
      studio: { id: created.space.id, name: created.space.name },
      task,
      spare,
      portal,
      signInUrl: async (to) => {
        // The service redeems at most 10 codes a minute (A2 3.8.3). A worker's tests sign in
        // more often than that when they run fast: wait for room rather than be signed out.
        const now = Date.now();
        while (redeems.length > 0 && (redeems[0] ?? 0) <= now - REDEEM_WINDOW_MS) redeems.shift();
        if (redeems.length >= REDEEMS_PER_WINDOW) {
          const wait = (redeems[0] ?? now) + REDEEM_WINDOW_MS + 250 - now;
          await new Promise((resolve) => setTimeout(resolve, wait));
          redeems.shift();
        }
        redeems.push(Date.now());
        const minted = (await user.call("ui/mint_code", {}, { timeoutMs: SLOW_MS })) as {
          code: string;
          port: number;
        };
        return `http://127.0.0.1:${String(minted.port)}/#k=${minted.code}&to=${encodeURIComponent(to)}`;
      },
      machine: async (key, value) => {
        const port = Number(new URL(origin).port);
        if (token === undefined) {
          redeems.push(Date.now());
          const minted = (await user.call("ui/mint_code", {}, { timeoutMs: SLOW_MS })) as {
            code: string;
          };
          const signed = await post(port, "/api/v1/auth/redeem", { code: minted.code });
          token = (JSON.parse(signed.body) as { token: string }).token;
        }
        const reply = await post(port, "/api/v1/machine/pref", { key, value }, { token });
        if (reply.status !== 200) throw new Error(`machine/pref answered ${String(reply.status)}`);
      },
      terminal: () =>
        readFileSync(record, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as TerminalCall),
      agentLog: async (space, taskId, text) => {
        logs += 1;
        await agent.call(
          "op/call",
          {
            space,
            op: "entry.add",
            input: {
              task: taskId,
              kind: "progress",
              text,
              request_id: `e2e-agent-log-${String(logs).padStart(4, "0")}`,
            },
          },
          { timeoutMs: SLOW_MS },
        );
      },
      op: async (space, op, input, as = "user") => {
        ops += 1;
        return (as === "user" ? user : agent).call(
          "op/call",
          {
            space,
            op,
            // Reads take no request ID; every write gets a fresh one.
            input:
              op.endsWith(".get") || op === "task.search"
                ? input
                : { ...input, request_id: `e2e-world-op-${String(ops).padStart(4, "0")}` },
          },
          { timeoutMs: SLOW_MS },
        );
      },
      close: async () => {
        for (const s of sessions.splice(0)) s.close();
        proc.send("stop");
        await within(proc.exit, SLOW_MS, "the service did not stop").catch(() =>
          services.stopAll(),
        );
        removeRuntimeDir(json);
        temp.cleanup();
      },
    };
  } catch (error) {
    for (const s of sessions.splice(0)) s.close();
    await services.stopAll();
    removeRuntimeDir(json);
    if (existsSync(temp.root)) temp.cleanup();
    throw error;
  }
}
