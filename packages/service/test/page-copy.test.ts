// One copy of a space at a time, as the page meets it: Open folder of a second copy is refused
// with what is open and what the folder is; a restored copy says so in the list and the feed; and a
// tab's calls name the copy it loaded, so after a claim or a close nothing the tab sends lands in
// another copy. Services run in this process on temporary homes; fixture data only.
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { SHIM_METHODS } from "@ttasks/launch";
import { afterEach, describe, expect, test } from "vitest";
import { COPY_HEADER, SPACE_HEADER } from "../src/http/app.ts";
import { instanceToml, waitFor } from "./harness.ts";
import { post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type FeedClient, type HttpWorld } from "./http-world.ts";

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

interface Answer {
  readonly result?: Record<string, unknown>;
  readonly error?: { code: string; message: string; hint?: string; data?: Record<string, unknown> };
}

const snapshotOf = (feed: FeedClient) =>
  feed.next((m) => m["type"] === "snapshot" || m["type"] === "error", 60_000);

interface Head {
  id: string;
  copy: string;
  folder: string;
  read_only?: { reason: string; message?: string };
  restored?: { at: string; backup?: string };
}

describe("[A2.3.10.5.copies.page] a tab shows one copy of its space and writes only into it", () => {
  test(
    "Open folder of a restored copy while its space is open is refused with what is open and what the folder is; once the space is closed the copy opens and says it is a restored copy; a claim gives the tab a new copy, and every call with the copy it loaded is refused, nothing written",
    SLOW,
    async () => {
      const w = await httpWorld("page-copy");
      worlds.push(w);
      const user = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      const before = (await add(user, "Before the backup", "page-copy-task-0001")).tasks[0];
      if (before === undefined) throw new Error("no task");
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
      const page = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
        JSON.parse((await post(w.port(), path, body, { token, headers })).body) as Answer;

      // Open folder while Mira is open: refused, in words the page shows as they are.
      const refused = await page("/api/v1/space/open", { folder: copyFolder });
      expect(refused.error).toMatchObject({
        code: "invalid_input",
        data: { reason: "other_copy_open" },
      });
      // The folders read as the page shows them: the home as `~`.
      expect(refused.error?.message).toMatch(/^Mira is open from \S*mira\. This folder holds /u);
      expect(refused.error?.message).not.toContain(homedir());
      expect(refused.error?.message).toContain("restored on");
      expect(refused.error?.hint).toContain("close Mira first");

      // The person closes Mira and opens the copy: the list says it is a restored copy, with its
      // folder and the backup it came from.
      await user.call("space/close", { space: mira.folder }, CALL);
      const opened = await page("/api/v1/space/open", { folder: copyFolder });
      expect(opened.result).toMatchObject({ id: mira.id });
      const listed = (await page("/api/v1/space/list", {})).result as {
        spaces: Record<string, unknown>[];
      };
      const restoredRow: unknown = expect.objectContaining({
        backup: `${backup.backup.name}.db.gz`,
      });
      const copyFolderShown: unknown = expect.stringMatching(/mira-copy$/u);
      expect(listed.spaces).toEqual([
        expect.objectContaining({
          id: mira.id,
          state: "read_only",
          reason: "read_only_copy",
          restored: restoredRow,
          folder: copyFolderShown,
        }),
      ]);

      // The feed's snapshot names the copy, its folder, why it takes no change and its record.
      const feed = await openFeed(w.port(), token);
      try {
        feed.send({ type: "subscribe", space: mira.id });
        const first = await snapshotOf(feed);
        expect(first["type"]).toBe("snapshot");
        const head = first["space"] as Head;
        expect(head.copy).toMatch(/^[0-9a-f]{24}$/u);
        expect(head.folder).toMatch(/mira-copy$/u);
        expect(head.read_only).toMatchObject({ reason: "read_only_copy" });
        expect(head.read_only?.message).toContain("space claim <folder>");
        expect(head.restored).toMatchObject({ backup: `${backup.backup.name}.db.gz` });
        const loaded = { [SPACE_HEADER]: mira.id, [COPY_HEADER]: head.copy };
        const write = (requestId: string, headers: Record<string, string>) =>
          page(
            "/api/v1/op/task.add",
            { tasks: [{ title: "From the tab" }], request_id: requestId },
            headers,
          );
        const readOnly = { code: "read_only", data: { reason: "read_only_copy" } };
        expect((await write("page-copy-task-0002", loaded)).error).toMatchObject(readOnly);
        // Run and Stop say the same: the space takes no change.
        expect(
          (
            await page(
              "/api/v1/launch/run",
              { task: before.id, request_id: "page-copy-run-0001" },
              loaded,
            )
          ).error,
        ).toMatchObject(readOnly);
        expect(
          (await page("/api/v1/launch/stop", { run: `ru_${"0".repeat(26)}` }, loaded)).error,
        ).toMatchObject(readOnly);

        // The copy is claimed: the tab's feed gets a snapshot of the space as it is now, with
        // another copy, no longer read-only or restored.
        await user.call("space/claim", { space: copyFolder }, CALL);
        const claimed = await snapshotOf(feed);
        expect(claimed["type"]).toBe("snapshot");
        const now = claimed["space"] as Head;
        expect(now.copy).not.toBe(head.copy);
        expect(now.read_only).toBeUndefined();
        expect(now.restored).toBeUndefined();

        // Every call the tab makes with the copy it loaded is refused, and nothing is written.
        const replaced = { code: "space_unavailable", data: { reason: "replaced" } };
        expect((await write("page-copy-task-0003", loaded)).error).toMatchObject(replaced);
        expect(
          (await page("/api/v1/op/history.undo", { request_id: "page-copy-undo-0001" }, loaded))
            .error,
        ).toMatchObject(replaced);
        expect((await page("/api/v1/op/task.get", { task: "M-1" }, loaded)).error).toMatchObject(
          replaced,
        );
        expect(
          (await page("/api/v1/launch/runs", { task: before.id }, loaded)).error,
        ).toMatchObject(replaced);
        const fresh = { [SPACE_HEADER]: mira.id, [COPY_HEADER]: now.copy };
        expect((await page("/api/v1/op/task.get", { task: "M-2" }, fresh)).error?.code).toBe(
          "not_found",
        );
        expect((await write("page-copy-task-0004", fresh)).result).toBeDefined();

        // A tab that comes back with the copy it loaded and its cursor gets a snapshot, never the
        // batches of another copy.
        feed.send({ type: "subscribe", space: mira.id, cursor: first["cursor"], copy: head.copy });
        const again = await snapshotOf(feed);
        expect(again).toMatchObject({ type: "snapshot", reason: "copy" });
        expect((again["space"] as Head).copy).toBe(now.copy);
      } finally {
        feed.ws.close();
      }

      // The space closed: the tab's copy is not served, and its calls say so in the same words.
      await user.call("space/close", { space: copyFolder }, CALL);
      const loadedNow = { [SPACE_HEADER]: mira.id, [COPY_HEADER]: "0".repeat(24) };
      expect((await page("/api/v1/op/task.get", { task: "M-1" }, loadedNow)).error?.code).toBe(
        "space_unavailable",
      );
    },
  );
});

