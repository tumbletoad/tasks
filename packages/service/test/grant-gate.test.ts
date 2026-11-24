// The grant gate (A3 3.7.4, 3.7.8, 3.7.9) on a service in this process with two spaces, Mira and
// Life. Agent homes are registered and revoked as `ttasks setup agents` does, through the user's
// `setup/home_grant` and `setup/home_revoke`. Every agent connection is made as a bridge or a shell
// makes one, through the local endpoint (agents.ts). The negative cases are proved as carefully as
// the positive ones: a refused call must not touch the other space's reader or writer at all.
// Fixture text and temporary folders only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { renderError } from "../src/mcp/index.ts";
import { homeGate } from "../src/hub/home-gate.ts";
import type { Grant } from "../src/local/index.ts";
import { grantRefused, MANUAL_INSTANCE, opCall } from "../src/ops/index.ts";
import {
  bridge,
  launchContext,
  OTHER_INSTANCE,
  shell,
  type Agent,
  type HostPatch,
} from "./agents.ts";
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
  life = await w.other();
  await user("task.add", { tasks: [{ title: "Fixture life task" }], request_id: rid() }, life);
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** The gate's connections: the hand-made entry, and an instance two rows hold, each with no registration. */
const MANUAL = { instance: MANUAL_INSTANCE, registration: undefined };
const SHARED = { instance: "shared", registration: undefined };

/** A3 3.5's grant refusal as a bridge's agent reads it. */
const GRANT_TEXT = renderError(GRANT);

/**
 * The grant refusal of a bridge that is no session, when its home may use another space now, with
 * what moves it there: a restart with that space named in its entry, or for a hand-made entry
 * that names no space a restart alone.
 */
const elsewhere = (
  name: string,
  space: string,
  entry: "names a space" | "hand-made naming none",
): string =>
  renderError({
    ...GRANT,
    hint:
      entry === "names a space"
        ? `It may use the space ${name} now: ask the user to check that the agent's ${PRODUCT_NAME} entry names it (--space ${space}), then to restart the agent app.`
        : `It may use the space ${name} now: ask the user to restart the agent app to work there.`,
    data: { rule: "grant", space },
  });

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
        // Its entry's space is the one it works in: the refusal names the space its home may use.
        for (const [op, input] of CALLS.filter(([op]) => op !== "receipt.get")) {
          expect(await refusedText(other, op, withRequest(input), host), `${why}: ${op}`).toBe(
            elsewhere("Life", life, "names a space"),
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
    "a launch reference, a ticket or a task of the other space makes nothing a session and reads nothing there",
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
        elsewhere("Life", life, "names a space"),
      );
      expect(touched).toEqual([]);
      expect((await evidenceOf(launch.id)).bound_at).toBeUndefined();

      // A ticket of Mira at the bind frame, presented by another home's entry with no space and
      // with Mira's: neither is the launch's app, so neither is its session.
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
        readLog(w.home).filter((e) => e["ev"] === "binding.unbound" && e["reason"] === "app")
          .length,
      ).toBeGreaterThanOrEqual(2);
      expect((await evidenceOf(ticketed.id)).bound_at).toBeUndefined();

      // A task of Mira by its ID, asked on Life's connection: not found there, nothing of it said.
      const mira = await user("task.get", { task: "M-1", sections: ["history"] });
      const id = String((mira["task"] as Json)["id"]);
      const missing = await own.refusal("task.get", { task: id });
      expect(missing.code).toBe("not_found");
      expect(missing.text).not.toContain("Fixture task one");
      expect((await own.refusal("task.get", { task: "M-1" })).code).toBe("not_found");

      // Mira's own home reads the reference, and the launch's own bridge is its session.
      const right = await connect({ instance: "home-mira", space: w.space });
      const read = await right.call("task.get", { launch: launch.reference });
      expect(read).toContain("Pass task M-2 on the calls that act on it");
      const rightTicket = await launched(ticketed);
      expect(rightTicket.binding?.["state"]).toBe("bound");
      for (const agent of [own, pinned, loose, named, right, rightTicket]) await agent.close();
    },
  );
});

