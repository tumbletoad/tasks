// The contract suite (contract/suite.ts) over the request path's own faces: the functions
// in-process, tasks-local/1's `op/call` with real sessions, and HTTP as the UI. MCP and the CLI
// run it in their own tests.
import type { RpcSession } from "@tasks/bridge/protocol";
import { expect } from "vitest";
import { ERROR_CODES, AppError, routePath, type ErrorBody } from "@tasks/contracts";
import { httpRoutes } from "@tasks/contracts/generated/http-routes.ts";
import { opCall } from "../src/ops/index.ts";
import {
  ContractError,
  contractSuite,
  contractWorld,
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
        headers: { "tasks-build": "source" },
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

contractSuite("[A3.3.2.ops.contract] the contract suite, over tasks-local/1", async () => {
  const w = await contractWorld("cr");
  const sessions = {
    agent: await classSession(w.home, w.path, "cli-script"),
    user: await classSession(w.home, w.path, "cli-interactive"),
  };
  const transport: ContractTransport = {
    portal: w.portal,
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
