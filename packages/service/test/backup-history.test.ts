// What a backup recorded open is history, through the service. A backup is taken while runs work
// and wait on active, finished, dropped and trashed tasks, and a terminal session is open. In the
// restored copy, opened read-only, every read answers and returns them as `recorded`; a claim, a
// restore in place and a claim on another machine end them as interrupted by the restore before
// the copy is served, so the first read after each already says so; and none of them is ever
// joined with the machine's live agents. Services run in this process on a temporary home, with process groups that
// hold nothing; fixture data only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { RUN_LIMITS } from "@ttasks/contracts/runs";
import { SpaceExecutionStore } from "@ttasks/launch";
import { newId } from "@ttasks/storage";
import type { ProcessGroups } from "@ttasks/runs";
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

/** Process groups that never held a run: nothing starts, and every process group is empty. */
const empty: ProcessGroups = {
  probe: () => Promise.resolve({ available: true, kind: "job" }),
  kind: () => Promise.resolve("job" as const),
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

type Ending = "active" | "done" | "dropped" | "trashed";
type Kind = "working" | "waiting";
const ENDINGS: readonly Ending[] = ["active", "done", "dropped", "trashed"];
const KINDS: readonly Kind[] = ["working", "waiting"];

interface Fixture {
  readonly task: string;
  readonly ending: Ending;
  readonly kind: Kind;
  readonly run: string;
}

describe("[A2.3.10.5.copies.recorded] what a backup recorded open is history: shown as recorded in a restored copy, ended as restored by a claim or a restore in place before either answers, and joined with no live agent", () => {
  test(
    "a backup with a working and a waiting run on an active, a finished, a dropped and a trashed task, and an open terminal session: every read of the read-only copy answers, and says recorded; the first reads after a claim and after a restore in place say restored; a claim on another machine ends them too; no session of them is held for the Agents page",
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
          runs: { groups: empty },
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
      const op = async (name: string, input: Record<string, unknown>) =>
        (await user.call("op/call", { op: name, input }, CALL)) as Record<string, unknown>;
      const add = async (title: string) => {
        const added = (await op("task.add", { tasks: [{ title }], request_id: rid() })) as {
          tasks: { id: string }[];
        };
        const id = added.tasks[0]?.id;
        if (id === undefined) throw new Error("no task");
        return id;
      };

      // Where the feed of the space stood before any task of the fixture: a batch from here
      // carries every one of their rows.
      const { token } = await signIn(w);
      const first = await openFeed(w.port(), token);
      let before: unknown;
      try {
        first.send({ type: "subscribe", space: mira.id });
        before = (await first.next((m) => m["type"] === "snapshot", 60_000))["cursor"];
      } finally {
        first.ws.close();
      }

      const titled = new Map<string, { ending: Ending; kind: Kind }>();
      for (const ending of ENDINGS) {
        for (const kind of KINDS)
          titled.set(await add(`Fixture ${kind} ${ending}`), { ending, kind });
      }
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
      const fixtures: Fixture[] = [];
      for (const [task, { ending, kind }] of titled) {
        const run = await store.createRun(
          {
            task,
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
        if (kind === "working") {
          const starting = await store.transitionRun(
            run.id,
            { state: "queued", version: run.version },
            "starting",
          );
          await store.transitionRun(
            run.id,
            { state: "starting", version: starting.version },
            "running",
            { evidence: { native_id: NATIVE, home: HOME } },
          );
        }
        fixtures.push({ task, ending, kind, run: run.id });
      }
      // A task finished while its run was open: the run goes on, as a person's Done never stops it.
      // And one moved to the Trash: its work goes on too.
      for (const f of fixtures) {
        if (f.ending === "active") continue;
        const base = (await op("space.status", {}))["as_of"];
        if (f.ending === "trashed") {
          await op("task.delete", { tasks: [f.task], base, request_id: rid() });
          continue;
        }
        await op("task.finish", { task: f.task, status: f.ending, base, request_id: rid() });
      }
      const finishedTasks = fixtures
        .filter((f) => f.ending === "done" || f.ending === "dropped")
        .map((f) => f.task);
      const trashedTasks = fixtures.filter((f) => f.ending === "trashed").map((f) => f.task);
      const activeTasks = fixtures.filter((f) => f.ending === "active").map((f) => f.task);
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
      const lastRequest = `backup-history-${String(n).padStart(6, "0")}`;
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string; folder: string };
      };

      const held = () =>
        heldSessions({
          spaces: () => w.service.ops.spaces(),
          machine,
          running: (space, copy) => w.service.launches.host.runningIn(space, copy),
          now: Date.now,
        });
      // In the space itself, the running runs and the session are its agents of today.
      expect((await held()).map((s) => s.task.id).sort()).toEqual(
        [terminal, ...fixtures.filter((f) => f.kind === "working").map((f) => f.task)].sort(),
      );

      const page = async (path: string, body: unknown, headers: Record<string, string>) =>
        JSON.parse((await post(w.port(), path, body, { token, headers })).body) as Answer;
      /** The page's read, which must answer: a contract error fails here with its message. */
      const read = async (path: string, body: unknown, headers: Record<string, string>) => {
        const answer = await page(path, body, headers);
        expect(answer.error, `${path} ${JSON.stringify(body)}`).toBeUndefined();
        return answer.result ?? {};
      };
      const runsOf = async (task: string, headers: Record<string, string>) =>
        (await read("/api/v1/launch/runs", { task }, headers))["runs"] as {
          id: string;
          state: string;
          reason: string | null;
          started_at: number | null;
        }[];
      const receiptsOf = async (headers: Record<string, string>) =>
        (await read("/api/v1/launch/list", { task: terminal }, headers))["receipts"] as {
          id: string;
          state: string;
          reason: string | null;
          session?: string;
        }[];
      type RowRun = { id: string; state: string } | undefined;
      const finishedRows = async (headers: Record<string, string>) =>
        new Map(
          (
            (await read("/api/v1/op/task.finished", {}, headers))["rows"] as {
              id: string;
              run?: RowRun;
            }[]
          ).map((r) => [r.id, r.run]),
        );
      const trashRows = async (headers: Record<string, string>) =>
        new Map(
          (
            (await read("/api/v1/op/task.trash", {}, headers))["rows"] as {
              id: string;
              run?: RowRun;
            }[]
          ).map((r) => [r.id, r.run]),
        );
      const snapshotRows = async () => {
        const feed = await openFeed(w.port(), token);
        try {
          feed.send({ type: "subscribe", space: mira.id });
          const snapshot = await feed.next((m) => m["type"] === "snapshot", 60_000);
          return new Map(
            (snapshot["tasks"] as { id: string; run?: RowRun }[]).map((r) => [r.id, r.run]),
          );
        } finally {
          feed.ws.close();
        }
      };
      /** The agent's and the page's reads that carry no run: each answers, in every copy. */
      const answers = async (headers: Record<string, string>) => {
        await read("/api/v1/op/space.status", {}, headers);
        for (const f of fixtures) await read("/api/v1/op/task.get", { task: f.task }, headers);
        await read("/api/v1/op/task.get", { launch: prepared.reference }, headers);
        await read("/api/v1/op/task.search", { q: "is:bound", scope: "all" }, headers);
        const all = (await read("/api/v1/op/task.search", { scope: "all", limit: 50 }, headers))[
          "rows"
        ] as { id: string }[];
        expect(all.map((r) => r.id)).toEqual(
          expect.arrayContaining([
            terminal,
            ...fixtures.filter((f) => f.ending !== "trashed").map((f) => f.task),
          ]),
        );
        await read("/api/v1/op/receipt.get", { request: lastRequest }, headers);
        expect(await read("/api/v1/launch/busy", {}, headers)).toMatchObject({ busy: [] });
        expect(await held()).toEqual([]);
      };

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

      for (const f of fixtures) {
        const runs = await runsOf(f.task, inCopy);
        expect(runs).toEqual([expect.objectContaining({ id: f.run, state: "recorded" })]);
        expect(runs[0]?.started_at, f.kind).toEqual(
          f.kind === "working" ? expect.any(Number) : null,
        );
      }
      const recorded = await receiptsOf(inCopy);
      expect(recorded).toEqual([expect.objectContaining({ id: launch, state: "recorded" })]);
      expect(recorded[0]).not.toHaveProperty("session");
      const listed = (await user.call("runs/list", { space: copyFolder }, CALL)) as {
        runs: { id: string; state: string }[];
      };
      expect(new Map(listed.runs.map((r) => [r.id, r.state]))).toEqual(
        new Map(fixtures.map((f) => [f.run, "recorded"])),
      );
      for (const f of fixtures) {
        expect(await user.call("runs/show", { space: copyFolder, run: f.run }, CALL)).toMatchObject(
          { id: f.run, state: "recorded" },
        );
      }
      const finished = await finishedRows(inCopy);
      for (const task of finishedTasks) {
        expect(finished.get(task)).toMatchObject({ state: "recorded" });
      }
      const trashed = await trashRows(inCopy);
      for (const task of trashedTasks) {
        expect(trashed.get(task)).toMatchObject({ state: "recorded" });
      }
      const open = await snapshotRows();
      for (const task of activeTasks) expect(open.get(task)).toMatchObject({ state: "recorded" });
      // A batch from before the fixture carries every task's row as the copy holds it now.
      const feed = await openFeed(w.port(), token);
      try {
        feed.send({ type: "subscribe", space: mira.id, cursor: before });
        const batched = new Map<string, RowRun>();
        for (;;) {
          const message = await feed.next(
            (m) => m["type"] === "batch" || m["type"] === "snapshot" || m["type"] === "error",
            60_000,
          );
          expect(message["type"]).toBe("batch");
          const events = message["events"] as {
            entities: { type: string; row?: { id: string; run?: RowRun } }[];
          }[];
          for (const event of events) {
            for (const entity of event.entities) {
              if (entity.type === "task" && entity.row !== undefined) {
                batched.set(entity.row.id, entity.row.run);
              }
            }
          }
          if (fixtures.every((f) => batched.has(f.task))) break;
        }
        for (const f of fixtures) expect(batched.get(f.task)).toMatchObject({ state: "recorded" });
      } finally {
        feed.ws.close();
      }
      await answers(inCopy);

      // What a claim and a restore in place answer with is settled: the first reads, with no
      // round of the service's recovery in between, say restored, and nothing is busy or held.
      const inSpace = { [SPACE_HEADER]: mira.id };
      const ended = async (folder: string) => {
        for (const f of fixtures) {
          expect(await runsOf(f.task, inSpace)).toEqual([
            expect.objectContaining({ id: f.run, state: "failed", reason: "restored" }),
          ]);
        }
        expect(await receiptsOf(inSpace)).toEqual([
          expect.objectContaining({ id: launch, state: "confirmed", session: "restored" }),
        ]);
        const runs = (await user.call("runs/list", { space: folder }, CALL)) as {
          runs: { id: string; state: string }[];
        };
        expect(new Map(runs.runs.map((r) => [r.id, r.state]))).toEqual(
          new Map(fixtures.map((f) => [f.run, "failed"])),
        );
        const rows = await finishedRows(inSpace);
        for (const task of finishedTasks) expect(rows.get(task)).toBeUndefined();
        const trash = await trashRows(inSpace);
        for (const task of trashedTasks) {
          expect(trash.has(task)).toBe(true);
          expect(trash.get(task)).toBeUndefined();
        }
        const open = await snapshotRows();
        for (const task of activeTasks) expect(open.get(task)).toBeUndefined();
        await answers(inSpace);
      };
      await user.call("space/claim", { space: copyFolder }, CALL);
      await ended(copyFolder);

      // A restore of the same backup in place does the same, by its file.
      const file = join(backup.backup.folder, `${backup.backup.name}.db.gz`);
      await user.call("space/restore", { backup: file, space: copyFolder }, CALL);
      await ended(copyFolder);

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
      for (const f of fixtures) {
        expect(await w.service.runs.read(mira.id, f.run)).toMatchObject({
          state: "failed",
          reason: "restored",
        });
      }
      const elsewhere = await w.service.launches.read(mira.id, launch);
      expect(elsewhere?.state).toBe("confirmed");
      expect(elsewhere?.evidence.restored_at).toEqual(expect.any(Number));
    },
  );
});
