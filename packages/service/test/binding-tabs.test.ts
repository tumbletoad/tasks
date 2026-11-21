// A space switch in a UI tab changes nothing for a bound session or for another tab (A7 3.9 M2.04's
// Verify line; A2 3.10.5 step 4, A3 3.7.8, A5's per-tab space). Through the real service in this
// process: its UI listener with two signed-in tabs, each with its feed, and an agent's real
// ttasks-local/1 mcp mode connection bound to a task. Fixture text and temporary folders only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { routePath, type ErrorBody } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { post } from "./http-client.ts";
import { openFeed, signIn, type FeedClient } from "./http-world.ts";
import { bridgeContext, openMcp, RawMcp, textOf } from "./mcp-helpers.ts";
import { classSession, grantHome } from "./ops-helpers.ts";

type Json = Record<string, unknown>;
const LONG = 180_000;

let w: ContractWorld & { root: string };
let life = "";
const sessions: RpcSession[] = [];

beforeAll(async () => {
  w = await contractWorld("tabs", { http: {} });
  const user = await classSession(w.home, w.path, "cli-interactive");
  sessions.push(user);
  const created = (await user.call(
    "space/create",
    { name: "Life", path: join(w.root, "s", "life"), ref_prefix: "L" },
    { timeoutMs: 120_000 },
  )) as { space: { id: string } };
  life = created.space.id;
  for (const space of [w.space, life]) {
    await user.call(
      "op/call",
      {
        space,
        op: "task.add",
        input: {
          tasks: [{ title: "Fixture task one" }, { title: "Fixture task two" }],
          request_id: `fixture-tabs-add-${space.slice(-6)}`,
        },
      },
      { timeoutMs: 60_000 },
    );
  }
  // The agent's home, registered for Mira as setup does.
  await grantHome(w.home, w.path, { instance: "tabs-agent", space: w.space });
}, LONG);
afterAll(async () => {
  for (const session of sessions) session.close();
  await w.close();
}, LONG);

/** A signed-in tab: its API calls name its space in a header, as the page does. */
interface Tab {
  space: string;
  readonly feed: FeedClient;
  call(entry: string, input: Json): Promise<{ status: number; body: Json }>;
}

async function tab(port: number): Promise<Tab> {
  const { token } = await signIn({
    user: async () => {
      const opened = await classSession(w.home, w.path, "cli-interactive");
      sessions.push(opened);
      return opened;
    },
  });
  const feed = await openFeed(port, token);
  const self: Tab = {
    space: w.space,
    feed,
    call: async (entry, input) => {
      const reply = await post(port, routePath(entry), input, {
        token,
        headers: { "ttasks-build": "source", "ttasks-space": self.space },
      });
      return { status: reply.status, body: JSON.parse(reply.body) as Json };
    },
  };
  return self;
}

/** Switches a tab's space, as the page does: its route's space, and its feed's subscription. */
async function switchTo(t: Tab, space: string): Promise<void> {
  t.space = space;
  t.feed.send({ type: "subscribe", space });
  await t.feed.next(
    (m) => m["type"] === "snapshot" && (m["space"] as Json | undefined)?.["id"] === space,
  );
}

let n = 0;
const rid = () => `fixture-tabs-${String((n += 1)).padStart(6, "0")}`;

describe("[A3.3.7.binding.ui-tabs] a space switch in a UI tab changes nothing for a bound session or another tab", () => {
  test(
    "two tabs on Mira, an agent bound to M-1; one tab switches to Life; the session still writes to M-1 in Mira, the other tab sees it, the switched tab does not",
    { timeout: LONG },
    async () => {
      const port = w.service.status().http?.port ?? 0;
      const one = await tab(port);
      const two = await tab(port);
      await switchTo(one, w.space);
      await switchTo(two, w.space);

      // The agent's connection names Mira and binds to M-1.
      const agent = new RawMcp(
        await openMcp(w.home, w.path, bridgeContext({ space: w.space, instance: "tabs-agent" })),
      );
      try {
        await agent.initialize();
        const tool = async (name: string, args: Json): Promise<string> =>
          textOf((await agent.request("tools/call", { name, arguments: args })).message["result"]);
        expect(await tool("get_task", { task: "M-1", bind: true })).toContain(
          "Session: bound to this task by this call",
        );

        // Tab one switches to Life.
        await switchTo(one, life);
        const lifeStatus = await one.call("space.status", {});
        expect(lifeStatus.status).toBe(200);
        expect((lifeStatus.body["result"] as Json)["space"]).toMatchObject({ id: life });

        // The bound session: still Mira, still M-1, and its write lands there.
        const status = await tool("status", {});
        expect(status).toContain("Session: bound to M-1");
        expect(
          await tool("add_entry", {
            kind: "progress",
            text: "Fixture progress after a tab switched.",
            request_id: rid(),
          }),
        ).toMatch(/M-1/);

        // The other tab, still on Mira, sees it in its view and in its feed.
        const read = await two.call("task.get", { task: "M-1", sections: ["log"] });
        expect(read.status).toBe(200);
        const log = ((read.body["result"] as Json)["sections"] as Json)["log"] as Json[];
        expect(log[0]?.["text"]).toBe("Fixture progress after a tab switched.");
        const batch = await two.feed.next(
          (m) =>
            m["type"] === "batch" &&
            m["space_id"] === w.space &&
            (m["events"] as Json[]).some((e) => (e["actor"] as Json)["label"] !== "user"),
        );
        expect(batch["space_id"]).toBe(w.space);

        // The switched tab: Life, which the session never wrote to. M-1 is no task there.
        const elsewhere = await one.call("task.get", { task: "M-1" });
        expect((elsewhere.body["error"] as ErrorBody | undefined)?.code).toBe("not_found");
        const lifeLog = await one.call("task.get", { task: "L-1", sections: ["log"] });
        expect(((lifeLog.body["result"] as Json)["sections"] as Json)["log"] ?? []).toEqual([]);
        expect(
          one.feed.messages.some(
            (m) =>
              m["type"] === "batch" && (m["events"] as Json[]).length > 0 && m["space_id"] === life,
          ),
        ).toBe(false);

        // Tab two never moved, and the session's status is unchanged by any of it.
        const twoStatus = await two.call("space.status", {});
        expect((twoStatus.body["result"] as Json)["space"]).toMatchObject({ id: w.space });
        expect(await tool("status", {})).toContain("Session: bound to M-1");
      } finally {
        agent.close();
        one.feed.ws.close();
        two.feed.ws.close();
      }
    },
  );
});
