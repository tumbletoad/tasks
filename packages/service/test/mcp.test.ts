// The MCP endpoint of a running service, over real tasks-local/1 mcp mode connections in this
// process (A3 3.3, A7 3.9 M2.02): one tool list on every connection and offline, both protocol
// eras' envelopes, tool calls on the request path as the connection's principal, the offline
// cache, and the contract suite and the grant gate's refusal over MCP for both eras.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { offlineReply, parseOffline } from "@tasks/bridge/mcp";
import { LocalError, PROTOCOL } from "@tasks/bridge/protocol";
import { findEntry, AppError } from "@tasks/contracts";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";
import {
  bridgePrincipal,
  clientOf,
  INSTRUCTIONS,
  renderError,
  renderResult,
} from "../src/mcp/index.ts";
import { grantRefused, opCall } from "../src/ops/index.ts";
import {
  ContractError,
  contractSuite,
  contractWorld,
  grantSuite,
  type ContractTransport,
  type GrantTransport,
} from "./contract/suite.ts";
import { diagnostics, readLog } from "./harness.ts";
import {
  bridgeContext,
  libOffline,
  LIB_OFFLINE,
  modern,
  openMcp,
  RawMcp,
  SessionTransport,
  textOf,
  unmarked,
  VERSION_META,
  world,
  type Json,
} from "./mcp-helpers.ts";
import { classSession, errorOf, grantHome } from "./ops-helpers.ts";

const LONG = 180_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function opened(label: string) {
  const w = await world(label);
  cleanups.push(() => w.close());
  return w;
}

async function raw(w: Awaited<ReturnType<typeof world>>, context?: Json): Promise<RawMcp> {
  const mcp = new RawMcp(await openMcp(w.home, w.path, context));
  cleanups.push(() => {
    mcp.close();
  });
  return mcp;
}

describe("[A3.3.3.mcp.tool-list] one tool list on every connection, online and offline", () => {
  test(
    "byte-identical whatever the bind context, in both eras, and equal to the offline file",
    async () => {
      const w = await opened("tl");
      const offline = libOffline();
      const contexts: Json[] = [
        bridgeContext(),
        bridgeContext({
          env: {
            TASKS_TICKET: "TICKETFIXTURE",
            CLAUDE_CODE_SESSION_ID: "6d1c2f9a-0000-4000-8000-000000000001",
            TASKS_TASK: "M-14",
            TASKS_SPACE: "sp_00000000000000000000000000",
          },
        }),
        bridgeContext({ resume: { handle: "bh_fixturehandle" } }),
        bridgeContext({ instance: "codex-work", app: "codex", space: w.space }),
        bridgeContext({ instance: null, app: null }),
      ];
      const legacy = new Set<string>();
      const modernLists = new Set<string>();
      for (const context of contexts) {
        const a = await raw(w, context);
        const init = await a.initialize("2025-06-18");
        expect(init.result).toBe(
          JSON.stringify({ ...offline.initialize.result, protocolVersion: "2025-06-18" }),
        );
        legacy.add((await a.request("tools/list")).result ?? "");
        const b = await raw(w, context);
        const discover = await b.request("server/discover", modern());
        expect(discover.result).toBe(JSON.stringify(offline.discover.result));
        modernLists.add((await b.request("tools/list", modern())).result ?? "");
      }
      // A connection whose bridge answered the opening offline (mcp_init): the same list.
      const replayed = await raw(
        w,
        bridgeContext({
          mcp_init: {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "c", version: "1" },
            },
          },
        }),
      );
      legacy.add((await replayed.request("tools/list")).result ?? "");
      expect([...legacy]).toEqual([JSON.stringify(offline.tools_list.result)]);
      expect([...modernLists]).toEqual([JSON.stringify(offline.tools_list.modern_result)]);
      // The list is the generated one, and the instructions are v0's.
      const tools = (offline.tools_list.result["tools"] as Json[]).map((tool) => tool["name"]);
      expect(tools).toEqual(["add_entry", "complete_task", "get_task", "status", "update_task"]);
      expect(offline.initialize.result["instructions"]).toBe(INSTRUCTIONS);
      expect(replayed.unanswered).toEqual([]);
    },
    LONG,
  );
});

