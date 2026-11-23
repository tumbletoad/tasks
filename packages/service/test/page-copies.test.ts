// A restored copy opened on the page beside its open original: the page's address names the copy,
// and its calls and its feed reach that copy and no other, also after the original is closed and
// the copy claimed. Services run in this process on temporary homes; fixture data only.
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { SPACE_HEADER } from "../src/http/app.ts";
import { instanceToml } from "./harness.ts";
import { post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type FeedClient, type HttpWorld } from "./http-world.ts";
import { errorOf } from "./ops-helpers.ts";

const SLOW = { timeout: 300_000 };
const CALL = { timeoutMs: 120_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

const add = (user: RpcSession, title: string, requestId: string) =>
  user.call(
    "op/call",
    { op: "task.add", input: { tasks: [{ title }], request_id: requestId } },
    CALL,
  ) as Promise<{ tasks: { id: string; ref: string }[] }>;

interface ListRow {
  readonly id: string;
  readonly address: string;
  readonly state: string;
  readonly reason?: string;
}

const snapshotOf = (feed: FeedClient) =>
  feed.next((m) => m["type"] === "snapshot" || m["type"] === "error", 60_000);

const refsOf = (snapshot: Record<string, unknown>) =>
  (snapshot["tasks"] as { ref: string }[]).map((t) => t.ref);

describe("[A2.3.10.5.copies.page] the page shows the copy the person opened", () => {
  test(
    "Open folder with a restored copy while its original is open: its address, calls and feed reach the copy, and say why it is read-only; the ID still means the original; once claimed, the copy's key reaches that same copy, now writable",
    SLOW,
    async () => {
      const w = await httpWorld("page-copies");
      worlds.push(w);
      const user = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      await add(user, "Before the backup", "page-copies-0001");
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      // M-2 is only in the original.
      await add(user, "After the backup", "page-copies-0002");
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );

      const { token } = await signIn(w);
      const port = w.port();
      const page = async (path: string, body: unknown, space?: string) =>
        JSON.parse(
          (
            await post(port, path, body, {
              token,
              ...(space === undefined ? {} : { headers: { [SPACE_HEADER]: space } }),
            })
          ).body,
        ) as { result?: Record<string, unknown>; error?: { code: string; data?: unknown } };

      const opened = (await page("/api/v1/space/open", { folder: copyFolder })).result as {
        id: string;
        address: string;
      };
      expect(opened.id).toBe(mira.id);
      expect(opened.address).toMatch(new RegExp(`^${mira.id}-copy-[0-9a-f]{12}$`, "u"));
      const address = opened.address;

      // The switcher lists both copies, each with the address that reaches it.
      const listed = (await page("/api/v1/space/list", {})).result as { spaces: ListRow[] };
      expect(listed.spaces).toEqual([
        expect.objectContaining({ id: mira.id, address: mira.id, state: "open" }),
        expect.objectContaining({ id: mira.id, address, reason: "read_only_copy" }),
      ]);

      // The copy's address reads the copy and refuses a write with the copy's own reason.
      expect((await page("/api/v1/op/task.get", { task: "M-2" }, address)).error?.code).toBe(
        "not_found",
      );
      expect((await page("/api/v1/op/task.get", { task: "M-1" }, address)).result).toBeDefined();
      const refused = await page(
        "/api/v1/op/task.add",
        { tasks: [{ title: "Into the copy" }], request_id: "page-copies-0003" },
        address,
      );
      expect(refused.error).toMatchObject({
        code: "read_only",
        data: { reason: "read_only_copy" },
      });
      // The space's ID still means the original.
      expect((await page("/api/v1/op/task.get", { task: "M-2" }, mira.id)).result).toBeDefined();

      // The feed: the copy, read-only for its reason, and again after a reload with its cursor.
      const feed = await openFeed(port, token);
      let cursor: unknown;
      try {
        feed.send({ type: "subscribe", space: address });
        const first = await snapshotOf(feed);
        expect(first["type"]).toBe("snapshot");
        expect(refsOf(first)).toEqual(["M-1"]);
        expect(first["space"]).toMatchObject({
          id: mira.id,
          read_only: {
            reason: "read_only_copy",
            message: expect.stringContaining("claim") as unknown,
          },
        });
        cursor = first["cursor"];
        // A write to the original moves nothing on the copy's feed: its next batch is a heartbeat.
        await add(user, "Only in the original", "page-copies-0004");
        feed.send({ type: "subscribe", space: address, cursor });
        const quiet = await feed.next(
          (m) => m["type"] !== "agents" && m["type"] !== "machine",
          60_000,
        );
        expect(quiet["type"]).not.toBe("snapshot");
        expect(quiet["events"] ?? []).toEqual([]);
      } finally {
        feed.ws.close();
      }

      // The original closed and the copy claimed: its key's feed and calls reach it, now writable.
      const again = await openFeed(port, token);
      try {
        again.send({ type: "subscribe", space: address, cursor });
        await user.call("space/close", { space: mira.folder }, CALL);
        await user.call("space/claim", { space: copyFolder }, CALL);
        // While the claim closes and opens the copy, the feed may say it is away; the snapshot
        // after it is of the same copy, and says it writes.
        const claimed = await again.next(
          (m) =>
            m["type"] === "snapshot" &&
            !Object.hasOwn(m["space"] as Record<string, unknown>, "read_only"),
          60_000,
        );
        expect(refsOf(claimed)).toEqual(["M-1"]);
        expect(claimed["space"]).toMatchObject({ copy: address });
      } finally {
        again.ws.close();
      }
      const written = await page(
        "/api/v1/op/task.add",
        { tasks: [{ title: "Into the claimed copy" }], request_id: "page-copies-0005" },
        address,
      );
      expect(written.result).toBeDefined();
    },
  );

  test(
    "a feed stays on the copy its subscription found: an ID that meant the restored copy is not resumed into the original after it reopens, and the copy's key resumes the copy",
    SLOW,
    async () => {
      const w = await httpWorld("page-copies-feed");
      worlds.push(w);
      const user = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      await add(user, "Before the backup", "page-copies-feed-0001");
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      await user.call("space/open", { path: copyFolder }, CALL);
      const { token } = await signIn(w);
      const port = w.port();
      // A feed that found the original by the space's ID, as a tab on it does.
      const held = await openFeed(port, token);
      held.send({ type: "subscribe", space: mira.id });
      const found = await snapshotOf(held);
      expect(refsOf(found)).toEqual(["M-1"]);
      const originalKey = (found["space"] as { copy: string }).copy;
      // The original closed: that feed is told, and the space's ID means the restored copy now.
      await user.call("space/close", { space: mira.folder }, CALL);
      expect(await held.next((m) => m["type"] === "error", 60_000)).toMatchObject({
        code: "space_unavailable",
      });
      const first = await openFeed(port, token);
      let cursor: unknown;
      let key: string | undefined;
      try {
        first.send({ type: "subscribe", space: mira.id });
        const snapshot = await snapshotOf(first);
        expect(refsOf(snapshot)).toEqual(["M-1"]);
        expect(snapshot["space"]).toMatchObject({ read_only: { reason: "read_only_copy" } });
        cursor = snapshot["cursor"];
        key = (snapshot["space"] as { copy: string }).copy;
      } finally {
        first.ws.close();
      }
      // The original opens again and takes a change the copy never has. The feed that found the
      // original comes back to it, and never showed the copy meanwhile.
      await user.call("space/open", { path: mira.folder }, CALL);
      await add(user, "Only in the original", "page-copies-feed-0002");
      try {
        const back = await held.next((m) => m["type"] === "snapshot", 60_000);
        expect(back["space"]).toMatchObject({ copy: originalKey });
        expect(back["space"]).not.toHaveProperty("read_only");
        const shown = held.messages.filter((m) => m["type"] === "snapshot");
        expect(shown.filter((m) => Object.hasOwn(m["space"] as object, "read_only"))).toEqual([]);
      } finally {
        held.ws.close();
      }

      // What a feed resumes with never carries the original's change under the copy's cursor.
      const next = (feed: FeedClient) =>
        feed.next((m) => m["type"] === "snapshot" || m["type"] === "batch", 60_000);
      const original = await openFeed(port, token);
      try {
        original.send({ type: "subscribe", space: mira.id, cursor });
        const got = await next(original);
        expect(got["type"]).toBe("snapshot");
        expect(refsOf(got).sort()).toEqual(["M-1", "M-2"]);
        expect(got["space"]).not.toHaveProperty("read_only");
      } finally {
        original.ws.close();
      }
      const copy = await openFeed(port, token);
      try {
        copy.send({ type: "subscribe", space: key, cursor });
        const got = await next(copy);
        const events = (got["events"] ?? []) as { request_id: string }[];
        expect(events.map((e) => e.request_id)).not.toContain("page-copies-feed-0002");
        if (got["type"] === "snapshot") expect(refsOf(got)).toEqual(["M-1"]);
      } finally {
        copy.ws.close();
      }
    },
  );

  test(
    "Run, Stop and a task's runs in a restored copy's tab act on that copy only: Run and Stop are refused with its reason, its history is its own, and the original's run is untouched; `ttasks run` by the copy's folder is the same",
    SLOW,
    async () => {
      const w = await httpWorld(
        "page-copies-runs",
        {},
        {
          toml: instanceToml({
            id: "claude-work",
            target: "claude-cli",
            label: "Claude · work",
            exec: process.execPath,
          }),
        },
      );
      worlds.push(w);
      // No run starts while the test looks: each stays queued until it is stopped.
      const hold = w.service.runs.hold();
      try {
        const user = await w.user();
        const [mira] = (
          (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
        ).spaces;
        if (mira === undefined) throw new Error("no Mira");
        const task = (await add(user, "Before the backup", "page-copies-run-0001")).tasks[0]?.id;
        if (task === undefined) throw new Error("no task");
        const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
          backup: { name: string };
        };
        const copyFolder = join(w.root, "s", "mira-copy");
        await user.call(
          "space/restore",
          { backup: backup.backup.name, to: copyFolder, of: mira.folder },
          CALL,
        );
        const { token } = await signIn(w);
        const port = w.port();
        const launch = async (action: string, body: unknown, space: string) =>
          JSON.parse(
            (
              await post(port, `/api/v1/launch/${action}`, body, {
                token,
                headers: { [SPACE_HEADER]: space },
              })
            ).body,
          ) as { result?: Record<string, unknown>; error?: { code: string; data?: unknown } };
        const opened = JSON.parse(
          (await post(port, "/api/v1/space/open", { folder: copyFolder }, { token })).body,
        ) as { result: { address: string } };
        const address = opened.result.address;
        const readOnly = { code: "read_only", data: { reason: "read_only_copy" } };
        const runsOf = async (space: string) =>
          (await launch("runs", { task }, space)).result?.["runs"] as {
            id: string;
            state: string;
          }[];

        // Run in the copy's tab: refused with the copy's reason, and nothing queued anywhere.
        expect(
          (await launch("run", { task, request_id: "page-copies-run-0002" }, address)).error,
        ).toMatchObject(readOnly);
        expect(await runsOf(mira.id)).toEqual([]);
        expect(await runsOf(address)).toEqual([]);

        // A run of the original: the copy's tab reads its own history, and its Stop is refused.
        const queued = (await launch("run", { task, request_id: "page-copies-run-0003" }, mira.id))
          .result?.["run"] as { id: string; state: string };
        expect(queued.state).toBe("queued");
        expect(await runsOf(address)).toEqual([]);
        expect((await launch("stop", { run: queued.id }, address)).error).toMatchObject(readOnly);
        expect(await runsOf(mira.id)).toEqual([
          expect.objectContaining({ id: queued.id, state: "queued" }),
        ]);

        // `ttasks run` names the copy by its folder: the same answers.
        const refusal = (verb: string, params: Record<string, unknown>) =>
          user.call(verb, { space: copyFolder, ...params }, CALL).then(
            () => undefined,
            (error: unknown) => errorOf(error),
          );
        expect(
          await refusal("runs/start", { task, request_id: "page-copies-run-0004" }),
        ).toMatchObject(readOnly);
        expect(await refusal("runs/stop", { run: queued.id })).toMatchObject(readOnly);
        expect(await user.call("runs/list", { space: copyFolder }, CALL)).toEqual({ runs: [] });

        // The original's own Stop still works.
        expect((await launch("stop", { run: queued.id }, mira.id)).result?.["run"]).toMatchObject({
          id: queued.id,
          state: "cancelled",
        });
      } finally {
        hold.release();
      }
    },
  );
});
