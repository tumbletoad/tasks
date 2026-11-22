// The grant gate (A3 3.7.4, 3.7.8, 3.7.9) on a service in this process with two spaces, Mira and
// Life. Agent homes are registered and revoked as `ttasks setup agents` does, through the user's
// `setup/home_grant` and `setup/home_revoke`. Every agent connection is made as a bridge or a shell
// makes one, through the local endpoint (agents.ts). The negative cases are proved as carefully as
// the positive ones: a refused call must not touch the other space's reader or writer at all.
// Fixture text and temporary folders only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { bridgePrincipal, renderError } from "../src/mcp/index.ts";
import { homeGate } from "../src/hub/home-gate.ts";
import type { Grant } from "../src/local/index.ts";
import { grantRefused, MANUAL_INSTANCE, opCall, Slot, type ServedSpace } from "../src/ops/index.ts";
import { bridge, launchContext, shell, type Agent, type HostPatch } from "./agents.ts";
import { contractWorld, type ContractWorld, type WorldLaunch } from "./contract/suite.ts";
import { diagnostics, readLog } from "./harness.ts";
import { bridgeContext, openMcp, RawMcp, textOf } from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome, revokeHome } from "./ops-helpers.ts";

type Json = Record<string, unknown>;
const LONG = 180_000;

/** A3 3.5's body for a space the agent home is not granted (A3 3.7.8). */
const GRANT: ErrorBody = {
  code: "forbidden",
  message: "This agent is not registered for this space.",
  hint: `Ask the user to run: ${CLI_NAME} setup agents`,
  data: { rule: "grant" },
};

let w: ContractWorld & { root: string };
let life: string;
/** Instances whose rows the tests change: one per test, so no test depends on another's rows. */
const rows = new Map<string, string>();

let n = 0;
const rid = () => `fixture-grant-${String((n += 1)).padStart(6, "0")}`;

/** The person's call, in Mira unless another space is named: two spaces are served. */
async function user(op: string, input: Json, space?: string): Promise<Json> {
  return (await opCall(
    w.service.ops,
    { class: "cli-interactive", env: {} },
    { op, input, space: space ?? w.space },
  )) as Json;
}

async function asUser(method: string, params: Json): Promise<Json> {
  const session = await classSession(w.home, w.path, "cli-interactive");
  try {
    return (await session.call(method, params, { timeoutMs: 120_000 })) as Json;
  } finally {
    session.close();
  }
}

const grant = async (instance: string, space: string, account?: string): Promise<string> => {
  const id = await grantHome(w.home, w.path, {
    instance,
    space,
    ...(account === undefined ? {} : { account }),
  });
  rows.set(instance, id);
  return id;
};

