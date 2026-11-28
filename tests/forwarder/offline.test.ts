// Forwarder conformance: the offline responder for both MCP eras, with
// and without the cache; the same tools offline and online; and a session that starts offline
// and goes on online once the service comes, without restarting the client.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  Procs,
  isObject,
  isOfflineText,
  libOffline,
  makeHome,
  peerBinds,
  sleep,
  textOf,
  type Bridge,
  type Home,
  type Json,
} from "./harness.ts";

const procs = new Procs();
const homes: Home[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
});

function home(label: string): Home {
  const made = makeHome(label);
  homes.push(made);
  return made;
}

const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const modernMeta = (version?: string): Json => ({
  _meta: {
    ...(version === undefined ? {} : { [VERSION_META]: version }),
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" },
  },
});

/** The stored part of the offline content, as the file holds it. */
const lib = () =>
  libOffline() as {
    initialize: { result: Json };
    discover: { result: Json };
    tools_list: { result: Json; modern_result: Json };
    modern_result_fields: Json;
  };

describe("[A2.3.7.bridge.offline] the offline responder", () => {
  test(
    "legacy era, service not running: the stored answers and the service_down text",
    { timeout: 120_000 },
    async () => {
      const bridge = procs.bridge(home("legacy"));
      const content = lib();
      const asked = await bridge.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      });
      expect(asked["result"]).toEqual({
        ...content.initialize.result,
        protocolVersion: "2025-06-18",
      });
      const unknown = await bridge.request("initialize", { protocolVersion: "2024-01-01" });
      expect(unknown["result"]).toEqual({
        ...content.initialize.result,
        protocolVersion: "2025-11-25",
      });
      bridge.notify("notifications/initialized");
      const list = await bridge.request("tools/list");
      expect(JSON.stringify(list["result"])).toBe(JSON.stringify(content.tools_list.result));
      const call = await bridge.call("status", {});
      expect(isOfflineText(call, "service_down")).toBe(true);
      expect(await bridge.request("ping")).toMatchObject({ result: {} });
      const other = await bridge.request("resources/list");
      expect(other["error"]).toMatchObject({ code: -32601 });
      // Notifications get no answer: the next reply is the one to the next request.
      bridge.notify("notifications/cancelled", { requestId: 99 });
      expect(await bridge.request("ping", {}, "after")).toMatchObject({ id: "after", result: {} });
      expect(bridge.lines).toHaveLength(7);
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "2026-07-28 era: every request's version is validated first",
    { timeout: 120_000 },
    async () => {
      const bridge = procs.bridge(home("modern"));
      const content = lib();
      const discover = await bridge.request("server/discover", modernMeta("2026-07-28"));
      expect(discover["result"]).toEqual(content.discover.result);
      const list = await bridge.request("tools/list", modernMeta("2026-07-28"));
      expect(JSON.stringify(list["result"])).toBe(JSON.stringify(content.tools_list.modern_result));
      const call = await bridge.request("tools/call", {
        name: "status",
        arguments: {},
        ...modernMeta("2026-07-28"),
      });
      expect(isOfflineText(call, "service_down")).toBe(true);
      expect(call["result"]).toMatchObject(content.modern_result_fields);
      const unsupported = await bridge.request("tools/list", modernMeta("2027-01-01"));
      expect(unsupported["error"]).toMatchObject({
        code: -32022,
        data: { supported: ["2026-07-28"], requested: "2027-01-01" },
      });
      const missing = await bridge.request("server/discover", modernMeta());
      expect(missing["error"]).toMatchObject({ code: -32602 });
      // The session began with server/discover: a request with no metadata at all is still a
      // 2026-07-28 request, and it lacks its version.
      const bare = await bridge.request("tools/list");
      expect(bare["error"]).toMatchObject({ code: -32602 });
      expect(bridge.stray).toEqual([]);
    },
  );

  test(
    "the cache is used when it parses and was written for this build, and the build's file otherwise",
    { timeout: 120_000 },
    async () => {
      const content = libOffline();
      const marked = (build: string): string => {
        const copy = JSON.parse(JSON.stringify(content)) as Json;
        copy["build"] = build;
        const init = (copy["initialize"] as Json)["result"] as Json;
        init["instructions"] = `from the cache of ${build}`;
        return JSON.stringify(copy);
      };
      const cases: [string, string | undefined, string][] = [
        [
          "same build",
          marked(String(content["build"])),
          `from the cache of ${String(content["build"])}`,
        ],
        [
          "other build",
          marked("other-build"),
          String(((content["initialize"] as Json)["result"] as Json)["instructions"]),
        ],
        [
          "broken",
          "{not json",
          String(((content["initialize"] as Json)["result"] as Json)["instructions"]),
        ],
        [
          "absent",
          undefined,
          String(((content["initialize"] as Json)["result"] as Json)["instructions"]),
        ],
      ];
      for (const [label, cache, expected] of cases) {
        const where = home(label.replace(" ", "-"));
        if (cache !== undefined) writeFileSync(join(where.cache, "mcp-offline.json"), cache);
        const bridge = procs.bridge(where);
        const reply = await bridge.initialize();
        expect((reply["result"] as Json)["instructions"], label).toBe(expected);
      }
    },
  );

  test(
    "service.json that says starting, and a missing key, give their own texts",
    { timeout: 120_000 },
    async () => {
      const starting = home("starting");
      writeFileSync(
        join(starting.state, "service.json"),
        JSON.stringify({ format: 1, state: "starting", endpoint: null }),
      );
      const one = procs.bridge(starting);
      await one.initialize();
      expect(isOfflineText(await one.call("status"), "starting")).toBe(true);

      const nokey = home("nokey");
      await procs.peer(nokey);
      writeFileSync(join(nokey.state, "ipc.key"), "not a key");
      const two = procs.bridge(nokey);
      await two.initialize();
      expect(isOfflineText(await two.call("status"), "unreachable")).toBe(true);
    },
  );
});

/** Calls echo until it is answered online, or fails after `ms`. */
async function untilOnline(bridge: Bridge, ms = 60_000): Promise<Json> {
  const deadline = Date.now() + ms;
  for (;;) {
    const reply = await bridge.call("echo", { ok: true });
    if (!isOffline(reply)) return reply;
    if (Date.now() > deadline) throw new Error("never online");
    await sleep(200);
  }
}

const isOffline = (reply: Json): boolean => {
  const result = reply["result"];
  return isObject(result) && result["isError"] === true;
};

describe("[A2.3.7.bridge.offline] a session that starts offline", () => {
  test(
    "the client lists tools and gets the offline text, then the service starts and the next call succeeds without a restart",
    { timeout: 120_000 },
    async () => {
      const where = home("late");
      const bridge = procs.bridge(where);
      const init = await bridge.initialize("2025-06-18");
      const offlineList = await bridge.request("tools/list");
      expect(isOfflineText(await bridge.call("status"), "service_down")).toBe(true);

      await procs.peer(where);
      const reply = await untilOnline(bridge);
      expect(textOf(reply)).toBe('{"ok":true}');
      // The same tools online as offline, byte for byte.
      const onlineList = await bridge.request("tools/list");
      expect(JSON.stringify(onlineList["result"])).toBe(JSON.stringify(offlineList["result"]));
      // The service got the client's initialize as mcp_init, so the session went on from it.
      const bind = peerBinds(where).at(-1);
      expect(bind?.context["mcp_init"]).toMatchObject({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      expect(init["result"]).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(bridge.stray).toEqual([]);
    },
  );
});