describe("[A3.3.7.grant.revoke] a revoked row stops the next call of every connection of its home", () => {
  test(
    "an open connection that is no session, a launched agent's bridge and its shell, and a real mcp mode connection: all refused at their next call; registered again, they go on with no reconnect",
    { timeout: LONG },
    async () => {
      const instance = "home-revoke";
      const row = await grant(instance, w.space);
      const unbound = await connect({ instance, space: w.space });
      expect(await unbound.call("space.status")).toContain("Session: not bound");
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
          [unbound, "no session"],
          [ticketed, "a session by its ticket"],
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

        // A bridge of the session that connects now is its session too, refused alike.
        const later = await launched(launch);
        expect(later.binding?.["state"]).toBe("bound");
        expect(await refusedText(later, "task.get")).toBe(GRANT_TEXT);

        // Registered again: the connections and the session go on as they were.
        await grant(instance, w.space);
        await grantHome(w.home, w.path, { instance: launch.instance, space: w.space });
        expect(await later.call("task.get")).toContain("M-1");
        expect(await unbound.call("space.status")).toContain("Space: Mira (M)");
        expect(
          await ticketed.call("entry.add", {
            kind: "progress",
            text: "Fixture progress, registered again.",
            request_id: rid(),
          }),
        ).toMatch(/^logged \S+ on M-1 /);
        expect(await cli.call("space.status")).toMatchObject({ session: { state: "bound" } });
        expect(textOf(await status())).toContain("Space: Mira (M)");
        for (const agent of [unbound, ticketed, later]) await agent.close();
      } finally {
        await cli.close();
        wire.close();
      }
    },
  );
});

describe("[A3.3.7.grant.revoke] a revoked row stops the next call of every connection of its home", () => {
  test(
    "access turned off for a home stays off when another home takes its instance: its open connection, a new one from its old entry, and a name-only entry are refused, and the other home is allowed",
    { timeout: LONG },
    async () => {
      const instance = "home-reused";
      const folder = (name: string) => join(w.home, "agent-homes", "reused", name);
      const register = async (name: string, registration: string): Promise<string> => {
        const answer = await asUser("setup/home_grant", {
          app: "codex",
          home: folder(name),
          file: join(folder(name), "config.toml"),
          instance,
          account: "",
          space: w.space,
          registration,
        });
        return (answer["grant"] as { grant: string }).grant;
      };
      const A = `rg_${"a".repeat(26)}`;
      const B = `rg_${"b".repeat(26)}`;
      const from = (registration?: string) =>
        connect({
          instance,
          space: w.space,
          env: registration === undefined ? {} : { TTASKS_REGISTRATION: registration },
        });

      const rowA = await register("a", A);
      const openA = await from(A);
      expect(await openA.call("space.status")).toContain("Space: Mira (M)");
      expect(await revokeHome(w.home, w.path, [rowA])).toBe(1);
      expect(await refusedText(openA, "space.status")).toBe(GRANT_TEXT);

      const rowB = await register("b", B);
      const openB = await from(B);
      const newA = await from(A);
      const nameOnly = await from(undefined);
      try {
        expect(await openB.call("space.status")).toContain("Space: Mira (M)");
        expect(await refusedText(openA, "space.status"), "A's open connection").toBe(GRANT_TEXT);
        expect(await refusedText(newA, "space.status"), "A's old entry, connecting now").toBe(
          GRANT_TEXT,
        );
        expect(await refusedText(nameOnly, "space.status"), "an entry naming no registration").toBe(
          GRANT_TEXT,
        );
      } finally {
        for (const agent of [openA, openB, newA, nameOnly]) await agent.close();
        await revokeHome(w.home, w.path, [rowB]);
      }
    },
  );
});

