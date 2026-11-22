// The one rule at the level of one call, under random interleavings of what agents do: the real
// shim host over machine state in memory, the real sessions port and bridges' bind over a grants
// table in memory, the real request path over two storage fixture spaces. A restart is new hosts
// over the same stores. Who made each call and what it meant come from the world: which agent,
// through which tool or which bridge process, whether the agent still runs. The outcome comes
// from what the endpoint answered and what the spaces kept.
//
// Invariants: one bridge process, one space; an open bridge never changes who it is; a request ID
// commits at most once per space, writer scope and request ID; a launched agent whose bridge and
// shell both got its value commits each request exactly once while it lives, through either tool,
// a reconnect, a replaced MCP process and a service restart; two connections of different scopes
// that use the same request ID are independent; after a miss the ordinary checks decide. What
// docs/promises-and-limits.md does not protect (a retry after the agent's end, chats of one app
// sharing request IDs) is accepted, never a failure. Fixture text only.
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
/** The tasks the agents work on, in the first space: references and IDs. */
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

/** The agents of one run. A and P are launched in the first space; D1 and D2 are two chats of one
 * desktop app, H a hand-made entry with no instance and no space. */
const AGENTS = ["A", "P", "D1", "D2", "H"] as const;
type AgentName = (typeof AGENTS)[number];
const LAUNCHED: readonly AgentName[] = ["A", "P"];

type Event =
  | {
      readonly e: "write";
      readonly agent: AgentName;
      readonly via: "bridge" | "shell";
      readonly task: boolean;
    }
  | {
      readonly e: "retry";
      readonly agent: AgentName;
      readonly via: "bridge" | "shell";
      readonly k: number;
    }
  | { readonly e: "borrow"; readonly agent: "D1" | "D2" | "H"; readonly k: number }
  | { readonly e: "reconnect"; readonly agent: AgentName }
  | { readonly e: "replace"; readonly agent: AgentName }
  | { readonly e: "restart" }
  | { readonly e: "end"; readonly agent: "A" | "P" }
  | { readonly e: "revoke"; readonly agent: "A" | "P" }
  | { readonly e: "restore"; readonly agent: "A" | "P" }
  | { readonly e: "default"; readonly space: 0 | 1 | 2 };

const agent = fc.constantFrom(...AGENTS);
const launched = fc.constantFrom<"A" | "P">("A", "P");
const via = fc.constantFrom<"bridge" | "shell">("bridge", "shell");
const event: fc.Arbitrary<Event> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({ e: fc.constant("write" as const), agent, via, task: fc.boolean() }),
  },
  {
    weight: 6,
    arbitrary: fc.record({ e: fc.constant("retry" as const), agent, via, k: fc.nat(6) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      e: fc.constant("borrow" as const),
      agent: fc.constantFrom<"D1" | "D2" | "H">("D1", "D2", "H"),
      k: fc.nat(6),
    }),
  },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("reconnect" as const), agent }) },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("replace" as const), agent }) },
  { weight: 2, arbitrary: fc.constant({ e: "restart" as const }) },
  { weight: 1, arbitrary: fc.record({ e: fc.constant("end" as const), agent: launched }) },
  { weight: 1, arbitrary: fc.record({ e: fc.constant("revoke" as const), agent: launched }) },
  { weight: 2, arbitrary: fc.record({ e: fc.constant("restore" as const), agent: launched }) },
  {
    weight: 1,
    arbitrary: fc.record({
      e: fc.constant("default" as const),
      space: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
    }),
  },
);

/** One request an agent sent, with its input, and every attempt at it. */
interface Request {
  readonly id: string;
  readonly agent: AgentName;
  readonly input: Json;
  readonly text: string;
  readonly attempts: {
    readonly via: "bridge" | "shell";
    /** The agent still ran and its home was registered when the attempt was made. */
    readonly protectedAttempt: boolean;
    readonly outcome:
      | { readonly ok: true; readonly replayed: boolean }
      | { readonly ok: false; readonly code: string };
  }[];
}

/** What the run reached, so a seed that never retries across a restart cannot pass unnoticed. */
const reached = new Map<string, number>();
const reach = (what: string): void => {
  reached.set(what, (reached.get(what) ?? 0) + 1);
};

let runs = 0;

