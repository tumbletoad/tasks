// What is bound to a copy of a space stays with that copy: an agent's session launched in the
// original writes nothing into a backup claimed after it, a close and an open of the same folder
// keep its session, and a restored copy that is not claimed shows its launches as recorded, with
// no live session of the machine joined in. A service in this process on a temporary home; the
// world's launches are claimed in this process as a shim claims them. Fixture data only.
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { SHIM_METHODS } from "@ttasks/launch";
import { afterEach, describe, expect, test } from "vitest";
import { LaunchWriterGone } from "../src/launch/open.ts";
import type { ServedSpace } from "../src/ops/index.ts";
import { bridge, launchContext, shell } from "./agents.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { classSession } from "./ops-helpers.ts";

const SLOW = { timeout: 300_000 };
const CALL = { timeoutMs: 120_000 };
const DAY = 24 * 60 * 60_000;

type World = ContractWorld & { readonly root: string };
const worlds: World[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  for (const w of worlds.splice(0)) await w.close();
});

/** A world with one task, M-1, and the person's session and Mira's folder. */
async function world(label: string) {
  // The PID check runs only when a test asks.
  const w = await contractWorld(label, { launch: { checkMs: DAY } });
  worlds.push(w);
  const person = await classSession(w.home, w.path, "cli-interactive");
  sessions.push(person);
  await person.call(
    "op/call",
    {
      op: "task.add",
      input: { tasks: [{ title: "Fixture task" }], request_id: `${label}-task-000001` },
    },
    CALL,
  );
  const listed = (await person.call("space/list", {}, CALL)) as { spaces: { folder: string }[] };
  const folder = listed.spaces[0]?.folder;
  if (folder === undefined) throw new Error("no Mira");
  return { w, person, folder };
}

/** The served copy of the world's space: the one entry with a reader. */
function served(w: World): ServedSpace {
  const found = w.service.ops.spaces().find((s) => s.id === w.space && s.reader !== undefined);
  if (found === undefined) throw new Error("the space is not served");
  return found;
}

/** The receipts a request ID left in the copy served now. */
async function receipts(w: World, requestId: string): Promise<unknown[]> {
  const reader = served(w).reader;
  if (reader === undefined) throw new Error("no reader");
  const [rows] = (await reader.transaction("deferred", [
    {
      sql: "SELECT scope_id FROM receipts WHERE request_id = $request",
      mode: "all",
      params: { request: requestId },
    },
  ])) as unknown[][];
  return rows ?? [];
}

/** Backs up Mira, closes it, restores the backup into a new folder and returns that folder. */
async function restoredCopy(w: World, person: RpcSession, folder: string): Promise<string> {
  const backup = (await person.call("space/backup", { space: folder }, CALL)) as {
    backup: { name: string };
  };
  await person.call("space/close", { space: folder }, CALL);
  const copy = join(w.root, "s", "mira-copy");
  await person.call("space/restore", { backup: backup.backup.name, to: copy, of: folder }, CALL);
  return copy;
}

const note = (requestId: string) => ({
  kind: "note",
  text: "Fixture note.",
  request_id: requestId,
});

describe("[A2.3.10.5.copies.session] an agent's session writes only into the copy of the space it was launched in", () => {
  test(
    "a terminal session goes on over a close and an open of its unchanged folder; once a backup is claimed, a note from its bridge and one from its shell are refused as replaced, in words that say not to retry, and the claimed space holds no receipt of either",
    SLOW,
    async () => {
      const { w, person, folder } = await world("session-copy");
      const launch = await w.launch("M-1");
      const agent = await bridge(w, launchContext(w.space, launch));
      const terminal = await shell(w, { TTASKS_TICKET: launch.ticket });
      try {
        // Closed and opened again from the same folder, unchanged: the same copy.
        await person.call("space/close", { space: folder }, CALL);
        await person.call("space/open", { path: folder }, CALL);
        await agent.call("entry.add", note("session-copy-note-000001"));
        await terminal.call("entry.add", note("session-copy-note-000002"));
        expect(await receipts(w, "session-copy-note-000001")).toHaveLength(1);
        expect(await receipts(w, "session-copy-note-000002")).toHaveLength(1);

        const copy = await restoredCopy(w, person, folder);
        await person.call("space/claim", { space: copy }, CALL);
        expect(served(w).folder).toBe(copy);

        const fromBridge = await agent.refusal("entry.add", note("session-copy-note-000003"));
        expect(fromBridge).toMatchObject({ code: "space_unavailable", reason: "replaced" });
        expect(fromBridge.text).toContain("restored since this session began");
        expect(fromBridge.text).toContain("Do not retry");
        const fromShell = await terminal.refusal("entry.add", note("session-copy-note-000004"));
        expect(fromShell.body).toMatchObject({
          code: "space_unavailable",
          data: { reason: "replaced", retryable: false },
        });
        expect(fromShell.body?.hint).toContain("start the agent again from the task");
        // A read is refused too: what the agent would read is not the copy it was given.
        expect(await terminal.refusal("task.get", {})).toMatchObject({ reason: "replaced" });

        expect(await receipts(w, "session-copy-note-000003")).toEqual([]);
        expect(await receipts(w, "session-copy-note-000004")).toEqual([]);
      } finally {
        await agent.close();
        await terminal.close();
      }
    },
  );
});

describe("[A2.3.10.5.copies.launch] a launch and its later reports stay with the copy its click was made in", () => {
  test(
    "a click checked against the writer of the original makes nothing once a backup is claimed, while the same click against the claimed copy's writer is made; the original's shim reporting its agent's end after the claim changes nothing in the claimed copy",
    SLOW,
    async () => {
      const { w, person, folder } = await world("launch-copy");
      const launch = await w.launch("M-1");
      const writer = served(w).writer;
      if (writer === undefined) throw new Error("no writer");
      const read = (await person.call(
        "op/call",
        { op: "task.get", input: { task: "M-1" } },
        CALL,
      )) as { task: { id: string } };
      // The task as the request path read it in the original.
      const task = {
        id: read.task.id,
        ref: "M-1",
        title: "Fixture task",
        version: 1,
        folder: { kind: "none" as const },
      };
      const copy = await restoredCopy(w, person, folder);
      await person.call("space/claim", { space: copy }, CALL);

      // A Copy click whose request path checked the original's writer, its turn in the queue
      // coming after the claim.
      const click = (checked: typeof writer, requestId: string) =>
        w.service.launches.openTask({
          space: w.space,
          writer: checked,
          task,
          instance: undefined,
          composer: undefined,
          requestId,
          saveNote: () => Promise.reject(new Error("no words were given")),
        });
      await expect(click(writer, "launch-copy-click-000001")).rejects.toBeInstanceOf(
        LaunchWriterGone,
      );
      expect(await receipts(w, "launch-copy-click-000001")).toEqual([]);
      const now = served(w).writer;
      if (now === undefined) throw new Error("the claimed copy takes no write");
      expect((await click(now, "launch-copy-click-000002")).intent.state).toBe("dispatched");

      // The original's agent ends: its shim's report is not the claimed copy's to take.
      const before = await w.service.launches.read(w.space, launch.id);
      if (launch.attachment === undefined) throw new Error("the launch was not claimed");
      const ended = await w.service.launches.host.report(launch.attachment, SHIM_METHODS.exited, {
        code: 0,
        signal: null,
        ran_ms: 5_000,
        settled: true,
      });
      expect(ended).toEqual({ kind: "refused", reason: "space" });
      expect(await w.service.launches.read(w.space, launch.id)).toEqual(before);
    },
  );
});
