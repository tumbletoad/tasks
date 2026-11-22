// One end-to-end world: a real service process (tests/e2e/serve-entry.ts) in a temporary
// TTASKS_HOME, serving the page's build on a loopback port the OS assigns, with three spaces of
// fixture data: the seeded Mira sample (areas, projects, tasks), a "Studio" with one task and a
// "Quiet" space whose views are empty. Sign-in goes the way `ttasks open` goes: a code from
// `ui/mint_code` over the socket, in the URL's fragment. The fake agent writes through the socket
// as an agent does (class `cli-agent`).
// Fixture data only. Tests only.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcSession } from "../../packages/bridge/src/protocol/index.ts";
import { startTimes } from "../../packages/launch/src/process.ts";
import { openSpace } from "../../packages/storage/src/index.ts";
import {
  instanceToml,
  registerSpaces,
  removeRuntimeDir,
  Services,
  stateOf,
  tempRoot,
  waitReady,
  within,
  type ServiceJson,
} from "../../packages/service/test/harness.ts";
import { REDEEM_PER_MINUTE } from "../../packages/service/src/http/auth.ts";
import { post } from "../../packages/service/test/http-client.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import { checkedDriver, seedMira } from "../../packages/testkit/src/index.ts";
import {
  addBulkTasks,
  addFinishedTasks,
  addLargeSpace,
  setScales,
  type FinishedCounts,
  type Scales,
} from "./bulk.ts";
import type { FakeCodexCase } from "./codex-cases.ts";
import { fakeInstanceToml, type TerminalCall } from "./fake-terminal.ts";

const ENTRY = fileURLToPath(new URL("./serve-entry.ts", import.meta.url));

/** The service runs as the sample's machine, so that machine's folders take this OS's form. */
const OS =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

/** Generous bounds: a loaded machine must not fail a test that is only slow. */
export const SLOW_MS = 120_000;

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
  /** A space with no open task, area or project. Tests leave its views empty. */
  readonly quiet: SpaceInfo;
  /** A task of Mira's in an area, for the launch. */
  readonly task: FixtureTask;
  /**
   * Another task of Mira's in an area, for a second launch: the tests of one worker share the
   * world, and a task whose session still runs shows a Running tile.
   */
  readonly spare: FixtureTask;
  /**
   * The reference of Mira's task with a Confirmed terminal launch whose record names no end, as
   * builds before this one recorded every session.
   */
  readonly launched: string;
  /** Mira's portal project's folder, as the space stores it: a temporary folder that exists. */
  readonly portal: string;
  /** The `ttasks open` URL of a fresh code, landing on `to`. */
  signInUrl(to: string): Promise<string>;
  /**
   * Sets one of this machine's settings (`ui.theme`, `ui.single_keys`) as the page does, or resets
   * it with null. The tests of a worker share its service: a test that changes one puts it back.
   */
  machine(key: string, value: unknown): Promise<void>;
  /** The fake terminal's command lines so far. */
  terminal(): TerminalCall[];
  /** The folders the file manager was asked to show so far, as the service resolved them. */
  folders(): string[];
  /** The cases the next runs of the task `ref` play, in order (a world with runs). */
  codex(ref: string, cases: readonly FakeCodexCase[]): void;
  /**
   * The cases still left for the task `ref`: a run's fake Codex takes its case once its program
   * runs, which can be after the run's record says it runs.
   */
  codexLeft(ref: string): FakeCodexCase[];
  /** The fake agent reads no request on this task, as an agent without the tools or a shell. */
  leaveUnread(ref: string): void;
  /**
   * The fake agents started on this task from now on run until `release`, or with `exit` end at
   * once with that code, as an agent that cannot start.
   */
  hold(ref: string, exit?: number): void;
  /** The held agents of this task end, as an agent the person quits. */
  release(ref: string): void;
  /** The PIDs of the held agents started on this task, oldest first. */
  heldAgents(ref: string): number[];
  /**
   * Stops the service, runs `whileStopped`, and starts it again on the same home: the page's
   * origin changes with its port, so a page signs in again.
   */
  restart(whileStopped?: () => Promise<void>): Promise<void>;
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
  /** Mira's space grown to the size of one in real use (bulk.ts addLargeSpace). */
  readonly large?: boolean;
  /** Mira's own statuses and effort keys. */
  readonly scales?: Scales;
  /**
   * A second instance, after the fake agent: the fake Codex (fake-codex.ts), which can work on a
   * task in the background. `World.codex` picks the cases its runs play.
   */
  readonly runs?: boolean;
}

