// The one rule at the level of one call, under random interleavings of what agents do: the real
// shim host over machine state in memory, the real sessions port and bridges' bind over a grants
// table in memory, the real request path over two storage fixture spaces. A restart is new hosts
// over the same stores.
//
// What each call must come to is taken from the world, never from the code: which agent made it,
// through which tool or which bridge process; whether its agent still runs and its launch file can
// be read; whether its home is registered; which space its bridge process holds; which task it
// named. Every answer is checked against that (refused with which code, replayed, or a new change
// on which task), and so is everything the spaces kept: each change on the expected task in the
// expected space, each receipt under the expected writer scope and request ID, nothing else.
//
// What this checks: one bridge process works in one space; an open bridge is who it bound as; a
// request commits at most once per space, writer scope and request ID; a launched agent whose
// bridge and shell both got its value commits each request once while it lives, through either
// tool, a reconnect, a replaced MCP process and a service restart; a task named on a call wins for
// that call only; while its launch file cannot be read the call is refused to try again, never
// taken as another caller's; two scopes with the same request ID are independent. What
// docs/promises-and-limits.md does not protect (a retry after the agent's end, chats of one app
// sharing request IDs) is predicted as it happens, never a failure. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError } from "@ttasks/contracts";
import { MemoryRecords, newTicket, secretHash, ShimHost } from "@ttasks/launch";
import type { ReceiptLookup, SpaceWriterHandle, WriteRequest } from "@ttasks/storage";
import { writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { BindNotYet, Bridges, sessionPort } from "../src/binding/index.ts";
import { homeGate } from "../src/hub/home-gate.ts";
import { homeRows } from "../src/hub/home-rows.ts";
import { namedBy } from "../src/hub/named.ts";
import type { Grant } from "../src/local/index.ts";
import { bridgeCaller } from "../src/mcp/index.ts";
import { opCall, type Binding, type OpsHost, type ServedSpace } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

type Json = Record<string, unknown>;
const MACHINE = "m_00000000000000000000000001";
const PRESET = "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a1f";

let temp: { root: string; cleanup: () => void };
let s1: Fixture;
let s2: Fixture;
/** The tasks the agents work on, in the first space: A's, P's, and the desktop chats'. */
let tasks: { ref: string; id: string }[] = [];

const writerOf = (f: Fixture): SpaceWriterHandle =>
  ({
    spaceId: f.spaceId,
    submit: (request: WriteRequest) => Promise.resolve(f.writer.submit(request)),
    receipt: (lookup: ReceiptLookup) => Promise.resolve(f.writer.receipt(lookup)),
    actor: (kind: "human" | "agent", label: string) => Promise.resolve(f.writer.actor(kind, label)),
  }) as unknown as SpaceWriterHandle;

const served = (f: Fixture, name: string): ServedSpace => ({
  id: f.spaceId,
  registered: f.spaceId,
  name,
  state: "open",
  writer: writerOf(f),
  reader: readerOf(f.reader),
});

beforeAll(async () => {
  temp = tempRoot("bind-model");
  for (const name of ["s1", "s2"]) mkdirSync(join(temp.root, name));
  s1 = await writeFixture(join(temp.root, "s1"));
  s2 = await writeFixture(join(temp.root, "s2"));
  const host: OpsHost = { machine: { id: MACHINE }, spaces: () => [served(s1, "One")] };
  const added = (await opCall(
    host,
    { class: "cli-interactive", env: {} },
    {
      op: "task.add",
      input: {
        tasks: ["Fixture task A", "Fixture task P", "Fixture task D"].map((title) => ({ title })),
        request_id: "fixture-model-tasks-000001",
      },
    },
  )) as { tasks: { ref: string; id: string }[] };
  tasks = added.tasks.map((t) => ({ ref: t.ref, id: t.id }));
});

afterAll(() => {
  s1.close();
  s2.close();
  temp.cleanup();
});

/**
 * The agents of one run. A and P are launched in the first space (A's tools and shell get its
 * ticket; P is Claude Code in allow-list mode, its tools get the preset and its shell the ticket);
 * D1 and D2 are two chats of one desktop app; H is a hand-made entry with no instance and no space.
 */
const AGENTS = ["A", "P", "D1", "D2", "H"] as const;
type AgentName = (typeof AGENTS)[number];
type Launched = "A" | "P";
const isLaunched = (name: AgentName): name is Launched => name === "A" || name === "P";

/** Which task a write names: none, the agent's own, or another one. H names none. */
type Named = "none" | "own" | "other";

type Event =
  | { readonly e: "write"; readonly agent: AgentName; readonly via: Via; readonly task: Named }
  | { readonly e: "retry"; readonly agent: AgentName; readonly via: Via; readonly k: number }
  | { readonly e: "borrow"; readonly agent: "D1" | "D2"; readonly k: number }
  | { readonly e: "reconnect"; readonly agent: AgentName }
  | { readonly e: "replace"; readonly agent: AgentName }
  | { readonly e: "restart" }
  | { readonly e: "end"; readonly agent: Launched }
  | { readonly e: "revoke"; readonly agent: Launched }
  | { readonly e: "restore"; readonly agent: Launched }
  | { readonly e: "unreadable"; readonly agent: Launched }
  | { readonly e: "readable"; readonly agent: Launched }
  | { readonly e: "default"; readonly space: 0 | 1 | 2 };
type Via = "bridge" | "shell";

const agent = fc.constantFrom(...AGENTS);
const launched = fc.constantFrom<Launched>("A", "P");
const via = fc.constantFrom<Via>("bridge", "shell");
const event: fc.Arbitrary<Event> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      e: fc.constant("write" as const),
      agent,
      via,
      task: fc.constantFrom<Named>("none", "own", "other"),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({ e: fc.constant("retry" as const), agent, via, k: fc.nat(6) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      e: fc.constant("borrow" as const),
      agent: fc.constantFrom<"D1" | "D2">("D1", "D2"),
      k: fc.nat(6),
    }),
  },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("reconnect" as const), agent }) },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("replace" as const), agent }) },
  { weight: 2, arbitrary: fc.constant({ e: "restart" as const }) },
  { weight: 1, arbitrary: fc.record({ e: fc.constant("end" as const), agent: launched }) },
  { weight: 1, arbitrary: fc.record({ e: fc.constant("revoke" as const), agent: launched }) },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("restore" as const), agent: launched }) },
  { weight: 1, arbitrary: fc.record({ e: fc.constant("unreadable" as const), agent: launched }) },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("readable" as const), agent: launched }) },
  {
    weight: 1,
    arbitrary: fc.record({
      e: fc.constant("default" as const),
      space: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
    }),
  },
);

