// The offline responder's table (A2 3.7.4) for both eras, the file format and its loading
// (A2 3.7.3), and the one parse per line the forwarder relies on.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION_META, eraOf, inspect, lightParams } from "./message.ts";
import {
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  SERVER_ERROR,
  TEXT_KEYS,
  TEXT_OF,
  UNSUPPORTED_VERSION,
  loadOffline,
  lostReply,
  offlineReply,
  parseOffline,
  type OfflineContent,
} from "./offline.ts";
import { SOURCE_LIB } from "./run.ts";

const TEXT = readFileSync(SOURCE_LIB, "utf8");
const CONTENT = parseOffline(TEXT) as OfflineContent;
const modern = (version?: string) => ({
  _meta:
    version === undefined
      ? { "io.modelcontextprotocol/clientCapabilities": {} }
      : { [VERSION_META]: version },
});

describe("[A2.3.7.bridge.offline] the offline responder's table", () => {
  test("the build's file parses, and every reason has a text naming it", () => {
    expect(CONTENT).toBeDefined();
    expect(CONTENT.tools_list.result["tools"]).toEqual(CONTENT.tools_list.modern_result["tools"]);
    for (const key of TEXT_KEYS)
      expect(CONTENT.texts[key]).toMatch(/^error service_unavailable \(/);
    for (const [reason, key] of Object.entries(TEXT_OF)) {
      expect(CONTENT.texts[key]).toContain(`(${reason})`);
    }
  });

  test("a file that is not exactly format 1 is refused", () => {
    const broken = (change: (copy: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(TEXT) as Record<string, unknown>;
      change(copy);
      return JSON.stringify(copy);
    };
    expect(parseOffline("{")).toBeUndefined();
    expect(parseOffline(broken((c) => (c["format"] = 2)))).toBeUndefined();
    expect(parseOffline(broken((c) => delete c["discover"]))).toBeUndefined();
    expect(
      parseOffline(broken((c) => ((c["texts"] as Record<string, unknown>)["starting"] = 1))),
    ).toBeUndefined();
    expect(
      parseOffline(
        broken((c) => ((c["initialize"] as Record<string, unknown>)["supported_versions"] = [])),
      ),
    ).toBeUndefined();
  });

  test("the cache wins only when it parses and names this build", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-off-"));
    try {
      const cache = join(dir, "mcp-offline.json");
      const marked = JSON.parse(TEXT) as { build: string; texts: Record<string, string> };
      marked.texts["service_down"] = "from the cache";
      writeFileSync(cache, JSON.stringify(marked));
      expect(loadOffline({ cache, lib: SOURCE_LIB }, CONTENT.build)?.texts.service_down).toBe(
        "from the cache",
      );
      expect(loadOffline({ cache, lib: SOURCE_LIB }, "another-build")?.texts.service_down).toBe(
        CONTENT.texts.service_down,
      );
      writeFileSync(cache, "x".repeat(2 * 1024 * 1024));
      expect(loadOffline({ cache, lib: SOURCE_LIB }, CONTENT.build)).toEqual(CONTENT);
      expect(
        loadOffline({ cache: undefined, lib: join(dir, "missing.json") }, "x"),
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy era: initialize negotiates, tools/list, tools/call, ping, and the rest", () => {
    const reply = (method: string, params?: Record<string, unknown>) =>
      offlineReply(CONTENT, { id: 7, method, params }, "service_down");
    expect(reply("initialize", { protocolVersion: "2025-03-26" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ...CONTENT.initialize.result, protocolVersion: "2025-03-26" },
    });
    expect(reply("initialize", { protocolVersion: "1999-01-01" })).toMatchObject({
      result: { protocolVersion: "2025-11-25" },
    });
    expect(reply("initialize")).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect(reply("tools/list")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: CONTENT.tools_list.result,
    });
    expect(reply("tools/call", { name: "status" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: CONTENT.texts.service_down }], isError: true },
    });
    expect(reply("ping")).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(reply("prompts/list")).toMatchObject({ error: { code: METHOD_NOT_FOUND } });
  });

  test("2026-07-28 era: the version comes first, then the same table with the era's fields", () => {
    const reply = (method: string, params: Record<string, unknown>) =>
      offlineReply(CONTENT, { id: "m", method, params }, "untrusted_endpoint");
    expect(reply("server/discover", modern("2026-07-28"))).toEqual({
      jsonrpc: "2.0",
      id: "m",
      result: CONTENT.discover.result,
    });
    expect(reply("tools/list", modern("2026-07-28"))).toMatchObject({
      result: CONTENT.tools_list.modern_result,
    });
    expect(reply("tools/call", { name: "x", ...modern("2026-07-28") })).toMatchObject({
      result: { isError: true, ...CONTENT.modern_result_fields },
    });
    expect(reply("tools/list", modern("2030-01-01"))).toMatchObject({
      error: {
        code: UNSUPPORTED_VERSION,
        data: { supported: ["2026-07-28"], requested: "2030-01-01" },
      },
    });
    expect(reply("server/discover", modern())).toMatchObject({ error: { code: INVALID_PARAMS } });
    expect(reply("server/discover", {})).toMatchObject({ error: { code: INVALID_PARAMS } });
    // 2026-07-28 removed ping: as the live endpoint, the responder knows no such method.
    expect(reply("ping", modern("2026-07-28"))).toMatchObject({
      error: { code: METHOD_NOT_FOUND },
    });
  });

  test("a request lost in flight: connection_lost for a tool call, the live answer for the rest, an error otherwise", () => {
    expect(
      JSON.stringify(lostReply(CONTENT, { id: 1, method: "tools/call", params: {} })),
    ).toContain("(connection_lost)");
    expect(lostReply(CONTENT, { id: 2, method: "tools/list", params: undefined })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: CONTENT.tools_list.result,
    });
    expect(lostReply(CONTENT, { id: 3, method: "custom/thing", params: {} })).toMatchObject({
      error: { code: SERVER_ERROR, data: { reason: "connection_lost", retryable: true } },
    });
    expect(lostReply(undefined, { id: 4, method: "tools/call", params: {} })).toMatchObject({
      error: { code: SERVER_ERROR },
    });
  });

  test("one parse tells the kind, ID and era; params in flight keep only what a reply needs", () => {
    expect(inspect('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toMatchObject({
      kind: "request",
      id: 1,
      method: "tools/list",
    });
    expect(inspect('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toMatchObject({
      kind: "notification",
    });
    expect(inspect('{"jsonrpc":"2.0","id":"a","result":{}}')).toEqual({
      kind: "response",
      id: "a",
    });
    for (const line of [
      "",
      "x",
      "[]",
      "1",
      '{"id":null,"method":"x"}',
      '[{"jsonrpc":"2.0","id":1,"method":"a"}]',
    ]) {
      expect(inspect(line)).toEqual({ kind: "other" });
    }
    expect(eraOf("initialize", modern("2026-07-28"))).toBe("legacy");
    expect(eraOf("server/discover", undefined)).toBe("modern");
    expect(eraOf("tools/list", modern("2026-07-28"))).toBe("modern");
    expect(eraOf("tools/list", { _meta: { progressToken: 1 } })).toBe("legacy");
    expect(eraOf("tools/call", { requestState: "x" })).toBe("modern");
    expect(
      lightParams({
        name: "x",
        arguments: { big: "y".repeat(1000) },
        _meta: { a: 1 },
        requestState: "s",
      }),
    ).toEqual({ _meta: {}, requestState: true }); // _meta's own keys are not kept
  });
});
