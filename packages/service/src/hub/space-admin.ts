// The space verbs' storage work that needs a SQLite connection of its own and no writer of a live
// space (A1 3.18, A2 3.10.1): create a space folder, take a manual backup, export a bundle,
// restore a backup or a bundle into a new folder. Each job runs in a worker thread of its own
// (space-admin-entry.ts), as the maintenance worker does: the main thread holds no SQLite
// connection (A1 3.9). Content-free replies: an error crosses as its code only, never a message
// that could name a path.
import { Worker } from "node:worker_threads";
import type { Id } from "@ttasks/storage";

export type AdminJob =
  | {
      readonly kind: "create";
      readonly folder: string;
      readonly name: string;
      readonly refPrefix?: string;
      readonly takenPrefixes: readonly string[];
      readonly machineId: Id<"m">;
      /** The label of the space's human, the `user` of A3 3.7.4. */
      readonly ownerLabel: string;
    }
  | { readonly kind: "backup"; readonly folder: string; readonly backupDir?: string }
  | {
      readonly kind: "export";
      readonly folder: string;
      readonly mode: "backup" | "fork";
      readonly withJsonl: boolean;
      /** Folders no file of the bundle may come from: the secrets folder (A6 3.16.4). */
      readonly secretFolders: readonly string[];
    }
  | {
      readonly kind: "restore";
      readonly backupFile: string;
      readonly target: string;
      /** The space the backup must be of, when the person named it. */
      readonly spaceId?: Id<"sp">;
    }
  | {
      /** The newest backup of the space that verifies, into a new folder (A1 3.2). */
      readonly kind: "restore-latest";
      readonly backupDir: string;
      readonly spaceId: Id<"sp">;
      readonly target: string;
    }
  /** The rows that can still be read, into `exchange/rescued/` (A1 3.2). */
  | {
      readonly kind: "rescue";
      readonly folder: string;
      /** The space the folder is registered as: another space's rows are refused. */
      readonly spaceId?: Id<"sp">;
    };

export interface AdminBackup {
  readonly name: string;
  readonly kind: string;
  readonly created_at: string;
  readonly epoch: number;
  readonly seq: number;
  readonly size: number;
  readonly compressed_size: number;
}

/** A published export bundle, as the CLI shows it. */
export interface AdminExport {
  readonly name: string;
  readonly file: string;
  readonly mode: string;
  readonly epoch: number;
  readonly seq: number;
  readonly size: number;
  readonly sha256: string;
  /**
   * The secret-shaped strings the bundle holds: each kind and place (`<table>.<column>` or `an
   * attachment`) once. Words only, never text.
   */
  readonly secrets: readonly { readonly kind: string; readonly place: string }[];
}

export type AdminResult =
  | { readonly kind: "create"; readonly spaceId: Id<"sp">; readonly refPrefix: string }
  | {
      readonly kind: "backup";
      readonly backup: AdminBackup;
      /** The backup found the space's search index damaged (BackupRecord.searchIndexRemade). */
      readonly searchIndexDamaged?: true;
    }
  | { readonly kind: "export"; readonly export: AdminExport }
  | { readonly kind: "restore"; readonly spaceId: Id<"sp">; readonly backup?: string }
  | {
      readonly kind: "rescue";
      readonly file: string;
      readonly tables: number;
      readonly rows: number;
      /** Tables that could not be read to their end: names from the schema, never content. */
      readonly failed: readonly string[];
      /** Whether the database said it holds the space the rescue was for (rescue.ts). */
      readonly identity: "confirmed" | "unconfirmed";
    };

export type AdminReply =
  | { readonly ok: true; readonly result: AdminResult }
  | { readonly ok: false; readonly code?: string };

/** A job that failed: its storage code, which maps to an error body (A3 3.5). */
export class AdminFailed extends Error {
  override readonly name = "AdminFailed";
  readonly code: string | undefined;
  constructor(code: string | undefined) {
    super("The space's storage work failed");
    this.code = code;
  }
}

const ENTRY = new URL("./space-admin-entry.ts", import.meta.url);

/** Runs one job in a worker thread of its own. Rejects with AdminFailed. */
export function runAdmin(job: AdminJob): Promise<AdminResult> {
  const worker = new Worker(ENTRY, { workerData: job });
  return new Promise<AdminResult>((resolve, reject) => {
    let settled = false;
    worker.once("message", (reply: AdminReply) => {
      settled = true;
      if (reply.ok) resolve(reply.result);
      else reject(new AdminFailed(reply.code));
      void worker.terminate();
    });
    worker.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new AdminFailed("STORAGE_WORKER_FAILED"));
    });
    worker.once("exit", () => {
      if (settled) return;
      settled = true;
      reject(new AdminFailed("STORAGE_WORKER_FAILED"));
    });
  });
}
