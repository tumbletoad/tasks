// A07 (A3 M0 item 7): the official MCP clients of both protocol eras against the stand-in
// endpoint through the bridge (the kit's forwarder to `kit service`), and whether one official
// server SDK object serves both eras.
//   2025-11-25 clients: @modelcontextprotocol/sdk 1.32.2 (latest 2025-11-25) and
//                       @modelcontextprotocol/client 2.4.0 in its default `legacy` mode.
//   2026-07-28 clients: @modelcontextprotocol/client 2.4.0 pinned to 2026-07-28, and in `auto`.
// Nothing here starts an agent CLI or a model session.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonObject } from "../kit/wire.ts";
import { openScratch } from "./scratch.ts";
import { cleanEnv } from "./spawn.ts";

const AGENTS = dirname(fileURLToPath(import.meta.url));

type ClientKind = "v1-legacy" | "v2-legacy" | "v2-pin-2026-07-28" | "v2-auto";
interface Target {
  name: string;
  command: string;
  args: string[];
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new Error("timeout"));
      }, ms),
    ),
  ]);

function errorClass(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout/i.test(text)) return "timeout";
  if (/-32022|unsupported.*version/i.test(text)) return "unsupported_version";
  if (/-32601|method not found/i.test(text)) return "method_not_found";
  if (/-32602|invalid/i.test(text)) return "invalid_params";
  if (/closed|EPIPE|exit/i.test(text)) return "connection_closed";
  return "other";
}

async function tryClient(
  kind: ClientKind,
  target: Target,
  env: Record<string, string>,
): Promise<JsonObject> {
  const t0 = performance.now();
  const result: JsonObject = { client: kind, target: target.name };
  try {
    if (kind === "v1-legacy") {
      const client = new ClientV1({ name: "mcp", version: "1.32.2" });
      const transport = new StdioV1({
        command: target.command,
        args: target.args,
        env,
        stderr: "ignore",
      });
      try {
        await withTimeout(client.connect(transport), 20_000);
        const tools = await withTimeout(client.listTools(), 10_000);
        const call = await withTimeout(
          client.callTool({ name: tools.tools[0]?.name ?? "status", arguments: {} }),
          10_000,
        );
        result["ok"] = true;
        // SDK 1.x does not expose the negotiated version: the service's mcp events show it.
        result["negotiated_version"] = null;
        result["instructions"] = (client.getInstructions() ?? "") !== "";
        result["tools"] = tools.tools.length;
        result["call_ok"] = call.isError !== true;
      } finally {
        await client.close().catch(() => undefined);
      }
    } else {
      const mode =
        kind === "v2-legacy" ? "legacy" : kind === "v2-auto" ? "auto" : { pin: "2026-07-28" };
      const client = new ClientV2(
        { name: "mcp", version: "2.4.0" },
        { versionNegotiation: { mode } },
      );
      const transport = new StdioV2({
        command: target.command,
        args: target.args,
        env,
        stderr: "ignore",
      });
      try {
        await withTimeout(client.connect(transport), 20_000);
        const tools = await withTimeout(client.listTools(), 10_000);
        const call = await withTimeout(
          client.callTool({ name: tools.tools[0]?.name ?? "status", arguments: {} }),
          10_000,
        );
        result["ok"] = true;
        result["negotiated_version"] = client.getNegotiatedProtocolVersion() ?? null;
        result["era"] = (client.getProtocolEra() as string | undefined) ?? null;
        result["instructions"] = (client.getInstructions() ?? "") !== "";
        result["tools"] = tools.tools.length;
        result["call_ok"] = call.isError !== true;
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  } catch (error) {
    result["ok"] = false;
    result["error"] = errorClass(error);
  }
  result["ms"] = Math.round(performance.now() - t0);
  return result;
}

/** The service's `mcp` events since `since`: method, era, version labels, counted. */
function mcpEvents(state: string, since: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of readFileSync(join(state, "events.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const e = JSON.parse(line) as JsonObject;
    if (typeof e["t"] !== "number" || e["t"] < since || e["kind"] !== "mcp") continue;
    const label = (v: unknown) => (typeof v === "string" ? v : "null");
    const key = `${label(e["method"])} ${label(e["era"])} ${label(e["version"])}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function runA07(o: {
  scratch: string;
  path: string;
  startService: (
    state: string,
    socketDir: string,
    kitJs: string,
  ) => Promise<{ stop: () => Promise<void> }>;
  kitJs: string;
}): Promise<JsonObject> {
  const node = process.execPath;
  const env = cleanEnv(process.env, {}, { path: o.path });
  // Every removal goes through the lab's removal rule (scratch.ts).
  const sc = openScratch(o.scratch);
  const state = join(o.scratch, "a07-svc", "state");
  sc.remove(state);
  const service = await o.startService(
    state,
    process.platform === "win32" ? "state" : "run-user",
    o.kitJs,
  );
  const count = join(o.scratch, "a07-svc", "instances.txt");
  const kinds: ClientKind[] = ["v1-legacy", "v2-legacy", "v2-pin-2026-07-28", "v2-auto"];
  const runs: JsonObject[] = [];
  try {
    const bridge: Target = {
      name: "bridge (kit forwarder to kit service)",
      command: node,
      args: [join(o.kitJs, "forwarder.mjs"), "--state", state],
    };
    for (const kind of kinds) {
      const t = Date.now();
      const r = await tryClient(kind, bridge, env);
      await new Promise((res) => setTimeout(res, 200));
      r["service_mcp_events"] = mcpEvents(state, t);
      runs.push(r);
    }
    for (const mode of ["factory", "single"] as const) {
      const target: Target = {
        name:
          mode === "factory"
            ? "v2 server SDK 2.4.0, serveStdio(factory)"
            : "v2 server SDK 2.4.0, one McpServer + StdioServerTransport",
        command: node,
        args: [join(AGENTS, "a07-server.ts"), "--mode", mode, "--count", count],
      };
      for (const kind of kinds) {
        sc.remove(count);
        appendFileSync(count, "");
        const r = await tryClient(kind, target, env);
        r["server_instances_built"] = existsSync(count)
          ? readFileSync(count, "utf8")
              .split("\n")
              .filter((l) => l === "instance").length
          : null;
        runs.push(r);
      }
    }
  } finally {
    await service.stop();
  }
  return {
    row: "A07",
    runs,
    bridge: "kit forwarder.mjs and kit service, both from a kit build (.mjs)",
  };
}