describe("[A3.3.7.grant.revoke] a revoked row stops the next call of every connection of its home", () => {
  test(
    "a launched agent's shell finds its own receipt while its home is registered; once the row is revoked the lookup is refused with rule grant before the space's reader is touched",
    { timeout: LONG },
    async () => {
      const launch = await w.launch("M-3");
      // On main a shell acts as the session its launch's bridge made.
      const agent = await launched(launch);
      expect(agent.binding?.["state"]).toBe("bound");
      const sh = await shell(w, { TTASKS_TICKET: launch.ticket });
      try {
        const request = rid();
        await sh.call("entry.add", {
          kind: "progress",
          text: "Fixture progress before the revoke.",
          request_id: request,
        });
        expect(await sh.call("receipt.get", { request })).toMatchObject({
          found: true,
          status: "applied",
        });

        expect(await revokeHome(w.home, w.path, [launch.row ?? ""])).toBe(1);
        const { host, touched } = trapped(w.space);
        expect((await sh.refusal("receipt.get", { request }, { host })).body).toEqual(GRANT);
        expect(touched).toEqual([]);
      } finally {
        await sh.close();
        await agent.close();
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
    "two connections of the home share it, and it holds when the row is replaced or revoked and made again: a retry never writes twice",
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
      // An entry naming no space, as setup printed it before: with no default to take, it is told
      // to set one.
      const printed = await connect({ instance: null });
      expect(printed.binding).toEqual({ space: null, state: "unbound" });
      const none = await printed.refusal("space.status");
      expect([none.code, none.reason]).toEqual(["space_unavailable", "no_space"]);
      expect(none.text).toContain(`set a default space (${CLI_NAME} space use`);
      expect(none.text).toContain("then restart the agent app");
      expect(none.text).not.toContain("entry");
      await printed.close();
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
      // In another space each is refused, naming the default it may use, for its entry to name.
      const odd = await connect({ instance: "Not An Instance!", space: life });
      expect(await refusedText(odd, "space.status")).toBe(
        elsewhere("Mira", w.space, "names a space"),
      );
      const manualLife = await connect({ instance: null, space: life });
      expect(await refusedText(manualLife, "space.status")).toBe(
        elsewhere("Mira", w.space, "names a space"),
      );
      // Without --space too: the default space when it binds, which is what taking it out gives.
      const plain = await connect({ instance: null });
      expect(await plain.call("space.status")).toContain("Space: Mira (M)");
      // When the default moves, a restart is what moves it: the next process takes the new one.
      await asUser("space/use", { space: life });
      expect(await refusedText(plain, "space.status")).toBe(
        elsewhere("Life", life, "hand-made naming none"),
      );
      const restarted = await connect({ instance: null });
      expect(await restarted.call("space.status")).toContain("Space: Life (L)");
      await asUser("space/use", { space: w.space });
      for (const agent of [manual, odd, manualLife, plain, restarted]) await agent.close();

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
    "a session is its home's: another home's connection presenting its ticket is none, and the session's calls stop with its home's row and go on when it is registered again",
    { timeout: LONG },
    async () => {
      await grant("home-session-y", w.space);
      const launch = await w.launch("M-2");
      const x = launch.row ?? "";
      const own = await launched(launch);
      expect(own.binding?.["state"]).toBe("bound");
      const mark = readLog(w.home).length;
      const other = await launched(launch, { instance: "home-session-y" });
      expect(other.binding?.["state"]).toBe("unbound");
      expect(
        readLog(w.home)
          .slice(mark)
          .some((e) => e["ev"] === "binding.unbound" && e["reason"] === "home"),
      ).toBe(true);
      expect(await other.call("space.status")).toContain("Session: not bound");
      await other.close();

      await revokeHome(w.home, w.path, [x]);
      expect(await refusedText(own, "space.status")).toBe(GRANT_TEXT);
      await grantHome(w.home, w.path, { instance: launch.instance, space: w.space });
      expect(await own.call("space.status")).toContain("Session: bound to M-2");
      await own.close();
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
      expect(gate.may(MANUAL, life)).toBe(false);
      expect(gate.may(MANUAL, w.space)).toBe(true);
      // The configured default counts whether or not it is served now: the request path then says
      // `space_unavailable` or `ambiguous` for it, not that the entry is not registered.
      const away = `sp_${"4".repeat(26)}`;
      const unserved = homeGate({
        grants: () => ({ list: () => [] }),
        spaces: () => [{ id: life, state: "open" }],
        defaultSpace: () => away,
      });
      expect(unserved.may(MANUAL, away)).toBe(true);
      expect(unserved.may(MANUAL, life)).toBe(false);
      // No default: the one space served, and with two none.
      const one = homeGate({
        grants: () => ({ list: () => [] }),
        spaces: () => [{ id: life, state: "open" }],
        defaultSpace: () => undefined,
      });
      expect(one.may(MANUAL, life)).toBe(true);
      const two = homeGate({
        grants: () => ({ list: () => [] }),
        spaces: () => [
          { id: w.space, state: "open" },
          { id: life, state: "open" },
        ],
        defaultSpace: () => undefined,
      });
      expect(two.may(MANUAL, life)).toBe(false);
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
                file: join(w.home, "agent-homes", folder, "config.toml"),
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
      expect(gate([rowOf(1, life)]).may(SHARED, life)).toBe(true);
      expect(gate([rowOf(1, life), rowOf(2, life)]).may(SHARED, life)).toBe(false);
      expect(gate([rowOf(1, life), rowOf(2, w.space)]).may(SHARED, w.space)).toBe(false);
      const revoked = { ...rowOf(2, w.space), revoked_at: new Date().toISOString() };
      expect(gate([rowOf(1, life), revoked]).may(SHARED, life)).toBe(true);
    },
  );
});

describe("[A3.3.7.grant.space] a home granted one space reaches no other", () => {
  test(
    "an entry without --space takes the machine's default at its bind and keeps it: refused there with the space its home may use, never moved by a later default; the next bridge process takes the default then",
    { timeout: LONG },
    async () => {
      await grant("home-life", life);
      await asUser("space/use", { space: w.space });
      const agent = await connect({ instance: "home-life" });
      expect(agent.binding).toEqual({ space: w.space, state: "unbound" });
      expect(await refusedText(agent, "space.status")).toBe(
        elsewhere("Life", life, "names a space"),
      );
      await asUser("space/use", { space: life });
      expect(await refusedText(agent, "space.status")).toBe(
        elsewhere("Life", life, "names a space"),
      );
      // The same process again holds Mira; a new one takes Life.
      const again = await connect({ instance: "home-life", held_space: w.space });
      expect(again.binding).toEqual({ space: w.space, state: "unbound" });
      // An older bridge reconnects with its handle and holds nothing: which space it worked in is
      // not known, so it gets none rather than the default of now, and is told to restart.
      const older = await connect({
        instance: "home-life",
        resume: { handle: "bh_0123456789abcdefghijkl" },
      });
      expect(older.binding).toEqual({ space: null, state: "unbound" });
      const restart = await older.refusal("space.status");
      expect([restart.code, restart.reason]).toEqual(["space_unavailable", "no_space"]);
      expect(restart.text).toContain(`It may use the space Life: ask the user to name it`);
      await older.close();
      // A hand-made one with a default: the restart alone settles it.
      const olderManual = await connect({
        instance: null,
        resume: { handle: "bh_0123456789abcdefghijkl" },
      });
      const manualRestart = await olderManual.refusal("space.status");
      expect(manualRestart.reason).toBe("no_space");
      expect(manualRestart.text).toContain(
        "restart the agent app: it then works in the default space",
      );
      expect(manualRestart.text).not.toContain("space use");
      await olderManual.close();
      const fresh = await connect({ instance: "home-life" });
      expect(fresh.binding).toEqual({ space: life, state: "unbound" });
      expect(await fresh.call("space.status")).toContain("Space: Life (L)");
      for (const each of [agent, again, fresh]) await each.close();
    },
  );

  test(
    "a bridge's space is settled at its bind: an entry naming no space that exists gets none, refused on every call with what settles it; a call never picks one, whatever the default is then",
    { timeout: LONG },
    async () => {
      await grant("home-target", life);
      const unknown = await connect({ instance: "home-target", space: "No Such Space" });
      expect(unknown.binding).toEqual({ space: null, state: "unbound" });
      const none = await unknown.refusal("space.status");
      expect([none.code, none.reason]).toEqual(["space_unavailable", "no_space"]);
      // A default alone does not settle it: the entry's space is tried first and alone. Its home
      // is registered, so it is told the space to name.
      expect(none.text).toContain(`entry names a space this machine has none of, or two of`);
      expect(none.text).toContain(`It may use the space Life: ask the user to name it`);
      expect(none.text).not.toContain("take the space out");
      expect(
        (await unknown.refusal("space.status", {}, { host: () => ({ defaultSpace: () => life }) }))
          .reason,
      ).toBe("no_space");
      // Its home's space by name works.
      const byName = await connect({ instance: "home-target", space: "life" });
      expect(await byName.call("space.status")).toContain("Space: Life (L)");
      // No --space: the default (Life) at the bind, whatever the default is at a call.
      const plain = await connect({ instance: "home-target" });
      expect(plain.binding).toEqual({ space: life, state: "unbound" });
      expect(
        await plain.call("space.status", {}, { host: () => ({ defaultSpace: () => undefined }) }),
      ).toContain("Space: Life (L)");
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

  test(
    "an entry edited by hand is told what works with the default left where it is: each to name the space it may use",
    { timeout: LONG },
    async () => {
      await grant("home-edited", life);
      await asUser("space/use", { space: w.space });
      const advice = `It may use the space Life: ask the user to name it in the agent's ${PRODUCT_NAME} entry (--space ${life})`;
      // Its space taken out: it binds the default, Mira, which it may not use.
      const bare = await connect({ instance: "home-edited" });
      expect(bare.binding).toEqual({ space: w.space, state: "unbound" });
      expect(await refusedText(bare, "space.status")).toBe(
        elsewhere("Life", life, "names a space"),
      );
      // Its space misspelled: no space, and the same advice.
      const typo = await connect({ instance: "home-edited", space: "Lief" });
      expect(typo.binding).toEqual({ space: null, state: "unbound" });
      const none = await typo.refusal("space.status");
      expect(none.reason).toBe("no_space");
      expect(none.text).toContain(advice);
      // Followed, with the default still Mira: the next process works in Life.
      const fixed = await connect({ instance: "home-edited", space: life });
      expect(await fixed.call("space.status")).toContain("Space: Life (L)");
      // A hand-made entry's misspelled space: it is told the default, the space it may use.
      const manualTypo = await connect({ instance: null, space: "Mira typo" });
      expect((await manualTypo.refusal("space.status")).text).toContain(
        `It may use the space Mira: ask the user to name it in the agent's ${PRODUCT_NAME} entry (--space ${w.space})`,
      );
      const manualFixed = await connect({ instance: null });
      expect(await manualFixed.call("space.status")).toContain("Space: Mira (M)");
      for (const each of [bare, typo, fixed, manualTypo, manualFixed]) await each.close();
      await asUser("space/use", { space: life });
    },
  );

  test(
    "an entry with an instance whose home has no space it may use, never registered or revoked, gets the grant refusal at its first call, not a hint about the default",
    { timeout: LONG },
    async () => {
      const row = await grant("home-gone", life);
      expect(await revokeHome(w.home, w.path, [row])).toBe(1);
      for (const instance of ["never-registered-here", "home-gone"]) {
        for (const space of ["No Such Space", undefined]) {
          const agent = await connect({ instance, ...(space === undefined ? {} : { space }) });
          // With nothing to settle on, the bind gives the default or none; either way the
          // command that registers the home is what helps.
          if (space !== undefined) expect(agent.binding).toEqual({ space: null, state: "unbound" });
          expect(await refusedText(agent, "space.status"), `${instance} ${String(space)}`).toBe(
            GRANT_TEXT,
          );
          await agent.close();
        }
      }
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
        const host: HostPatch = () => ({
          homes: { may: () => (asked += 1) <= yes, spaceOf: () => undefined },
        });
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

describe("[A3.3.7.binding.worlds] a world launch is what a click and setup leave, on the home a test names", () => {
  test(
    "registered by default, also two at once; without an app, without a row, with its row revoked, or registered for another space when asked; and a bridge inside it that presents another instance",
    { timeout: LONG },
    async () => {
      const live = async () => {
        const session = await classSession(w.home, w.path, "cli-interactive");
        try {
          const answer = (await session.call("setup/homes", {}, { timeoutMs: 60_000 })) as {
            homes: { instance: string; app: string; home: string; spaces: string[] }[];
          };
          return answer.homes;
        } finally {
          session.close();
        }
      };
      const recorded = (launch: WorldLaunch) => w.service.launches.host.liveByTicket(launch.ticket);
      const rowsOf = async (launch: WorldLaunch) =>
        (await live()).filter((row) => row.instance === launch.instance);

      // Two launches of one task opened at the same time are two launches, each on its own home.
      const both = await Promise.all([w.launch("M-1"), w.launch("M-1")]);
      expect(new Set(both.map((l) => l.id)).size).toBe(2);
      expect(new Set(both.map((l) => l.instance)).size).toBe(2);
      for (const launch of both) {
        expect(recorded(launch)).toMatchObject({ launch: launch.id, app: "codex" });
        expect(await rowsOf(launch)).toHaveLength(1);
      }

      const registered = await w.launch("M-1");
      const home = join(w.home, "agent-homes", registered.instance);
      expect(registered).toMatchObject({ app: "codex", home });
      expect(recorded(registered)).toMatchObject({ app: "codex", home });
      expect(await rowsOf(registered)).toEqual([
        expect.objectContaining({ app: "codex", home, spaces: [w.space] }),
      ]);
      expect(launchContext(w.space, registered)).toMatchObject({
        space: w.space,
        instance: registered.instance,
        app: "codex",
        env: { TTASKS_TICKET: registered.ticket },
      });
      expect(launchContext(w.space, registered, { present: "other-instance" })).toMatchObject({
        instance: OTHER_INSTANCE,
        app: "codex",
        env: { TTASKS_TICKET: registered.ticket },
      });

      const noApp = await w.launch("M-1", { home: "no-app" });
      expect(noApp.app).toBeUndefined();
      expect(recorded(noApp)).not.toHaveProperty("app");
      expect(recorded(noApp)).toMatchObject({ home: noApp.home });
      expect(await rowsOf(noApp)).toEqual([]);

      const noRow = await w.launch("M-1", { home: "no-row" });
      expect(recorded(noRow)).toMatchObject({ app: "codex", home: noRow.home });
      expect(noRow.row).toBeUndefined();
      expect(await rowsOf(noRow)).toEqual([]);

      const revoked = await w.launch("M-1", { home: "revoked" });
      expect(recorded(revoked)).toMatchObject({ app: "codex", home: revoked.home });
      expect(revoked.row).toMatch(/^gr_/);
      expect(await rowsOf(revoked)).toEqual([]);

      const elsewhere = await w.launch("M-1", { home: "other-space" });
      expect(recorded(elsewhere)).toMatchObject({ space: w.space, app: "codex" });
      expect(await rowsOf(elsewhere)).toEqual([expect.objectContaining({ spaces: [life] })]);
    },
  );
});