describe("[A3.3.3.mcp.eras] the envelopes of both eras", () => {
  test(
    "2025-11-25: negotiated at initialize and held; tools only",
    async () => {
      const w = await opened("el");
      const a = await raw(w);
      expect(JSON.parse((await a.initialize("2025-06-18")).result ?? "{}")).toMatchObject({
        protocolVersion: "2025-06-18",
        serverInfo: { name: "tasks" },
        capabilities: { tools: { listChanged: false } },
      });
      const b = await raw(w);
      expect(JSON.parse((await b.initialize("2024-01-01")).result ?? "{}")).toMatchObject({
        protocolVersion: "2025-11-25",
      });
      const list = await a.request("tools/list");
      expect(JSON.parse(list.result ?? "{}")).not.toHaveProperty("resultType");
      expect((await a.request("ping")).result).toBe("{}");
      for (const method of ["resources/list", "prompts/list", "completion/complete"]) {
        expect((await a.request(method)).error, method).toMatchObject({ code: -32601 });
      }
      expect(
        (await a.request("tools/call", { name: "no_such_tool", arguments: {} })).error,
      ).toMatchObject({
        code: -32602,
      });
      const call = await a.request("tools/call", { name: "status", arguments: {} });
      expect(JSON.parse(call.result ?? "{}")).not.toHaveProperty("resultType");
      expect(a.unanswered).toEqual([]);
    },
    LONG,
  );

  test(
    "2026-07-28: every request's version is validated, and each result carries the modern fields",
    async () => {
      const w = await opened("em");
      const offline = libOffline();
      const a = await raw(w);
      const discover = JSON.parse(
        (await a.request("server/discover", modern())).result ?? "{}",
      ) as Json;
      expect(discover).toMatchObject({
        supportedVersions: ["2026-07-28"],
        instructions: INSTRUCTIONS,
        resultType: "complete",
      });
      const unsupported = await a.request("tools/list", modern("2027-01-01"));
      expect(unsupported.error).toMatchObject({
        code: -32022,
        data: { supported: ["2026-07-28"], requested: "2027-01-01" },
      });
      expect((await a.request("tools/list", modern(null))).error).toMatchObject({ code: -32602 });
      expect((await a.request("tools/list")).error).toMatchObject({ code: -32602 });
      const call = JSON.parse(
        (await a.request("tools/call", modern("2026-07-28", { name: "status", arguments: {} })))
          .result ?? "{}",
      ) as Json;
      expect(call).toMatchObject(offline.modern_result_fields);
      // The legacy handshake on a 2026-07-28 connection, and ping, which 2026-07-28 removed.
      expect(
        (
          await a.request("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "c", version: "1" },
          })
        ).error,
      ).toMatchObject({ code: -32022, data: { supported: ["2026-07-28"] } });
      expect((await a.request("ping", modern())).error).toMatchObject({ code: -32601 });
      // The bridge's offline responder answers each of these as the live endpoint does, so an
      // agent app cannot tell the two apart (A2 3.7.4).
      // A claim that is there but is not a version string.
      const claim = (value: unknown): Json => ({
        _meta: { ...(modern()["_meta"] as Json), [VERSION_META]: value },
      });
      const cases: [string, Json | undefined][] = [
        ["tools/list", modern("2027-01-01")],
        ["tools/list", modern(null)],
        ["tools/list", claim(null)],
        ["tools/list", claim(1)],
        ["tools/list", claim({})],
        ["tools/list", undefined],
        ["ping", modern()],
        ["resources/list", modern()],
      ];
      const content = parseOffline(readFileSync(LIB_OFFLINE, "utf8"));
      if (content === undefined) throw new Error("the build's offline file does not parse");
      for (const [method, params] of cases) {
        const live = (await a.request(method, params)).error;
        const away = offlineReply(content, { id: 1, method, params }, "service_down", "modern");
        expect(live, method).toBeDefined();
        expect(away["error"], method).toMatchObject({ code: live?.["code"] });
      }
      // An unsupported version that opens a connection is refused the same way.
      const b = await raw(w);
      expect((await b.request("server/discover", modern("2030-01-01"))).error).toMatchObject({
        code: -32022,
        data: { supported: ["2026-07-28"], requested: "2030-01-01" },
      });
      expect(a.unanswered).toEqual([]);
    },
    LONG,
  );

  test(
    "a bridge newer than the service is refused as service_too_old before any MCP line",
    async () => {
      const w = await opened("eo");
      const refused = await openMcp(w.home, w.path, bridgeContext(), PROTOCOL + 1).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(LocalError);
      expect((refused as LocalError).reason).toBe("service_too_old");
      expect(
        readLog(w.home).some(
          (e) => e["ev"] === "local.bind_refused" && e["reason"] === "service_too_old",
        ),
      ).toBe(true);
    },
    LONG,
  );
});

