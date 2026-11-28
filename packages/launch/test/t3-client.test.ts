// The MCP client of T3: how it reads an answer streamed as server-sent
// events. A server may keep the stream open after the reply (the specification only says it SHOULD
// close it), and the SSE grammar allows CRLF, LF and CR line endings in any mix, also split across
// chunks. The reply must be taken as soon as its event is complete; waiting for the end of the
// stream turns every answer into a lost one at the deadline. A stub server in this process, no
// network and no T3.
import { describe, expect, test } from "vitest";
import { T3_MAX_ANSWER, T3Error, T3Mcp } from "../src/t3-client.ts";

const ORIGIN = "http://127.0.0.1:9";
const TOKEN = "fixture-token-0001";

/**
 * A fetch that plays T3's MCP endpoint: `initialize` and the notification answer at once, the tool
 * call answers with `chunks(id)` as an SSE stream that stays open until the request is aborted.
 */
function streaming(chunks: (id: number) => (string | Uint8Array)[]): typeof fetch {
  const encoder = new TextEncoder();
  return ((_url: string, init: RequestInit) => {
    const text = typeof init.body === "string" ? init.body : "";
    const body = JSON.parse(text) as { id?: number; method: string };
    if (body.method === "initialize") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-11-25" },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s-1" } },
        ),
      );
    }
    if (body.method.startsWith("notifications/")) {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    const parts = chunks(body.id ?? 0);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
        }
        // Open until the client cancels it or its deadline aborts the request.
        init.signal?.addEventListener("abort", () => {
          controller.error(new Error("aborted"));
        });
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
  }) as typeof fetch;
}

const reply = (id: number) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: { structuredContent: { threadId: "thread-1" } } });

async function call(fetchFn: typeof fetch): Promise<unknown> {
  const mcp = new T3Mcp({ fetch: fetchFn, requestMs: 2_000 });
  return mcp
    .call({ origin: ORIGIN, token: TOKEN }, "t3_thread_launch", {})
    .catch((error: unknown) => error);
}

describe("[A4.3.4.1.t3.client] the MCP client reads T3's streamed answers", () => {
  test("a reply event ended by any mix of line endings is taken at once from a stream left open", async () => {
    const endings: [string, (id: number) => (string | Uint8Array)[]][] = [
      ["LF", (id) => [`event: message\ndata: ${reply(id)}\n\n`]],
      ["CRLF", (id) => [`event: message\r\ndata: ${reply(id)}\r\n\r\n`]],
      ["CR", (id) => [`event: message\rdata: ${reply(id)}\r\r`]],
      ["LF then CRLF", (id) => [`data: ${reply(id)}\n\r\n`]],
      ["CRLF then CR", (id) => [`data: ${reply(id)}\r\n\r`]],
      ["CRLF split across chunks", (id) => [`data: ${reply(id)}\r`, `\n\r`, `\n`]],
      ["CR at a chunk's end, then LF", (id) => [`data: ${reply(id)}\r`, `\n`, `\r`]],
      [
        "the data split across chunks",
        (id) => [`da`, `ta: ${reply(id).slice(0, 9)}`, `${reply(id).slice(9)}\n\n`],
      ],
      [
        "a comment and another event first",
        (id) => [`: ping\n\nevent: other\ndata: {"x":1}\n\n`, `data: ${reply(id)}\n\n`],
      ],
    ];
    for (const [name, chunks] of endings) {
      const started = performance.now();
      const answer = await call(streaming(chunks));
      expect(answer, name).toEqual({ threadId: "thread-1" });
      // Well before the 2 s deadline: the reply was taken when its event ended.
      expect(performance.now() - started, name).toBeLessThan(1_500);
    }
  });

  test("a request from the server with the same ID is not the reply; a stream with no reply is lost at the deadline", async () => {
    const request = (id: number) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "sampling/createMessage", params: {} });
    expect(
      await call(streaming((id) => [`data: ${request(id)}\n\n`, `data: ${reply(id)}\n\n`])),
    ).toEqual({ threadId: "thread-1" });
    const lost = await call(streaming((id) => [`data: ${request(id)}\n\n`]));
    expect(lost).toBeInstanceOf(T3Error);
    expect((lost as T3Error).failure).toBe("lost");
  });

  test("an answer over the size limit, or not UTF-8, is unreadable", async () => {
    const big = await call(streaming(() => [`: ${"x".repeat(T3_MAX_ANSWER)}\n`]));
    expect((big as T3Error).failure).toBe("unreadable");
    const bad = await call(streaming(() => [new Uint8Array([0x64, 0x61, 0xff, 0x0a, 0x0a])]));
    expect((bad as T3Error).failure).toBe("unreadable");
  });
});
