// The one rule at the level of one call, under random interleavings of what agents do: the real
// shim host over machine state in memory, the real sessions port and bridges' bind over a grants
// table in memory, the real request path over two storage fixture spaces. A restart is new hosts
// over the same stores.
//
// What each call must come to is taken from the world, never from the code: which agent made it,
// through which tool or which bridge process; whether its agent still runs; whether its home is
// registered; which space its bridge process holds and which the machine's default is; which task
// it named. Every answer is checked against that (refused with which code, replayed, or a new
// change on which task), and so is everything the spaces kept: every change of the run, in the
// space and on the task expected, every receipt under the expected writer scope and request ID,
// nothing else.
//
// What this checks: one bridge process works in one space, also when the default moves; an open
// bridge is who it bound as, also after its agent ended; a request commits at most once per space,
// writer scope and request ID; a launched agent whose bridge and shell both got its value commits
// each request once while it lives, through either tool, a reconnect, a replaced MCP process and a
// service restart; a task named on a call wins for that call only; two scopes with the same request
// ID are independent. What docs/promises-and-limits.md does not protect (a retry after the agent's
// end, chats of one app sharing request IDs) is predicted as it happens, never a failure. Fixture
// text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError } from "@ttasks/contracts";
import { MemoryRecords, newTicket, secretHash, ShimHost } from "@ttasks/launch";
import type { ReceiptLookup, SpaceWriterHandle, WriteRequest } from "@ttasks/storage";
import { writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { Bridges, sessionPort } from "../src/binding/index.ts";
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
/** The task in the second space. */
let task2 = { ref: "", id: "" };

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
  folder: `/fixture/${name}`,
  state: "open",
  writer: writerOf(f),
  reader: readerOf(f.reader),
});

/** The person adds `titles` as tasks to the space of `f`. */
async function addTasks(f: Fixture, name: string, titles: string[], requestId: string) {
  const host: OpsHost = { machine: { id: MACHINE }, spaces: () => [served(f, name)] };
  const added = (await opCall(
    host,
    { class: "cli-interactive", env: {} },
    { op: "task.add", input: { tasks: titles.map((title) => ({ title })), request_id: requestId } },
  )) as { tasks: { ref: string; id: string }[] };
  return added.tasks.map((t) => ({ ref: t.ref, id: t.id }));
}

beforeAll(async () => {
  temp = tempRoot("bind-model");
  for (const name of ["s1", "s2"]) mkdirSync(join(temp.root, name));
  s1 = await writeFixture(join(temp.root, "s1"));
  s2 = await writeFixture(join(temp.root, "s2"));
  tasks = await addTasks(
    s1,
    "One",
    ["Fixture task A", "Fixture task P", "Fixture task D"],
    "fixture-model-tasks-000001",
  );
  const [second] = await addTasks(s2, "Two", ["Fixture task H"], "fixture-model-tasks-000002");
  if (second === undefined) throw new Error("no task in the second space");
  task2 = second;
});

afterAll(() => {
  s1.close();
  s2.close();
  temp.cleanup();
});

/**
 * The agents of one run. A and P are launched in the first space (A's tools and shell get its
 * ticket; P is Claude Code in allow-list mode, its tools get the preset and its shell the ticket);
 * D1 and D2 are two chats of one desktop app; H is a hand-made entry with no instance and no space,
 * which names the task of the space its process works in.
 */
const AGENTS = ["A", "P", "D1", "D2", "H"] as const;
type AgentName = (typeof AGENTS)[number];
type Launched = "A" | "P";
const isLaunched = (name: AgentName): name is Launched => name === "A" || name === "P";

/** Which task a write names: none, the agent's own, or another one. */
type Named = "none" | "own" | "other";

/** The machine's default: none, the first space or the second. */
type DefaultSpace = 0 | 1 | 2;

type Event =
  | { readonly e: "write"; readonly agent: AgentName; readonly via: Via; readonly task: Named }
  | { readonly e: "retry"; readonly agent: AgentName; readonly via: Via; readonly k: number }
  | { readonly e: "borrow"; readonly agent: "D1" | "D2"; readonly k: number }
  | { readonly e: "reconnect"; readonly agent: AgentName }
  | { readonly e: "replace"; readonly agent: AgentName }
  | { readonly e: "restart" }
  /** The agent ends; `late`: its bridge is connected then, and sends its last call once more. */
  | { readonly e: "end"; readonly agent: Launched; readonly late: boolean }
  | { readonly e: "revoke"; readonly agent: Launched }
  | { readonly e: "restore"; readonly agent: Launched }
  | { readonly e: "default"; readonly space: DefaultSpace };
