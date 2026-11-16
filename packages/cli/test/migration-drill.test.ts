// The installed-build migration failure and restore drill with the real 0.2 to 0.5 (A7 3.10
// M3.01 and 3.13 M6.01, which repeat M1.15's drill; A1 5; MIL-02). Against a build (`pnpm accept
// m3 --part migration --installed <install root or version folder>`; CI's smoke job runs it on the
// real install), the service is the built one, so the migration, its barrier backup and the
// restore run in the build's own workers. From source, the same test runs on every `pnpm verify`.
// The drill also searches by words, which the space can answer only once it is at 0.4 or later.
//
// The fault. A product build has no fault hook (A1 5: only a test's worker entry can arm
// one), and this drill runs the version folder `pnpm build --sign test` makes, unchanged. So the
// fault is planted in the space instead: a trigger that fails the 0.5 step's system commit, after
// every statement and commit of the 0.2 to 0.4 steps and every statement of the 0.5 step ran in
// the migration's one transaction. Its rollback has to take all of them back. The trigger is a schema
// object, not a row: the fixture's counts and last_seq do not see it. Removing it lets the same
// space migrate, which is the upgrade the owner's real spaces get once this drill passes.
//
// The fixture is the Mira sample built by the 0.1 chain through the write path (testkit's seedMira
// with STEPS_0_1, whose known digest is the 0.1 builds'), with this service's machine as its
// authority. Fixture data only, in the world's temporary folder.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openSpace, openWriter } from "@tasks/storage";
import { STEPS_0_1 } from "@tasks/storage/revisions";
import { stateOf } from "@tasks/service/test/harness";
import { checkedDriver, seedMira } from "@tasks/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("md");
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

const user = (argv: string[]) => runMain(argv, { home: world.home, cwd: world.root, tty: true });
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

/** How a failed migration is tried again (A1 3.17), at the end of its message. */
const TRIED_AGAIN =
  "It is tried again after an update, or now with: tasks space open <folder> --retry-migration";

/**
 * A failed migration's message (A1 3.17), for the 0.1 to 0.5 migration, and how it is
 * tried again (A2 3.1).
 */
