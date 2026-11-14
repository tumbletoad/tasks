// Connection classes (A2 3.6.5, A2 5 "Connection classes from client.tty and markers. A shim
// connection may call only A4's methods, each with its own credential").
import {
  AGENT_MARKERS,
  RPC_ERROR,
  openRpc,
  rpcContextEnv,
  type ClientInfo,
  type JsonObject,
} from "@tasks/bridge/protocol";
import { clientInfo, endpointRoot } from "@tasks/bridge/test/endpoint";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer } from "../../test/local.ts";
import {
  CONNECTION_CLASSES,
  RPC_METHODS,
  classify,
  mayCall,
  type ConnectionClass,
  type RpcHandlers,
  type RpcMethod,
} from "./index.ts";

const SLOW = { timeout: 60_000 };

let root: ReturnType<typeof endpointRoot>;
beforeAll(() => {
  root = endpointRoot();
});
afterAll(() => {
  root.remove();
});

const cli = (stdin: boolean, stdout: boolean): ClientInfo => ({
  ...clientInfo("cli"),
  tty: { stdin, stdout },
});
const withEnv = (env: Record<string, string>): JsonObject => ({ env });

const A4_METHODS: RpcMethod[] = [
  "launch.claim",
  "launch.attach",
  "launch.started",
  "launch.settled",
  "launch.exited",
  "launch.failed",
  "run.attach",
  "run.event",
  "run.exited",
];

describe("[A2.3.6.local.classes] classification", () => {
  test("the CLI is interactive only with both TTYs and no marker", () => {
    expect(classify("rpc", cli(true, true), {})).toBe("cli-interactive");
    expect(classify("rpc", cli(true, false), {})).toBe("cli-script");
    expect(classify("rpc", cli(false, true), {})).toBe("cli-script");
    expect(classify("rpc", cli(false, false), {})).toBe("cli-script");
    expect(classify("rpc", cli(true, true), withEnv({ TASKS_SPACE: "sp_x" }))).toBe(
      "cli-interactive",
    );
  });

  test("any agent marker makes a CLI call cli-agent, TTY or not", () => {
    const markers = [...AGENT_MARKERS, "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"];
    for (const marker of markers) {
      for (const tty of [true, false]) {
        expect(classify("rpc", cli(tty, tty), withEnv({ [marker]: "1" })), marker).toBe(
          "cli-agent",
        );
      }
    }
    expect(classify("rpc", cli(true, true), withEnv({ CLAUDE: "1", CODEX: "1" }))).toBe(
      "cli-interactive",
    );
    expect(classify("rpc", cli(true, true), { CLAUDECODE: "1" })).toBe("cli-interactive");
  });

  test("shims, bridges and forwarders, and kinds that do not fit their mode", () => {
    expect(classify("rpc", clientInfo("shim", true), withEnv({ CLAUDECODE: "1" }))).toBe("shim");
    expect(classify("mcp", clientInfo("bridge"), {})).toBe("bridge");
    expect(classify("mcp", clientInfo("forwarder", true), {})).toBe("bridge");
    expect(classify("mcp", clientInfo("cli", true), {})).toBeUndefined();
    expect(classify("mcp", clientInfo("shim"), {})).toBeUndefined();
    expect(classify("rpc", clientInfo("bridge"), {})).toBeUndefined();
    expect(classify("rpc", clientInfo("forwarder"), {})).toBeUndefined();
  });

  test("rpcContextEnv copies only the markers and TASKS_SPACE", () => {
    expect(
      rpcContextEnv({
        PATH: "/usr/bin",
        HOME: "/home/mira",
        CLAUDECODE: "1",
        CODEX_SANDBOX: "seatbelt",
        TASKS_TICKET: "t",
        TASKS_SPACE: "sp_x",
        TASKS_HOME: "/tmp/k",
        OPENAI_API_KEY: "sk-SENTINEL",
        UNSET: undefined,
      }),
    ).toEqual({
      CLAUDECODE: "1",
      CODEX_SANDBOX: "seatbelt",
      TASKS_TICKET: "t",
      TASKS_SPACE: "sp_x",
    });
  });

  test("a shim may call only A4's methods, and no other class may call them", () => {
    for (const method of Object.keys(RPC_METHODS) as RpcMethod[]) {
      const a4 = A4_METHODS.includes(method);
      expect(mayCall("shim", method), method).toBe(a4);
      for (const cls of CONNECTION_CLASSES.filter((c) => c !== "shim")) {
        if (a4) expect(mayCall(cls, method), `${cls} ${method}`).toBe(false);
      }
    }
    expect(A4_METHODS.every((m) => Object.hasOwn(RPC_METHODS, m))).toBe(true);
  });

  test("shutdown and UI codes are for a person or a script, never an agent", () => {
    const allowed = (method: RpcMethod) =>
      CONNECTION_CLASSES.filter((cls) => mayCall(cls, method)).sort();
    expect(allowed("service/shutdown")).toEqual(["cli-interactive", "cli-script"]);
    expect(allowed("ui/mint_code")).toEqual(["cli-interactive", "cli-script"]);
    for (const method of ["op/call", "op/list", "feed/subscribe", "service/status"] as const) {
      expect(allowed(method)).toEqual(["cli-agent", "cli-interactive", "cli-script"]);
    }
    // The socket never produces the UI's class, and no rpc method names it.
    expect(
      Object.values(RPC_METHODS).some((classes) => (classes as readonly string[]).includes("ui")),
    ).toBe(false);
  });
});

