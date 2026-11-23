// What a backup recorded open is history, through the service. A backup is taken while a run
// works, another waits and a terminal session is open. In the restored copy, opened read-only,
// every read returns them as `recorded`; a claim, a restore in place and a claim on another
// machine end them as interrupted by the restore; and none of them is ever joined with the
// machine's live agents. Services run in this process on a temporary home, with containers that
// hold nothing; fixture data only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import { backupsFolder, newId } from "@ttasks/storage";
import type { Containers } from "@ttasks/runs";
import { afterEach, describe, expect, test } from "vitest";
import { COPY_HEADER, SPACE_HEADER } from "../src/http/app.ts";
import { heldSessions } from "../src/monitor/held.ts";
import { instanceToml, stateOf } from "./harness.ts";
import { post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type HttpWorld } from "./http-world.ts";

const SLOW = { timeout: 300_000 };
const CALL = { timeoutMs: 120_000 };
const HASH = "0123456789abcdef".repeat(4);
/** Session IDs as the agent apps write them, and an agent home's digest: invented. */
const PRESET = "aaaaaaaa-1111-4111-8111-0000000000c1";
const NATIVE = "019a0000-0000-7000-8000-0000000000c2";
const HOME = "fixture-home-digest";

const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

/** Containers that never held a run: nothing starts, and every container is empty. */
const empty: Containers = {
  probe: () => Promise.resolve({ available: true, kind: "job" }),
  start: () => Promise.reject(new Error("no run starts in this test")),
  interrupt: () => Promise.resolve(false),
  kill: () => Promise.resolve(),
  confirmEmpty: () => Promise.resolve({ state: "empty" }),
  recover: () => Promise.resolve({ state: "empty" }),
};

interface Answer {
  readonly result?: Record<string, unknown>;
  readonly error?: { code: string; message: string };
}

