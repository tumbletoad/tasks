// Calls while the service starts, after it said it is ready and before its spaces are handed to
// the space manager: held there by a stand-in for the offline cache's write, the step between the
// two. A service in this process over one space registered in machine.toml, fixture text and
// temporary folders only.
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { LocalError, RpcError, type JsonObject } from "@ttasks/bridge/protocol";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { openingEntry, startService, type RunningService } from "../src/hub/service.ts";
import { bridgeCaller } from "../src/mcp/index.ts";
import {
  opCall,
  type Caller,
  type OpsHost,
  type ServedSpace,
  type Session,
} from "../src/ops/index.ts";
import { runVerbs, type RunVerbsHost } from "../src/runs/verbs.ts";
import {
  readServiceJson,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { hubSpace } from "./mcp-hub.ts";
import { toolOf } from "../src/mcp/index.ts";
import { bridgeContext, openMcp, RawMcp, textOf } from "./mcp-helpers.ts";
import { classSession } from "./ops-helpers.ts";

const gate = vi.hoisted(() => {
  let release = (): void => undefined;
  let held = Promise.resolve();
  return {
    get held() {
      return held;
    },
    /** The next start waits at the step until `release`. */
    arm: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release();
    },
  };
});

/**
 * Runs `body` with the endpoint of `home`'s service, started and held before the hand-over. The
 * hold is released and the service stopped however the body or the wait for readiness ends.
 */
async function whileStarting(home: string, body: (path: string) => Promise<void>): Promise<void> {
  gate.arm();
  const starting: Promise<RunningService> = startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  try {
    const path = await waitFor(
      () => {
        const json = readServiceJson(home);
        return json?.state === "ready" ? json.endpoint?.path : undefined;
      },
      60_000,
      "the service says it is ready",
    );
    await body(path);
  } finally {
    gate.release();
    const service = await starting;
    await service.stop();
    removeRuntimeDir(service);
  }
}

vi.mock("../src/mcp/offline.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mcp/offline.ts")>();
  return {
    ...real,
    writeOfflineCache: async (...args: Parameters<typeof real.writeOfflineCache>) => {
      await gate.held;
      return real.writeOfflineCache(...args);
    },
  };
});

describe("[A3.3.7.binding.space] a bind while the service starts settles the configured space", () => {
  test(
    "on an install with one space and no default, a hand-made entry bound before the spaces are handed over gets that space by its registered ID, and its first call is told the space is still opening, to try again",
    { timeout: 180_000 },
    async () => {
      const temp = tempRoot("bind-startup");
      try {
        const home = join(temp.root, "h");
        const space = await hubSpace(home);
        await whileStarting(home, async (path) => {
          const session = await openMcp(home, path, bridgeContext({ instance: null, app: null }));
          expect(session.bound.binding).toEqual({ space: space.id, state: "unbound" });
          const mcp = new RawMcp(session);
          await mcp.initialize();
          const reply = await mcp.request("tools/call", {
            name: toolOf("space.status"),
            arguments: {},
          });
          expect(textOf(reply.message["result"])).toMatch(/^error space_unavailable \(opening\):/);
          session.close();
        });
      } finally {
        temp.cleanup();
      }
    },
  );

  test(
    "every door a call comes through, asked for the space by ID, name, folder or the default while it opens, is told it is opening, to try again",
    { timeout: 180_000 },
    async () => {
      const temp = tempRoot("doors-startup");
      try {
        const home = join(temp.root, "h");
        const space = await hubSpace(home);
        registerSpaces(home, [space.folder], `\n[service]\ndefault_space = "${space.id}"\n`);
        const named = (way: Way): string | undefined =>
          way === "id"
            ? space.id
            : way === "name"
              ? "Mira"
              : way === "folder"
                ? space.folder
                : undefined;
        const asked: { readonly at: string; readonly answer: string; readonly want: string }[] = [];
        const ask = async (doors: readonly Door[]): Promise<void> => {
          for (const door of doors) {
            for (const way of door.ways) {
              asked.push({
                at: `${door.name}, by ${way}`,
                answer: await door.ask(named(way)),
                want: door.otherwise?.[way] ?? OPENING,
              });
            }
          }
        };
        await whileStarting(home, (path) => ask(liveDoors(home, path)));
        // A session's doors, over the very view the start gives while it opens.
        await ask(sessionDoors(space.id, [openingEntry({ id: space.id, path: space.folder })]));
        expect(asked.map(({ at, answer }) => `${at}: ${answer}`)).toEqual(
          asked.map(({ at, want }) => `${at}: ${want}`),
        );
      } finally {
        temp.cleanup();
      }
    },
  );

  test("a session that names another space while that one opens is refused at once: its ID or its folder is never its own, and a name is known once its own space is open", async () => {
    const held = "sp_00000000000000000000000001";
    const other = "sp_00000000000000000000000002";
    const own: ServedSpace = {
      id: held,
      registered: held,
      name: "Mira",
      folder: "/fixture/spaces/mira",
      state: "open",
      writer: undefined,
      reader: undefined,
    };
    const view = [own, openingEntry({ id: other, path: "/fixture/spaces/life" })];
    const [shell] = sessionDoors(held, view);
    if (shell === undefined) throw new Error("no session shell");
    const answers = [];
    for (const named of [other, "/fixture/spaces/life", "Life"]) {
      answers.push(`${named}: ${await shell.ask(named)}`);
    }
    expect(answers).toEqual([
      `${other}: ${BOUND_ELSEWHERE}`,
      `/fixture/spaces/life: ${BOUND_ELSEWHERE}`,
      `Life: ${BOUND_ELSEWHERE}`,
    ]);
  });
});

