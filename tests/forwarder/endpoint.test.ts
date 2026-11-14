// The forwarder against the real service's MCP endpoint (A3 3.3, A2 3.7.3, A7 3.9 M2.02): the
// tool list a live connection gives is the offline file's, byte for byte, in both eras; a session
// that starts offline goes on with the real service from mcp_init; and a forwarder newer than the
// service gets service_too_old in both eras. The hub runs as a real process with a space from
// machine.toml.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hubSpace, spaceOpen } from "../../packages/service/test/mcp-hub.ts";
import {
  Procs,
  isObject,
  isOfflineText,
  libOffline,
  makeHome,
  sleep,
  textOf,
  waitFor,
  type Bridge,
  type Home,
  type Json,
  type Proc,
} from "./harness.ts";

const procs = new Procs();
const homes: Home[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const home of homes.splice(0)) home.remove();
});

const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const modern = (params: Json = {}): Json => ({
  ...params,
  _meta: {
    [VERSION_META]: "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" },
  },
});

/** A home with a space in its machine.toml; the hub started on it and ready. */
async function served(label: string): Promise<{ home: Home; space: string; hub: Proc }> {
  const home = makeHome(label);
  homes.push(home);
  const space = await hubSpace(home.root);
  return { home, space: space.id, hub: await startHub(home) };
}

async function startHub(home: Home, times = 1): Promise<Proc> {
  const hub = procs.hub(home);
  await waitFor(
    () => {
      try {
        const json = JSON.parse(readFileSync(join(home.state, "service.json"), "utf8")) as Json;
        return json["state"] === "ready" && json["pid"] === hub.pid ? true : undefined;
      } catch {
        return undefined;
      }
    },
    60_000,
    "hub ready",
  );
  await spaceOpen(home.root, times);
  return hub;
}

/** Stops the hub gracefully: it removes its service.json, so a bridge then reports it down. */
async function stopHub(hub: Proc): Promise<void> {
  hub.child.stdin?.write("stop\n");
  await hub.exit;
}

const args = (space: string) => ["--space", space, "--instance", "test-agent", "--app", "test"];
const resultJson = (reply: Json): string => JSON.stringify(reply["result"]);

async function lists(
  bridge: Bridge,
  era: "legacy" | "modern",
): Promise<{ open: Json; list: string }> {
  if (era === "legacy") {
    const open = await bridge.initialize("2025-06-18");
    return { open, list: resultJson(await bridge.request("tools/list")) };
  }
  const open = await bridge.request("server/discover", modern());
  return { open, list: resultJson(await bridge.request("tools/list", modern())) };
}

describe("[A3.3.3.mcp.tool-list] through the forwarder: the live list is the offline list", () => {
  test(
    "online and offline, in both eras, byte for byte; the opening answers are the offline file's",
    { timeout: 240_000 },
    async () => {
      const { home, space, hub } = await served("list");
      const offline = libOffline() as {
        initialize: { result: Json };
        discover: { result: Json };
        tools_list: { result: Json; modern_result: Json };
        modern_result_fields: Json;
      };
      const online = {
        legacy: await lists(procs.bridge(home, { args: args(space) }), "legacy"),
        modern: await lists(procs.bridge(home, { args: args(space) }), "modern"),
      };
      expect(online.legacy.list).toBe(JSON.stringify(offline.tools_list.result));
      expect(online.modern.list).toBe(JSON.stringify(offline.tools_list.modern_result));
      expect(online.legacy.open["result"]).toEqual({
        ...offline.initialize.result,
        protocolVersion: "2025-06-18",
      });
      expect(online.modern.open["result"]).toEqual(offline.discover.result);

      // A tool call online is the service's answer, with the modern fields in 2026-07-28.
      const caller = procs.bridge(home, { args: args(space) });
      await caller.request("server/discover", modern());
      const call = await caller.request("tools/call", modern({ name: "status", arguments: {} }));
      expect(textOf(call)).toContain("Space: Mira (M)");
      expect(call["result"]).toMatchObject(offline.modern_result_fields);

      await stopHub(hub);
      const down = {
        legacy: await lists(procs.bridge(home, { args: args(space) }), "legacy"),
        modern: await lists(procs.bridge(home, { args: args(space) }), "modern"),
      };
      expect(down.legacy.list).toBe(online.legacy.list);
      expect(down.modern.list).toBe(online.modern.list);
      expect(down.legacy.open["result"]).toEqual(online.legacy.open["result"]);
      expect(down.modern.open["result"]).toEqual(online.modern.open["result"]);
    },
  );

  test(
    "a session that starts offline goes on with the real service, from mcp_init, without a new initialize",
    { timeout: 240_000 },
    async () => {
      const home = makeHome("late");
      homes.push(home);
      const space = (await hubSpace(home.root)).id;
      const bridge = procs.bridge(home, { args: args(space) });
      await bridge.initialize("2025-06-18");
      const offlineList = resultJson(await bridge.request("tools/list"));
      expect(isOfflineText(await bridge.call("status"), "service_down")).toBe(true);

      await startHub(home);
      let reply: Json = {};
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        reply = await bridge.call("status");
        if (isObject(reply["result"]) && reply["result"]["isError"] !== true) break;
        await sleep(200);
      }
      expect(textOf(reply)).toContain("Space: Mira (M)");
      expect(resultJson(await bridge.request("tools/list"))).toBe(offlineList);
      // The client's initialize was answered offline: the service replayed it and sent nothing
      // for it, so every line on stdout answers a request the client sent, once.
      expect(bridge.stray).toEqual([]);
    },
  );
});

describe("[A3.3.3.mcp.eras] a forwarder newer than the service", () => {
  test(
    "tools answer service_unavailable with service_too_old, in both eras",
    { timeout: 240_000 },
    async () => {
      const { home, space } = await served("newer");
      const legacy = procs.bridge(home, { args: args(space), newer: true });
      await legacy.initialize();
      expect(isOfflineText(await legacy.call("status"), "service_too_old")).toBe(true);
      expect(textOf(await legacy.call("status"))).toMatch(
        /^error service_unavailable \(service_too_old\): /,
      );
      const current = procs.bridge(home, { args: args(space), newer: true });
      await current.request("server/discover", modern());
      const call = await current.request("tools/call", modern({ name: "status", arguments: {} }));
      expect(isOfflineText(call, "service_too_old")).toBe(true);
      expect(call["result"]).toMatchObject(
        (libOffline() as { modern_result_fields: Json }).modern_result_fields,
      );
      expect(legacy.stray).toEqual([]);
      expect(current.stray).toEqual([]);
    },
  );
});