describe("[A2.3.10.5.copies.first-load] a tab sent to the folder the person opened loads that copy or nothing", () => {
  test(
    "Open folder answers the copy the folder is served as, and a first subscription for it gets that copy; once another copy is served instead, the same subscription gets the word that it was replaced and no snapshot",
    SLOW,
    async () => {
      const w = await httpWorld("first-load");
      worlds.push(w);
      const user = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      await user.call("space/close", { space: mira.folder }, CALL);
      const { token } = await signIn(w);
      const opened = JSON.parse(
        (await post(w.port(), "/api/v1/space/open", { folder: copyFolder }, { token })).body,
      ) as { result: { id: string; copy?: string } };
      expect(opened.result.id).toBe(mira.id);
      const copy = opened.result.copy;
      expect(copy).toMatch(/^[0-9a-f]{24}$/u);

      const feed = await openFeed(w.port(), token);
      try {
        feed.send({ type: "subscribe", space: mira.id, copy });
        const first = await snapshotOf(feed);
        expect(first["type"]).toBe("snapshot");
        expect((first["space"] as Head).copy).toBe(copy);

        // Another window closes the copy and opens Mira's own folder before this tab loads.
        await user.call("space/close", { space: copyFolder }, CALL);
        await user.call("space/open", { path: mira.folder }, CALL);
        feed.send({ type: "subscribe", space: mira.id, copy });
        expect(await snapshotOf(feed)).toEqual({
          type: "error",
          code: "space_unavailable",
          reason: "replaced",
        });
      } finally {
        feed.ws.close();
      }
    },
  );
});