/** One run of the world. Returns the violations it found. */
async function run(events: readonly Event[]): Promise<string[]> {
  runs += 1;
  const tag = `r${String(runs).padStart(4, "0")}`;
  const violations: string[] = [];
  const records = new MemoryRecords();
  const rows: Grant[] = [];
  let defaultSpace: string | undefined;
  const spaces = (): ServedSpace[] => [served(s1, "One"), served(s2, "Two")];

  // The two launched agents: claimed records as the click and the claim leave them, each on a
  // home setup registered for the first space.
  const launches = new Map<"A" | "P", { id: string; ticket: string; row: Grant; live: boolean }>();
  for (const [i, name] of (["A", "P"] as const).entries()) {
    const launch = `la_${(tag + String(i)).padStart(26, "0")}`;
    const ticket = newTicket();
    const home = `/fixture/homes/${name}`;
    const app = name === "P" ? "claude-code" : "codex";
    const instance = `inst-${name.toLowerCase()}`;
    records.put({
      format: 1,
      space: s1.spaceId,
      launch,
      reference: "L7KQ2M",
      task: tasks[i]?.id ?? null,
      createdAt: 1_800_000_000_000 + runs * 10 + i,
      plan: { argv: ["/opt/agent"], folder: null, env: {}, title: "Fixture", afterExit: "close" },
      ticket: {
        hash: secretHash("ticket", launch, ticket),
        issuedAt: 1,
        shimUsed: true,
        bridgeUsed: false,
      },
      attachment: { hash: "a".repeat(64), pid: 4242 + i, startTime: "linux:1" },
      app,
      home,
      ...(name === "P" ? { preset: PRESET } : {}),
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
    launches.set(name, { id: launch, ticket, row, live: true });
  }
  // The desktop app's home, registered for the first space.
  rows.push({
    ...(rows[0] as Grant),
    grant_id: `gr_${(tag + "D").padStart(26, "0")}`,
    attrs: { app: "claude-desktop", home: "/fixture/homes/D", instance: "inst-d", account: "" },
  });
  const presetOf = (name: "A" | "P"): string | undefined =>
    records.get(launches.get(name)?.id ?? "")?.preset;

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

  // Each agent's bridge: its process (a number), the space that process holds, its connection.
  const process = new Map<AgentName, number>(AGENTS.map((a) => [a, 0]));
  const held = new Map<AgentName, string | undefined>();
  const connection = new Map<AgentName, { binding: Binding; scopes: Set<string> } | undefined>();
  const answers = new Map<string, Set<string>>();

  const contextOf = (name: AgentName): JsonObject => {
    const env: Json = {};
    let entry: JsonObject;
    if (name === "A") {
      env["TTASKS_TICKET"] = launches.get("A")?.ticket;
      entry = { space: s1.spaceId, instance: "inst-a", app: "codex" };
    } else if (name === "P") {
      // Allow-list mode: Claude Code hands its MCP servers the preset, not the ticket.
      env["CLAUDE_CODE_SESSION_ID"] = presetOf("P");
      entry = { space: s1.spaceId, instance: "inst-p", app: "claude-code" };
    } else if (name === "D1" || name === "D2") {
      entry = { space: s1.spaceId, instance: "inst-d", app: "claude-desktop" };
    } else {
      entry = { space: null, instance: null, app: null };
    }
    const kept = held.get(name);
    return {
      ...entry,
      cwd: null,
      env,
      parent: { pid: 1 },
      ...(kept === undefined ? {} : { held_space: kept }),
    };
  };
  const shellEnv = (name: AgentName): Record<string, string> => {
    const env: Record<string, string> = { CLAUDECODE: "1" };
    const launch = name === "A" || name === "P" ? launches.get(name) : undefined;
    if (launch !== undefined) env["TTASKS_TICKET"] = launch.ticket;
    const preset = name === "P" ? presetOf("P") : undefined;
    if (preset !== undefined) env["CLAUDE_CODE_SESSION_ID"] = preset;
    return env;
  };

  /** The bridge connection of `name`, bound now when it has none, as the forwarder binds. */
  const bridgeOf = (name: AgentName) => {
    let open = connection.get(name);
    if (open === undefined) {
      const conn = { context: contextOf(name) };
      const answer = bridges.bind(conn);
      const binding = bridges.attach(conn);
      if (binding === undefined) throw new Error("no binding");
      const space = typeof answer["space"] === "string" ? answer["space"] : undefined;
      const key = `${name}#${String(process.get(name))}`;
      const seen = answers.get(key) ?? new Set();
      if (space !== undefined) seen.add(space);
      answers.set(key, seen);
      if (space !== undefined) held.set(name, space);
      open = { binding, scopes: new Set() };
      connection.set(name, open);
    }
    return { open, context: contextOf(name) };
  };

  /** The writer scopes a request ID has receipts under in a space. */
  const receipts = (f: Fixture, request: string): string[] =>
    f.reader
      .prepare("SELECT scope_id FROM receipts WHERE request_id = $request ORDER BY scope_id")
      .all({ request })
      .map((r) => String(r["scope_id"]));
  /** How often a request's text was committed in a space. */
  const commits = (f: Fixture, text: string): number =>
    Number(
      f.reader
        .prepare("SELECT count(*) AS n FROM log_entries WHERE body = $body")
        .get({ body: text })?.["n"] ?? 0,
    );

  const requests: Request[] = [];
  /** The launched agents' request IDs each chat scope reused. */
  const borrowed = new Map<string, Set<string>>();
  let made = 0;
  const call = async (name: AgentName, through: "bridge" | "shell", request: Request) => {
    const shell = through === "shell" && name !== "D1" && name !== "D2" && name !== "H";
    const launch = name === "A" || name === "P" ? launches.get(name) : undefined;
    const protectedAttempt = launch !== undefined && launch.live && launch.row.revoked_at === null;
    const before = new Set([...receipts(s1, request.id), ...receipts(s2, request.id)]);
    let outcome: Request["attempts"][number]["outcome"];
    try {
      let result: Json;
      if (shell) {
        result = (await opCall(
          host,
          { class: "cli-agent", env: shellEnv(name) },
          { op: "entry.add", input: request.input, space: s1.spaceId },
        )) as Json;
      } else {
        const { open, context } = bridgeOf(name);
        result = (await opCall(host, bridgeCaller(context, MACHINE, open.binding), {
          op: "entry.add",
          input: request.input,
        })) as Json;
        const after = [...receipts(s1, request.id), ...receipts(s2, request.id)];
        for (const scope of after) if (!before.has(scope)) open.scopes.add(scope);
        if (open.scopes.size > 1) {
          violations.push(
            `${name}'s open bridge wrote under two scopes: ${[...open.scopes].join(", ")}`,
          );
        }
      }
      outcome = { ok: true, replayed: result["replayed"] === true };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      outcome = { ok: false, code: error.code };
    }
    request.attempts.push({ via: through, protectedAttempt, outcome });
  };

  for (const ev of events) {
    switch (ev.e) {
      case "write": {
        made += 1;
        const text = `Fixture model ${tag} ${String(made)}.`;
        const id = `fixture-model-${tag}-${String(made).padStart(6, "0")}`;
        const own = tasks[AGENTS.indexOf(ev.agent) > 1 ? 2 : AGENTS.indexOf(ev.agent)];
        const input: Json = {
          kind: "progress",
          text,
          request_id: id,
          ...(ev.task ? { task: own?.ref } : {}),
        };
        const request: Request = { id, agent: ev.agent, input, text, attempts: [] };
        requests.push(request);
        await call(ev.agent, ev.via, request);
        // After a miss the ordinary checks decide: a chat that names no task is refused.
        const last = request.attempts.at(-1)?.outcome;
        if (!ev.task && !LAUNCHED.includes(ev.agent) && last?.ok === true) {
          violations.push(`${ev.agent}'s write without a task was taken`);
        }
        break;
      }
      case "retry": {
        const own = requests.filter((r) => r.agent === ev.agent);
        const request = own[ev.k % Math.max(own.length, 1)];
        if (request === undefined) break;
        const previous = request.attempts.at(-1)?.via;
        if (previous !== undefined && previous !== ev.via) reach("retry through the other tool");
        await call(ev.agent, ev.via, request);
        break;
      }
      case "borrow": {
        // A chat that reuses a launched agent's request ID for its own change, on its own task.
        const theirs = requests.filter((r) => LAUNCHED.includes(r.agent));
        const source = theirs[ev.k % Math.max(theirs.length, 1)];
        if (source === undefined) break;
        made += 1;
        const text = `Fixture model ${tag} ${String(made)} borrowed.`;
        const request: Request = {
          id: source.id,
          agent: ev.agent,
          input: { kind: "progress", text, request_id: source.id, task: tasks[2]?.ref },
          text,
          attempts: [],
        };
        // The chats of one app share one scope: an ID one of them used before is theirs already.
        const scope = ev.agent === "H" ? "H" : "D";
        const usedHere = borrowed.get(scope) ?? new Set<string>();
        const fresh = !usedHere.has(source.id);
        usedHere.add(source.id);
        borrowed.set(scope, usedHere);
        await call(ev.agent, "bridge", request);
        const outcome = request.attempts[0]?.outcome;
        const space = connection.get(ev.agent)?.binding;
        const inFirst = space?.kind === "none" && space.space === s1.spaceId;
        if (fresh && inFirst && outcome?.ok === false && outcome.code === "request_id_conflict") {
          violations.push(`${ev.agent} was refused another scope's request ID`);
        }
        if (fresh && outcome?.ok === true) reach("independent scopes");
        break;
      }
      case "reconnect":
        connection.set(ev.agent, undefined);
        break;
      case "replace":
        connection.set(ev.agent, undefined);
        held.set(ev.agent, undefined);
        process.set(ev.agent, (process.get(ev.agent) ?? 0) + 1);
        break;
      case "restart":
        for (const a of AGENTS) connection.set(a, undefined);
        start();
        reach("restart");
        break;
      case "end": {
        const launch = launches.get(ev.agent);
        if (launch === undefined || !launch.live) break;
        records.remove(launch.id);
        launch.live = false;
        reach("end");
        break;
      }
      case "revoke":
      case "restore": {
        const launch = launches.get(ev.agent);
        if (launch === undefined) break;
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
        defaultSpace = ev.space === 0 ? undefined : ev.space === 1 ? s1.spaceId : s2.spaceId;
        break;
    }
  }

  // One bridge process, one space.
  for (const [key, seen] of answers) {
    if (seen.size > 1)
      violations.push(`bridge process ${key} worked in ${String(seen.size)} spaces`);
  }
  for (const request of requests) {
    const scopes = [...receipts(s1, request.id), ...receipts(s2, request.id)];
    // At most once per space, writer scope and request ID.
    if (new Set(scopes).size !== scopes.length)
      violations.push(`${request.id}: two receipts in one scope`);
    for (const f of [s1, s2]) {
      const committed = commits(f, request.text);
      const applied = receipts(f, request.id).length;
      if (committed > applied)
        violations.push(`${request.id}: ${String(committed)} commits, ${String(applied)} receipts`);
    }
    // A launched agent while it lives: exactly once, whichever tool, connection or service start.
    const protectedOnly =
      request.attempts.length > 0 && request.attempts.every((a) => a.protectedAttempt);
    if (LAUNCHED.includes(request.agent) && protectedOnly) {
      const taken = request.attempts.filter((a) => a.outcome.ok);
      const total = commits(s1, request.text) + commits(s2, request.text);
      if (taken.length > 0 && total !== 1)
        violations.push(`${request.id}: ${String(total)} commits while its agent lived`);
      const fresh = taken.filter((a) => a.outcome.ok && !a.outcome.replayed);
      if (fresh.length > 1)
        violations.push(`${request.id}: committed by ${String(fresh.length)} attempts`);
      const refused = request.attempts.filter((a) => !a.outcome.ok);
      if (refused.length > 0) {
        violations.push(
          `${request.id}: refused while its agent lived and was registered: ${refused.map((a) => (a.outcome.ok ? "" : a.outcome.code)).join(", ")}`,
        );
      }
      if (taken.length > 1) reach("a retry replayed while the agent lived");
    }
    if (request.attempts.some((a) => !a.protectedAttempt) && LAUNCHED.includes(request.agent)) {
      reach("a retry after the end or a revoke");
    }
  }
  return violations;
}

describe("[A3.3.7.binding.model] who a connection is, under random interleavings of what agents do", () => {
  test(
    "the invariants hold, and what is not protected is accepted",
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
        "retry through the other tool",
        "restart",
        "end",
        "independent scopes",
        "a retry replayed while the agent lived",
        "a retry after the end or a revoke",
      ]) {
        expect(reached.get(what) ?? 0, what).toBeGreaterThan(0);
      }
    },
  );
});
