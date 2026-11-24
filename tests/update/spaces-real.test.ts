// One space through an update whose migration fails, with the real updater, the real service in
// this process and the real storage worker: version A migrates the space, a task is added, then
// version B's migration fails. The end of the update names B's backup, the one that holds the
// added task, in the service's own words, and never an older migration's; the rollback leaves the
// space open for changes on A, with that task. The fixture versions differ only in the schema
// steps their storage worker knows (stand-in-steps.ts): A's end at 0.5, B's add a 0.6 that fails
// midway. Fixture spaces and text only, in temporary folders; no real service is touched.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RpcSession } from "../../packages/bridge/src/protocol/index.ts";
import { spaceLines } from "../../packages/cli/src/update.ts";
import { startService, type RunningService } from "../../packages/service/src/hub/service.ts";
import {
  rollbackUpdate,
  spaceNotes,
  updateFromArchive,
  type RunningService as Running,
  type ServiceControl,
} from "../../packages/service/src/version/update.ts";
import { currentVersion } from "../../packages/service/src/version/switch.ts";
import {
  backupsOf,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
} from "../../packages/service/test/harness.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import { listBackups } from "../../packages/storage/src/index.ts";
import { FIXTURE_MACHINE } from "../../packages/storage/test/fixture-requests.ts";
import { createSpaceAt, STEPS_0_4 } from "../../packages/storage/test/revisions.ts";
import { checkedDriver } from "../../packages/storage/test/space-helpers.ts";
import type { StepSet } from "../../packages/storage/test/stand-in-steps.ts";
import { workerWithSteps } from "../../packages/storage/test/worker-helpers.ts";
import {
  fakeSelfTest,
  fixtureInstall,
  fixtureRelease,
  keyLine,
  scratch,
  throwawayKey,
} from "./fixture.ts";

const os = process.platform;
const LONG = 240_000;