describe("[A3.3.3.mcp.calls] a tool call on the request path, as the connection's principal", () => {
  test(
    "unbound: agent:<instance> in history, a machine-qualified writer scope, the entry's space and never TASKS_SPACE",
    async () => {
      const w = await opened("ca");
      const user = await classSession(w.home, w.path, "cli-interactive");
      cleanups.push(() => {
        user.close();
      });
      await user.call("op/call", {
        op: "task.add",
        input: { tasks: [{ title: "Fixture task one" }], request_id: "fixture-request-add-0001" },
      });
      // The agent homes these entries name, registered for the one space as setup does.
      for (const instance of ["codex-work", "test-agent"]) {
        await grantHome(w.home, w.path, { instance, space: w.space });
      }
      // TASKS_SPACE names a space the service does not serve: ignored, the one space is used.
      const context = bridgeContext({
        instance: "codex-work",
        env: { TASKS_SPACE: "sp_00000000000000000000000000" },
      });
      const a = await raw(w, context);
      await a.initialize();
      const args = {
        task: "M-1",
        kind: "evidence",
        text: "CONTENTSENTINEL fixture evidence",
        request_id: "fixture-request-log-0001",
      };
      const logged = await a.request("tools/call", { name: "add_entry", arguments: args });
      const text = textOf(JSON.parse(logged.result ?? "{}"));
      expect(text).toMatch(/^logged l1 on M-1 \(evidence\) · as_of /);

      // The history names the instance's actor.
      const read = (await user.call("op/call", {
        op: "task.get",
        input: { task: "M-1", sections: ["log", "history"] },
      })) as { sections: { log: { author: string }[]; history: { actor: string }[] } };
      expect(read.sections.log[0]?.author).toBe("agent:codex-work");
      expect(read.sections.history[0]?.actor).toBe("agent:codex-work");

      // The writer scope: the same request ID from this principal replays, in another process too.
      const principal = bridgePrincipal(context, w.service.ops.machine.id);
      expect(principal.scope).toBe(`bridge:codex-work:${w.service.ops.machine.id}`);
      const again = await a.request("tools/call", { name: "add_entry", arguments: args });
      expect(textOf(JSON.parse(again.result ?? "{}"))).toMatch(/\(replayed\)$/);
      const b = await raw(w, bridgeContext({ instance: "codex-work" }));
      await b.initialize();
      const third = await b.request("tools/call", { name: "add_entry", arguments: args });
      expect(textOf(JSON.parse(third.result ?? "{}"))).toMatch(/^logged l1 on M-1 .*\(replayed\)$/);

      // An entry without a valid instance writes as agent:manual, in the machine's default space
      // (here the one space served, A3 3.7.4).
      const c = await raw(w, bridgeContext({ instance: "Not An Instance!" }));
      await c.initialize();
      await c.request("tools/call", {
        name: "add_entry",
        arguments: {
          task: "M-1",
          text: "fixture progress",
          request_id: "fixture-request-log-0002",
        },
      });
      const after = (await user.call("op/call", {
        op: "task.get",
        input: { task: "M-1", sections: ["log"] },
      })) as { sections: { log: { author: string }[] } };
      expect(after.sections.log[0]?.author).toBe("agent:manual");

      // The entry's --space: a space the home is not registered for is refused, never another
      // (the grant comes first; a granted space no longer served is space_unavailable, as
      // binding.test.ts shows).
      const d = await raw(w, bridgeContext({ space: "sp_00000000000000000000000000" }));
      await d.initialize();
      const elsewhere = JSON.parse(
        (await d.request("tools/call", { name: "status", arguments: {} })).result ?? "{}",
      ) as Json;
      expect(elsewhere["isError"]).toBe(true);
      expect(textOf(elsewhere)).toBe(renderError(grantRefused().toBody()));
      const e = await raw(w, bridgeContext({ space: w.space }));
      await e.initialize();
      const here = JSON.parse(
        (await e.request("tools/call", { name: "status", arguments: {} })).result ?? "{}",
      ) as Json;
      expect(here["isError"]).toBeUndefined();
      expect(textOf(here)).toContain("Space: Mira (M)");

      // A field only the user may set is refused, in A3 3.5's text form, as a tool result.
      const forAgents = JSON.parse(
        (
          await a.request("tools/call", {
            name: "add_entry",
            arguments: {
              task: "M-1",
              kind: "note",
              text: "x",
              for_agents: true,
              request_id: "fixture-request-note-001",
            },
          })
        ).result ?? "{}",
      ) as Json;
      expect(forAgents["isError"]).toBe(true);
      expect(textOf(forAgents)).toBe(
        "error forbidden: Only the user can do this. Ask the user to do this in TT Tasks.",
      );

      // Nothing a call carried reached the log or a crash file.
      for (const file of diagnostics(w.home)) {
        expect(file.text, file.file).not.toContain("CONTENTSENTINEL");
        expect(file.text, file.file).not.toContain("fixture-request");
      }
    },
    LONG,
  );
});

