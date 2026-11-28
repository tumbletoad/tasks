// A task's reference names one task for good: whatever a person does with backups and restores in
// place, no reference that was given out in the space on this machine is given to another task.
import { basename, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { backupSpace } from "../src/backup/backup.ts";
import { DATABASE_FILE } from "../src/manifest.ts";
import { openReader } from "../src/open.ts";
import { restoreInPlace } from "../src/restore/restore.ts";
import { backupsBeside, copyTree, rawWriter, readFacts, writeCommits } from "./backup-helpers.ts";
import { checkedDriver, createFixtureSpace, TEST_MACHINE, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("refs-restore");

afterEach(() => {
  folders.cleanup();
});

type Step =
  { kind: "create"; count: number } | { kind: "backup" } | { kind: "restore"; pick: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const), count: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("backup" as const) }),
  fc.record({ kind: fc.constant("restore" as const), pick: fc.nat() }),
);

/** Every task of the space at `folder`, by its reference. */
async function tasksByRef(folder: string): Promise<Map<number, string>> {
  const conn = openReader(await checkedDriver(), join(folder, DATABASE_FILE));
  try {
    const rows = conn.prepare("SELECT id, ref FROM tasks").all<{ id: unknown; ref: unknown }>();
    return new Map(rows.map((row) => [Number(row.ref), String(row.id)]));
  } finally {
    conn.close();
  }
}

describe("[A1.5.refs.across-restore] a restore over a space never gives a reference twice", () => {
  test("over random sequences of creates, backups and restores in place, each reference names one task", async () => {
    const checked = await checkedDriver();
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 10 }), async (steps) => {
        const { folder } = await createFixtureSpace(folders.make());
        const backupDir = folders.make();
        // Each reference ever given in the space, with the task it named.
        const given = new Map<number, string>();
        const backups: string[] = [];
        // Distinct times, so no two backups or replaced folders want one name.
        let clock = Date.UTC(2026, 10, 16, 9, 0, 0);
        const tick = (): number => (clock += 1000);
        const record = async (): Promise<void> => {
          for (const [ref, id] of await tasksByRef(folder)) {
            const before = given.get(ref);
            expect(before === undefined || before === id, `reference ${String(ref)}`).toBe(true);
            given.set(ref, id);
          }
        };
        for (const s of steps) {
          if (s.kind === "create") {
            await writeCommits(folder, s.count + 1, "p");
            await record();
          } else if (s.kind === "backup") {
            const at = tick();
            backups.push(
              basename(
                (await backupSpace(checked, folder, { kind: "manual", backupDir, now: () => at }))
                  .file,
              ),
            );
          } else if (backups.length > 0) {
            const name = backups[s.pick % backups.length] ?? "";
            const at = tick();
            await restoreInPlace(checked, join(backupDir, name), folder, {
              machineId: TEST_MACHINE,
              now: () => at,
            });
            await record();
          }
        }
        // One more task after the last step: it takes a reference no task had.
        await writeCommits(folder, 2, "q");
        await record();
      }),
      { numRuns: 12 },
    );
  });

  test("a backup from a later state keeps its own counter, and a live space that does not open still lends its", async () => {
    const checked = await checkedDriver();
    const parent = folders.make();
    const { folder } = await createFixtureSpace(parent);
    await writeCommits(folder, 2, "a");
    const early = await backupSpace(checked, folder, { kind: "manual", backupDir: folders.make() });

    // The same space, further on elsewhere: its backup's counter is above the live space's.
    const elsewhere = join(parent, "elsewhere");
    copyTree(folder, elsewhere);
    await writeCommits(elsewhere, 5, "b");
    const later = await backupSpace(checked, elsewhere, {
      backupDir: backupsBeside(elsewhere),
      kind: "manual",
    });
    const restored = await restoreInPlace(checked, later.file, folder, { machineId: TEST_MACHINE });
    expect((await readFacts(folder)).space.nextRef).toBe(
      (await readFacts(elsewhere)).space.nextRef,
    );
    expect(restored.claim.space.nextRef).toBe((await readFacts(elsewhere)).space.nextRef);

    // A damaged space row stops the space from opening; its counter still reads, and the restore
    // goes on from it.
    await writeCommits(folder, 3, "c");
    const reached = (await readFacts(folder)).space.nextRef;
    const raw = await rawWriter(folder);
    raw.exec("UPDATE space SET format_minor = format_minor + 50 WHERE one = 1");
    raw.close();
    await restoreInPlace(checked, early.file, folder, {
      machineId: TEST_MACHINE,
    });
    expect((await readFacts(folder)).space.nextRef).toBe(reached);
  });
});