/** The schema steps each fixture version's storage worker knows. */
const STEPS: Readonly<Record<string, StepSet>> = { "0.1.0": "0.5", "0.2.0": "midway" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

/** The service of whichever fixture version current names, in this process, on its own home. */
class HubControl implements ServiceControl {
  hub: RunningService | undefined;
  version: string | undefined;
  readonly #home: string;
  readonly #root: string;

  constructor(home: string, root: string) {
    this.#home = home;
    this.#root = root;
  }

  async start(version: string): Promise<RunningService> {
    const set = STEPS[version];
    if (set === undefined) throw new Error(`no fixture steps for ${version}`);
    const hub = await startService({
      env: serviceEnv(this.#home),
      identity: () => ({ root: false, elevated: false, package: null }),
      say: () => undefined,
      maintenance: false,
      spaceOptions: {
        startWorker: () => workerWithSteps(set),
        build: { version, build: "fixture" },
      },
    });
    this.hub = hub;
    this.version = version;
    return hub;
  }

  async stop(): Promise<void> {
    const hub = this.hub;
    this.hub = undefined;
    this.version = undefined;
    if (hub === undefined) return;
    await hub.stop();
    removeRuntimeDir(hub);
  }

  running(): Promise<Running | undefined> {
    const { hub, version } = this;
    return Promise.resolve(
      hub === undefined || version === undefined
        ? undefined
        : { version, manager: "manual", spaces: spaceNotes(hub.status().spaces) },
    );
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start(currentVersion(this.#root, os) ?? "none");
  }

  waitFor(version: string): Promise<boolean> {
    return Promise.resolve(this.version === version);
  }
}

/** The space's barrier backups that are complete, oldest first, with their tasks counted. */
const barriers = (folder: string) =>
  listBackups(folder)
    .backups.filter((b) => b.state === "ok" && b.sidecar?.kind === "pre-migrate")
    .map((b) => ({ name: b.name, tasks: b.sidecar?.counts["tasks"] ?? -1 }))
    .sort((a, b) => a.name.localeCompare(b.name));

describe("[A2.3.12.6.update.spaces] an update whose migration fails names its own backup, and the rollback keeps every change", () => {
  test(
    "A migrates the space, a task is added, B's migration fails: the end names B's backup, which holds the task, and the rollback opens the space on A with it",
    async () => {
      const made = scratch("spaces-real");
      cleanups.push(made.remove);
      const key = throwawayKey();
      const keys = [keyLine(key)];
      const { root, facts } = await fixtureInstall(made.dir, os);
      const release = fixtureRelease(join(made.dir, "r2"), "0.2.0", os, key, { launcher: "two" });

      // The service's home, apart from the fixture install: machine.json names the space's
      // authority, so the service migrates it and may write.
      const home = join(made.dir, "h");
      mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(stateOf(home), "machine.json"),
        JSON.stringify({
          machine_id: FIXTURE_MACHINE.id,
          name: "fixture-machine",
          created_at: "2026-11-14T08:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const folder = join(made.dir, "spaces", "work");
      mkdirSync(join(made.dir, "spaces"));
      const created = createSpaceAt(
        await checkedDriver(),
        folder,
        { name: "Work", ownerLabel: "Fixture Owner", machineId: FIXTURE_MACHINE.id },
        STEPS_0_4,
      );
      registerSpaces(home, [folder]);
      const backups = backupsOf(home, created.space.spaceId);
      const control = new HubControl(home, root);
      cleanups.push(() => control.stop());

      // A opens the space and migrates it from 0.4 to 0.5 behind its barrier backup.
      const first = await control.start("0.1.0");
      await first.spacesSettled;
      expect(control.hub?.status().spaces[0]).toMatchObject({ state: "open" });
      const [fromA] = barriers(backups);
      if (fromA === undefined) throw new Error("A took no barrier backup");

      // A task is added through an operation.
      const user: RpcSession = await classSession(home, first.endpoint.path, "cli-interactive");
      await user.call(
        "op/call",
        {
          op: "task.add",
          input: {
            tasks: [{ title: "Fixture added after the first migration" }],
            request_id: "fixture-real-000001",
          },
        },
        { timeoutMs: 30_000 },
      );
      user.close();

      // B's migration to 0.6 fails midway, behind a barrier backup of its own.
      const updated = await updateFromArchive(release.archive, {
        facts,
        keys,
        control,
        selfTest: fakeSelfTest(),
        settleWaitMs: 120_000,
      });
      expect(updated).toMatchObject({ outcome: "updated", from: "0.1.0", to: "0.2.0" });
      const fromB = barriers(backups).find((b) => b.name !== fromA.name);
      if (fromB === undefined) throw new Error("B took no barrier backup");
      expect(fromB.tasks).toBe(fromA.tasks + 1);
      const report = updated.spaces;
      if (report === undefined) throw new Error("no report about the spaces");
      expect(report.spaces.map((s) => [s.name, s.verdict, s.now?.reason])).toEqual([
        ["Work", "not_usable", "migration_failed"],
      ]);
      expect(report.spaces[0]?.now?.migration_backup).toBe(fromB.name);
      const { lines, flagged } = spaceLines(report);
      expect(flagged).toBe(true);
      const said = lines.join("\n");
      expect(said).toContain(`Backup: ${fromB.name}.`);
      expect(said).not.toContain(fromA.name);
      expect(said).toContain("To go back to 0.1.0: ttasks update --rollback");

      // The rollback: A opens the space for changes, at 0.5, with the added task.
      const back = await rollbackUpdate({ facts, keys, control, selfTest: fakeSelfTest() });
      expect(back).toMatchObject({ outcome: "updated", from: "0.2.0", to: "0.1.0" });
      expect(back.spaces?.spaces.map((s) => [s.name, s.verdict])).toEqual([["Work", "usable"]]);
      const again = control.hub;
      if (again === undefined) throw new Error("the service is not running");
      await again.spacesSettled;
      expect(again.status().spaces[0]).toMatchObject({ state: "open" });
      const reader = await classSession(home, again.endpoint.path, "cli-interactive");
      try {
        const found = (await reader.call(
          "op/call",
          { op: "task.search", input: { q: "status:open", scope: "active", limit: 50 } },
          { timeoutMs: 30_000 },
        )) as { rows: { title: string }[] };
        expect(found.rows.map((row) => row.title)).toEqual([
          "Fixture added after the first migration",
        ]);
      } finally {
        reader.close();
      }
    },
    LONG,
  );
});
