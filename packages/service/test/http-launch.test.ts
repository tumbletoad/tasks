// The page's launch tile in the service (A5 3.6, 3.9; A4 3.9; A7 3.9 M2.13, M2.10): the tiles are
// machine.toml's instances that can open here, a click is `launch.open` over HTTP on the hub's
// one launch machine per space, its route's terminal runs once after Dispatching is durable, the
// page reads the receipts of a task and sees launch events on the feed, and Copy gives the
// pointer brief. A test's terminal stands where the terminal adapters do: it records each start
// and starts nothing. Fixture data only.
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PRODUCT_NAME } from "@ttasks/brand";
import type { DispatchOutcome, LaunchIntent, OpenResult } from "@ttasks/launch";
import type { TerminalStart } from "../src/launch/index.ts";
import { post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type HttpWorld } from "./http-world.ts";
import { instanceToml } from "./harness.ts";

const SLOW = { timeout: 180_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

/** Instances of this machine: one that opens here, and three the page never shows. */
const TOML = [
  instanceToml({
    id: "fake-agent",
    target: "claude-cli",
    label: "Fake agent · test",
    exec: process.execPath,
  }),
  // Off, not built here (T3 opens through its own route), and Codex without an executable.
  instanceToml({
    id: "off",
    target: "claude-cli",
    label: "Off",
    exec: process.execPath,
    enabled: false,
  }),
  instanceToml({ id: "t3-later", target: "t3", label: "T3 · test" }),
  instanceToml({ id: "codex-none", target: "codex-cli", label: "Codex · none" }),
].join("");

/** A terminal that records each launch it is given and starts nothing. */
function recordingTerminal(answer: DispatchOutcome = { kind: "accepted" }): {
  start: TerminalStart;
  started: LaunchIntent[];
} {
  const started: LaunchIntent[] = [];
  return {
    started,
    start: ({ intent }) => {
      started.push(intent);
      return Promise.resolve(answer);
    },
  };
}

async function world(terminal?: TerminalStart, toml = TOML): Promise<HttpWorld> {
  const w = await httpWorld(
    "launch",
    {},
    { toml, ...(terminal === undefined ? {} : { launch: { terminal } }) },
  );
  worlds.push(w);
  return w;
}

async function addTask(w: HttpWorld, title: string): Promise<{ id: string; ref: string }> {
  const user = await w.user();
  const added = (await user.call(
    "op/call",
    {
      op: "task.add",
      input: { tasks: [{ title }], request_id: `launch-test-${String(title.length)}-task` },
    },
    { timeoutMs: 60_000 },
  )) as { tasks: { id: string; ref: string }[] };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  return task;
}

const until = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const OPEN = "/api/v1/op/launch.open";

describe("[A4.3.9.http.launch-tile] the page's launch tile on the hub's launch machines", () => {
  test(
    "Open records a Prepared intent, its terminal starts once, and the receipt reaches Dispatched",
    SLOW,
    async () => {
      const terminal = recordingTerminal();
      const w = await world(terminal.start);
      const task = await addTask(w, "Fix appointment time zones");
      const { token } = await signIn(w);
      const port = w.port();
      const headers = { "ttasks-space": "Mira", "ttasks-build": "source" };

      // The snapshot names the instances the tiles draw: only the one that opens here.
      const feed = await openFeed(port, token);
      await feed.next((m) => m["type"] === "hello");
      feed.send({ type: "subscribe", space: "Mira" });
      const snapshot = await feed.next((m) => m["type"] === "snapshot");
      expect(snapshot["instances"]).toEqual([
        { key: "fake-agent", label: "Fake agent · test", glyph: "Cc", ring: 1, route: "terminal" },
      ]);

      const click = { task: task.id, instance: "fake-agent", request_id: "click-0000000000000001" };
      const opened = await post(port, OPEN, click, { token, headers });
      expect(opened.status).toBe(200);
      const { launch } = (
        JSON.parse(opened.body) as { result: { launch: Record<string, unknown> } }
      ).result;
      expect(launch).toMatchObject({ instance: "fake-agent", route: "terminal" });
      expect(launch["reference"]).toMatch(/^L[0-9A-Z]{5}$/);
      await until(() => Promise.resolve(terminal.started.length === 1), "the terminal");
      expect(terminal.started[0]).toMatchObject({
        id: launch["id"],
        task: task.id,
        state: "dispatching",
      });

      // A repeated click (the same request ID) returns the same intent and starts nothing more.
      const again = await post(port, OPEN, click, { token, headers });
      expect(
        (JSON.parse(again.body) as { result: { launch: { id: string } } }).result.launch.id,
      ).toBe(launch["id"]);

      const list = async () =>
        (
          JSON.parse(
            (await post(port, "/api/v1/launch/list", { task: task.id }, { token, headers })).body,
          ) as { result: { receipts: { id: string; state: string; at: Record<string, number> }[] } }
        ).result.receipts;
      await until(async () => (await list())[0]?.state === "dispatched", "Dispatched");
      const receipts = await list();
      expect(receipts).toHaveLength(1);
      expect(Object.keys(receipts[0]?.at ?? {})).toEqual(["prepared", "dispatching", "dispatched"]);
      expect(terminal.started).toHaveLength(1);
      // No text of the task travels with a receipt.
      expect(JSON.stringify(receipts)).not.toContain("appointment");

      // The tab learns which agent apps are busy here for every task, without a task's receipts:
      // this one is opening until its shim settles it.
      const busy = await post(port, "/api/v1/launch/busy", {}, { token, headers });
      expect(JSON.parse(busy.body)).toEqual({
        result: { busy: [{ task: task.id, instance: "fake-agent", state: "opening" }] },
      });
      // A distinct click while it is opening gets the same launch and starts nothing.
      const second = await post(
        port,
        OPEN,
        { ...click, request_id: "click-0000000000000002" },
        { token, headers },
      );
      expect(
        (JSON.parse(second.body) as { result: { launch: { id: string } } }).result.launch.id,
      ).toBe(launch["id"]);
      expect(terminal.started).toHaveLength(1);

      // The feed tells the page a launch changed, and of which task: a tab follows the receipts
      // of the tasks it shows by their task.
      await feed.next(
        (m) =>
          m["type"] === "batch" &&
          JSON.stringify(m["events"]).includes(
            `"type":"launch","id":"${String(launch["id"])}","task":"${task.id}"`,
          ),
      );
      feed.ws.close();
    },
  );

  test(
    "a Prepared launch that no call of the service holds, as a crash leaves one, holds no Open: the next click opens it",
    SLOW,
    async () => {
      const terminal = recordingTerminal();
      const w = await world(terminal.start);
      const task = await addTask(w, "Plan the garden beds");
      const { token } = await signIn(w);
      const port = w.port();
      const headers = { "tasks-space": "Mira", "tasks-build": "source" };
      const feed = await openFeed(port, token);
      await feed.next((m) => m["type"] === "hello");
      feed.send({ type: "subscribe", space: "Mira" });
      const snapshot = await feed.next((m) => m["type"] === "snapshot");
      feed.ws.close();
      const space = (snapshot["space"] as { id: string }).id;
      // Recorded, and never dispatched: the service that made it stopped in between.
      const left = await w.service.launches.open(
        space,
        {
          task: task.id,
          instance: "fake-agent",
          route: "terminal",
          place: null,
          taskVersion: 1,
          briefHash: "c".repeat(64),
        },
        "crash-left-000000000001",
        { argv: [process.execPath], folder: null, env: {}, title: "Left", afterExit: "close" },
      );
      expect(left.state).toBe("prepared");
      const busy = await post(port, "/api/v1/launch/busy", {}, { token, headers });
      expect(JSON.parse(busy.body)).toEqual({ result: { busy: [] } });
      const opened = await post(
        port,
        OPEN,
        { task: task.id, instance: "fake-agent", request_id: "click-0000000000000011" },
        { token, headers },
      );
      expect(
        (JSON.parse(opened.body) as { result: { launch: { id: string } } }).result.launch.id,
      ).toBe(left.id);
      await until(() => Promise.resolve(terminal.started.length === 1), "the terminal");
      expect(terminal.started[0]?.id).toBe(left.id);
    },
  );

  test("Copy gives the pointer brief and a launch that is Dispatched at once", SLOW, async () => {
    const w = await world(recordingTerminal().start);
    const task = await addTask(w, "Sign the lease");
    const { token } = await signIn(w);
    const port = w.port();
    const headers = { "ttasks-space": "Mira", "ttasks-build": "source" };
    const copied = await post(
      port,
      OPEN,
      { task: task.ref, request_id: "click-0000000000000004" },
      { token, headers },
    );
    expect(copied.status).toBe(200);
    const { result } = JSON.parse(copied.body) as {
      result: { launch: { route: string; state: string; reference: string }; copy: string };
    };
    expect(result.launch).toMatchObject({ route: "clipboard", state: "dispatched" });
    const lines = result.copy.split("\n");
    expect(lines[0]).toBe(`${PRODUCT_NAME} task ${task.ref} (launch ${result.launch.reference}).`);
    expect(lines[4]?.startsWith(`Folder: ${PRODUCT_NAME} work folder (`)).toBe(true);
    expect(lines).toHaveLength(6);
  });

  test(
    "bad input, an unknown instance or task, another space and no token are refused; the old route is gone",
    SLOW,
    async () => {
      const w = await world(recordingTerminal().start);
      const task = await addTask(w, "Sign the lease");
      const { token } = await signIn(w);
      const port = w.port();
      const headers = { "ttasks-space": "Mira", "ttasks-build": "source" };
      const open = (
        body: Record<string, unknown>,
        h: Record<string, string> = headers,
        t = token,
      ) =>
        post(
          port,
          OPEN,
          { request_id: "click-0000000000000002", ...body },
          { token: t, headers: h },
        );
      const refused = await open({ task: task.id, instance: "other" });
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.body)).toMatchObject({
        error: { code: "invalid_input", data: { reason: "not_set_up" } },
      });
      expect((await open({ task: task.id, instance: "t3-later" })).status).toBe(400);
      expect((await open({ task: "M-99", instance: "fake-agent" })).status).toBe(404);
      expect(
        (await open({ task: "t_0000000000000000000000000z", instance: "fake-agent" })).status,
      ).toBe(404);
      expect(
        (
          await open(
            { task: task.id, instance: "fake-agent" },
            { "ttasks-space": "Elsewhere", "ttasks-build": "source" },
          )
        ).status,
      ).toBe(503);
      expect((await open({ task: task.id, instance: "fake-agent", request_id: "x" })).status).toBe(
        400,
      );
      const unauthenticated = await post(port, OPEN, { task: task.id }, { headers });
      expect(unauthenticated.status).toBe(401);
      for (const gone of ["/api/v1/launch/open"]) {
        expect((await post(port, gone, {}, { token, headers })).status).toBe(404);
      }
    },
  );

  test(
    "the folder button shows the task's own folder in the file manager, read from the task; a folder that is gone or no file manager is said, and nothing else starts",
    SLOW,
    async () => {
      const shown: string[] = [];
      let answer: OpenResult = "opened";
      const w = await httpWorld(
        "folder",
        {},
        {
          toml: TOML,
          launch: {
            terminal: recordingTerminal().start,
            showFolder: (folder) => {
              shown.push(folder);
              return Promise.resolve(answer);
            },
          },
        },
      );
      worlds.push(w);
      const task = await addTask(w, "Fix appointment time zones");
      const { token } = await signIn(w);
      const port = w.port();
      const headers = { "ttasks-space": "Mira", "ttasks-build": "source" };
      const show = (body: Record<string, unknown>, signedIn = true) =>
        post(port, "/api/v1/launch/folder", body, { ...(signedIn ? { token } : {}), headers });

      // No folder of its own here: the space's work folder, where Open would start the agent.
      const work = await show({ task: task.id });
      expect(work.status).toBe(200);
      const answered = JSON.parse(work.body) as { result: { result: string; machine: unknown } };
      expect(answered.result.result).toBe("opened");
      expect(typeof answered.result.machine).toBe("string");
      expect(shown).toHaveLength(1);

      const folder = join(w.root, "work", "lumen", "portal");
      mkdirSync(folder, { recursive: true });
      const user = await w.user();
      const status = (await user.call("op/call", { op: "space.status", input: {} })) as {
        as_of: string;
      };
      await user.call("op/call", {
        op: "folder.manage",
        input: {
          action: "set",
          task: task.id,
          folder,
          base: status.as_of,
          request_id: "folder-test-set-000001",
        },
      });
      expect((await show({ task: task.id })).status).toBe(200);
      expect(shown[1]).toBe(realpathSync.native(folder));

      // The page names a task, never a path: anything else is refused before anything starts.
      expect((await show({ task: task.id, folder: "/etc" })).status).toBe(200);
      expect(shown[2]).toBe(realpathSync.native(folder));
      expect((await show({ task: folder })).status).toBe(400);
      expect((await show({ task: task.id }, false)).status).toBe(401);

      answer = "no_session";
      const none = await show({ task: task.id });
      expect(none.status).toBe(400);
      expect(JSON.parse(none.body)).toMatchObject({
        error: { data: { field: "task", reason: "no_file_manager" } },
      });

      answer = "opened";
      rmSync(folder, { recursive: true });
      const gone = await show({ task: task.id });
      expect(gone.status).toBe(400);
      expect(JSON.parse(gone.body)).toMatchObject({
        error: { data: { field: "task", reason: "path_missing" } },
      });
      expect(shown).toHaveLength(4);
    },
  );

  test(
    "without instances the page gets no tile, Open is refused and Copy still works",
    SLOW,
    async () => {
      const w = await world(undefined, "");
      const task = await addTask(w, "Book the moving van");
      const { token } = await signIn(w);
      const port = w.port();
      const feed = await openFeed(port, token);
      await feed.next((m) => m["type"] === "hello");
      feed.send({ type: "subscribe" });
      expect((await feed.next((m) => m["type"] === "snapshot"))["instances"]).toEqual([]);
      feed.ws.close();
      const headers = { "ttasks-space": "Mira", "ttasks-build": "source" };
      const opened = await post(
        port,
        OPEN,
        { task: task.id, instance: "fake-agent", request_id: "click-0000000000000003" },
        { token, headers },
      );
      expect(opened.status).toBe(400);
      const copied = await post(
        port,
        OPEN,
        { task: task.id, request_id: "click-0000000000000005" },
        { token, headers },
      );
      expect(copied.status).toBe(200);
    },
  );
});