describe("[A2.3.7.mcp.offline-cache] the service writes the offline cache at every start", () => {
  test(
    "<cache>/mcp-offline.json equals the build's lib/mcp-offline.json, user-only",
    async () => {
      const w = await opened("oc");
      const cache = join(w.home, "cache", "mcp-offline.json");
      expect(readFileSync(cache, "utf8")).toBe(readFileSync(LIB_OFFLINE, "utf8"));
      if (process.platform !== "win32") expect(statSync(cache).mode & 0o777).toBe(0o600);
      expect(
        readLog(w.home).some((e) => e["ev"] === "mcp.offline_written" && e["result"] === "written"),
      ).toBe(true);
    },
    LONG,
  );
});

// ---------------------------------------------------------------------------------------------
// The contract suite over MCP, in both eras. A tool's text must be the entry's rendering of the
// structured result `op/call` gives the same principal: for a write its replay (the same request
// ID in the same writer scope), for a read the same read again. Entries without a tool go to the
// request path with the connection's principal, so receipts stay in one writer scope; the user's
// own calls go to op/call as the user.

const ERROR_TEXT = /^error ([a-z_]+)(?: \([a-z_]+\))?: /;

function mcpContract(era: "legacy" | "modern"): () => Promise<ContractTransport> {
  return async () => {
    const w = await contractWorld(`k${era[0] ?? ""}`);
    // The agent's home, registered for the world's space as setup does.
    await grantHome(w.home, w.path, { instance: "contract-agent", space: w.space });
    const context = bridgeContext({ instance: "contract-agent" });
    const principal = bridgePrincipal(context, w.service.ops.machine.id);
    const who = clientOf(context);
    const session = await openMcp(w.home, w.path, context);
    const client = new Client(
      { name: "contract", version: "1.0.0" },
      { versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } } },
    );
    await client.connect(new SessionTransport(session));
    expect(client.getProtocolEra()).toBe(era);
    const user = await classSession(w.home, w.path, "cli-interactive");
    // The structured result to compare the text with comes from the request path in this process,
    // on the connection's own binding: what the MCP call bound, it is bound to as well.
    const [binding] = w.service.bindings.open();
    if (binding === undefined) throw new Error("the MCP connection holds no binding");
    const direct = async (op: string, input: Json): Promise<unknown> => {
      try {
        return await opCall(
          w.service.ops,
          { class: "bridge", env: {}, principal, client: who, binding },
          { op, input },
        );
      } catch (error) {
        throw error instanceof AppError ? new ContractError(error.toBody()) : error;
      }
    };
    return {
      portal: w.portal,
      binds: true,
      launch: async (task) => (await w.launch(task)).reference,
      call: async (name, input, actor) => {
        const entry = findEntry(name);
        if (actor === "user") {
          try {
            return await user.call("op/call", { op: name, input }, { timeoutMs: 60_000 });
          } catch (error) {
            throw new ContractError(errorOf(error));
          }
        }
        const tool = entry?.faces.mcp?.tool;
        if (entry === undefined || tool === undefined) return direct(name, input);
        const result = await client.callTool({ name: tool, arguments: input });
        const text = textOf(result);
        if (result.isError === true) {
          const code = ERROR_TEXT.exec(text)?.[1];
          if (code === undefined) throw new Error("a tool error without A3's text form");
          throw new ContractError({ code: code as never, message: text });
        }
        const structured = (await direct(name, input)) as Json;
        let first = structured;
        if (entry.kind === "write") {
          expect(structured["replayed"], `${name}: the same request replays`).toBe(true);
          first = Object.fromEntries(
            Object.entries(structured).filter(([key]) => key !== "replayed"),
          );
        }
        expect(unmarked(text), `${name}: the text is the rendering of the result`).toBe(
          unmarked(renderResult(name, first)),
        );
        return first;
      },
      close: async () => {
        await client.close();
        user.close();
        await w.close();
      },
    };
  };
}