type Via = "bridge" | "shell";

const agent = fc.constantFrom(...AGENTS);
const launched = fc.constantFrom<Launched>("A", "P");
const via = fc.constantFrom<Via>("bridge", "shell");
const defaultSpace = fc.constantFrom<DefaultSpace>(0, 1, 2);
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
  // The hand-made bridge's writes, where its space and the default meet.
  {
    weight: 3,
    arbitrary: fc.record({
      e: fc.constant("write" as const),
      agent: fc.constant("H" as const),
      via: fc.constant("bridge" as const),
      task: fc.constant("own" as const),
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
  // Every agent reconnects, the hand-made bridge as often as all others together.
  {
    weight: 3,
    arbitrary: fc.record({
      e: fc.constant("reconnect" as const),
      agent: fc.oneof(agent, fc.constant("H" as const)),
    }),
  },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("replace" as const), agent }) },
  { weight: 2, arbitrary: fc.constant({ e: "restart" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({ e: fc.constant("end" as const), agent: launched, late: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ e: fc.constant("revoke" as const), agent: launched }) },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("restore" as const), agent: launched }) },
  { weight: 4, arbitrary: fc.record({ e: fc.constant("default" as const), space: defaultSpace }) },
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
  /** A task of another space: refused as not found, and the writer keeps that answer's receipt. */
  | { readonly kind: "rejected"; readonly space: string; readonly scope: string }
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
async function run(initial: DefaultSpace, events: readonly Event[]): Promise<string[]> {
  runs += 1;
  const tag = `r${String(runs).padStart(4, "0")}`;
  const violations: string[] = [];
  const records = new MemoryRecords();
  const rows: Grant[] = [];
  const spaceOf = (choice: DefaultSpace): string | undefined =>
    choice === 0 ? undefined : choice === 1 ? s1.spaceId : s2.spaceId;
  let machineDefault = spaceOf(initial);
  const spaces = (): ServedSpace[] => [served(s1, "One"), served(s2, "Two")];
  const refOf = (id: string): string =>
    tasks.find((t) => t.id === id)?.ref ?? (id === task2.id ? "the second space's task" : id);
  /** The task an answer in `space` names by its reference. */
  const taskIn = (space: string | undefined, ref: string): string =>
    space === s2.spaceId
      ? ref === task2.ref
        ? task2.id
        : ref
      : (tasks.find((t) => t.ref === ref)?.id ?? ref);

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
    launches.set(name, { id, ticket, task, preset, instance, row, live: true });
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
  const gate = homeGate({ grants: () => grants, spaces, defaultSpace: () => machineDefault });
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
      defaultSpace: () => machineDefault,
      homes: gate,
      sessions,
      now: () => 1_800_000_000_000,
    };
    bridges = new Bridges({ sessions, spaces, defaultSpace: () => machineDefault });
  };
  start();

  // The world's facts a decision rests on, read from the world, not from the code.
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
   * session while its agent runs and its process holds that space or nothing; otherwise its own,
   * in what its process holds, else its entry's space, else the default.
   */
  const bindsAs = (name: AgentName): { session: boolean; space: string | undefined } => {
    const holds = held.has(name);
    const kept = holds ? (held.get(name) ?? undefined) : undefined;
    if (isLaunched(name) && launchOf(name).live && (!holds || kept === s1.spaceId)) {
      return { session: true, space: s1.spaceId };
    }
    if (holds) return { session: false, space: kept };
    const entry = entryOf(name)["space"];
    if (typeof entry === "string") return { session: false, space: entry };
    return { session: false, space: machineDefault };
  };

  /** The space the bridge of `name` works in: its connection's, or the one it would bind in. */
  const bridgeSpace = (name: AgentName): string | undefined =>
    connections.has(name) ? connections.get(name)?.space : bindsAs(name).space;

  /** The bridge connection of `name`, bound now when it has none, as the forwarder binds. */
  const bridgeOf = (name: AgentName): Open => {
    const open = connections.get(name);
    if (open !== undefined) {
      if (isLaunched(name) && open.session && !launchOf(name).live) {
        reach("an open bridge after its agent's end");
      }
      return open;
    }
    const expected = bindsAs(name);
    if (held.get(name) === null && machineDefault !== undefined) {
      reach("a held none bound again after a default was set");
    }
    // Only where the held space decides: without it, the bind would give another space.
    const kept = held.get(name);
    const entry = entryOf(name)["space"];
    const without = typeof entry === "string" ? entry : machineDefault;
    if (typeof kept === "string" && kept !== without && !expected.session) {
      reach("a held space bound again after the default moved");
    }
    const connection = { context: contextOf(name) };
    const answer = bridges.bind(connection);
    const binding = bridges.attach(connection);
    if (binding === undefined) throw new Error("no binding");
    const space = typeof answer["space"] === "string" ? answer["space"] : undefined;
    const session = answer["state"] === "bound";
    if (expected.session !== session || expected.space !== space) {
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
  /** Every change the spaces must hold: `<space>|<text>|<task>`, once for each commit. */
  const changes: string[] = [];
  /** A receipt of a request the writer refused: no change, and the same answer at a retry. */
  const REJECTED = "rejected";
  const keyOf = (space: string, scope: string, id: string): string => `${space}|${scope}|${id}`;

  /** What a write of `request` through `through` must come to now, and its writer scope. */
  const expect_ = (
    name: AgentName,
    through: Via,
    request: Request,
    open: Open | undefined,
  ): Expected => {
    let session: boolean;
    let space: string | undefined;
    let scope: string;
    let allowed: boolean;
    if (through === "shell" && isLaunched(name)) {
      session = launchOf(name).live;
      space = s1.spaceId;
      scope = session ? sessionScope(name) : `agent:unknown:${MACHINE}`;
      allowed = !session || launchOf(name).row.revoked_at === null;
    } else {
      if (open === undefined) throw new Error("no bridge");
      session = open.session;
      space = open.space;
      if (space === undefined) return { kind: "refused", code: "space_unavailable" };
      if (isLaunched(name)) {
        scope = session ? sessionScope(name) : `bridge:${launchOf(name).instance}:${MACHINE}`;
        allowed = launchOf(name).row.revoked_at === null && space === s1.spaceId;
      } else if (name === "H") {
        scope = `bridge:manual:${MACHINE}`;
        allowed = space === machineDefault;
      } else {
        scope = `bridge:inst-d:${MACHINE}`;
        allowed = space === s1.spaceId;
      }
    }
    if (!allowed) return { kind: "refused", code: "forbidden" };
    const task = request.named ?? (session && isLaunched(name) ? launchOf(name).task : undefined);
    if (task === undefined) return { kind: "refused", code: "unbound" };
    const before = kept.get(keyOf(space, scope, request.id));
    if (before !== undefined) {
      if (before.text !== request.text) return { kind: "refused", code: "request_id_conflict" };
      return before.task === REJECTED
        ? { kind: "rejected", space, scope }
        : { kind: "replayed", task: before.task };
    }
    const here = space === s2.spaceId ? task === task2.id : tasks.some((t) => t.id === task);
    if (!here) return { kind: "rejected", space, scope };
    if (session && isLaunched(name) && task !== launchOf(name).task) {
      reach("a named task over the session's");
    }
    return { kind: "commit", space, task, scope };
  };

  const call = async (name: AgentName, through: Via, request: Request): Promise<void> => {
    const shell = through === "shell" && isLaunched(name);
    const open = shell ? undefined : bridgeOf(name);
    const expected = expect_(name, shell ? "shell" : "bridge", request, open);
    let actual: Expected;
    try {
      let result: Json;
      if (open === undefined) {
        result = (await opCall(
          host,
          { class: "cli-agent", env: shellEnv(name as Launched) },
          { op: "entry.add", input: request.input, space: s1.spaceId },
        )) as Json;
      } else {
        result = (await opCall(host, bridgeCaller(contextOf(name), MACHINE, open.binding), {
          op: "entry.add",
          input: request.input,
        })) as Json;
      }
      const task = taskIn(open === undefined ? s1.spaceId : open.space, String(result["task"]));
      actual =
        result["replayed"] === true
          ? { kind: "replayed", task }
          : expected.kind === "commit"
            ? { kind: "commit", space: expected.space, task, scope: expected.scope }
            : { kind: "commit", space: "?", task, scope: "?" };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      actual = { kind: "refused", code: error.code };
    }
    const same =
      expected.kind === "rejected"
        ? actual.kind === "refused" && actual.code === "not_found"
        : expected.kind === actual.kind &&
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
      changes.push(`${expected.space}|${request.text}|${expected.task}`);
      if (expected.space === s2.spaceId) reach("a change in the second space");
    }
    if (expected.kind === "rejected") {
      kept.set(keyOf(expected.space, expected.scope, request.id), {
        text: request.text,
        task: REJECTED,
      });
      reach("a task of another space");
    }
    if (expected.kind === "replayed") reach("a replay");
  };

  const requests: Request[] = [];
  let made = 0;
  for (const ev of events) {
    switch (ev.e) {
      case "write": {
        made += 1;
        const text = `Fixture model ${tag} ${String(made)}.`;
        const id = `fixture-model-${tag}-${String(made).padStart(6, "0")}`;
        let task: string | undefined;
        if (ev.agent === "H") {
          // The hand-made entry names the task of the space it works in, or with `other` the
          // task of the space it does not.
          const space = bridgeSpace("H");
          const s1Task = tasks[2]?.id;
          const inSpace =
            space === s1.spaceId ? s1Task : space === s2.spaceId ? task2.id : undefined;
          const outside =
            space === s1.spaceId ? task2.id : space === s2.spaceId ? s1Task : undefined;
          task = ev.task === "other" ? outside : inSpace;
        } else {
          const own = isLaunched(ev.agent) ? launchOf(ev.agent).task : tasks[2]?.id;
          const other = isLaunched(ev.agent) ? tasks[2]?.id : tasks[0]?.id;
          task = ev.task === "none" ? undefined : ev.task === "own" ? own : other;
        }
        const input: Json = {
          kind: "progress",
          text,
          request_id: id,
          ...(task === undefined ? {} : { task }),
        };
        const request: Request = { id, agent: ev.agent, input, text, named: task };
        requests.push(request);
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
        // Counted only when another scope holds the ID in the space the chat writes to.
        const into = bridgeSpace(ev.agent);
        const chat = `bridge:inst-d:${MACHINE}`;
        if (
          [...kept.keys()].some((key) => {
            const [space, scope, id] = key.split("|");
            return space === into && scope !== chat && id === source.id;
          })
        ) {
          reach("another scope's request ID");
        }
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
        if (ev.late) bridgeOf(ev.agent);
        records.remove(launch.id);
        launch.live = false;
        reach("end");
        const last = requests.findLast((r) => r.agent === ev.agent);
        if (ev.late && last !== undefined) await call(ev.agent, "bridge", last);
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
      case "default":
        machineDefault = spaceOf(ev.space);
        break;
    }
  }

  // One bridge process, one space.
  for (const [key, seen] of answers) {
    if (seen.size > 1)
      violations.push(`bridge process ${key} worked in ${String(seen.size)} spaces`);
  }
  // What the spaces kept: every change of this run, on its task in its space, and each receipt
  // under its scope; nothing else.
  for (const [f, space] of [
    [s1, s1.spaceId],
    [s2, s2.spaceId],
  ] as const) {
    const actual = f.reader
      .prepare("SELECT body, task_id FROM log_entries WHERE body LIKE $prefix")
      .all({ prefix: `Fixture model ${tag} %` })
      .map((r) => `${String(r["body"])}|${refOf(String(r["task_id"]))}`)
      .sort();
    const expectedChanges = changes
      .filter((c) => c.startsWith(`${space}|`))
      .map((c) => {
        const [, text, task] = c.split("|");
        return `${String(text)}|${refOf(String(task))}`;
      })
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedChanges)) {
      violations.push(
        `${space} kept ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedChanges)}`,
      );
    }
    const receipts = f.reader
      .prepare("SELECT scope_id, request_id FROM receipts WHERE request_id LIKE $prefix")
      .all({ prefix: `fixture-model-${tag}-%` })
      .map((r) => `${String(r["scope_id"])}|${String(r["request_id"])}`)
      .sort();
    const expectedReceipts = [...kept.keys()]
      .filter((k) => k.startsWith(`${space}|`))
      .map((k) => k.slice(space.length + 1))
      .sort();
    if (JSON.stringify(receipts) !== JSON.stringify(expectedReceipts)) {
      violations.push(
        `${space} kept receipts ${JSON.stringify(receipts)}, expected ${JSON.stringify(expectedReceipts)}`,
      );
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
        fc.asyncProperty(
          defaultSpace,
          fc.array(event, { minLength: 8, maxLength: 40, size: "max" }),
          async (initial, events) => {
            expect(await run(initial, events)).toEqual([]);
          },
        ),
        { numRuns: deep ? 1_000 : 60, seed: 4_221_122, endOnFailure: true },
      );
      for (const what of [
        "restart",
        "end",
        "a replay",
        "a named task over the session's",
        "another scope's request ID",
        "a change in the second space",
        "a task of another space",
        "a held none bound again after a default was set",
        "a held space bound again after the default moved",
        "an open bridge after its agent's end",
      ]) {
        expect(reached.get(what) ?? 0, what).toBeGreaterThan(0);
      }
    },
  );
});