describe("[A2.3.10.5.copies.recorded] what a backup recorded open is history: shown as recorded in a restored copy, ended as restored by a claim or a restore in place, and joined with no live agent", () => {
  test(
    "a backup with a working run, a waiting run and an open terminal session: the read-only copy's rows, runs, receipts and run list say recorded and nothing is busy; a claim, a restore in place and a claim on another machine end each as restored; no session of them is held for the Agents page",
    SLOW,
    async () => {
      const w = await httpWorld(
        "backup-history",
        {},
        {
          toml: instanceToml({
            id: "claude-work",
            target: "claude-cli",
            label: "Claude · work",
            exec: process.execPath,
          }),
          runs: { containers: empty },
        },
      );
      worlds.push(w);
      const user: RpcSession = await w.user();
      const [mira] = (
        (await user.call("space/list", {}, CALL)) as { spaces: { id: string; folder: string }[] }
      ).spaces;
      if (mira === undefined) throw new Error("no Mira");
      let n = 0;
      const rid = () => `backup-history-${String((n += 1)).padStart(6, "0")}`;
      const add = async (title: string) => {
        const added = (await user.call(
          "op/call",
          { op: "task.add", input: { tasks: [{ title }], request_id: rid() } },
          CALL,
        )) as { tasks: { id: string }[] };
        const id = added.tasks[0]?.id;
        if (id === undefined) throw new Error("no task");
        return id;
      };
      const working = await add("Fixture working");
      const waiting = await add("Fixture waiting");
      const terminal = await add("Fixture terminal");

      // The records as a run host and a shim would leave them, written through the space's own
      // operations. No round of the service's runs takes them while the original is open.
      const hold = w.service.runs.hold();
      const served = w.service.ops.spaces().find((s) => s.id === mira.id);
      const writer = served?.writer;
      if (writer === undefined) throw new Error("Mira is not open");
      const machine = w.service.ops.machine.id;
      const store = new SpaceExecutionStore({
        writer,
        spaceId: mira.id,
        credential: {
          scope_id: `fixture:${machine}`,
          principal_id: await writer.actor("human", "user"),
          actor_kind: "human",
          machine_id: machine,
          origin: "ui",
        },
      });
      const newRun = (task: string) =>
        store.createRun(
          {
            task,
            routine: null,
            machine,
            instance: "claude-work",
            adapter: "claude-print",
            place: null,
            request: "Fixture request",
            briefHash: HASH,
            permission: "auto-edit",
            limits: RUN_LIMITS.task,
          },
          rid(),
        );
      const work = await newRun(working);
      const starting = await store.transitionRun(
        work.id,
        { state: "queued", version: work.version },
        "starting",
      );
      await store.transitionRun(
        work.id,
        { state: "starting", version: starting.version },
        "running",
        { evidence: { native_id: NATIVE, home: HOME } },
      );
      const wait = await newRun(waiting);
      const prepared = await store.createIntent(
        {
          task: terminal,
          machine,
          instance: "claude-work",
          route: "terminal",
          place: null,
          taskVersion: 1,
          briefHash: HASH,
          evidence: { preset: PRESET, home: HOME },
        },
        rid(),
      );
      const launch = prepared.id;
      await store.transitionIntent(launch, "prepared", "dispatching");
      await store.transitionIntent(launch, "dispatching", "dispatched");
      await store.transitionIntent(launch, "dispatched", "confirmed", {
        evidence: { folder_checked: true },
      });
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };

      const held = () =>
        heldSessions({
          spaces: () => w.service.ops.spaces(),
          machine,
          running: (space, copy) => w.service.launches.host.runningIn(space, copy),
          now: Date.now,
        });
      // In the space itself, both sessions are its agents of today.
      expect((await held()).map((s) => s.task.id).sort()).toEqual([terminal, working].sort());

      const { token } = await signIn(w);
      const page = async (path: string, body: unknown, headers: Record<string, string>) =>
        JSON.parse((await post(w.port(), path, body, { token, headers })).body) as Answer;
      const runsOf = async (task: string, headers: Record<string, string>) =>
        (
          (await page("/api/v1/launch/runs", { task }, headers)).result as {
            runs: { id: string; state: string; reason: string | null; started_at: number | null }[];
          }
        ).runs;
      const receiptsOf = async (headers: Record<string, string>) =>
        (
          (await page("/api/v1/launch/list", { task: terminal }, headers)).result as {
            receipts: { id: string; state: string; reason: string | null; session?: string }[];
          }
        ).receipts;

      // The backup restored into a folder of its own and opened read-only.
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      await user.call("space/close", { space: mira.folder }, CALL);
      hold.release();
      const copy = (
        (await page("/api/v1/space/open", { folder: copyFolder }, {})).result as { copy: string }
      ).copy;
      const inCopy = { [SPACE_HEADER]: mira.id, [COPY_HEADER]: copy };
      await w.service.runs.tick();
      await w.service.launches.tick();

      const workRuns = await runsOf(working, inCopy);
      expect(workRuns).toHaveLength(1);
      const [recordedWork] = workRuns;
      expect(recordedWork).toMatchObject({ id: work.id, state: "recorded" });
      expect(recordedWork?.started_at).toEqual(expect.any(Number));
      expect(await runsOf(waiting, inCopy)).toEqual([
        expect.objectContaining({ id: wait.id, state: "recorded", started_at: null }),
      ]);
      const recorded = await receiptsOf(inCopy);
      expect(recorded).toEqual([expect.objectContaining({ id: launch, state: "recorded" })]);
      expect(recorded[0]).not.toHaveProperty("session");
      expect(await page("/api/v1/launch/busy", {}, inCopy)).toEqual({ result: { busy: [] } });
      const listed = (await user.call("runs/list", { space: copyFolder }, CALL)) as {
        runs: { id: string; state: string }[];
      };
      expect(new Map(listed.runs.map((r) => [r.id, r.state]))).toEqual(
        new Map([
          [work.id, "recorded"],
          [wait.id, "recorded"],
        ]),
      );
      const feed = await openFeed(w.port(), token);
      try {
        feed.send({ type: "subscribe", space: mira.id });
        const snapshot = await feed.next((m) => m["type"] === "snapshot", 60_000);
        const rows = new Map(
          (snapshot["tasks"] as { id: string; run?: { state: string } }[]).map((r) => [r.id, r]),
        );
        expect(rows.get(working)?.run).toMatchObject({ id: work.id, state: "recorded" });
        expect(rows.get(waiting)?.run).toMatchObject({ id: wait.id, state: "recorded" });
      } finally {
        feed.ws.close();
      }
      expect(await held()).toEqual([]);

      // A claim ends each as interrupted by the restore, and none is held as an agent of today.
      await user.call("space/claim", { space: copyFolder }, CALL);
      await w.service.runs.tick();
      await w.service.runs.tick();
      await w.service.launches.tick();
      const inSpace = { [SPACE_HEADER]: mira.id };
      const ended = async () => {
        expect(await runsOf(working, inSpace)).toEqual([
          expect.objectContaining({ id: work.id, state: "failed", reason: "restored" }),
        ]);
        expect(await runsOf(waiting, inSpace)).toEqual([
          expect.objectContaining({ id: wait.id, state: "failed", reason: "restored" }),
        ]);
        expect(await receiptsOf(inSpace)).toEqual([
          expect.objectContaining({ id: launch, state: "confirmed", session: "restored" }),
        ]);
        expect(await page("/api/v1/launch/busy", {}, inSpace)).toEqual({ result: { busy: [] } });
        expect(await held()).toEqual([]);
      };
      await ended();

      // A restore of the same backup in place does the same. Its file is in the original's folder.
      const file = join(backupsFolder(mira.folder), `${backup.backup.name}.db.gz`);
      await user.call("space/restore", { backup: file, space: copyFolder }, CALL);
      await w.service.runs.tick();
      await w.service.runs.tick();
      await w.service.launches.tick();
      await ended();

      // The backup claimed by another machine: what the first machine left open ends there too,
      // and nothing of it is asked of a process.
      await user.call("space/close", { space: copyFolder }, CALL);
      const otherFolder = join(w.root, "s", "mira-other");
      await user.call("space/restore", { backup: file, to: otherFolder }, CALL);
      await w.stop();
      writeFileSync(
        join(stateOf(w.home), "machine.json"),
        JSON.stringify({
          machine_id: newId("m"),
          name: "fixture-other-machine",
          created_at: "2026-11-16T08:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      await w.restart();
      await w.service.spacesSettled;
      const other = await w.user();
      await other.call("space/claim", { space: otherFolder }, CALL);
      await w.service.runs.tick();
      await w.service.runs.tick();
      await w.service.launches.tick();
      expect(await w.service.runs.read(mira.id, work.id)).toMatchObject({
        state: "failed",
        reason: "restored",
      });
      expect(await w.service.runs.read(mira.id, wait.id)).toMatchObject({
        state: "failed",
        reason: "restored",
      });
      const elsewhere = await w.service.launches.read(mira.id, launch);
      expect(elsewhere?.state).toBe("confirmed");
      expect(elsewhere?.evidence.restored_at).toEqual(expect.any(Number));
    },
  );
});
