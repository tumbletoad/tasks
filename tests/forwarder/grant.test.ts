// The grant gate through real processes (A3 3.7.8; A2 3.2.5): the real hub (`ttasks serve` with its
// UI listener, so the grants table is service.sqlite's) and real bridges started with the
// arguments setup writes. An agent home registered for one space reaches it and is refused the
// other, before and after the service restarts: the rows outlive the process and still decide, for
// the bridges that reconnect and for new ones. Fixture text and temporary folders only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CLI_NAME } from "../../packages/brand/src/index.ts";
import { hubGrant, hubSpace, spaceOpen } from "../../packages/service/test/mcp-hub.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import {
  Procs,
  isObject,
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

/** A3 3.5's text form of the refusal (A3 3.7.8). */
const REFUSED = `error forbidden: This agent is not registered for this space. Ask the user to run: ${CLI_NAME} setup agents`;

async function startHub(home: Home): Promise<{ hub: Proc; path: string }> {
  const hub = procs.hub(home);
  const path = await waitFor(
    () => {
      try {
        const json = JSON.parse(readFileSync(join(home.state, "service.json"), "utf8")) as Json;
        const endpoint = json["endpoint"];
        return json["state"] === "ready" && json["pid"] === hub.pid && isObject(endpoint)
          ? String(endpoint["path"])
          : undefined;
      } catch {
        return undefined;
      }
    },
    60_000,
    "hub ready",
  );
  return { hub, path };
}

const args = (space: string) => ["--space", space, "--instance", "grant-agent", "--app", "test"];

/** The status call's text once the service answers it (a reconnecting bridge holds it a while). */
async function status(bridge: Bridge, ready: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 60_000;
  let text = "";
  while (Date.now() < deadline) {
    text = textOf(await bridge.call("status")) ?? "";
    if (ready(text)) return text;
    await sleep(200);
  }
  return text;
}

const answered = (text: string) => !text.startsWith("error service_unavailable");

describe("[A3.3.7.grant.space] the rows decide across a restart of the real service", () => {
  test(
    "a home registered for Mira reaches Mira and is refused Life, before and after the service restarts, through the bridges that reconnect and through new ones",
    { timeout: 300_000 },
    async () => {
      const home = makeHome("grant");
      homes.push(home);
      const mira = (await hubSpace(home.root)).id;
      const first = await startHub(home);
      await spaceOpen(home.root);
      const user = await classSession(home.root, first.path, "cli-interactive");
      let life: string;
      try {
        const created = (await user.call(
          "space/create",
          { name: "Life", path: join(home.root, "spaces", "life"), ref_prefix: "L" },
          { timeoutMs: 120_000 },
        )) as { space: { id: string } };
        life = created.space.id;
      } finally {
        user.close();
      }
      await hubGrant(home.root, "grant-agent", mira);

      const own = procs.bridge(home, { args: args(mira) });
      const other = procs.bridge(home, { args: args(life) });
      await own.initialize();
      await other.initialize();
      expect(await status(own, answered)).toContain("Space: Mira (M)");
      expect(await status(other, answered)).toBe(REFUSED);

      // A graceful stop, then a new start of the same install: the rows are service.sqlite's.
      first.hub.child.stdin?.write("stop\n");
      await first.hub.exit;
      await startHub(home);
      expect(await status(own, (text) => text.includes("Space: Mira (M)"))).toContain(
        "Space: Mira (M)",
      );
      expect(await status(other, answered)).toBe(REFUSED);
      const fresh = procs.bridge(home, { args: args(life) });
      await fresh.initialize();
      expect(await status(fresh, answered)).toBe(REFUSED);
      for (const bridge of [own, other, fresh]) {
        expect(bridge.stray).toEqual([]);
        bridge.end();
      }
    },
  );
});