const FAILED_MESSAGE = new RegExp(
  "^Migration to 0\\.5 failed \\(STORAGE_CONSTRAINT\\)\\. Your data is unchanged\\. The space " +
    "stays at 0\\.1\\. Backup: (pre-migrate-[0-9TZ.]+-e1-s[0-9]+)\\. " +
    `${TRIED_AGAIN.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
  "u",
);

/** The planted fault: the 0.5 step's system commit, and nothing else, is refused. */
const FAULT =
  "CREATE TRIGGER drill_fault BEFORE INSERT ON commits WHEN NEW.kind = 'migration' " +
  "AND json_extract(NEW.ops, '$[0].input.to') = '0.5' " +
  "BEGIN SELECT RAISE(ABORT, 'drill fault'); END";

async function onClosedSpace(folder: string, sql: string): Promise<void> {
  const conn = openWriter(await checkedDriver(), join(folder, "space.db"));
  try {
    conn.exec(sql);
  } finally {
    conn.close();
  }
}

interface Facts {
  userVersion: number;
  lastSeq: number;
  counts: Record<string, number>;
}

/** What the drill compares: the revision, last_seq and the rows of every table, read-only. */
async function factsOf(folder: string): Promise<Facts> {
  const { conn, space } = openSpace(await checkedDriver(), folder, { role: "reader" });
  try {
    const tables = conn
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all<{ name: string }>()
      .map((t) => t.name);
    return {
      userVersion: Number(conn.pragma("user_version")),
      lastSeq: space.lastSeq,
      counts: Object.fromEntries(
        tables.map((t) => [t, Number(conn.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.["n"])]),
      ),
    };
  } finally {
    conn.close();
  }
}

describe("[A1.5.migration.drill] the installed-build migration failure and restore drill with the real 0.2 to 0.5", () => {
  test("a fault in the migration leaves the 0.1 space read-only with A1's message, its barrier backup restores the fixture, and without the fault it upgrades", async () => {
    // The service that migrates is the build under test: the built folder's, or the source.
    const build =
      world.install === undefined
        ? "source"
        : (
            JSON.parse(
              readFileSync(join(world.install.versionFolder, "manifest.json"), "utf8"),
            ) as { build: string }
          ).build;
    expect(world.json["build"]).toBe(build);

    // A populated 0.1 fixture space whose authority is this service's machine.
    const machine = (
      JSON.parse(readFileSync(join(stateOf(world.home), "machine.json"), "utf8")) as {
        machine_id: `m_${string}`;
      }
    ).machine_id;
    const parent = join(world.root, "d");
    mkdirSync(parent);
    const seeded = await seedMira(parent, {
      seed: "drill",
      tasks: 30,
      steps: STEPS_0_1,
      machineId: machine,
    });
    const folder = seeded.folder;
    const fixture = await factsOf(folder);
    expect(fixture.userVersion).toBe(1);
    expect(fixture.counts["tasks"]).toBe(30);
    await onClosedSpace(folder, FAULT);
    expect(await factsOf(folder)).toEqual(fixture);

    // The service opens it: the barrier backup is taken and verified, the migration fails, and
    // the space is served read-only at 0.1 with A1's message.
    const opened = await user(["space", "open", folder, "--json"]);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    const space = parsed(opened.stdout)["space"] as Record<string, string>;
    expect(space).toMatchObject({
      name: "Mira",
      state: "read_only",
      reason: "migration_failed",
      code: "MIGRATION_FAILED",
    });
    const message = FAILED_MESSAGE.exec(space["message"] ?? "");
    expect(message, space["message"]).not.toBeNull();
    const backupName = message?.[1] ?? "";
    expect(backupName.endsWith(`-s${String(fixture.lastSeq)}`)).toBe(true);
    // The person sees the message in the list, through the build's own CLI when there is one.
    const listed = await world.tasks(["space", "list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(space["message"]);
    // The data is the fixture's: still 0.1, every table's rows, the same last_seq.
    expect(await factsOf(folder)).toEqual(fixture);
    // Served read-only: reads answer, a write is refused with the reason.
    const id = space["id"] ?? "";
    const shown = await world.tasks(["show", "M-1", "--space", id, "--json"]);
    expect(shown.code, shown.stdout + shown.stderr).toBe(0);
    const refused = await world.tasks(["add", "Drill fixture task", "--space", id, "--json"]);
    expect(refused.code, refused.stdout).toBe(8);
    expect(parsed(refused.stdout)).toMatchObject({
      error: { code: "read_only", data: { reason: "migration_failed" } },
    });
    // Words need the search index the failed update would have made: refused with why, while a
    // search by filters answers.
    const words = await world.tasks(["find", "fixture", "--space", id, "--json"]);
    expect(words.code, words.stdout).not.toBe(0);
    expect(parsed(words.stdout)).toMatchObject({
      error: {
        code: "space_unavailable",
        message: expect.stringContaining("could not be updated from schema 0.1") as unknown,
        data: { reason: "not_indexed" },
      },
    });
    const filtered = await world.tasks(["find", "status:open", "--space", id, "--json"]);
    expect(filtered.code, filtered.stdout + filtered.stderr).toBe(0);

    // The barrier backup is listed and complete.
    const backups = parsed((await user(["space", "backups", "list", folder, "--json"])).stdout) as {
      folder: string;
      backups: { name: string; state: string; kind?: string; seq?: number }[];
    };
    expect(backups.backups).toContainEqual(
      expect.objectContaining({
        name: backupName,
        state: "ok",
        kind: "pre-migrate",
        seq: fixture.lastSeq,
      }),
    );

    // A restore of it into a new folder, through the service: a read-only copy that holds the
    // fixture's counts and last_seq.
    const copyFolder = join(parent, "restored");
    const restored = await user([
      "space",
      "restore",
      join(backups.folder, `${backupName}.db.gz`),
      "--to",
      copyFolder,
      "--json",
    ]);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(parsed(restored.stdout)).toMatchObject({
      read_only_copy: true,
      space: { state: "read_only", reason: "read_only_copy" },
    });
    const copy = await factsOf(copyFolder);
    expect(copy.userVersion).toBe(1);
    expect(copy.lastSeq).toBe(fixture.lastSeq);
    expect(copy.counts).toEqual(fixture.counts);
    expect((await user(["space", "close", copyFolder, "--json"])).code).toBe(0);

    // The fault is removed. The same build does not try the same state again by itself (A1
    // 3.17): the next open serves it read-only and writes no new barrier backup.
    expect((await user(["space", "close", folder, "--json"])).code).toBe(0);
    await onClosedSpace(folder, "DROP TRIGGER drill_fault");
    const held = await user(["space", "open", folder, "--json"]);
    expect(held.code, held.stdout + held.stderr).toBe(0);
    expect(parsed(held.stdout)["space"]).toMatchObject({
      state: "read_only",
      reason: "migration_failed",
      code: "MIGRATION_FAILED",
      message:
        "Migration to 0.5 failed with this version (MIGRATION_FAILED) and was not tried again. " +
        `Your data is unchanged. The space stays at 0.1. Backup: ${backupName}. ${TRIED_AGAIN}`,
    });
    const barriers = async () =>
      (
        parsed((await user(["space", "backups", "list", folder, "--json"])).stdout) as {
          backups: { kind?: string }[];
        }
      ).backups.filter((b) => b.kind === "pre-migrate").length;
    expect(await barriers()).toBe(1);

    // Only the person asks for it: the build's own CLI takes the option, and from a script (no
    // terminal) the service refuses it and tries nothing.
    const scripted = await world.tasks(["space", "open", folder, "--retry-migration", "--json"]);
    expect(scripted.code, scripted.stdout + scripted.stderr).not.toBe(0);
    expect(parsed(scripted.stdout)).toMatchObject({ error: { code: "forbidden" } });
    expect(await barriers()).toBe(1);

    // The person asks for it in a terminal: the space migrates, behind its own new barrier backup:
    // 0.5, a migration commit per step, every 0.1 table's rows kept, the new tables empty but the
    // search index, which holds the tasks, and writes are taken and found by their words.
    const reopened = await user(["space", "open", folder, "--retry-migration", "--json"]);
    expect(reopened.code, reopened.stdout + reopened.stderr).toBe(0);
    expect(parsed(reopened.stdout)["space"]).toMatchObject({ state: "open" });
    expect(parsed(reopened.stdout)["space"]).not.toHaveProperty("message");
    expect(await barriers()).toBe(2);
    const upgraded = await factsOf(folder);
    expect(upgraded.userVersion).toBe(5);
    expect(upgraded.lastSeq).toBeGreaterThan(fixture.lastSeq);
    for (const [table, n] of Object.entries(fixture.counts)) {
      // The outbox is the projection's queue: the open space's projection empties it at its pace.
      if (table !== "commits" && table !== "outbox") {
        expect(upgraded.counts[table], table).toBe(n);
      }
    }
    for (const table of [
      "labels",
      "task_labels",
      "learnings",
      "proposals",
      "exchanges",
      "sessions",
      "runs",
      "folders",
    ]) {
      expect(upgraded.counts[table], table).toBe(0);
    }
    // The space list says what the update did, and which backup is from just before it.
    const newest = (
      parsed((await user(["space", "backups", "list", folder, "--json"])).stdout) as {
        backups: { name: string; kind?: string }[];
      }
    ).backups
      .filter((b) => b.kind === "pre-migrate" && b.name !== backupName)
      .map((b) => b.name);
    expect(newest).toHaveLength(1);
    const after = await world.tasks(["space", "list"]);
    expect(after.stdout).toMatch(
      new RegExp(
        `Updated from schema 0\\.1 to 0\\.4 on [0-9-]+ [0-9:]+\\. The backup from just before it: ${newest[0] ?? "?"} `,
        "u",
      ),
    );
    expect(upgraded.counts["search_docs"]).toBeGreaterThanOrEqual(fixture.counts["tasks"] ?? 0);
    const added = await world.tasks(["add", "Drill fixture task", "--space", id, "--json"]);
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const found = await world.tasks(["find", "drill", "--space", id, "--json"]);
    expect(found.code, found.stdout + found.stderr).toBe(0);
    const rows = (parsed(found.stdout) as { rows: { title: string }[] }).rows;
    expect(rows.map((row) => row.title)).toContain("Drill fixture task");
  }, 300_000);
});
