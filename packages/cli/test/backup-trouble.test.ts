// A daily backup that fails is shown where a person looks at their spaces, with what to do, and the
// report goes once a backup succeeds again: through a running service, `ttasks doctor` and
// `ttasks space list`. Fixture spaces only.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { startService, type RunningService } from "@ttasks/service/hub";
import {
  backupsOf,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "@ttasks/service/test/harness";
import { createSpace, newId } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { runMain } from "./cli-harness.ts";

interface Report {
  checks: { id: string; status: string; detail: string }[];
}

const running: RunningService[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.stop();
    removeRuntimeDir(service);
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const spacesRow = async (home: string) => {
  const ran = await runMain(["doctor", "--json"], { home });
  const report = JSON.parse(ran.stdout) as Report;
  return report.checks.find((c) => c.id === "spaces");
};

describe("[A1.5.backup.failure-shown] a failed daily backup is shown until a backup succeeds", () => {
  test("doctor and the space list name the trouble and what to run; a backup made then clears it", async () => {
    const { root, cleanup } = tempRoot("bt");
    cleanups.push(cleanup);
    const home = join(root, "h");
    const machine = newId("m");
    mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateOf(home), "machine.json"),
      JSON.stringify({
        machine_id: machine,
        name: "fixture-machine",
        created_at: "2026-11-16T08:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const folder = join(root, "spaces", "mira");
    mkdirSync(join(root, "spaces"));
    const created = createSpace(await checkedDriver(), folder, {
      name: "Mira",
      ownerLabel: "Mira Okafor",
      machineId: machine,
    });
    // A file where the space's backups folder goes: no daily backup can be made.
    const blocker = backupsOf(home, created.space.spaceId);
    mkdirSync(dirname(blocker));
    writeFileSync(blocker, "not a folder");
    registerSpaces(home, [folder]);
    const service = await startService({
      env: serviceEnv(home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
    });
    running.push(service);
    await service.spacesSettled;
    // The upkeep at the start tries the daily backup, which is due: there is none yet.
    await waitFor(
      () => (service.spaces()[0]?.backup === undefined ? undefined : true),
      60_000,
      "the failed daily backup",
    );

    const failed = await spacesRow(home);
    expect(failed?.status).toBe("warn");
    expect(failed?.detail).toContain(
      "Mira: open. The backups folder for this space is not there, so no daily backup was made.",
    );
    expect(failed?.detail).toContain(`${CLI_NAME} space backups <folder>`);
    expect(failed?.detail).toContain(`Run ${CLI_NAME} space list to see each space's folder.`);
    expect(failed?.detail).not.toContain(folder);
    const listed = await runMain(["space", "list"], { home });
    expect(listed.stdout).toMatch(/^ {2}The backups folder for this space is not there/m);

    // The person frees the folder and makes a backup now: it passes its trial restore, and the
    // report is gone.
    rmSync(blocker);
    const made = await runMain(["space", "backup", folder], { home, tty: true });
    expect(made.code, made.stderr).toBe(0);
    expect(service.spaces()[0]?.backup).toBeUndefined();
    const fine = await spacesRow(home);
    expect(fine?.status).toBe("ok");
    expect(fine?.detail).not.toContain("backup");
    expect((await runMain(["space", "list"], { home })).stdout).not.toContain("is not there");
  }, 120_000);
});
