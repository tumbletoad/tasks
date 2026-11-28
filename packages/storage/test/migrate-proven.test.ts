// The backup before an upgrade must restore before the upgrade starts: one that reads back but
// fails a trial restore stops it, and the space stays as it was, readable at its revision.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listBackups } from "../src/backup/list.ts";
import { migrateSpaceWith, type MigrationOutcome } from "../src/migrate/runner.ts";
import { openWriter } from "../src/open.ts";
import { openSpace } from "../src/space.ts";
import type { CheckedDriver } from "../src/startup-check.ts";
import { backupsBeside, readFacts, writeCommits } from "./backup-helpers.ts";
import { STEPS_0_1 } from "./revisions.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("migrate-proven");

afterEach(() => {
  folders.cleanup();
});

async function spaceAt01(): Promise<string> {
  const { folder } = await createFixtureSpace(folders.make(), "mira", {}, STEPS_0_1);
  await writeCommits(folder, 3, "s", STEPS_0_1);
  return folder;
}

function failed(outcome: MigrationOutcome): Extract<MigrationOutcome, { state: "failed" }> {
  if (outcome.state !== "failed") throw new Error("expected a failed migration");
  return outcome;
}

/**
 * Damage that only a restore meets: a table the space's schema does not have, put into the
 * backup's snapshot after it was copied. The snapshot still passes its integrity check, its facts
 * agree with it, and its compressed form reads back.
 */
function strayTableInSnapshot(checked: CheckedDriver, backups: string): void {
  const copy = readdirSync(backups).find(
    (name) => name.startsWith(".backup.tmp-") && name.endsWith(".db"),
  );
  if (copy === undefined) throw new Error("no snapshot to damage");
  const conn = openWriter(checked, join(backups, copy));
  try {
    conn.exec("CREATE TABLE stray (x INTEGER)");
  } finally {
    conn.close();
  }
}

describe("[A1.5.migration.proven-barrier] an upgrade starts only behind a backup that restores", () => {
  test("a barrier backup that reads back but fails its trial restore stops the upgrade, and the space stays readable", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01();
    const before = await readFacts(folder);
    const backups = backupsBeside(folder);
    const outcome = failed(
      await migrateSpaceWith(
        checked,
        folder,
        { backupDir: backupsBeside(folder) },
        {
          backup: {
            at: (point) => {
              if (point === "copied") strayTableInSnapshot(checked, backups);
            },
          },
        },
      ),
    );
    expect(outcome.stage).toBe("backup");
    expect(outcome.error.code).toBe("BACKUP_FAILED");
    expect(outcome.error.message).toMatch(
      /^The barrier backup before the migration to 0\.\d+ failed, so nothing was migrated\. The space stays at 0\.1\./,
    );
    expect(outcome.error.message).not.toContain(folder);
    // Nothing changed in the space.
    const after = await readFacts(folder);
    expect(after.userVersion).toBe(1);
    expect(after.space.lastSeq).toBe(before.space.lastSeq);
    expect(after.counts).toEqual(before.counts);
    // The backup that does not restore stays, as every published backup does, and the scratch
    // copy of its trial restore is gone.
    expect(listBackups(backups).backups.map((b) => b.sidecar?.kind)).toEqual(["pre-migrate"]);
    expect(readdirSync(backups).filter((name) => name.startsWith(".backup.tmp-"))).toEqual([]);
    const reader = openSpace(checked, folder, { role: "reader" });
    expect(reader.readOnlyReasons).toEqual(["older_revision"]);
    reader.conn.close();
  });

  test("a full disk at the trial restore stops the upgrade with the free-space refusal", async () => {
    const checked = await checkedDriver();
    const folder = await spaceAt01();
    let calls = 0;
    // The backup's own check passes; the trial restore's, which comes after it, finds no room.
    const freeBytes = (): number => (++calls === 1 ? 64 * 1024 ** 3 : 0);
    const outcome = failed(
      await migrateSpaceWith(
        checked,
        folder,
        { backupDir: backupsBeside(folder) },
        { backup: { freeBytes } },
      ),
    );
    expect(calls).toBe(2);
    expect(outcome.stage).toBe("backup");
    expect(outcome.error.code).toBe("BUNDLE_LIMIT_EXCEEDED");
    expect((await readFacts(folder)).userVersion).toBe(1);
  });
});
