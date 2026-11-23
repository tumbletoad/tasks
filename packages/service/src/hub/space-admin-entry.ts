// The space admin worker's entry (space-admin.ts): one job, off the main thread. Storage's
// functions as the space verbs use them (A1 3.18): createSpace, provenBackup of kind `manual`,
// exportBundle, and restoreBackup into a new folder, which leaves a read-only copy until a person
// claims it.
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  CheckedDriver,
  createSpace,
  DEFAULT_DRIVER,
  exportBundle,
  loadDriver,
  provenBackup,
  rescueSpace,
  restoreBackup,
  restoreLatest,
} from "@ttasks/storage";
import { makeDir } from "./files.ts";
import type { AdminJob, AdminReply, AdminResult } from "./space-admin.ts";

const reply = (message: AdminReply): void => {
  parentPort?.postMessage(message);
};

async function run(job: AdminJob): Promise<AdminResult> {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  switch (job.kind) {
    case "create": {
      // The folder for spaces, such as ~/.ttasks/spaces, on the first create: user-only, like the
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
      // Proven by a trial restore, so a person who makes one after a failed daily backup knows it
      // restores.
      const record = await provenBackup(checked, job.folder, {
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
        ...(record.searchIndexRemade === true ? { searchIndexDamaged: true as const } : {}),
      };
    }
    case "export": {
      const record = await exportBundle(checked, job.folder, {
        mode: job.mode,
        withJsonl: job.withJsonl,
        secretFolders: job.secretFolders,
      });
      const { manifest } = record;
      return {
        kind: "export",
        export: {
          name: record.name,
          file: record.file,
          mode: manifest.mode,
          epoch: manifest.epoch,
          seq: manifest.seq,
          size: record.size,
          sha256: record.sha256,
          secrets: record.secrets,
        },
      };
    }
    case "restore": {
      // A backup's `.db.gz` or an export bundle's `.zip`: either restores as a read-only copy.
      const restored = await restoreBackup(
        checked,
        job.backupFile,
        job.target,
        job.spaceId === undefined ? {} : { spaceId: job.spaceId },
      );
      return { kind: "restore", spaceId: restored.space.spaceId };
    }
    case "restore-latest": {
      const { restored, backup } = await restoreLatest(
        checked,
        job.backupDir,
        job.spaceId,
        job.target,
      );
      return { kind: "restore", spaceId: restored.space.spaceId, backup };
    }
    case "rescue": {
      const rescued = rescueSpace(checked, job.folder);
      return {
        kind: "rescue",
        file: rescued.file,
        tables: rescued.tables,
        rows: rescued.rows,
        failed: rescued.failed,
      };
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
