// What is bound to a copy of a space stays with that copy: an agent's session launched in the
// original writes nothing into a backup claimed after it, a close and an open of the same folder
// keep its session, and a restored copy that is not claimed shows its launches as recorded, with
// no live session of the machine joined in. A service in this process on a temporary home; the
// world's launches are claimed in this process as a shim claims them. Fixture data only.
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
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
