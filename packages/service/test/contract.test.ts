// The contract suite (contract/suite.ts) over the request path's own faces: the functions
// in-process, ttasks-local/1's `op/call` with real sessions, and HTTP as the UI; and the grant
// gate's refusal on the faces here that carry an agent home's call. MCP and the CLI run both in
// their own tests.
import type { RpcSession } from "@ttasks/bridge/protocol";
import { expect } from "vitest";
import { ERROR_CODES, AppError, routePath, type ErrorBody } from "@ttasks/contracts";
import { httpRoutes } from "@ttasks/contracts/generated/http-routes.ts";
import { bridgePrincipal, clientOf, instanceOf } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import {
  ContractError,
  contractSuite,
  contractWorld,
  grantSuite,
  revokedSession,
  type Actor,
  type ContractTransport,
} from "./contract/suite.ts";
import { post } from "./http-client.ts";
import { signIn } from "./http-world.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

const classOf = (actor: Actor) => (actor === "user" ? "cli-interactive" : "cli-script");

contractSuite("[A3.3.2.ops.contract] the contract suite, in-process", async () => {
  const w = await contractWorld("ci");
  const transport: ContractTransport = {
    portal: w.portal,
    folder: (task) => w.folder(task),
    binds: false,
    launch: async (task) => (await w.launch(task)).reference,
    call: async (entry, input, actor) => {
      try {
        return await opCall(
          w.service.ops,
          { class: classOf(actor), env: {} },
          { op: entry, input },
        );
      } catch (error) {
        throw error instanceof AppError ? new ContractError(error.toBody()) : error;
      }
    },
    close: () => w.close(),
  };
  return transport;
});

contractSuite("[A3.3.2.ops.contract] the contract suite, over HTTP as the UI", async () => {
  // The UI is the user: every example runs as one browser session, the `ui` class with its
  // grant's writer scope (A3 3.7.9). Every entry with a UI face goes over HTTP as the page sends
  // it; `receipt.get`, which has none, reads the same scope through the request path.
  const w = await contractWorld("ch", { http: {} });
  const sessions: RpcSession[] = [];
  const { token, session } = await signIn({
    user: async () => {
      const opened = await classSession(w.home, w.path, "cli-interactive");
      sessions.push(opened);
      return opened;
    },
  });
  const port = w.service.status().http?.port ?? 0;
  const transport: ContractTransport = {
    portal: w.portal,
    folder: (task) => w.folder(task),
    binds: false,
    launch: async (task) => (await w.launch(task)).reference,
    call: async (entry, input) => {
      if (!httpRoutes.some((route) => route.entry === entry)) {
        try {
          return await opCall(
            w.service.ops,
            { class: "ui", env: {}, grant: session },
            { op: entry, input },
          );
        } catch (error) {
          throw error instanceof AppError ? new ContractError(error.toBody()) : error;
        }
      }
      const reply = await post(port, routePath(entry), input, {
        token,
        headers: { "ttasks-build": "source" },
      });
      const body = JSON.parse(reply.body) as { result?: unknown; error?: ErrorBody };
      if (reply.status === 200) return body.result;
      if (body.error === undefined) throw new Error(`HTTP ${String(reply.status)} with no body`);
      expect(reply.status).toBe(ERROR_CODES[body.error.code].http);
      throw new ContractError(body.error);
    },
    close: async () => {
      for (const opened of sessions) opened.close();
      await w.close();
    },
  };
  return transport;
});

// The grant gate (A3 3.7.8) on the faces here that carry an agent home's call. HTTP carries none:
// it is the UI's, and the UI is the user.
grantSuite("the grant gate, in-process, for an MCP connection of a home no row names", async () => {
  const w = await contractWorld("gi");
  const context = {
    space: w.space,
    instance: "ungranted-agent",
    app: "test",
    cwd: null,
    env: {},
    parent: { pid: process.pid },
  };
  // Bound as the local endpoint binds an mcp mode connection, and called as its tool caller calls.
  const connection = { context };
  await w.service.bindings.bridge(connection);
  const slot = w.service.bindings.attach(connection);
  const caller: Caller = {
    class: "bridge",
    env: {},
    principal: bridgePrincipal(context, w.service.ops.machine.id),
    client: clientOf(context),
    home: instanceOf(context),
    ...(slot === undefined ? {} : { binding: slot }),
  };
  return {
    refused: async (entry, input) => {
      try {
        await opCall(w.service.ops, caller, { op: entry, input });
        return undefined;
      } catch (error) {
        if (error instanceof AppError) return error.toBody();
        throw error;
      }
    },
    close: async () => {
      if (slot !== undefined) w.service.bindings.closed(slot);
      await w.close();
    },
  };
});

grantSuite(
  "the grant gate over ttasks-local/1, for a CLI call acting as a session of a revoked home",
  async () => {
    const w = await contractWorld("gr");
    const { ticket } = await revokedSession(w);
    const agent = await classSession(w.home, w.path, "cli-agent", { TTASKS_TICKET: ticket });
    return {
      refused: (entry, input) =>
        agent.call("op/call", { op: entry, input }, { timeoutMs: 60_000 }).then(
          () => undefined,
          (error: unknown) => errorOf(error),
        ),
      close: async () => {
        agent.close();
        await w.close();
      },
    };
  },
);

contractSuite("[A3.3.2.ops.contract] the contract suite, over ttasks-local/1", async () => {
  const w = await contractWorld("cr");
  const sessions = {
    agent: await classSession(w.home, w.path, "cli-script"),
    user: await classSession(w.home, w.path, "cli-interactive"),
  };
  const transport: ContractTransport = {
    portal: w.portal,
    folder: (task) => w.folder(task),
    binds: false,
    launch: async (task) => (await w.launch(task)).reference,
    call: async (entry, input, actor) => {
      try {
        return await sessions[actor].call("op/call", { op: entry, input }, { timeoutMs: 60_000 });
      } catch (error) {
        throw new ContractError(errorOf(error));
      }
    },
    close: async () => {
      sessions.agent.close();
      sessions.user.close();
      await w.close();
    },
  };
  return transport;
});
