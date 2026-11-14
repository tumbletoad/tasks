// The space admin worker's entry (space-admin.ts): one job, off the main thread. M1.06's functions
// as M1.10 uses them (A1 3.18): createSpace, backupSpace of kind `manual`, and
// restoreBackup into a new folder, which leaves a read-only copy until a person claims it.
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  backupSpace,
  CheckedDriver,
  createSpace,
  DEFAULT_DRIVER,
  loadDriver,
  restoreBackup,
} from "@tasks/storage";
import { makeDir } from "./files.ts";
import type { AdminJob, AdminReply, AdminResult } from "./space-admin.ts";

const reply = (message: AdminReply): void => {
  parentPort?.postMessage(message);
};

async function run(job: AdminJob): Promise<AdminResult> {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  switch (job.kind) {
    case "create": {
      // The folder for spaces, such as ~/.tasks/spaces, on the first create: user-only, like the
      // spaces in it (A6 3.16.6), whatever the umask. One that is already there keeps its mode.
      makeDir(dirname(job.folder), 0o700);
      const created = createSpace(checked, job.folder, {
        name: job.name,
        ...(job.refPrefix === undefined ? {} : { refPrefix: job.refPrefix }),
        takenPrefixes: job.takenPrefixes,
        machineId: job.machineId,
        ownerLabel: job.ownerLabel,
      });
      return { kind: "create", spaceId: created.space.spaceId, refPrefix: created.space.refPrefix };
    }
    case "backup": {
      const record = await backupSpace(checked, job.folder, {
        kind: "manual",
        ...(job.backupDir === undefined ? {} : { backupDir: job.backupDir }),
      });
      const { sidecar } = record;
      return {
        kind: "backup",
        backup: {
          name: record.name,
          kind: sidecar.kind,
          created_at: new Date(sidecar.created_at).toISOString(),
          epoch: sidecar.epoch,
          seq: sidecar.seq,
          size: sidecar.size,
          compressed_size: sidecar.compressed_size,
        },
      };
    }
    case "restore": {
      const restored = await restoreBackup(checked, job.backupFile, job.target);
      return { kind: "restore", spaceId: restored.space.spaceId };
    }
  }
}

try {
  reply({ ok: true, result: await run(workerData as AdminJob) });
} catch (error) {
  // Only the code crosses: the message can name a path.
  const code = (error as { code?: unknown } | null)?.code;
  reply({ ok: false, ...(typeof code === "string" ? { code } : {}) });
}
