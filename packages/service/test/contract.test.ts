// The contract suite (contract/suite.ts) over the request path's own faces: ttasks-local/1's
// `op/call` with real sessions, which reaches the same functions as an in-process call after a JSON
// round trip, and HTTP as the UI; and the grant gate's refusal for a shell acting as a session. MCP
// and the CLI run both in their own tests.
import type { RpcSession } from "@ttasks/bridge/protocol";
import { expect } from "vitest";
import { ERROR_CODES, AppError, routePath, type ErrorBody } from "@ttasks/contracts";
import { httpRoutes } from "@ttasks/contracts/generated/http-routes.ts";
import { opCall } from "../src/ops/index.ts";
import {
  ContractError,
  contractSuite,
  contractWorld,
  grantSuite,
  revokedSession,
  type ContractTransport,
} from "./contract/suite.ts";
import { post } from "./http-client.ts";
import { signIn } from "./http-world.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

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
// it is the UI's, and the UI is the user. An MCP connection's is mcp.test.ts's.
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