describe("[A2.3.6.local.classes] over a connection", () => {
  test("the service classifies each connection and enforces its methods", SLOW, async () => {
    const seen: ConnectionClass[] = [];
    const handler = (_params: JsonObject, ctx: { connection: { class: ConnectionClass } }) => {
      seen.push(ctx.connection.class);
      return "ok";
    };
    const handlers: RpcHandlers = Object.fromEntries(
      Object.keys(RPC_METHODS).map((method) => [method, handler]),
    );
    const started = await startServer(root, { handlers });
    const open = (client: ClientInfo, context: JsonObject = {}) =>
      openRpc({ path: started.path, key: started.key, client, context });
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) => {
          const data = (error as { data?: { code?: string; data?: { reason?: string } } }).data;
          return `${String((error as { code?: number }).code)} ${data?.code ?? ""} ${data?.data?.reason ?? ""}`.trim();
        },
      );
    const forbidden = `${String(RPC_ERROR.app)} forbidden connection_class`;
    try {
      const agent = await open(cli(true, true), withEnv({ CODEX_THREAD_ID: "019a" }));
      expect(await outcome(agent.call("op/list"))).toBe("ok");
      expect(await outcome(agent.call("ui/mint_code"))).toBe(forbidden);
      expect(await outcome(agent.call("service/shutdown"))).toBe(forbidden);
      expect(await outcome(agent.call("launch.claim"))).toBe(forbidden);

      const person = await open(cli(true, true));
      expect(await outcome(person.call("ui/mint_code"))).toBe("ok");
      expect(await outcome(person.call("run.event"))).toBe(forbidden);

      const shim = await open(clientInfo("shim"), withEnv({ TASKS_TICKET: "t" }));
      expect(await outcome(shim.call("launch.claim"))).toBe("ok");
      expect(await outcome(shim.call("op/call"))).toBe(forbidden);
      expect(await outcome(shim.call("service/status"))).toBe(forbidden);

      expect(seen).toEqual(["cli-agent", "cli-interactive", "shim"]);
      for (const session of [agent, person, shim]) session.close();

      const misfit = await open(clientInfo("bridge")).catch((e: unknown) => e);
      expect(misfit).toMatchObject({ reason: "service_too_old", detail: "invalid_bind" });
      expect(started.events).toContainEqual({ ev: "local.bind_refused", reason: "invalid_bind" });
    } finally {
      await started.server.close();
    }
  });

  test("a bind with malformed client details is refused", SLOW, async () => {
    const started = await startServer(root);
    try {
      for (const client of [
        { ...clientInfo(), kind: "desktop" },
        { ...clientInfo(), tty: { stdin: "yes", stdout: true } },
        { ...clientInfo(), pid: -1 },
        { ...clientInfo(), extra: 1 },
        { ...clientInfo(), version: "" },
      ]) {
        const error = await openRpc({
          path: started.path,
          key: started.key,
          client: client as unknown as ClientInfo,
          context: {},
        }).catch((e: unknown) => e);
        expect(error).toMatchObject({ reason: "service_too_old", detail: "invalid_bind" });
      }
    } finally {
      await started.server.close();
    }
  });
});
