// The service's reads of preferences (A1 3.16, A5 3.15; A7 3.10 M3.11): status, the snapshot, the
// feed and `readPreferences` take every stored value through the registry. A fixture space with
// its writer in this thread, and its reader behind the service's reader interface.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PREFERENCES } from "@ttasks/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Operation, WriteResult } from "@ttasks/storage";
import { writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { parseMachineConfig } from "../src/config/machine-toml.ts";
import { readBatch, readHead, readSnapshot } from "../src/http/feed.ts";
import { readPreferences } from "../src/ops/preferences.ts";
import { readStatus } from "../src/ops/read.ts";
import { readerOf, tempRoot } from "./harness.ts";

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

function submit(ops: Operation[]): WriteResult {
  const result = fx.writer.submit(fx.request(fx.human, ops, { base: fx.base() }));
  expect(result.status, JSON.stringify(result.error)).toBe("applied");
  return result;
}

const status = () =>
  readStatus(readerOf(fx.reader), {
    clock: { today: "2026-11-12", now: Date.UTC(2026, 10, 12, 9), timeZone: "Europe/Lisbon" },
    since: 0,
    include: [],
  });

describe("[A1.3.16.prefs.read] the service reads preferences through the registry", () => {
  test("status follows the space's statuses, and their default after a reset", async () => {
    const before = await status();
    expect(before.statuses.map((s) => s.status)).toEqual(["open", "waiting", "review", "backlog"]);
    submit([{ kind: "pref.set", key: "tasks.statuses", value: ["open", "doing"] }]);
    const set = await status();
    expect(set.statuses.map((s) => s.status)).toEqual(["open", "doing"]);
    submit([{ kind: "pref.set", key: "tasks.statuses", value: null }]);
    const reset = await status();
    expect(reset.statuses.map((s) => s.status)).toEqual(["open", "waiting", "review", "backlog"]);
  });

  test("the snapshot carries every space preference and flag; a batch names a changed one", async () => {
    const start = (await readHead(readerOf(fx.reader))).cursor.seq;
    const result = submit([{ kind: "pref.set", key: "tasks.dedupe_window_days", value: 7 }]);
    const snapshot = await readSnapshot(readerOf(fx.reader));
    expect(snapshot.preferences.map((p) => p.key)).toEqual([
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
    expect(snapshot.preferences.find((p) => p.key === "tasks.dedupe_window_days")).toEqual({
      key: "tasks.dedupe_window_days",
      value: 7,
      state: "set",
    });
    expect(snapshot.preferences.find((p) => p.key === "projection.enabled")).toEqual({
      key: "projection.enabled",
      value: true,
      state: "default",
    });
    const { batch } = await readBatch(readerOf(fx.reader), start);
    const event = batch.events.find((e) => e.seq === result.seq);
    expect(event?.entities).toEqual([
      {
        type: "preference",
        id: "tasks.dedupe_window_days",
        row: null,
        changed: [],
        created: true,
      },
    ]);
  });

  test("readPreferences gives each declared key with its declaration, this machine's from machine.toml", async () => {
    const { config } = parseMachineConfig(
      '[preferences]\n"projection.dir" = "/srv/ttasks-view"\n',
      "linux",
    );
    submit([{ kind: "pref.set", key: "features.search_trigram", value: true }]);
    const all = await readPreferences(readerOf(fx.reader), config);
    expect(all.find((p) => p.key === "projection.dir")).toEqual({
      key: "projection.dir",
      value: "/srv/ttasks-view",
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
    expect(all).toHaveLength(PREFERENCES.length);
  });
});
