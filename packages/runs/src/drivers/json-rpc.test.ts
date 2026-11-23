import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { LineRpc, NO_ANSWER, RPC_ERRORS, RpcClosed, RpcError } from "./json-rpc.ts";

/** One side of a connection, and what it wrote, line by line. */
function side(options: { version?: boolean; lineCap?: number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Record<string, unknown>[] = [];
  let pending = "";
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      written.push(JSON.parse(pending.slice(0, at)) as Record<string, unknown>);
      pending = pending.slice(at + 1);
    }
  });
  const rpc = new LineRpc(input, output, options);
  const say = (message: unknown) => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  return { rpc, input, written, say };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("[A4.3.11.json-rpc.lines] JSON-RPC over lines, with requests in both directions", () => {
  test("a request gets its answer by its ID, an error answer rejects with the code and message", async () => {
    const { rpc, written, say } = side();
    const first = rpc.request("thread/start", { cwd: "/w" });
    const second = rpc.request("turn/start");
    expect(written).toEqual([
      { id: 1, method: "thread/start", params: { cwd: "/w" } },
      { id: 2, method: "turn/start" },
    ]);
    say({ id: 2, error: { code: -32600, message: "Already started" } });
    say({ id: 1, result: { thread: { id: "t1" } } });
    await expect(first).resolves.toEqual({ thread: { id: "t1" } });
    await expect(second).rejects.toMatchObject({ code: -32600, message: "Already started" });
    await expect(second).rejects.toBeInstanceOf(RpcError);
  });

  test("the other side's requests are answered by the handler; a method it does not take gets the protocol's error", async () => {
    const { rpc, written, say } = side();
    rpc.onRequest((method, params) => {
      if (method === "item/commandExecution/requestApproval") return { decision: "accept" };
      if (method === "explode") throw new Error("a private detail");
      if (method === "refuse") throw new RpcError(RPC_ERRORS.invalidParams, "No such thing");
      throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`, params);
    });
    say({ id: 0, method: "item/commandExecution/requestApproval", params: {} });
    say({ id: "a", method: "account/chatgptAuthTokens/refresh" });
    say({ id: 7, method: "explode" });
    say({ id: 8, method: "refuse" });
    await tick();
    expect(written).toEqual([
      { id: 0, result: { decision: "accept" } },
      {
        id: "a",
        error: {
          code: -32601,
          message: "Method not found: account/chatgptAuthTokens/refresh",
        },
      },
      { id: 7, error: { code: -32603, message: "Internal error" } },
      { id: 8, error: { code: -32602, message: "No such thing" } },
    ]);
    expect(JSON.stringify(written)).not.toContain("private");
  });

  test("without a handler every request of the other side gets method not found", async () => {
    const { written, say } = side();
    say({ id: 3, method: "anything", params: { x: 1 } });
    await tick();
    expect(written).toEqual([
      { id: 3, error: { code: -32601, message: "Method not found: anything" } },
    ]);
  });

  test("an answer that takes its time holds up nothing that comes after it", async () => {
    const { rpc, written, say } = side();
    let release: (value: unknown) => void = () => undefined;
    rpc.onRequest(() => new Promise((resolve) => (release = resolve)));
    const heard: string[] = [];
    rpc.onNotification((method) => heard.push(method));
    const mine = rpc.request("turn/interrupt", {});
    say({ id: 5, method: "item/fileChange/requestApproval" });
    say({ method: "turn/completed" });
    say({ id: 1, result: {} });
    await expect(mine).resolves.toEqual({});
    expect(heard).toEqual(["turn/completed"]);
    expect(written.filter((m) => m["id"] === 5)).toEqual([]);
    release({ decision: "decline" });
    await tick();
    expect(written.filter((m) => m["id"] === 5)).toEqual([
      { id: 5, result: { decision: "decline" } },
    ]);
  });

  test("a request left open is answered later, or never", async () => {
    const { rpc, written, say } = side();
    const asked: (number | string)[] = [];
    rpc.onRequest((_method, _params, id) => {
      asked.push(id);
      return NO_ANSWER;
    });
    say({ id: 9, method: "item/tool/requestUserInput" });
    await tick();
    expect(written).toEqual([]);
    rpc.answer(9, { answers: {} });
    expect(written).toEqual([{ id: 9, result: { answers: {} } }]);
    expect(asked).toEqual([9]);
  });

  test("lines split anywhere, with CRLF, are read whole; an over-long line, a line that is not JSON and an object that is no message are skipped", async () => {
    const { rpc, input, say } = side({ lineCap: 64 });
    const heard: unknown[] = [];
    rpc.onNotification((method, params) => heard.push([method, params]));
    const text = `${JSON.stringify({ method: "a", params: { n: 1 } })}\r\n`;
    for (const ch of text) input.write(ch);
    input.write(`${JSON.stringify({ method: "long", params: "x".repeat(200) })}\n`);
    input.write("not json\n");
    say([1, 2]);
    say({ unrelated: true });
    say({ method: "b" });
    await tick();
    expect(heard).toEqual([
      ["a", { n: 1 }],
      ["b", undefined],
    ]);
    expect(rpc.skipped).toBe(4);
  });

  test("a line too long to read is still told by what can be read of it: a notification by its method and short values, a request gets an error, an answer fails its request", async () => {
    const { rpc, input, written, say } = side({ lineCap: 256 });
    const cut: unknown[] = [];
    rpc.onCut((method, params) => cut.push([method, params]));
    const asked = rpc.request("thread/read", {}).then(
      () => "answered",
      (error: unknown) => error,
    );
    const big = "x".repeat(10_000);
    const completion = {
      method: "item/completed",
      params: {
        threadId: "t1",
        item: {
          type: "commandExecution",
          id: "exec-1",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: big,
          commandActions: [{ type: "unknown", id: "not this one" }],
          deep: { a: { b: { c: "too deep" } } },
        },
      },
    };
    // Split anywhere: one byte at a time.
    for (const byte of Buffer.from(`${JSON.stringify(completion)}\n`)) {
      input.write(Buffer.from([byte]));
    }
    say({ id: 9, method: "item/fileChange/requestApproval", params: { diff: big } });
    say({ id: 1, result: { thread: { text: big } } });
    input.write(`${"not json ".repeat(100)}\n`);
    await tick();
    expect(cut).toEqual([
      [
        "item/completed",
        {
          threadId: "t1",
          item: {
            type: "commandExecution",
            id: "exec-1",
            status: "completed",
            exitCode: 0,
            deep: {},
          },
        },
      ],
      [undefined, undefined],
    ]);
    expect(written.find((message) => message["id"] === 9)?.["error"]).toMatchObject({
      code: RPC_ERRORS.invalidRequest,
    });
    expect(await asked).toBeInstanceOf(RpcError);
    expect(rpc.skipped).toBe(4);
  });

  test("what is read of a line too long to keep stays small, however many short values it has", async () => {
    const { rpc, input } = side({ lineCap: 256 });
    const cut: unknown[] = [];
    rpc.onCut((method, params) => cut.push([method, params]));
    const params = Object.fromEntries(
      Array.from({ length: 50_000 }, (_, i) => [`key${String(i)}`, "v".repeat(20)]),
    );
    input.write(`${JSON.stringify({ method: "flood", params })}\n`);
    await tick();
    expect(cut).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(cut[0]))).toBeLessThan(128 * 1024);
  });

  test("the version field is written when the protocol wants it", () => {
    const { rpc, written } = side({ version: true });
    void rpc.request("initialize", {}).catch(() => undefined);
    rpc.notify("initialized");
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "initialized" },
    ]);
  });

  test("the end of the other side's output rejects every open request, and so does close", async () => {
    const a = side();
    const open = a.rpc.request("turn/start", {});
    a.input.end();
    await expect(open).rejects.toBeInstanceOf(RpcClosed);
    await a.rpc.ended;
    await expect(a.rpc.request("x")).rejects.toBeInstanceOf(RpcClosed);

    const b = side();
    const waiting = b.rpc.request("turn/start", {});
    b.rpc.close();
    await expect(waiting).rejects.toBeInstanceOf(RpcClosed);
  });
});