/**
 * The grant gate over MCP (A3 3.7.8): a real mcp mode connection whose entry names a home no row
 * names, through the SDK's client in `era`. A tool's refusal is A3's text form of the body; an
 * entry without a tool in this build goes to the request path as the same connection.
 */
function mcpGrant(era: "legacy" | "modern"): () => Promise<GrantTransport> {
  return async () => {
    const w = await contractWorld(`g${era[0] ?? ""}`);
    const context = bridgeContext({ space: w.space, instance: "ungranted-agent" });
    const session = await openMcp(w.home, w.path, context);
    const client = new Client(
      { name: "grant", version: "1.0.0" },
      { versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } } },
    );
    await client.connect(new SessionTransport(session));
    expect(client.getProtocolEra()).toBe(era);
    const [binding] = w.service.bindings.open();
    return {
      refused: async (name, input) => {
        const tool = findEntry(name)?.faces.mcp?.tool;
        if (tool === undefined) {
          try {
            await opCall(
              w.service.ops,
              {
                class: "bridge",
                env: {},
                principal: bridgePrincipal(context, w.service.ops.machine.id),
                home: "ungranted-agent",
                ...(binding === undefined ? {} : { binding }),
              },
              { op: name, input },
            );
            return undefined;
          } catch (error) {
            if (error instanceof AppError) return error.toBody();
            throw error;
          }
        }
        const result = await client.callTool({ name: tool, arguments: input });
        return result.isError === true ? textOf(result) : undefined;
      },
      close: async () => {
        await client.close();
        await w.close();
      },
    };
  };
}

grantSuite("the grant gate over MCP (2025-11-25)", mcpGrant("legacy"));
grantSuite("the grant gate over MCP (2026-07-28)", mcpGrant("modern"));

contractSuite(
  "[A3.3.2.ops.contract] [A3.3.10.mcp.framing] the contract suite, over MCP (2025-11-25)",
  mcpContract("legacy"),
);
contractSuite(
  "[A3.3.2.ops.contract] [A3.3.10.mcp.framing] the contract suite, over MCP (2026-07-28)",
  mcpContract("modern"),
);
