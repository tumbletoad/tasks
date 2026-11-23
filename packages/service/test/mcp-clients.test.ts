// Official MCP clients of both eras against the real service through `ttasks mcp` (A3 3.3, A3 5's
// M0 item 7, A7 3.9 M2.02's Verify line). Every client is the SDK's own, as the lab ran them (M0
// row A07): SDK 1.x (2025-11-25), and SDK 2.x in its legacy mode, its auto mode (which probes
// with server/discover) and pinned to 2026-07-28. Each starts the bridge as a real process the way
// an agent app does, through the CLI's entry and through the bridge's direct entry, against a real
// service process in a temporary TTASKS_HOME whose space comes from machine.toml. No agent app is
// started and no agent home is read or written.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "vitest";
import { INSTRUCTIONS } from "../src/mcp/index.ts";
import { removeRuntimeDir, Services, tempRoot, waitReady, type ServiceJson } from "./harness.ts";
import { hubSpace, spaceOpen } from "./mcp-hub.ts";
import { grantHome } from "./ops-helpers.ts";

const CLI_BIN = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
const BRIDGE_MAIN = fileURLToPath(new URL("../../bridge/src/mcp/main.ts", import.meta.url));

const services = new Services();
const cleanups: (() => void)[] = [];
const runtimeDirs: (ServiceJson | undefined)[] = [];
afterEach(async () => {
  await services.stopAll();
  for (const json of runtimeDirs.splice(0)) removeRuntimeDir(json);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The client's environment: this process's, without TTasks's variables or agent markers. */
function clientEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(TTASKS_|CLAUDE|CODEX_|T3CODE_)/i.test(name)) env[name] = value;
  }
  return { ...env, TTASKS_HOME: home };
}

type Kind = "v1-legacy" | "v2-legacy" | "v2-auto" | "v2-pin-2026-07-28";
const KINDS: readonly Kind[] = ["v1-legacy", "v2-legacy", "v2-auto", "v2-pin-2026-07-28"];

interface Seen {
  readonly tools: string[];
  readonly eager: string[];
  readonly instructions: string | undefined;
  readonly era: string | undefined;
  readonly version: string | undefined;
  readonly isError: boolean;
  readonly text: string;
}

const TIMEOUT_MS = 60_000;
const timeout = { timeout: TIMEOUT_MS };

/** One official client: connect through `command`, list, read the instructions, call status. */
async function useClient(
  kind: Kind,
  command: { readonly args: string[]; readonly env: Record<string, string> },
): Promise<Seen> {
  const params = {
    command: process.execPath,
    args: command.args,
    env: command.env,
    stderr: "ignore" as const,
  };
  const textOf = (content: unknown): string => {
    const first = (content as { type?: string; text?: string }[] | undefined)?.[0];
    return typeof first?.text === "string" ? first.text : "";
  };
  if (kind === "v1-legacy") {
    const client = new ClientV1({ name: "ttasks-test", version: "1.0.0" });
    await client.connect(new StdioV1(params), timeout);
    try {
      const tools = (await client.listTools(undefined, timeout)).tools;
      const call = await client.callTool({ name: "status", arguments: {} }, undefined, timeout);
      return {
        tools: tools.map((tool) => tool.name).sort(),
        eager: tools
          .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
          .map((tool) => tool.name)
          .sort(),
        instructions: client.getInstructions(),
        era: undefined,
        version: undefined,
        isError: call.isError === true,
        text: textOf(call.content),
      };
    } finally {
      await client.close();
    }
  }
  const mode =
    kind === "v2-legacy" ? "legacy" : kind === "v2-auto" ? "auto" : { pin: "2026-07-28" };
  const client = new ClientV2(
    { name: "ttasks-test", version: "2.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(new StdioV2(params), timeout);
  try {
    const tools = (await client.listTools(undefined, timeout)).tools;
    const call = await client.callTool({ name: "status", arguments: {} }, timeout);
    return {
      tools: tools.map((tool) => tool.name).sort(),
      eager: tools
        .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
        .map((tool) => tool.name)
        .sort(),
      instructions: client.getInstructions(),
      era: client.getProtocolEra(),
      version: client.getNegotiatedProtocolVersion(),
      isError: call.isError === true,
      text: textOf(call.content),
    };
  } finally {
    await client.close();
  }
}

describe("[A3.3.3.mcp.clients] official clients of both eras through ttasks mcp", () => {
  test(
    "each lists the ten tools, reads the instructions and calls status, through the CLI's entry and the bridge's",
    { timeout: 300_000 },
    async () => {
      const temp = tempRoot("oc");
      cleanups.push(temp.cleanup);
      const home = join(temp.root, "h");
      const space = await hubSpace(home);
      const service = services.start(home);
      const ready = await waitReady(home, service.pid);
      runtimeDirs.push(ready);
      await spaceOpen(home);
      // The entry's agent home, registered for the space as setup does.
      await grantHome(home, ready.endpoint?.path ?? "", {
        instance: "test-agent",
        space: space.id,
      });
      const args = ["--space", space.id, "--instance", "test-agent", "--app", "test"];
      const entries = {
        "ttasks mcp (the CLI's entry)": [CLI_BIN, "mcp", ...args],
        "the bridge's direct entry": [BRIDGE_MAIN, ...args],
      };
      for (const [entry, entryArgs] of Object.entries(entries)) {
        for (const kind of KINDS) {
          const label = `${kind} through ${entry}`;
          const seen = await useClient(kind, { args: entryArgs, env: clientEnv(home) });
          expect(seen.tools, label).toEqual([
            "add_entry",
            "add_tasks",
            "complete_task",
            "get_task",
            "organize",
            "preferences",
            "reopen_task",
            "search",
            "status",
            "update_task",
          ]);
          expect(seen.eager, label).toEqual(["get_task", "status"]);
          expect(seen.instructions, label).toBe(INSTRUCTIONS);
          expect(seen.isError, label).toBe(false);
          expect(seen.text, label).toContain("Space: Mira (M)");
          expect(seen.text, label).toMatch(/^TTasks · [^\n]* · autonomy full\n/);
          if (kind === "v2-legacy") {
            expect([seen.era, seen.version], label).toEqual(["legacy", "2025-11-25"]);
          } else if (kind !== "v1-legacy") {
            // auto probes with server/discover, which this endpoint answers: 2026-07-28.
            expect([seen.era, seen.version], label).toEqual(["modern", "2026-07-28"]);
          }
        }
      }
    },
  );
});