describe("[A2.3.10.5.copies.history] a restored copy shows its launches and runs as they were recorded", () => {
  test(
    "a terminal launch running in the space shows as running there; in a restored copy of a backup made meanwhile its receipt is recorded, with no live session, and its run history reads, on the page and in ttasks run list",
    SLOW,
    async () => {
      const START = "windows:1";
      const tickets = new Map<string, string>();
      const w = await httpWorld(
        "copy-history",
        {},
        {
          toml: instanceToml({
            id: "fake-agent",
            target: "claude-cli",
            label: "Fake agent · test",
            exec: process.execPath,
          }),
          launch: {
            terminal: ({ intent, ticket }) => {
              tickets.set(intent.id, ticket);
              return Promise.resolve({ kind: "accepted" });
            },
            probe: {
              startTimes: (pids) => Promise.resolve(new Map(pids.map((pid) => [pid, START]))),
            },
          },
        },
      );
      worlds.push(w);
      const user = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      const task = (await add(user, "Fixture task", "copy-history-task-0001")).tasks[0];
      if (task === undefined) throw new Error("no task");
      const { token } = await signIn(w);
      const page = async (path: string, body: unknown, headers: Record<string, string>) =>
        JSON.parse((await post(w.port(), path, body, { token, headers })).body) as Answer;

      // The person opens the task in a terminal, and its agent starts and settles.
      const inMira = { [SPACE_HEADER]: mira.id };
      const opened = await page(
        "/api/v1/op/launch.open",
        { task: task.id, instance: "fake-agent", request_id: "copy-history-click-0001" },
        inMira,
      );
      const launch = (opened.result as { launch: { id: string } }).launch.id;
      const ticket = await waitFor(() => tickets.get(launch), 60_000, "the terminal");
      const host = w.service.launches.host;
      const claimed = await host.claim(
        { ticket, role: "shim", pid: process.pid, start_time: START },
        () => Promise.resolve(),
      );
      if (claimed.kind !== "claimed") throw new Error("the launch was not claimed");
      await host.report(claimed.attachment, SHIM_METHODS.started, {
        pid: process.pid,
        started_at: Date.now(),
      });
      await host.report(claimed.attachment, SHIM_METHODS.settled, {});
      const receipts = async (headers: Record<string, string>) =>
        (
          (await page("/api/v1/launch/list", { task: task.id }, headers)).result as {
            receipts: { id: string; state: string; session?: string }[];
          }
        ).receipts;
      expect(await receipts(inMira)).toEqual([
        expect.objectContaining({ id: launch, state: "confirmed", session: "running" }),
      ]);

      // A backup made while it runs, restored into a folder of its own and opened read-only.
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      await user.call("space/close", { space: mira.folder }, CALL);
      const copy = (
        (await page("/api/v1/space/open", { folder: copyFolder }, {})).result as { copy: string }
      ).copy;
      const inCopy = { [SPACE_HEADER]: mira.id, [COPY_HEADER]: copy };
      const shown = await receipts(inCopy);
      expect(shown).toEqual([expect.objectContaining({ id: launch, state: "recorded" })]);
      expect(shown[0]?.session).toBeUndefined();
      expect(await page("/api/v1/launch/runs", { task: task.id }, inCopy)).toEqual({
        result: { runs: [] },
      });
      expect(await user.call("runs/list", { space: copyFolder }, CALL)).toEqual({ runs: [] });
    },
  );
});

describe("[A2.3.10.5.copies.words] the refusal of a second copy names a command that works as printed", () => {
  test(
    "with another space of the same name, the command that closes the open copy names it by its ID",
    SLOW,
    async () => {
      const w = await httpWorld("copy-words");
      worlds.push(w);
      const user = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      await user.call(
        "space/create",
        { name: "Mira", path: join(w.root, "s", "other-mira"), ref_prefix: "N" },
        CALL,
      );
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "mira-copy");
      const made = (await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      )) as { not_opened?: string };
      expect(made.not_opened).toContain(`space close ${mira.id}`);
      const { token } = await signIn(w);
      const refused = JSON.parse(
        (await post(w.port(), "/api/v1/space/open", { folder: copyFolder }, { token })).body,
      ) as Answer;
      expect(refused.error?.hint).toContain(`space close ${mira.id}`);
      expect(refused.error?.hint).not.toContain("space close Mira");
    },
  );
});
