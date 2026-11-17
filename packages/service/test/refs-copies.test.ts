// Copies of one space on this machine (a backup restored into a new folder, and its original) never
// give one task reference to two tasks across a claim or a restore in place: each goes on from the
// highest counter of the copies the service knows. Fixture spaces only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupSpace, createSpace, restoreBackup } from "@tasks/storage";
import { checkedDriver } from "@tasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { rawWriter, readFacts, writeCommits } from "../../storage/test/backup-helpers.ts";
import { TEST_MACHINE } from "../../storage/test/space-helpers.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import { registerSpaces, removeRuntimeDir, serviceEnv, stateOf, tempRoot } from "./harness.ts";

const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("[A1.5.refs.copies] a claimed copy and a restore in place go on from every copy's counter", () => {
  test("a claim of a restored copy goes above its original's references, and a restore in place above the claimed copy's", async () => {
    const { root, cleanup } = tempRoot("refs-copies");
    cleanups.push(cleanup);
    const home = join(root, "h");
    mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateOf(home), "machine.json"),
      JSON.stringify({
        machine_id: TEST_MACHINE,
        name: "fixture-machine",
        created_at: "2026-11-16T08:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const spaces = join(root, "spaces");
    mkdirSync(spaces);
    const checked = await checkedDriver();
    const original = createSpace(checked, join(spaces, "work"), {
      name: "Work",
      ownerLabel: "Mira Okafor",
      machineId: TEST_MACHINE,
    });
    await writeCommits(original.folder, 2, "a");
    const backup = await backupSpace(checked, original.folder, { kind: "manual" });
    await writeCommits(original.folder, 3, "b");
    const copy = join(spaces, "copy");
    await restoreBackup(checked, backup.file, copy);
    const originalNext = (await readFacts(original.folder)).space.nextRef;
    expect((await readFacts(copy)).space.nextRef).toBeLessThan(originalNext);

    registerSpaces(home, [original.folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
      maintenance: false,
    });
    running.push(service);
    await service.spacesSettled;
    // Served beside its original, as `tasks space restore --to` serves a copy.
    expect(await service.spaceManager.open(copy)).toBe(1);
    expect(service.spaces().map((s) => s.state)).toEqual(["open", "read_only"]);

    // The person moves to the copy: the original closes, the copy is claimed.
    await service.spaceManager.close(0);
    await service.spaceManager.claim(1);
    expect((await readFacts(copy)).space.nextRef).toBe(originalNext);

    // The copy takes tasks, then the person goes back and restores the original from the backup.
    await service.spaceManager.close(1);
    await writeCommits(copy, 3, "c");
    const copyNext = (await readFacts(copy)).space.nextRef;
    expect(copyNext).toBeGreaterThan(originalNext);
    await service.spaceManager.restoreInPlace(0, backup.file);
    expect((await readFacts(original.folder)).space.nextRef).toBe(copyNext);
  }, 120_000);

  test("a claim goes above an original that no longer opens as a space, while its counter reads", async () => {
    const { root, cleanup } = tempRoot("refs-damaged");
    cleanups.push(cleanup);
    const home = join(root, "h");
    mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateOf(home), "machine.json"),
      JSON.stringify({
        machine_id: TEST_MACHINE,
        name: "fixture-machine",
        created_at: "2026-11-16T08:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const spaces = join(root, "spaces");
    mkdirSync(spaces);
    const checked = await checkedDriver();
    const original = createSpace(checked, join(spaces, "work"), {
      name: "Work",
      ownerLabel: "Mira Okafor",
      machineId: TEST_MACHINE,
    });
    await writeCommits(original.folder, 2, "a");
    const backup = await backupSpace(checked, original.folder, { kind: "manual" });
    await writeCommits(original.folder, 3, "b");
    const originalNext = (await readFacts(original.folder)).space.nextRef;
    // The original's space row stops passing its checks: it no longer opens as a space.
    const raw = await rawWriter(original.folder);
    raw.exec("UPDATE space SET format_minor = format_minor + 50 WHERE one = 1");
    raw.close();
    const copy = join(spaces, "copy");
    await restoreBackup(checked, backup.file, copy);

    registerSpaces(home, [original.folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
      maintenance: false,
    });
    running.push(service);
    await service.spacesSettled;
    expect(service.spaces()[0]?.state).not.toBe("open");
    expect(await service.spaceManager.open(copy)).toBe(1);
    await service.spaceManager.claim(1);
    expect((await readFacts(copy)).space.nextRef).toBe(originalNext);
  }, 120_000);
});