/** One request an agent sent: its ID and its input, the same at every attempt. */
interface Request {
  readonly id: string;
  readonly agent: AgentName;
  readonly input: Json;
  readonly text: string;
  /** The task it names (`t_` ID), if it names one. */
  readonly named: string | undefined;
}

/** What a call must come to, from the world. */
type Expected =
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "replayed"; readonly task: string }
  | {
      readonly kind: "commit";
      readonly space: string;
      readonly task: string;
      readonly scope: string;
    };

/** What the run reached, so a seed that never reaches a kind of trouble cannot pass unnoticed. */
const reached = new Map<string, number>();
const reach = (what: string): void => {
  reached.set(what, (reached.get(what) ?? 0) + 1);
};

let runs = 0;

/** One run of the world. Returns what did not come as the world says it must. */
async function run(events: readonly Event[]): Promise<string[]> {
  runs += 1;
  const tag = `r${String(runs).padStart(4, "0")}`;
  const violations: string[] = [];
  const records = new MemoryRecords();
  const rows: Grant[] = [];
  let defaultSpace: string | undefined;
  const spaces = (): ServedSpace[] => [served(s1, "One"), served(s2, "Two")];
  const refOf = (id: string): string => tasks.find((t) => t.id === id)?.ref ?? id;

  // The two launched agents: claimed records as the click and the claim leave them, each on a
  // home setup registered for the first space.
  interface Launch {
    readonly id: string;
    readonly ticket: string;
    readonly task: string;
    readonly preset: string | undefined;
    readonly instance: string;
    row: Grant;
    live: boolean;
    readable: boolean;
  }
  const launches = new Map<Launched, Launch>();
  for (const [i, name] of (["A", "P"] as const).entries()) {
    const id = `la_${(tag + String(i)).padStart(26, "0")}`;
    const ticket = newTicket();
    const home = `/fixture/homes/${name}`;
    const app = name === "P" ? "claude-code" : "codex";
    const instance = `inst-${name.toLowerCase()}`;
    const task = tasks[i]?.id ?? "";
    const preset = name === "P" ? PRESET : undefined;
    records.put({
      format: 1,
      space: s1.spaceId,
      launch: id,
      reference: "L7KQ2M",
      task,
      createdAt: 1_800_000_000_000 + runs * 10 + i,
      plan: { argv: ["/opt/agent"], folder: null, env: {}, title: "Fixture", afterExit: "close" },
      ticket: {
        hash: secretHash("ticket", id, ticket),
        issuedAt: 1,
        shimUsed: true,
        bridgeUsed: false,
      },
      attachment: { hash: "a".repeat(64), pid: 4242 + i, startTime: "linux:1" },
      app,
      home,
      ...(preset === undefined ? {} : { preset }),
    });
    const row: Grant = {
      grant_id: `gr_${(tag + name).padStart(26, "0")}`,
      kind: "agent_home",
      principal: "user",
      spaces: [s1.spaceId],
      scopes: [],
      token_hash: null,
      attrs: { app, home, instance, account: "" },
      created_at: new Date(1_800_000_000_000 + i).toISOString(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    };
    rows.push(row);
    launches.set(name, { id, ticket, task, preset, instance, row, live: true, readable: true });
  }
  const launchOf = (name: Launched): Launch => {
    const found = launches.get(name);
    if (found === undefined) throw new Error("no launch");
    return found;
  };
  // The desktop app's home, registered for the first space.
  rows.push({
    ...(rows[0] as Grant),
    grant_id: `gr_${(tag + "D").padStart(26, "0")}`,
    attrs: { app: "claude-desktop", home: "/fixture/homes/D", instance: "inst-d", account: "" },
  });

  // The hosts, made again at a restart over the same records, rows and spaces.
  const grants = { list: () => rows };
  const gate = homeGate({ grants: () => grants, spaces, defaultSpace: () => defaultSpace });
  let shim!: ShimHost;
  let host!: OpsHost;
  let bridges!: Bridges;
  const start = (): void => {
    shim = new ShimHost({
      records,
      probe: { startTimes: () => Promise.resolve(new Map()) },
      platform: "linux",
      machine: () => undefined,
      environment: () => ({ kind: "service", env: {} }),
    });
    const sessions = sessionPort({
      named: (values) =>
        namedBy({ launches: () => shim, runs: { liveByTicket: () => undefined } }, values),
      rows: (app, home) => homeRows({ grants: () => grants, platform: "linux" }, app, home),
      runAllows: () => false,
      machineDefault: () => gate.machineDefault(),
      live: () => new Map(),
    });
    host = {
      machine: { id: MACHINE },
      spaces,
      defaultSpace: () => defaultSpace,
      homes: gate,
      sessions,
      now: () => 1_800_000_000_000,
    };
    bridges = new Bridges({ sessions, spaces, defaultSpace: () => defaultSpace });
  };
  start();

  // The world's facts a decision rests on, read from the world, not from the code.
  /** A launched agent's values name it now: its agent runs and its file can be read. */
  const named = (name: Launched): boolean => launchOf(name).live && launchOf(name).readable;
  /** A file that cannot be read now: a value that names no readable launch waits for it. */
  const anyUnreadable = (): boolean => [...launches.values()].some((l) => l.live && !l.readable);
  /** The space a hand-made entry may use: the machine's default; two spaces and none, no space. */
  const machineDefault = (): string | undefined => defaultSpace;
  const sessionScope = (name: Launched): string =>
    `session:se_${launchOf(name).id.slice("la_".length)}`;

  // Each agent's bridge: its process, what that process holds of its space (a space, or null for
  // none; absent before an answer), and its connection with who it bound as.
  interface Open {
    readonly binding: Binding;
    /** Who it is for its life: the session of its launch, or its own. */
    readonly session: boolean;
    readonly space: string | undefined;
  }
  const processes = new Map<AgentName, number>(AGENTS.map((a) => [a, 0]));
  const held = new Map<AgentName, string | null>();
  const connections = new Map<AgentName, Open>();
  const answers = new Map<string, Set<string>>();

  const entryOf = (name: AgentName): JsonObject => {
    if (name === "A") return { space: s1.spaceId, instance: "inst-a", app: "codex" };
    if (name === "P") return { space: s1.spaceId, instance: "inst-p", app: "claude-code" };
    if (name === "H") return { space: null, instance: null, app: null };
    return { space: s1.spaceId, instance: "inst-d", app: "claude-desktop" };
  };
  const bridgeEnv = (name: AgentName): Json => {
    if (name === "A") return { TTASKS_TICKET: launchOf("A").ticket };
    // Allow-list mode: Claude Code hands its MCP servers the preset, not the ticket.
    if (name === "P") return { CLAUDE_CODE_SESSION_ID: launchOf("P").preset };
    return {};
  };
  const contextOf = (name: AgentName): JsonObject => ({
    ...entryOf(name),
    cwd: null,
    env: bridgeEnv(name),
    parent: { pid: 1 },
    ...(held.has(name) ? { held_space: held.get(name) ?? null } : {}),
  });
  const shellEnv = (name: Launched): Record<string, string> => {
    const launch = launchOf(name);
    return {
      CLAUDECODE: "1",
      TTASKS_TICKET: launch.ticket,
      ...(launch.preset === undefined ? {} : { CLAUDE_CODE_SESSION_ID: launch.preset }),
    };
  };

  /**
   * Who the bridge of `name` binds as now, and in which space, from the world: the launch's
   * session while its values name it; none while a file it may be cannot be read (the bind fails);
   * otherwise its own, in what its process holds, else its entry's space, else the default.
   */
  const bindsAs = (
    name: AgentName,
  ):
    | { readonly fails: true }
    | { readonly fails: false; session: boolean; space: string | undefined } => {
    const kept = held.has(name) ? (held.get(name) ?? undefined) : undefined;
    if (isLaunched(name)) {
      if (named(name)) return { fails: false, session: true, space: s1.spaceId };
      if (anyUnreadable()) return { fails: true };
    }
    if (held.has(name)) return { fails: false, session: false, space: kept };
    const entry = entryOf(name)["space"];
    if (typeof entry === "string") return { fails: false, session: false, space: entry };
    return { fails: false, session: false, space: defaultSpace };
  };

  /** The bridge connection of `name`, bound now when it has none, as the forwarder binds. */
  const bridgeOf = (name: AgentName): Open | "failed" => {
    const open = connections.get(name);
    if (open !== undefined) return open;
    const expected = bindsAs(name);
    const connection = { context: contextOf(name) };
    let answer: JsonObject;
    try {
      answer = bridges.bind(connection);
    } catch (error) {
      if (!(error instanceof BindNotYet)) throw error;
      if (!expected.fails) violations.push(`${name}'s bind failed, and should have been decided`);
      reach("a bind failed to try again");
      return "failed";
    }
    if (expected.fails)
      violations.push(`${name}'s bind was decided while a launch file was unreadable`);
    const binding = bridges.attach(connection);
    if (binding === undefined) throw new Error("no binding");
    const space = typeof answer["space"] === "string" ? answer["space"] : undefined;
    const session = answer["state"] === "bound";
    if (!expected.fails && (expected.session !== session || expected.space !== space)) {
      violations.push(
        `${name} bound as ${session ? "a session" : "its own"} in ${String(space)}, expected ${expected.session ? "a session" : "its own"} in ${String(expected.space)}`,
      );
    }
    const key = `${name}#${String(processes.get(name))}`;
    const seen = answers.get(key) ?? new Set<string>();
    if (space !== undefined) seen.add(space);
    answers.set(key, seen);
    // As the forwarder: the first answer is kept, a space or none.
    if (!held.has(name)) held.set(name, space ?? null);
    const made: Open = { binding, session, space };
    connections.set(name, made);
    return made;
  };

  /** What the spaces kept, as the model expects it: receipts by space, scope and request. */
  const kept = new Map<string, { readonly text: string; readonly task: string }>();
  const expectedCommits = new Map<string, string[]>();
  const keyOf = (space: string, scope: string, id: string): string => `${space}|${scope}|${id}`;

  /** What a write of `request` through `through` must come to now, and its writer scope. */
  const expect_ = (
    name: AgentName,
    through: Via,
    request: Request,
    open: Open | undefined,
  ): { expected: Expected; scope?: string; space?: string } => {
    let session = false;
    let space: string | undefined;
    let scope: string;
    let allowed: boolean;
    if (through === "shell" && isLaunched(name)) {
      if (named(name)) session = true;
      else if (anyUnreadable())
        return { expected: { kind: "refused", code: "service_unavailable" } };
      space = s1.spaceId;
      scope = session ? sessionScope(name) : `agent:unknown:${MACHINE}`;
      allowed = !session || launchOf(name).row.revoked_at === null;
    } else {
      if (open === undefined) return { expected: { kind: "refused", code: "bind_failed" } };
      session = open.session;
      space = open.space;
      if (space === undefined) return { expected: { kind: "refused", code: "space_unavailable" } };
      if (isLaunched(name)) {
        scope = session ? sessionScope(name) : `bridge:${launchOf(name).instance}:${MACHINE}`;
        allowed = launchOf(name).row.revoked_at === null;
      } else if (name === "H") {
        scope = `bridge:manual:${MACHINE}`;
        allowed = space === machineDefault();
      } else {
        scope = `bridge:inst-d:${MACHINE}`;
        allowed = true;
      }
    }
    if (!allowed) return { expected: { kind: "refused", code: "forbidden" } };
    const task = request.named ?? (session && isLaunched(name) ? launchOf(name).task : undefined);
    if (task === undefined) return { expected: { kind: "refused", code: "unbound" } };
    const before = kept.get(keyOf(space, scope, request.id));
    if (before !== undefined) {
      return before.text === request.text
        ? { expected: { kind: "replayed", task: before.task }, scope, space }
        : { expected: { kind: "refused", code: "request_id_conflict" } };
    }
    return { expected: { kind: "commit", space, task, scope }, scope, space };
  };

  const call = async (name: AgentName, through: Via, request: Request): Promise<void> => {
    const shell = through === "shell" && isLaunched(name);
    const open = shell ? undefined : bridgeOf(name);
    const { expected } = expect_(
      name,
      shell ? "shell" : "bridge",
      request,
      open === "failed" ? undefined : open,
    );
    let actual: Expected;
    try {
      let result: Json;
      if (shell) {
        result = (await opCall(
          host,
          { class: "cli-agent", env: shellEnv(name) },
          { op: "entry.add", input: request.input, space: s1.spaceId },
        )) as Json;
      } else if (open === undefined || open === "failed") {
        throw new AppError({ code: "service_unavailable", message: "bind_failed" });
      } else {
        result = (await opCall(host, bridgeCaller(contextOf(name), MACHINE, open.binding), {
          op: "entry.add",
          input: request.input,
        })) as Json;
      }
      const task = tasks.find((t) => t.ref === result["task"])?.id ?? String(result["task"]);
      actual =
        result["replayed"] === true
          ? { kind: "replayed", task }
          : expected.kind === "commit"
            ? { kind: "commit", space: expected.space, task, scope: expected.scope }
            : { kind: "commit", space: "?", task, scope: "?" };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      actual = {
        kind: "refused",
        code: error.message === "bind_failed" ? "bind_failed" : error.code,
      };
    }
    const same =
      expected.kind === actual.kind &&
      (expected.kind === "refused"
        ? expected.code === (actual as { code: string }).code
        : expected.task === (actual as { task: string }).task);
    if (!same) {
      violations.push(
        `${name} through its ${through}, ${request.id}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
      return;
    }
    if (expected.kind === "commit") {
      kept.set(keyOf(expected.space, expected.scope, request.id), {
        text: request.text,
        task: expected.task,
      });
      const where = `${expected.space}|${request.text}`;
      expectedCommits.set(where, [...(expectedCommits.get(where) ?? []), expected.task]);
    }
    if (expected.kind === "replayed") reach("a replay");
    if (expected.kind === "refused" && expected.code === "service_unavailable") {
      reach("a shell refused to try again");
    }
  };

  const requests: Request[] = [];
  let made = 0;
  for (const ev of events) {
    switch (ev.e) {
      case "write": {
        made += 1;
        const text = `Fixture model ${tag} ${String(made)}.`;
        const id = `fixture-model-${tag}-${String(made).padStart(6, "0")}`;
        const own = isLaunched(ev.agent) ? launchOf(ev.agent).task : tasks[2]?.id;
        const other = isLaunched(ev.agent) ? tasks[2]?.id : tasks[0]?.id;
        const task =
          ev.agent === "H" || ev.task === "none" ? undefined : ev.task === "own" ? own : other;
        const input: Json = {
          kind: "progress",
          text,
          request_id: id,
          ...(task === undefined ? {} : { task }),
        };
        const request: Request = { id, agent: ev.agent, input, text, named: task };
        requests.push(request);
        if (isLaunched(ev.agent) && ev.task === "other") reach("a named task over the session's");
        await call(ev.agent, ev.via, request);
        break;
      }
      case "retry": {
        const own = requests.filter((r) => r.agent === ev.agent);
        const request = own[ev.k % Math.max(own.length, 1)];
        if (request === undefined) break;
        await call(ev.agent, ev.via, request);
        break;
      }
      case "borrow": {
        // A chat that reuses a launched agent's request ID for its own change, on its own task.
        const theirs = requests.filter((r) => isLaunched(r.agent));
        const source = theirs[ev.k % Math.max(theirs.length, 1)];
        if (source === undefined) break;
        made += 1;
        const text = `Fixture model ${tag} ${String(made)} borrowed.`;
        const task = tasks[2]?.id;
        const request: Request = {
          id: source.id,
          agent: ev.agent,
          input: { kind: "progress", text, request_id: source.id, task },
          text,
          named: task,
        };
        reach("another scope's request ID");
        await call(ev.agent, "bridge", request);
        break;
      }
      case "reconnect":
        connections.delete(ev.agent);
        break;
      case "replace":
        connections.delete(ev.agent);
        held.delete(ev.agent);
        processes.set(ev.agent, (processes.get(ev.agent) ?? 0) + 1);
        break;
      case "restart":
        connections.clear();
        start();
        reach("restart");
        break;
      case "end": {
        const launch = launchOf(ev.agent);
        if (!launch.live) break;
        records.remove(launch.id);
        launch.live = false;
        reach("end");
        break;
      }
      case "revoke":
      case "restore": {
        const launch = launchOf(ev.agent);
        const index = rows.indexOf(launch.row);
        const row = {
          ...launch.row,
          revoked_at: ev.e === "revoke" ? new Date().toISOString() : null,
        };
        rows[index] = row;
        launch.row = row;
        break;
      }
      case "unreadable":
      case "readable": {
        const launch = launchOf(ev.agent);
        launch.readable = ev.e === "readable";
        if (launch.readable) records.held.delete(launch.id);
        else records.held.add(launch.id);
        break;
      }
      case "default":
        defaultSpace = ev.space === 0 ? undefined : ev.space === 1 ? s1.spaceId : s2.spaceId;
        break;
    }
  }

  // One bridge process, one space.
  for (const [key, seen] of answers) {
    if (seen.size > 1)
      violations.push(`bridge process ${key} worked in ${String(seen.size)} spaces`);
  }
  // What the spaces kept: each change on its task in its space, each receipt under its scope.
  for (const [f, space] of [
    [s1, s1.spaceId],
    [s2, s2.spaceId],
  ] as const) {
    for (const request of requests) {
      const actual = f.reader
        .prepare("SELECT task_id FROM log_entries WHERE body = $body ORDER BY task_id")
        .all({ body: request.text })
        .map((r) => String(r["task_id"]));
      const expectedTasks = [...(expectedCommits.get(`${space}|${request.text}`) ?? [])].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expectedTasks)) {
        violations.push(
          `${request.id} in ${space}: changes on ${actual.map(refOf).join(", ") || "none"}, expected ${expectedTasks.map(refOf).join(", ") || "none"}`,
        );
      }
    }
    const ids = new Set(requests.map((r) => r.id));
    for (const id of ids) {
      const scopes = f.reader
        .prepare("SELECT scope_id FROM receipts WHERE request_id = $request ORDER BY scope_id")
        .all({ request: id })
        .map((r) => String(r["scope_id"]));
      const expectedScopes = [...kept.keys()]
        .filter((k) => k.startsWith(`${space}|`) && k.endsWith(`|${id}`))
        .map((k) => k.slice(space.length + 1, k.length - id.length - 1))
        .sort();
      if (JSON.stringify(scopes) !== JSON.stringify(expectedScopes)) {
        violations.push(
          `${id} in ${space}: receipts under ${scopes.join(", ")}, expected ${expectedScopes.join(", ")}`,
        );
      }
    }
  }
  return violations;
}

describe("[A3.3.7.binding.model] who a connection is, under random interleavings of what agents do", () => {
  test(
    "every answer and every kept change is what the world says it must be",
    { timeout: 300_000 },
    async () => {
      const deep = process.env["TTASKS_DEEP"] === "1";
      await fc.assert(
        fc.asyncProperty(fc.array(event, { minLength: 8, maxLength: 40 }), async (events) => {
          expect(await run(events)).toEqual([]);
        }),
        { numRuns: deep ? 1_000 : 60, seed: 4_221_122, endOnFailure: true },
      );
      for (const what of [
        "restart",
        "end",
        "a replay",
        "a named task over the session's",
        "another scope's request ID",
        "a bind failed to try again",
        "a shell refused to try again",
      ]) {
        expect(reached.get(what) ?? 0, what).toBeGreaterThan(0);
      }
    },
  );
});
