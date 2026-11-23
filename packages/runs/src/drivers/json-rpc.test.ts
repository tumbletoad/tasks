import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  CUT_DEPTH,
  CUT_KEPT_BYTES,
  CUT_STRING_BYTES,
  CutJson,
  wasCut,
} from "../streams/cut-json.ts";
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

  test("lines split anywhere, with CRLF, are read whole, a line over the cap too; a line that is not JSON and an object that is no message are skipped", async () => {
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
      ["long", "x".repeat(200)],
      ["b", undefined],
    ]);
    expect(rpc.skipped).toBe(3);
  });

  test("a line too long to read whole is a message like any other, in its own shape, with each long string cut to its start and marked as cut, however it is split", async () => {
    const { rpc, input, written, say } = side({ lineCap: 256 });
    const heard: [string, Record<string, unknown>][] = [];
    rpc.onNotification((method, params) => heard.push([method, params as Record<string, unknown>]));
    const asked: unknown[] = [];
    rpc.onRequest((_method, params) => {
      asked.push(params);
      return { decision: "decline" };
    });
    let lost = 0;
    rpc.onLost(() => (lost += 1));
    const answer = rpc.request("thread/read", {});
    // One is cut inside an escape, the other inside a character of two bytes.
    const big = `${"é".repeat(CUT_STRING_BYTES / 2 - 1)}x\n${"y".repeat(CUT_STRING_BYTES)}`;
    const wide = `x${"é".repeat(CUT_STRING_BYTES / 2)}`;
    const items = Array.from({ length: 300 }, (_, at) => ({ id: `i${String(at)}`, at }));
    const completion = {
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "exec-1",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: big,
          commandActions: [{ type: "unknown", id: "not this one" }, null, true, -1.5e3],
          deep: { a: { b: { c: "deep" } } },
          items,
        },
        threadId: "t1",
      },
    };
    for (const byte of Buffer.from(`${JSON.stringify(completion)}\n`)) {
      input.write(Buffer.from([byte]));
    }
    say({ id: 9, method: "item/fileChange/requestApproval", params: { diff: wide, why: "edit" } });
    say({ id: 1, result: { thread: { id: "t1", text: big } } });
    await tick();

    const kept = `${"é".repeat(CUT_STRING_BYTES / 2 - 1)}x`;
    const params = heard[0]?.[1] as { item: Record<string, unknown>; threadId: string };
    expect(heard[0]?.[0]).toBe("item/completed");
    expect(params).toEqual({
      item: { ...completion.params.item, aggregatedOutput: kept },
      threadId: "t1",
    });
    expect(wasCut(params.item, "aggregatedOutput")).toBe(true);
    expect(wasCut(params, "item") && wasCut(params)).toBe(true);
    expect(wasCut(params.item, "id") || wasCut(params, "threadId")).toBe(false);
    expect(wasCut(params.item["deep"])).toBe(false);
    expect(asked).toEqual([{ diff: wide.slice(0, -1), why: "edit" }]);
    expect(written.find((message) => message["id"] === 9)).toEqual({
      id: 9,
      result: { decision: "decline" },
    });
    const thread = ((await answer) as { thread: Record<string, unknown> }).thread;
    expect(thread).toEqual({ id: "t1", text: kept });
    expect(wasCut(thread, "text")).toBe(true);
    expect([lost, rpc.skipped]).toEqual([0, 0]);
    expect(wasCut(JSON.parse(JSON.stringify(completion)))).toBe(false);
  });

  test("a line too long to read that is not JSON, holds more than is kept of one, is nested deeper or has a key too long to keep is lost: nothing of it reaches a handler", async () => {
    const { rpc, input } = side({ lineCap: 256 });
    const heard: string[] = [];
    rpc.onNotification((method) => heard.push(method));
    let lost = 0;
    rpc.onLost(() => (lost += 1));
    const nested = (depth: number): string =>
      `{"method":"deep","pad":"${"p".repeat(300)}","params":${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}}`;
    input.write(`${"not json ".repeat(100)}\n`);
    input.write(`{"method":"flood","params":[${'"ab",'.repeat(CUT_KEPT_BYTES / 5)}"ab"]}\n`);
    input.write(`${nested(CUT_DEPTH + 1)}\n`);
    input.write(`{"method":"key","params":{"${"k".repeat(CUT_STRING_BYTES + 1)}":1}}\n`);
    input.write(`{"method":"unfinished","params":{"a":1${" ".repeat(300)}\n`);
    input.write(`${nested(CUT_DEPTH)}\n`);
    await tick();
    expect([lost, rpc.skipped]).toEqual([5, 5]);
    expect(heard).toEqual(["deep"]);
  });

  test("what is kept of a line too long to read stays within its bound, however long the line", () => {
    const reader = new CutJson();
    reader.push(Buffer.from('{"method":"output","params":{"text":"'));
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    for (let i = 0; i < 64; i += 1) {
      reader.push(chunk);
      expect(reader.kept).toBeLessThan(CUT_STRING_BYTES + 1024);
    }
    reader.push(Buffer.from('"}}'));
    const value = reader.end() as { params: { text: string } };
    expect(value.params.text).toHaveLength(CUT_STRING_BYTES);
    expect(reader.kept).toBeLessThan(CUT_STRING_BYTES + 1024);
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