beforeAll(async () => {
  w = await contractWorld("gate");
  await user("task.add", {
    tasks: ["Fixture task one", "Fixture task two", "Fixture task three", "Fixture task four"].map(
      (title) => ({ title }),
    ),
    request_id: rid(),
  });
  const created = await asUser("space/create", {
    name: "Life",
    path: join(w.root, "s", "life"),
    ref_prefix: "L",
  });
  life = String((created["space"] as Json)["id"]);
  await user("task.add", { tasks: [{ title: "Fixture life task" }], request_id: rid() }, life);
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** A3 3.5's grant refusal as a bridge's agent reads it. */
const GRANT_TEXT = renderError(GRANT);

/** A bridge of no launch: the entry of a home, `extra` naming its instance and space. */
const connect = (extra: JsonObject): Promise<Agent<string>> => bridge(w, bridgeContext(extra));

/** The bridge a launched agent's app starts: the entry of the launch's home, with its ticket. */
const launched = (launch: WorldLaunch, extra: JsonObject = {}): Promise<Agent<string>> =>
  bridge(w, { ...launchContext(w.space, launch), ...extra });

/** The refusal text of a bridge's call. */
const refusedText = async (
  agent: Agent<string>,
  op: string,
  input: Json = {},
  host?: HostPatch,
): Promise<string> => (await agent.refusal(op, input, host === undefined ? {} : { host })).text;

/**
 * The request path with `space`'s reader and writer replaced by traps: a call that reads from the
 * space or writes to it touches one, which is recorded and fails the call.
 */
function trapped(space: string): { host: HostPatch; touched: string[] } {
  const touched: string[] = [];
  const trap = (what: string): never =>
    new Proxy(
      {},
      {
        get(_target, key) {
          touched.push(`${what}.${String(key)}`);
          throw new Error(`the ${what} of the refused space was touched`);
        },
      },
    ) as never;
  return {
    touched,
    host: (own) => ({
      spaces: () =>
        own
          .spaces()
          .map((s) =>
            s.id === space ? { ...s, reader: trap("reader"), writer: trap("writer") } : s,
          ),
    }),
  };
}

/** Every agent call a home could make into a space, each needing a read or a write there. */
const CALLS: readonly [string, Json][] = [
  ["space.status", {}],
  ["task.get", { task: "M-1" }],
  ["task.get", { task: "M-1", sections: ["log", "history"] }],
  ["entry.add", { task: "M-1", kind: "progress", text: "Fixture progress, refused." }],
  ["task.reopen", { task: "M-1", reason: "Fixture reason, refused.", base: "1.1.00000000" }],
  [
    "task.update",
    {
      task: "M-1",
      set: { summary: "Fixture summary, refused." },
      base: "1.1.00000000",
      reason: "Fixture.",
    },
  ],
  ["receipt.get", { request: "fixture-grant-receipt-000001" }],
];

const withRequest = (input: Json): Json =>
  Object.hasOwn(input, "text") || Object.hasOwn(input, "reason")
    ? { ...input, request_id: rid() }
    : input;

/** The log entries of a task, newest first, with their authors. */
async function logOf(task: string, space?: string): Promise<Json[]> {
  const read = await user("task.get", { task, sections: ["log"] }, space);
  return ((read["sections"] as Json)["log"] as Json[] | undefined) ?? [];
}

/** A launch's evidence: `bound_at` is there once a bridge's binding was recorded on it. */
async function evidenceOf(id: string): Promise<{ readonly bound_at?: number }> {
  const intent = await w.service.launches.read(w.space, id);
  return intent?.evidence ?? {};
}

describe("[A3.3.7.grant.space] a home granted one space reaches no other", () => {
  test(
    "its own space works; the other, named by ID or by name, is forbidden with rule grant before its reader or writer is touched",
    { timeout: LONG },
    async () => {
      // The service's own refusal is A3's body.
      expect(grantRefused().toBody()).toEqual(GRANT);
      await grant("home-life", life);

      const own = await connect({ instance: "home-life", space: life });
      expect(await own.call("space.status")).toContain("Space: Life (L)");
      expect(
        await own.call("entry.add", {
          task: "L-1",
          kind: "progress",
          text: "Fixture progress in the granted space.",
          request_id: rid(),
        }),
      ).toMatch(/^logged \S+ on L-1 /);
      expect((await logOf("L-1", life))[0]?.["author"]).toBe("agent:home-life");
      await own.close();

      const before = JSON.stringify(await logOf("M-1"));
      for (const [named, why] of [
        [w.space, "by ID"],
        ["Mira", "by name"],
        ["mira", "by name, any case"],
      ] as const) {
        const other = await connect({ instance: "home-life", space: named });
        const { host, touched } = trapped(w.space);
        // receipt.get has no tool: no bridge can call it.
        for (const [op, input] of CALLS.filter(([op]) => op !== "receipt.get")) {
          expect(await refusedText(other, op, withRequest(input), host), `${why}: ${op}`).toBe(
            GRANT_TEXT,
          );
        }
        expect(touched, why).toEqual([]);
        await other.close();
      }
      // Nothing reached Mira.
      expect(JSON.stringify(await logOf("M-1"))).toBe(before);
    },
  );

  test(
    "a launch reference, a ticket or a task of the other space binds nothing and reads nothing there",
    { timeout: LONG },
    async () => {
      await grant("home-life", life);
      await grant("home-mira", w.space);

      // A launch reference of Mira, asked on a connection of Life: looked for in Life only.
      const launch = await w.launch("M-2");
      const own = await connect({ instance: "home-life", space: life });
      expect((await own.refusal("task.get", { launch: launch.reference })).code).toBe(
        "launch_unknown",
      );
      // The same home's connection whose entry names Mira: refused before the launch is read.
      const pinned = await connect({ instance: "home-life", space: w.space });
      const { host, touched } = trapped(w.space);
      expect(await refusedText(pinned, "task.get", { launch: launch.reference }, host)).toBe(
        GRANT_TEXT,
      );
      expect(touched).toEqual([]);
      expect((await evidenceOf(launch.id)).bound_at).toBeUndefined();

      // A ticket of Mira at the bind frame: from an entry with no space (two spaces served, no
      // default, so nothing is pinned before the ticket) and from one that names Mira.
      const ticketed = await w.launch("M-3");
      const loose = await connect({
        instance: "home-life",
        env: { TTASKS_TICKET: ticketed.ticket },
      });
      expect(loose.binding?.["state"]).toBe("unbound");
      const named = await connect({
        instance: "home-life",
        space: w.space,
        env: { TTASKS_TICKET: ticketed.ticket },
      });
      expect(named.binding?.["state"]).toBe("unbound");
      expect(
        readLog(w.home).filter(
          (e) =>
            e["ev"] === "binding.ignored" && e["input"] === "ticket" && e["reason"] === "grant",
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect((await evidenceOf(ticketed.id)).bound_at).toBeUndefined();

      // A task of Mira by its ID, asked on Life's connection: not found there, nothing of it said.
      const mira = await user("task.get", { task: "M-1", sections: ["history"] });
      const id = String((mira["task"] as Json)["id"]);
      const missing = await own.refusal("task.get", { task: id });
      expect(missing.code).toBe("not_found");
      expect(missing.text).not.toContain("Fixture task one");
      expect((await own.refusal("task.get", { task: "M-1" })).code).toBe("not_found");

      // Neither the reference nor the ticket was used up: Mira's own home binds with the
      // reference, and the launch's own bridge with the ticket.
      const right = await connect({ instance: "home-mira", space: w.space });
      const read = await right.call("task.get", { launch: launch.reference });
      expect(read).toContain("Session: bound to this task by this call");
      expect(read).toContain("M-2");
      const rightTicket = await launched(ticketed);
      expect(rightTicket.binding?.["state"]).toBe("bound");
      for (const agent of [own, pinned, loose, named, right, rightTicket]) await agent.close();
    },
  );
});

describe("[A3.3.7.grant.revoke] a revoked row stops the next call of every connection of its home", () => {
  test(
    "an open unbound connection, a bound one, one bound by its ticket, a resumed handle, a CLI call acting as the session and a real mcp mode connection: all refused at their next call; registered again, they go on as they were",
    { timeout: LONG },
    async () => {
      const instance = "home-revoke";
      const row = await grant(instance, w.space);
      const unbound = await connect({ instance, space: w.space });
      expect(await unbound.call("space.status")).toContain("Session: not bound");
      const bound = await connect({ instance, space: w.space });
      expect(await bound.call("task.get", { task: "M-4", bind: true })).toContain(
        "Session: bound to this task by this call",
      );
      // A launched agent: its bridge, and its shell acting as its session. Its home's row is
      // revoked with the other.
      const launch = await w.launch("M-1");
      const ticketed = await launched(launch);
      expect(ticketed.binding?.["state"]).toBe("bound");
      const cli = await shell(w, { TTASKS_TICKET: launch.ticket });
      const wire = new RawMcp(
        await openMcp(w.home, w.path, bridgeContext({ space: w.space, instance })),
      );
      try {
        expect(await cli.call("space.status")).toMatchObject({ session: { state: "bound" } });
        await wire.initialize();
        const status = async () =>
          (await wire.request("tools/call", { name: "status", arguments: {} })).message["result"];
        expect(textOf(await status())).toContain("Space: Mira (M)");

        expect(await revokeHome(w.home, w.path, [row, launch.row ?? ""])).toBe(2);

        for (const [agent, why] of [
          [unbound, "unbound"],
          [bound, "bound by task"],
          [ticketed, "bound by ticket"],
        ] as const) {
          expect(await refusedText(agent, "space.status"), why).toBe(GRANT_TEXT);
          expect(
            await refusedText(agent, "entry.add", {
              task: "M-1",
              kind: "progress",
              text: "Fixture progress after the revoke.",
              request_id: rid(),
            }),
            why,
          ).toBe(GRANT_TEXT);
        }
        expect((await cli.refusal("space.status")).body).toEqual(GRANT);
        const refused = (await status()) as Json;
        expect(refused["isError"]).toBe(true);
        expect(textOf(refused)).toBe(GRANT_TEXT);

        // The bound session's handle still restores its binding, and its calls are refused too.
        await bound.close();
        const resumed = await connect({
          instance,
          space: w.space,
          resume: { handle: bound.binding?.["handle"] },
        });
        expect(resumed.binding?.["state"]).toBe("bound");
        expect(await refusedText(resumed, "task.get")).toBe(GRANT_TEXT);

        // Registered again: the connections and the sessions go on as they were.
        await grant(instance, w.space);
        await grantHome(w.home, w.path, { instance: launch.instance, space: w.space });
        expect(await resumed.call("task.get")).toContain("M-4");
        expect(
          await ticketed.call("entry.add", {
            kind: "progress",
            text: "Fixture progress, registered again.",
            request_id: rid(),
          }),
        ).toMatch(/^logged \S+ on M-1 /);
        expect(await cli.call("space.status")).toMatchObject({ session: { state: "bound" } });
        expect(textOf(await status())).toContain("Space: Mira (M)");
        for (const agent of [unbound, ticketed, resumed]) await agent.close();
      } finally {
        await cli.close();
        wire.close();
      }
    },
  );
});

describe("[A3.3.7.grant.precedence] grant and binding: which refusal wins", () => {
  test(
    "a session in a granted space that names another space gets binding; once its space is no longer granted, every call gets grant, whatever it names",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-2");
      const agent = await launched(launch);
      expect(agent.binding?.["state"]).toBe("bound");
      const cli = await shell(w, { TTASKS_TICKET: launch.ticket });
      const call = (space?: string): Promise<ErrorBody | undefined> =>
        cli.refusal("space.status", {}, space === undefined ? {} : { space }).then(
          (refusal) => refusal.body,
          () => undefined,
        );
      try {
        expect(await cli.call("space.status")).toMatchObject({ session: { state: "bound" } });
        expect(await call(life)).toMatchObject({ code: "forbidden", data: { rule: "binding" } });
        // Not even the user's other space by name tells the session anything else.
        expect(await call("Life")).toMatchObject({ code: "forbidden", data: { rule: "binding" } });

        await revokeHome(w.home, w.path, [launch.row ?? ""]);
        expect(await call()).toEqual(GRANT);
        expect(await call(w.space)).toEqual(GRANT);
        expect(await call(life)).toEqual(GRANT);
        expect(await refusedText(agent, "space.status")).toBe(GRANT_TEXT);
      } finally {
        await cli.close();
        await agent.close();
      }
    },
  );
});

describe("[A3.3.7.grant.scope] the unbound writer scope is the home's grant row", () => {
  test(
    "two connections of the home share it, it holds when the row is replaced or revoked and made again, and it stays the earlier scope once the connection binds: a retry never writes twice",
    { timeout: LONG },
    async () => {
      const instance = "home-scope";
      const first = await grant(instance, w.space);
      const a = await connect({ instance, space: w.space });
      const b = await connect({ instance, space: w.space });
      const input = {
        task: "M-3",
        kind: "progress",
        text: "Fixture progress under the home's own scope.",
        request_id: rid(),
      };
      const written = await a.call("entry.add", input);
      expect(written).toMatch(/^logged \S+ on M-3 /);
      const replayed = `${written} (replayed)`;
      expect(await b.call("entry.add", input)).toBe(replayed);

      // Another answer replaces the home's row (setup keeps one live row per home).
      const second = await grant(instance, w.space, "fixture-account");
      expect(second).not.toBe(first);
      expect(await a.call("entry.add", input)).toBe(replayed);

      // Revoked and registered again: a new row, the same scope.
      await revokeHome(w.home, w.path, [second]);
      expect(await refusedText(a, "entry.add", input)).toBe(GRANT_TEXT);
      await grant(instance, w.space);
      expect(await b.call("entry.add", input)).toBe(replayed);

      // Bound now: the unbound scope is its earlier scope (A3 3.7.9).
      expect(await a.call("task.get", { task: "M-3", bind: true })).toContain(
        "Session: bound to this task by this call",
      );
      expect(await a.call("entry.add", input)).toBe(replayed);

      const log = JSON.stringify(await logOf("M-3"));
      expect(log.split(input.text).length - 1).toBe(1);
      await a.close();
      await b.close();
    },
  );
});

describe("[A3.3.7.grant.unregistered] a home with no row, and an entry without --instance", () => {
  test(
    "a home no row names is refused with the command that registers it; a hand-made entry acts in the machine's default space only; nothing of a folder, ticket, reference or task reaches a refusal or the log",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-4");
      // Another home's bridge inside the launched agent, with its ticket.
      const stranger = await launched(launch, { instance: "never-registered" });
      expect(stranger.binding?.["state"]).toBe("unbound");
      const refusal = await stranger.refusal("task.get", { launch: launch.reference });
      expect(refusal.text).toBe(GRANT_TEXT);
      expect(refusal.text).toContain(`${CLI_NAME} setup agents`);
      await stranger.close();

      // A3 3.7.4: an entry without --instance is `agent:manual`, in the machine's default space.
      // Two spaces and no default yet: neither is the machine's default.
      const manual = await connect({ instance: null, space: w.space });
      expect(await refusedText(manual, "space.status")).toBe(GRANT_TEXT);
      await asUser("space/use", { space: w.space });
      expect(await manual.call("space.status")).toContain("Space: Mira (M)");
      expect(
        await manual.call("entry.add", {
          task: "M-4",
          kind: "progress",
          text: "Fixture progress from a hand-made entry.",
          request_id: rid(),
        }),
      ).toMatch(/^logged /);
      expect((await logOf("M-4"))[0]?.["author"]).toBe("agent:manual");
      // An instance that is not an instance ID is a hand-made entry as well.
      const odd = await connect({ instance: "Not An Instance!", space: life });
      expect(await refusedText(odd, "space.status")).toBe(GRANT_TEXT);
      const manualLife = await connect({ instance: null, space: life });
      expect(await refusedText(manualLife, "space.status")).toBe(GRANT_TEXT);
      // Without --space too: the default space is its first call's.
      const plain = await connect({ instance: null });
      expect(await plain.call("space.status")).toContain("Space: Mira (M)");
      for (const agent of [manual, odd, manualLife, plain]) await agent.close();

      // Nothing a refused call or a bind carried is in the log or a crash file.
      const homes = join(w.home, "agent-homes");
      for (const file of diagnostics(w.home)) {
        for (const secret of [launch.ticket, launch.reference, homes, "Fixture progress"]) {
          expect(file.text, file.file).not.toContain(secret);
        }
      }
      // A refusal says the same whichever home or space it is about.
      expect(JSON.stringify(GRANT)).not.toMatch(/sp_|agent-homes|L[0-9A-Z]{5}/u);
    },
  );
});

describe("[A3.3.7.grant.revoke] a revoked row stops the next call of every connection of its home", () => {
  test(
    "a session is its home's: another home's connection presenting its ticket again binds nothing, and a call on a session is refused once the session's home or the connection's home is not granted",
    { timeout: LONG },
    async () => {
      const y = await grant("home-session-y", w.space);
      const launch = await w.launch("M-2");
      const x = launch.row ?? "";
      const own = await launched(launch);
      expect(own.binding?.["state"]).toBe("bound");
      await own.close();
      // No connection of the session is open and its agent runs, so rule 2 honours the ticket
      // again: for the session's own instance only, as a handle is.
      const other = await launched(launch, { instance: "home-session-y" });
      expect(other.binding?.["state"]).toBe("unbound");
      expect(
        readLog(w.home).some(
          (e) =>
            e["ev"] === "binding.ignored" && e["input"] === "ticket" && e["reason"] === "instance",
        ),
      ).toBe(true);
      expect(await other.call("space.status")).toContain("Session: not bound");
      await other.close();
      const again = await launched(launch);
      expect(again.binding?.["state"]).toBe("bound");
      // The endpoint gives no connection's session out: the service's own record of it is read.
      const session = w.service.bindings.sessionOfLaunch(launch.id);
      if (session === undefined) throw new Error("the session's own home did not bind");

      // A slot that carries another home's session (a record made before that rule): its calls
      // need both homes' rows.
      const carried = new Slot({
        kind: "bridge",
        instance: "home-session-y",
        origin: "mcp",
        space: session.space,
        session,
      });
      const call = () =>
        opCall(
          w.service.ops,
          {
            class: "bridge",
            env: {},
            principal: bridgePrincipal(bridgeContext({ instance: "home-session-y" }), "m_x"),
            home: "home-session-y",
            binding: carried,
          },
          { op: "space.status", input: {} },
        ).then(
          () => undefined,
          (e: unknown) => (e instanceof AppError ? e.toBody() : e),
        );
      expect(await call()).toBeUndefined();
      await revokeHome(w.home, w.path, [x]);
      expect(await call()).toEqual(GRANT);
      expect(await refusedText(again, "space.status")).toBe(GRANT_TEXT);
      await grantHome(w.home, w.path, { instance: launch.instance, space: w.space });
      expect(await call()).toBeUndefined();
      await revokeHome(w.home, w.path, [y]);
      expect(await call()).toEqual(GRANT);
      expect(await again.call("space.status")).toContain("Session: bound to M-2");
      await again.close();
    },
  );
});

describe("[A3.3.7.grant.unregistered] a home with no row, and an entry without --instance", () => {
  test(
    "manual is the hand-made entry's alone: setup refuses to register it, and a row of it gives no connection anything",
    { timeout: LONG },
    async () => {
      const refused = await grantHome(w.home, w.path, {
        instance: MANUAL_INSTANCE,
        space: life,
      }).then(
        () => undefined,
        (e: unknown) => errorOf(e),
      );
      expect(refused).toMatchObject({
        code: "invalid_input",
        data: { issues: [{ path: "instance" }] },
      });
      // A row of it made before setup refused the word counts for nothing: the hand-made entry
      // keeps the machine's default space only, and no revoked home keeps that.
      const row: Grant = {
        grant_id: `gr_${"0".repeat(26)}`,
        kind: "agent_home",
        principal: "user",
        spaces: [life],
        scopes: [],
        token_hash: null,
        attrs: { app: "codex", home: "fixture-home", instance: MANUAL_INSTANCE, account: "" },
        created_at: new Date().toISOString(),
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      };
      const gate = homeGate({
        grants: () => ({ list: () => [row] }),
        spaces: () => [
          { id: w.space, state: "open" },
          { id: life, state: "open" },
        ],
        defaultSpace: () => w.space,
      });
      expect(gate.may(MANUAL_INSTANCE, life)).toBe(false);
      expect(gate.may(MANUAL_INSTANCE, w.space)).toBe(true);
      // The configured default counts whether or not it is served now: the request path then says
      // `space_unavailable` or `ambiguous` for it, not that the entry is not registered.
      const away = `sp_${"4".repeat(26)}`;
      const unserved = homeGate({
        grants: () => ({ list: () => [] }),
        spaces: () => [{ id: life, state: "open" }],
        defaultSpace: () => away,
      });
      expect(unserved.may(MANUAL_INSTANCE, away)).toBe(true);
      expect(unserved.may(MANUAL_INSTANCE, life)).toBe(false);
      // No default: the one space served, and with two none.
      const one = homeGate({
        grants: () => ({ list: () => [] }),
        spaces: () => [{ id: life, state: "open" }],
        defaultSpace: () => undefined,
      });
      expect(one.may(MANUAL_INSTANCE, life)).toBe(true);
      const two = homeGate({
        grants: () => ({ list: () => [] }),
        spaces: () => [
          { id: w.space, state: "open" },
          { id: life, state: "open" },
        ],
        defaultSpace: () => undefined,
      });
      expect(two.may(MANUAL_INSTANCE, life)).toBe(false);
    },
  );

  test(
    "one home per instance: setup refuses an instance another home's live row holds, and an instance two live rows hold is refused rather than given both",
    { timeout: LONG },
    async () => {
      const first = await grant("home-one", life);
      const other = async (app: string, folder: string) => {
        const session = await classSession(w.home, w.path, "cli-interactive");
        try {
          return await session
            .call(
              "setup/home_grant",
              {
                app,
                home: join(w.home, "agent-homes", folder),
                instance: "home-one",
                account: "",
                space: life,
              },
              { timeoutMs: 60_000 },
            )
            .then(
              () => undefined,
              (e: unknown) => errorOf(e),
            );
        } finally {
          session.close();
        }
      };
      for (const [app, folder] of [
        ["codex", "another-codex-home"],
        ["claude-code", "home-one"],
      ] as const) {
        expect(await other(app, folder), `${app} ${folder}`).toMatchObject({
          code: "invalid_input",
          data: { issues: [{ path: "instance" }] },
        });
      }
      // The home's own row is kept, and its connection works.
      const agent = await connect({ instance: "home-one", space: life });
      expect(await agent.call("space.status")).toContain("Space: Life (L)");
      await agent.close();
      // Freed by removing that home (whose entry `--remove` takes out), the instance may be
      // registered for another.
      await revokeHome(w.home, w.path, [first]);
      expect(await other("codex", "another-codex-home")).toBeUndefined();

      // Two live rows of one instance (made before setup refused it): neither home's grant counts.
      const rowOf = (n: number, space: string): Grant => ({
        grant_id: `gr_${String(n).repeat(26)}`,
        kind: "agent_home",
        principal: "user",
        spaces: [space],
        scopes: [],
        token_hash: null,
        attrs: { app: "codex", home: `fixture-home-${String(n)}`, instance: "shared", account: "" },
        created_at: new Date().toISOString(),
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      });
      const gate = (rows: Grant[]) =>
        homeGate({
          grants: () => ({ list: () => rows }),
          spaces: () => [],
          defaultSpace: () => undefined,
        });
      expect(gate([rowOf(1, life)]).may("shared", life)).toBe(true);
      expect(gate([rowOf(1, life), rowOf(2, life)]).may("shared", life)).toBe(false);
      expect(gate([rowOf(1, life), rowOf(2, w.space)]).may("shared", w.space)).toBe(false);
      const revoked = { ...rowOf(2, w.space), revoked_at: new Date().toISOString() };
      expect(gate([rowOf(1, life), revoked]).may("shared", life)).toBe(true);
    },
  );
});

describe("[A3.3.7.grant.space] a home granted one space reaches no other", () => {
  test(
    "an entry without --space whose machine default is another space is refused at its first call and pins nothing, so the person's fix takes effect at once",
    { timeout: LONG },
    async () => {
      await grant("home-life", life);
      await asUser("space/use", { space: w.space });
      const agent = await connect({ instance: "home-life" });
      expect(agent.binding?.["space"]).toBeNull();
      expect(await refusedText(agent, "space.status")).toBe(GRANT_TEXT);
      await asUser("space/use", { space: life });
      expect(await agent.call("space.status")).toContain("Space: Life (L)");
      // Its first allowed call pinned Life: a later default leaves it there.
      await asUser("space/use", { space: w.space });
      expect(await agent.call("space.status")).toContain("Space: Life (L)");
      await asUser("space/use", { space: life });
      await agent.close();
    },
  );

  test(
    "a target that does not resolve says nothing of which spaces exist: a name no space has, or no space named and no default, is the grant refusal; a space the home is granted keeps its own answer",
    { timeout: LONG },
    async () => {
      await grant("home-target", life);
      const unknown = await connect({ instance: "home-target", space: "No Such Space" });
      expect(await refusedText(unknown, "space.status")).toBe(GRANT_TEXT);
      // Its home's space by name works.
      const byName = await connect({ instance: "home-target", space: "life" });
      expect(await byName.call("space.status")).toContain("Space: Life (L)");

      // No --space: two spaces served, so nothing is pinned at the bind.
      const plain = await connect({ instance: "home-target" });
      const host =
        (defaultSpace: string | undefined, served?: readonly ServedSpace[]): HostPatch =>
        (own) => ({
          spaces: () => served ?? own.spaces(),
          defaultSpace: () => defaultSpace,
        });
      // No default: neither "name the space" nor how many spaces there are.
      expect(await refusedText(plain, "space.status", {}, host(undefined))).toBe(GRANT_TEXT);
      // A default nobody serves: the home's own space says so, another space does not.
      const others = w.service.ops.spaces().filter((s) => s.id !== life);
      expect((await plain.refusal("space.status", {}, { host: host(life, others) })).code).toBe(
        "space_unavailable",
      );
      expect(await refusedText(plain, "space.status", {}, host(`sp_${"2".repeat(26)}`))).toBe(
        GRANT_TEXT,
      );
      // A name its space shares with a space it may not use: not `ambiguous`, which would say the
      // other one exists. (An entry that names a name no space had at its bind pins nothing.)
      const twin = await connect({ instance: "home-target", space: "Twin" });
      const twins = w.service.ops
        .spaces()
        .map((s) => (s.id === life ? { ...s, name: "Twin" } : s))
        .concat([{ id: `sp_${"3".repeat(26)}`, name: "twin", state: "open" } as ServedSpace]);
      expect(await refusedText(twin, "space.status", {}, host(undefined, twins))).toBe(GRANT_TEXT);
      // Its own space under that name alone: it is the home's, and it answers.
      const single = twins.filter((s) => s.id !== `sp_${"3".repeat(26)}`);
      expect(await twin.call("space.status", {}, { host: host(undefined, single) })).toContain(
        "Space: Life (L)",
      );
      await twin.close();
      // The default is an ID and matches by ID only, as the request path takes it: a space of the
      // home's whose name is the default's ID text does not make the default the home's.
      const mira = w.space;
      const namedAsMira = (s: ServedSpace): ServedSpace =>
        s.id === life ? { ...s, name: mira } : s;
      const withMira = w.service.ops.spaces().map(namedAsMira);
      const withoutMira = withMira.filter((s) => s.id !== mira);
      expect(await refusedText(plain, "space.status", {}, host(mira, withMira))).toBe(GRANT_TEXT);
      expect(await refusedText(plain, "space.status", {}, host(mira, withoutMira))).toBe(
        GRANT_TEXT,
      );
      // The person still hears what is wrong.
      const person = await opCall(
        { ...w.service.ops, defaultSpace: () => undefined },
        { class: "cli-interactive", env: {} },
        { op: "space.status", input: {} },
      ).then(
        () => undefined,
        (e: unknown) => (e instanceof AppError ? e.toBody() : e),
      );
      expect(person).toMatchObject({ code: "invalid_input" });
      for (const agent of [unknown, byName, plain]) await agent.close();
    },
  );
});

describe("[A3.3.7.grant.revoke] a revoked row stops the next call of every connection of its home", () => {
  test(
    "a write admitted before its row was revoked is checked again before its actor is registered and before the writer gets it: refused, nothing written",
    { timeout: LONG },
    async () => {
      await grant("home-late", w.space);
      const agent = await connect({ instance: "home-late", space: w.space });
      const before = JSON.stringify(await logOf("M-1"));
      // The gate answers yes until the row is gone: a revoke after the call was admitted (the
      // first question), or after its actor was registered too (the second).
      for (const yes of [1, 2]) {
        let asked = 0;
        const host: HostPatch = () => ({ homes: { may: () => (asked += 1) <= yes } });
        expect(
          await refusedText(
            agent,
            "entry.add",
            {
              task: "M-1",
              kind: "progress",
              text: "Fixture progress, admitted then revoked.",
              request_id: rid(),
            },
            host,
          ),
          `revoked after ${String(yes)}`,
        ).toBe(GRANT_TEXT);
        expect(asked).toBe(yes + 1);
      }
      expect(JSON.stringify(await logOf("M-1"))).toBe(before);
      await agent.close();
    },
  );
});
