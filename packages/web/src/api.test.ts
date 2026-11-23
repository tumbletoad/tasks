// What the browser is asked to send (api.ts): every request is kept alive across a reload or a
// close while the bodies in flight that way fit the page's 48 KiB, under the browser's 64 KiB;
// one past that goes as an ordinary request, and a settled one frees its share. A tab whose copy
// of its space is gone sends nothing that changes the space.
import { registry } from "@ttasks/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Api, READ_ENTRIES } from "./api.ts";

interface Sent {
  readonly size: number;
  readonly keepalive: boolean;
  readonly answer: (body: string) => void;
}

function fakeFetch(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    (_path: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        sent.push({
          size: new TextEncoder().encode(init.body as string).length,
          keepalive: init.keepalive === true,
          answer: (body) => {
            resolve(new Response(body, { status: 200 }));
          },
        });
      }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[A5.3.11.web.sent-at-unload] a write made just before the tab goes is still sent", () => {
  test("small requests are kept alive; past 48 KiB in flight a request is an ordinary one; an answer frees its share", async () => {
    const sent = fakeFetch();
    const api = new Api("t", "", () => undefined);
    const big = "x".repeat(30 * 1024);
    const first = api.post("/api/v1/op/task.update", big);
    const second = api.post("/api/v1/op/task.update", big);
    const small = api.post("/api/v1/op/task.update", "{}");
    expect(sent.map((s) => s.keepalive)).toEqual([true, false, true]);
    sent[0]?.answer("{}");
    await first;
    const third = api.post("/api/v1/op/task.update", big);
    expect(sent[3]?.keepalive).toBe(true);
    for (const s of sent.slice(1)) s.answer("{}");
    await Promise.all([second, small, third]);
  });

  test("the budget counts bytes as the browser does, not characters", () => {
    const sent = fakeFetch();
    const api = new Api("t", "", () => undefined);
    // 20,000 three-byte characters are 60,000 bytes: past 48 KiB, though fewer characters.
    void api.post("/api/v1/op/entry.add", "界".repeat(20_000));
    expect(sent[0]?.size).toBe(60_000);
    expect(sent[0]?.keepalive).toBe(false);
    sent[0]?.answer("{}");
  });
});

describe("[A5.3.15.web.gone-sends-nothing] a tab that says nothing more is saved from it sends nothing that changes its space", () => {
  test("a write, a launch, Run and Stop are refused in the page as replaced and never sent; a read still goes", async () => {
    const sent = fakeFetch();
    let ended = false;
    const api = new Api(
      "t",
      "",
      () => "sp_00000000000000000000000000",
      () => "a".repeat(24),
      () => ended,
    );
    void api.post("/api/v1/op/task.update", "{}");
    expect(sent).toHaveLength(1);
    sent[0]?.answer("{}");
    ended = true;
    for (const path of [
      "/api/v1/op/task.update",
      "/api/v1/op/entry.add",
      "/api/v1/op/history.undo",
      "/api/v1/op/launch.open",
      "/api/v1/op/group.manage",
      "/api/v1/launch/run",
      "/api/v1/launch/stop",
    ]) {
      await expect(api.post(path, "{}"), path).rejects.toMatchObject({
        code: "space_unavailable",
        data: { reason: "replaced" },
      });
    }
    expect(sent).toHaveLength(1);
    const read = api.post("/api/v1/op/task.get", "{}");
    expect(sent).toHaveLength(2);
    sent[1]?.answer("{}");
    await read;
  });

  test("the entries it still sends are exactly the registry's reads", () => {
    const reads = [...registry].filter((entry) => entry.kind === "read").map((e) => e.name);
    expect([...READ_ENTRIES].sort()).toEqual(reads.sort());
  });
});
