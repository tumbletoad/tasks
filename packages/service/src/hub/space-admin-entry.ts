// The space admin worker's entry (space-admin.ts): one job, off the main thread. Storage's
// functions as the space verbs use them (A1 3.18): createSpace, backupSpace of kind `manual`,
// exportBundle, and restoreBackup into a new folder, which leaves a read-only copy until a person
// claims it.
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  backupSpace,
  CheckedDriver,
  createSpace,
  DEFAULT_DRIVER,
  exportBundle,
  loadDriver,
  newestVerifiedBackup,
  rescueSpace,
  restoreBackup,
  StorageError,
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
        },
      };
    }
    case "restore": {
      // A backup's `.db.gz` or an export bundle's `.zip`: either restores as a read-only copy.
      const restored = await restoreBackup(checked, job.backupFile, job.target);
      return { kind: "restore", spaceId: restored.space.spaceId };
    }
    case "restore-latest": {
      const newest = await newestVerifiedBackup(checked, job.backupDir, job.spaceId);
      if (newest === undefined) {
        throw new StorageError("BACKUP_INVALID", "No backup of the space verifies");
      }
      const restored = await restoreBackup(checked, newest.file, job.target);
      return { kind: "restore", spaceId: restored.space.spaceId, backup: newest.name };
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

/**
 * Where an export's secret scan found a secret-shaped string: its kind and the table and column,
 * or "an attachment". Read from storage's fixed sentence, and passed on only when both parts are
 * plain words: never a path or text.
 */
function secretPlace(error: unknown): { kind: string; place: string } | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return undefined;
  const match = /\(([a-z_]{1,32})\) in ([a-z_]{1,64}(?:\.[a-z_]{1,64})?|an attachment)\./.exec(
    message,
  );
  return match === null ? undefined : { kind: match[1] ?? "", place: match[2] ?? "" };
}

try {
  reply({ ok: true, result: await run(workerData as AdminJob) });
} catch (error) {
  // Only the code crosses: the message can name a path. A secret's kind and place are words.
  const code = (error as { code?: unknown } | null)?.code;
  const secret = code === "EXPORT_SECRET_FOUND" ? secretPlace(error) : undefined;
  reply({
    ok: false,
    ...(typeof code === "string" ? { code } : {}),
    ...(secret === undefined ? {} : { secret }),
  });
}