/** The fake Codex's instance in a world with runs: the first that can run, Run's default. */
export const CODEX_INSTANCE = { key: "codex-fake", label: "Codex · test", glyph: "Cx" } as const;
/** A second instance of the fake Codex, for a person's other agent: in Run's menu. */
export const CODEX_OTHER = { key: "codex-other", label: "Codex · other", glyph: "Cx" } as const;

const FAKE_CODEX = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

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
    let launched: string;
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
      const confirmed = opened.conn
        .prepare(
          "SELECT t.ref AS ref FROM launches l JOIN tasks t ON t.id = l.task_id " +
            "WHERE l.state = 'confirmed' AND l.route = 'terminal' LIMIT 1",
        )
        .get<{ ref: number }>();
      if (confirmed === undefined) throw new Error("the fixture has no Confirmed launch");
      launched = `${opened.space.refPrefix}-${String(confirmed.ref)}`;
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
    if (options.large === true) {
      await addLargeSpace(seeded.folder, { id: machine, name: "mira-desktop", os: OS });
    }
    if (options.scales !== undefined) {
      await setScales(seeded.folder, { id: machine, name: "mira-desktop", os: OS }, options.scales);
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
    // The fake agent is this machine's first instance: the page draws its tile (A5 3.6). It is a
    // Claude Code instance, which can run tasks too, so a world with runs has the fake Codex
    // first: the page's first runner is its default Run.
    const unread = join(temp.root, "unread.txt");
    writeFileSync(unread, "");
    const holds = join(temp.root, "holds");
    mkdirSync(holds);
    const cases = join(temp.root, "codex-cases.json");
    writeFileSync(cases, "{}");
    const codexes =
      options.runs === true
        ? [CODEX_INSTANCE, CODEX_OTHER]
            .map((codex) =>
              instanceToml({
                id: codex.key,
                target: "codex-cli",
                label: codex.label,
                exec: process.execPath,
                args_prefix: [FAKE_CODEX],
                env: { FAKE_CODEX_CASES: cases },
              }),
            )
            .join("")
        : "";
    registerSpaces(
      home,
      [{ path: seeded.folder, id: opened.space.spaceId }],
      codexes + fakeInstanceToml(home, unread, holds),
    );

    const record = join(temp.root, "terminal.jsonl");
    writeFileSync(record, "");
    const shown = join(temp.root, "folders.txt");
    writeFileSync(shown, "");
    /** One life of the service: its process, its page's origin and its two sessions. */
    const boot = async () => {
      const proc = services.start(home, {
        script: ENTRY,
        env: { E2E_UI: ui, E2E_TERMINAL: record, E2E_FOLDERS: shown },
      });
      json = await waitReady(home, proc.pid);
      const endpoint = json.endpoint?.path;
      const http = json["http"] as { port?: number } | null;
      if (endpoint === undefined || typeof http?.port !== "number") {
        throw new Error("the service reports no endpoint or UI port");
      }
      const user = await classSession(home, endpoint, "cli-interactive");
      sessions.push(user);
      const agent = await classSession(home, endpoint, "cli-agent", { CLAUDECODE: "1" });
      sessions.push(agent);
      return { proc, origin: `http://127.0.0.1:${String(http.port)}`, user, agent };
    };
    let life = await boot();
    const stop = async () => {
      for (const s of sessions.splice(0)) s.close();
      life.proc.send("stop");
      await within(life.proc.exit, SLOW_MS, "the service did not stop");
    };
    const { user } = life;
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
    const quiet = (await user.call(
      "space/create",
      { name: "Quiet", path: join(spacesRoot, "quiet"), ref_prefix: "Q" },
      { timeoutMs: SLOW_MS },
    )) as { space: Described };
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

    let logs = 0;
    let ops = 0;
    /** For each of this world's redeems, a time at or after the service counted it. */
    const redeems: number[] = [];
    /** The world's own sign-in for `machine`, made once. */
    let token: string | undefined;
    // The service redeems only so many codes a minute, and a worker's tests sign in more often
    // than that when they run fast: every redeem, the page's and the world's own, waits for room.
    // A page redeems its code some time after its URL is handed out, however slow the machine,
    // but before the test asks for the next sign-in (it waits for the signed-in page first). So
    // the last redeem counts as made now, and the window is counted from there, not from a guess.
    const roomToRedeem = async (): Promise<void> => {
      if (redeems.length > 0) redeems[redeems.length - 1] = Date.now();
      for (;;) {
        const now = Date.now();
        while (redeems.length > 0 && (redeems[0] ?? 0) <= now - REDEEM_WINDOW_MS) redeems.shift();
        if (redeems.length < REDEEM_PER_MINUTE) break;
        const wait = (redeems[0] ?? now) + REDEEM_WINDOW_MS - now + 1;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      redeems.push(Date.now());
    };
    return {
      get origin() {
        return life.origin;
      },
      mira: { id: opened.space.spaceId, name: opened.space.name },
      studio: { id: created.space.id, name: created.space.name },
      quiet: { id: quiet.space.id, name: quiet.space.name },
      task,
      spare,
      launched,
      portal,
      signInUrl: async (to) => {
        await roomToRedeem();
        const minted = (await life.user.call("ui/mint_code", {}, { timeoutMs: SLOW_MS })) as {
          code: string;
          port: number;
        };
        return `http://127.0.0.1:${String(minted.port)}/#k=${minted.code}&to=${encodeURIComponent(to)}`;
      },
      machine: async (key, value) => {
        const port = Number(new URL(life.origin).port);
        if (token === undefined) {
          await roomToRedeem();
          const minted = (await life.user.call("ui/mint_code", {}, { timeoutMs: SLOW_MS })) as {
            code: string;
          };
          const signed = await post(port, "/api/v1/auth/redeem", { code: minted.code });
          if (signed.status !== 200)
            throw new Error(`auth/redeem answered ${String(signed.status)}`);
          token = (JSON.parse(signed.body) as { token: string }).token;
        }
        const reply = await post(port, "/api/v1/machine/pref", { key, value }, { token });
        if (reply.status !== 200) throw new Error(`machine/pref answered ${String(reply.status)}`);
      },
      codex: (task, next) => {
        const known = JSON.parse(readFileSync(cases, "utf8")) as Record<string, FakeCodexCase[]>;
        known[task] = [...next];
        writeFileSync(cases, JSON.stringify(known));
      },
      codexLeft: (task) =>
        (JSON.parse(readFileSync(cases, "utf8")) as Record<string, FakeCodexCase[]>)[task] ?? [],
      terminal: () =>
        readFileSync(record, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as TerminalCall),
      folders: () =>
        readFileSync(shown, "utf8")
          .split("\n")
          .filter((line) => line !== ""),
      leaveUnread: (ref) => {
        appendFileSync(unread, `${ref}\n`);
      },
      hold: (ref, exit) => {
        writeFileSync(join(holds, ref), exit === undefined ? "" : `exit ${String(exit)}`);
      },
      release: (ref) => {
        rmSync(join(holds, ref), { force: true });
      },
      heldAgents: (ref) => {
        const file = join(holds, `${ref}.pids`);
        if (!existsSync(file)) return [];
        return readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map(Number);
      },
      agentLog: async (space, taskId, text) => {
        logs += 1;
        await life.agent.call(
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
        return (as === "user" ? life.user : life.agent).call(
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
      restart: async (whileStopped) => {
        await stop();
        await whileStopped?.();
        life = await boot();
        // The page's sign-in for `machine` was the stopped service's port's.
        token = undefined;
        // Ready before its spaces are: Mira's answers once it is open again.
        const until = Date.now() + SLOW_MS;
        for (;;) {
          try {
            await life.user.call(
              "op/call",
              { space: opened.space.spaceId, op: "space.status", input: {} },
              { timeoutMs: SLOW_MS },
            );
            break;
          } catch (error) {
            if (Date.now() > until) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      },
      close: async () => {
        // The shims are detached, as a terminal's are, and work in the world's folders. Every held
        // agent ends, and each shim reports its agent's end while the service still runs, and goes.
        for (const name of readdirSync(holds)) {
          if (!name.endsWith(".pids")) rmSync(join(holds, name), { force: true });
        }
        // A shim is known by its PID and start time, so a PID the OS gave to another process since
        // is not waited for.
        const shims = readFileSync(record, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as TerminalCall)
          .flatMap((call) =>
            call.pid === undefined || call.start === undefined
              ? []
              : [{ pid: call.pid, start: call.start }],
          );
        const until = Date.now() + SLOW_MS;
        while (shims.length > 0 && Date.now() < until) {
          const live = await startTimes(shims.map((s) => s.pid)).catch(() => undefined);
          if (live !== undefined && !shims.some((s) => live.get(s.pid) === s.start)) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await stop().catch(() => services.stopAll());
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
