// A space of every revision with a search index, from 0.4 to this build's, backs up, passes this
// build's trial restore, restores with the index of its own tasks, and upgrades with its references,
// its counter and its history as they were. This build's search documents read pages and a node's
// texts, which an older copy does not have: they are read by the copy's own revision. Fixture text
// only.
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpaceWith } from "../src/backup/backup.ts";
import { listBackups, verifyBackup } from "../src/backup/list.ts";
import type { Connection } from "../src/driver.ts";
import { migrateSpace } from "../src/migrate/runner.ts";
import { openWriter } from "../src/open.ts";
import { restoreBackup } from "../src/restore/restore.ts";
import { expectedDocuments, rebuildSearchIndex } from "../src/search/documents.ts";
import { DATABASE_FILE } from "../src/manifest.ts";
import { encodeRevision } from "../src/schema.ts";
import { openSpace } from "../src/space.ts";
import type { SchemaStep } from "../src/schema.ts";
import { backupsBeside, writeCommits } from "./backup-helpers.ts";
import { STEPS_0_4, STEPS_0_5, STEPS_0_6 } from "./revisions.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("revision-upgrade");

afterEach(() => {
  folders.cleanup();
});

/** What an upgrade must keep: the task references, the counter and every change record. */
function kept(conn: Connection): unknown {
  return {
    refs: conn.prepare("SELECT id, ref FROM tasks ORDER BY ref").all(),
    nextRef: conn.prepare("SELECT next_ref FROM space WHERE one = 1").get()?.["next_ref"],
    changes: conn
      .prepare(
        "SELECT seq, n, entity, entity_id, action, field, before, after FROM changes " +
          "ORDER BY seq, n",
      )
      .all(),
  };
}

/** The entity IDs whose documents hold `word`. */
function matching(conn: Connection, word: string): string[] {
  return conn
    .prepare(
      "SELECT d.entity_id FROM search_fts f JOIN search_docs d ON d.doc = f.rowid " +
        "WHERE search_fts MATCH $word ORDER BY d.entity_id",
    )
    .all<{ entity_id: string }>({ word: `"${word}"` })
    .map((row) => row.entity_id);
}

async function read<T>(folder: string, fn: (conn: Connection) => T): Promise<T> {
  const { conn } = openSpace(await checkedDriver(), folder, { role: "reader" });
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

const CHAINS: readonly (readonly [string, readonly SchemaStep[]])[] = [
  ["0.4", STEPS_0_4],
  ["0.5", STEPS_0_5],
  ["0.6", STEPS_0_6],
];

describe("[A1.5.restore.every-revision] a backup of every revision with a search index restores and upgrades with this build", () => {
  test.each(CHAINS)(
    "a %s space: its backup passes the trial restore and restores searchable, and its upgrade keeps references, counter and history",
    async (name, steps) => {
      const checked = await checkedDriver();
      const { folder } = await createFixtureSpace(folders.make(), "mira", {}, steps);
      const tag = `rev${name.replace(".", "")}x`;
      await writeCommits(folder, 4, tag, steps);
      const revision = steps.at(-1)?.revision ?? { major: 0, minor: 0 };
      const before = await read(folder, kept);

      const backup = await backupSpaceWith(
        checked,
        folder,
        { backupDir: backupsBeside(folder), kind: "manual" },
        { steps },
      );
      expect(backup.sidecar.user_version).toBe(encodeRevision(revision));
      const listed = listBackups(backupsBeside(folder)).backups.find((b) => b.name === backup.name);
      if (listed === undefined) throw new Error("the backup is listed");
      expect(await verifyBackup(checked, listed)).toEqual({
        state: "verified",
        sidecar: backup.sidecar,
      });
      const copy = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
      expect(copy.revision).toEqual(revision);
      await read(copy.folder, (conn) => {
        expect(matching(conn, `${tag}1`)).toHaveLength(1);
      });

      // The upgrade's barrier backup is trial-restored by this build before any step runs.
      const outcome = await migrateSpace(checked, folder, { backupDir: backupsBeside(folder) });
      expect(outcome.state).toBe(name === "0.6" ? "current" : "migrated");
      await read(folder, (conn) => {
        expect(Number(conn.pragma("user_version"))).toBe(encodeRevision({ major: 0, minor: 6 }));
        expect(kept(conn)).toEqual(before);
        expect(matching(conn, `${tag}2`)).toHaveLength(1);
      });
    },
  );

  test("a 0.6 space's live pages are search documents, and a page on a task in the Trash is not", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3, "holder");
    const conn = openWriter(await checkedDriver(), join(folder, DATABASE_FILE));
    let live = "";
    try {
      conn.transaction("immediate", () => {
        const owner = conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
        const space = conn.prepare("SELECT space_id FROM space WHERE one = 1").get()?.["space_id"];
        const [first, trashed] = conn
          .prepare("SELECT id FROM tasks ORDER BY ref")
          .all<{ id: string }>()
          .map((row) => row.id);
        live = first ?? "";
        conn.prepare("UPDATE tasks SET deleted_at = 1 WHERE id = $id").run({ id: trashed ?? "" });
        const insert = conn.prepare(
          "INSERT INTO pages (id, ref, owner_kind, owner_id, title, brief, body, created_at, " +
            "created_by, created_seq, version) VALUES ($id, $ref, $kind, $owner, $title, '', " +
            "$body, 1, $by, 1, 1)",
        );
        const page = (id: string, ref: number, kind: string, on: unknown, word: string) =>
          insert.run({
            id,
            ref,
            kind,
            owner: String(on),
            title: `Page ${word}`,
            body: `The ${word} rule`,
            by: String(owner),
          });
        page("pg_00000000000000000000000001", 900, "space", space, "spacewide");
        page("pg_00000000000000000000000002", 901, "task", live, "onlive");
        page("pg_00000000000000000000000003", 902, "task", trashed, "ontrashed");
        rebuildSearchIndex(conn);
      });
      const docs = expectedDocuments(conn);
      expect(docs.get("pg_00000000000000000000000001")).toMatchObject({
        kind: "page",
        taskId: null,
        title: "Page spacewide",
        extra: "Mira\nM-900",
      });
      expect(docs.get("pg_00000000000000000000000002")).toMatchObject({
        kind: "page",
        taskId: live,
      });
      expect(docs.has("pg_00000000000000000000000003")).toBe(false);
      expect(matching(conn, "spacewide")).toEqual(["pg_00000000000000000000000001"]);
      expect(matching(conn, "ontrashed")).toEqual([]);
    } finally {
      conn.close();
    }
  });
});
