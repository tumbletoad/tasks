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
    "Open folder with a restored copy while its original is open: its address, calls and feed reach the copy, and say why it is read-only; the ID still means the original; once claimed the copy's tab takes changes",
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

      // The original closed and the copy claimed: the copy's tab follows it, now writable.
      const again = await openFeed(port, token);
      try {
        again.send({ type: "subscribe", space: address, cursor });
        await user.call("space/close", { space: mira.folder }, CALL);
        await user.call("space/claim", { space: copyFolder }, CALL);
        // A snapshot may come while the claim is under way; the one after it says it writes.
        const claimed = await again.next(
          (m) =>
            m["type"] === "error" ||
            (m["type"] === "snapshot" &&
              !Object.hasOwn(m["space"] as Record<string, unknown>, "read_only")),
          60_000,
        );
        expect(claimed["type"]).toBe("snapshot");
        expect(refsOf(claimed)).toEqual(["M-1"]);
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