/** A session's refusal of a space it is not bound to. */
const BOUND_ELSEWHERE = "forbidden binding final";

type Way = "id" | "name" | "folder" | "default";
const WAYS: readonly Way[] = ["id", "name", "folder", "default"];

/** What every door answers while the space opens. */
const OPENING = "space_unavailable opening retryable";

/**
 * A door a call comes through: the ways it names a space, its answer to one call, and for a way
 * that is no space's lookup at this door, the answer it gets instead.
 */
interface Door {
  readonly name: string;
  readonly ways: readonly Way[];
  readonly otherwise?: Partial<Record<Way, string>>;
  ask(space: string | undefined): Promise<string>;
}

/** An answer in the table's words: what was refused, why (its reason, rule or field), and whether to retry. */
const words = (body: ErrorBody): string => {
  const issues = body.data?.["issues"];
  const path = Array.isArray(issues)
    ? (issues[0] as { path?: unknown } | undefined)?.path
    : undefined;
  const why = body.data?.["reason"] ?? body.data?.["rule"] ?? path;
  return `${body.code} ${String(why)} ${body.data?.["retryable"] === true ? "retryable" : "final"}`;
};

/** A running service's doors: a person's command, an agent's shell, a bridge, each run verb. */
function liveDoors(home: string, path: string): Door[] {
  const rpc = async (
    cls: "cli-interactive" | "cli-agent",
    method: string,
    params: JsonObject,
  ): Promise<string> => {
    // An agent's shell shows its app's marker; a person's command shows none.
    const session = await classSession(
      home,
      path,
      cls,
      cls === "cli-agent" ? { CLAUDECODE: "1" } : {},
    );
    try {
      await session.call(method, params, { timeoutMs: 60_000 });
      return "answered";
    } catch (error) {
      const body = error instanceof RpcError ? (error.data as ErrorBody | undefined) : undefined;
      return body === undefined ? `failed: ${String(error)}` : words(body);
    } finally {
      session.close();
    }
  };
  const inSpace = (space: string | undefined): JsonObject => (space === undefined ? {} : { space });
  const status = (space: string | undefined): JsonObject => ({
    op: "space.status",
    input: {},
    ...inSpace(space),
  });
  return [
    {
      name: "a person's command",
      ways: WAYS,
      ask: (space) => rpc("cli-interactive", "op/call", status(space)),
    },
    // An agent's shell that is no session names its space: told so when it names none.
    {
      name: "an agent's shell",
      ways: WAYS,
      otherwise: { default: "invalid_input space final" },
      ask: (space) => rpc("cli-agent", "op/call", status(space)),
    },
    // A bridge settles its space at the bind, from its entry or the default. A name or a folder
    // cannot be resolved while spaces open, so the bind fails to be tried again, which is the
    // bridge's own retry.
    {
      name: "a bridge",
      ways: WAYS,
      ask: async (space) => {
        let session;
        try {
          session = await openMcp(home, path, bridgeContext({ instance: null, app: null, space }));
        } catch (error) {
          if (error instanceof LocalError && error.retryable) return OPENING;
          throw error;
        }
        try {
          const mcp = new RawMcp(session);
          await mcp.initialize();
          const reply = await mcp.request("tools/call", {
            name: toolOf("space.status"),
            arguments: {},
          });
          const text = textOf(reply.message["result"]);
          return /^error space_unavailable \(opening\):/u.test(text) ? OPENING : text;
        } finally {
          session.close();
        }
      },
    },
    // Every run verb the endpoint serves, from the verbs' own table, so a new one is asked too.
    ...Object.keys(runVerbs({} as RunVerbsHost)).map((verb): Door => ({
      name: `the run verb ${verb}`,
      ways: WAYS,
      ask: (space) =>
        rpc("cli-interactive", verb, {
          run: "ru_00000000000000000000000001",
          task: "M-1",
          request_id: "fixture-run-request-000001",
          ...inSpace(space),
        }),
    })),
  ];
}

/** A session's doors, its shell and its bridge, over `view`: a session holds its launch's space. */
function sessionDoors(held: string, view: readonly ServedSpace[]): Door[] {
  const machine = "m_00000000000000000000000001";
  const session: Session = {
    session: "se_00000000000000000000000001",
    space: held,
    task: "t_00000000000000000000000001",
    home: { of: "launch", app: "codex", home: undefined },
  };
  const host = {
    machine: { id: machine },
    spaces: () => view,
    defaultSpace: () => held,
    homes: { may: () => true, spaceOf: () => held },
    sessions: {
      decide: () => ({ kind: "session", by: "ticket", session }),
      standing: () => ({ kind: "read", instance: "manual", may: () => true }),
      live: () => new Map(),
    },
  } as unknown as OpsHost;
  const ask = (caller: Caller) => async (space: string | undefined) => {
    try {
      await opCall(host, caller, {
        op: "space.status",
        input: {},
        ...(space === undefined ? {} : { space }),
      });
      return "answered";
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return words(error.toBody());
    }
  };
  return [
    // Its own space by ID, name or folder, or none named.
    {
      name: "a session's shell",
      ways: WAYS,
      ask: ask({ class: "cli-agent", env: { TTASKS_TICKET: "fixture-ticket" } }),
    },
    // A bridge's tools name no space: it goes to the one its session holds.
    {
      name: "a session's bridge",
      ways: ["default"],
      ask: ask(
        bridgeCaller(bridgeContext({ instance: null }), machine, { kind: "session", session }),
      ),
    },
  ];
}
