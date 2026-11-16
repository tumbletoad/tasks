// The service's reads of preferences (A1 3.16, A5 3.15; A7 3.10 M3.11): status, the snapshot, the
// feed and `readPreferences` take every stored value through the registry. A fixture space with
// its writer in this thread, and its reader behind the service's reader interface.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Connection, Operation, Row, WorkerConnection, WriteResult } from "@tasks/storage";
import { writeFixture, type Fixture } from "@tasks/storage/write-helpers";
import { parseMachineConfig } from "../src/config/machine-toml.ts";
import { readBatch, readHead, readSnapshot } from "../src/http/feed.ts";
import { readPreferences } from "../src/ops/preferences.ts";
import { readStatus } from "../src/ops/read.ts";
import { tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;

beforeAll(async () => {
  temp = tempRoot("preferences-read");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder);
});

afterAll(() => {
  fx.close();
  temp.cleanup();
});

/** The service's reader, in this thread: each call is one deferred read transaction. */
function readerOf(f: Fixture): WorkerConnection {
  const conn: Connection = f.reader;
  return {
    transaction: (mode: "deferred", queries: { sql: string; mode: string; params?: object }[]) =>
      Promise.resolve(
        conn.transaction(mode, () =>
          queries.map((q) => {
            const statement = conn.prepare(q.sql);
            const params = q.params as Record<string, null> | undefined;
            if (q.mode === "get") return statement.get(params) ?? null;
            const all: Row[] = statement.all(params);
            return all;
          }),
        ),
      ),
    get: (sql: string) => Promise.resolve(conn.prepare(sql).get() ?? null),
  } as unknown as WorkerConnection;
}

function submit(ops: Operation[]): WriteResult {
  const result = fx.writer.submit(fx.request(fx.human, ops, { base: fx.base() }));
  expect(result.status, JSON.stringify(result.error)).toBe("applied");
  return result;
}

const status = () =>
  readStatus(readerOf(fx), { today: "2026-11-12", week: "2026-11-19", since: 0, include: [] });

describe("[A1.3.16.prefs.read] the service reads preferences through the registry", () => {
  test("status follows the space's statuses and autonomy level, and their defaults after a reset", async () => {
    const before = await status();
    expect(before.statuses.map((s) => s.status)).toEqual(["open", "waiting", "review", "backlog"]);
    expect(before.autonomy).toBe("review");
    submit([
      { kind: "pref.set", key: "tasks.statuses", value: ["open", "doing"] },
      { kind: "pref.set", key: "autonomy.level", value: "suggest" },
    ]);
    const set = await status();
    expect(set.statuses.map((s) => s.status)).toEqual(["open", "doing"]);
    expect(set.autonomy).toBe("suggest");
    submit([
      { kind: "pref.set", key: "tasks.statuses", value: null },
      { kind: "pref.set", key: "autonomy.level", value: null },
    ]);
    const reset = await status();
    expect(reset.statuses.map((s) => s.status)).toEqual(["open", "waiting", "review", "backlog"]);
    expect(reset.autonomy).toBe("review");
  });

  test("the snapshot carries every space preference and flag; a batch names a changed one", async () => {
    const start = (await readHead(readerOf(fx))).cursor.seq;
    const result = submit([{ kind: "pref.set", key: "ui.theme", value: "washi" }]);
    const snapshot = await readSnapshot(readerOf(fx));
    expect(snapshot.preferences.map((p) => p.key)).toEqual([
      "ui.theme",
      "tasks.statuses",
      "tasks.effort_scale",
      "tasks.dedupe_window_days",
      "grouping.names",
      "autonomy.level",
      "autonomy.agent_tasks_to_inbox",
      "autonomy.overrides",
      "autonomy.areas",
      "targets.default",
      "projection.enabled",
      "features.search_trigram",
    ]);
    expect(snapshot.preferences[0]).toEqual({ key: "ui.theme", value: "washi", state: "set" });
    expect(snapshot.preferences.find((p) => p.key === "projection.enabled")).toEqual({
      key: "projection.enabled",
      value: true,
      state: "default",
    });
    const { batch } = await readBatch(readerOf(fx), start);
    const event = batch.events.find((e) => e.seq === result.seq);
    expect(event?.entities).toEqual([
      { type: "preference", id: "ui.theme", row: null, changed: [], created: true },
    ]);
  });

  test("readPreferences gives each declared key with its declaration, this machine's from machine.toml", async () => {
    const { config } = parseMachineConfig(
      '[preferences]\n"projection.dir" = "/srv/tasks-view"\n',
      "linux",
    );
    submit([{ kind: "pref.set", key: "features.search_trigram", value: true }]);
    const all = await readPreferences(readerOf(fx), config);
    expect(all.find((p) => p.key === "projection.dir")).toEqual({
      key: "projection.dir",
      value: "/srv/tasks-view",
      state: "set",
      scope: "machine",
      policy: false,
      writers: ["human"],
      default: null,
      summary: expect.any(String) as string,
    });
    expect(all.find((p) => p.key === "features.search_trigram")).toMatchObject({
      value: true,
      state: "set",
      default: false,
      flag: { stability: "preview" },
    });
    expect(all.find((p) => p.key === "autonomy.level")).toMatchObject({
      policy: true,
      writers: ["human"],
    });
    expect(all).toHaveLength(13);
  });
});
